// Observation relay for the WING native protocol: stands in for the console so a tablet app
// (WING-Q, Co-Pilot, WING Edit) can be pointed at it, relays everything 1:1 to the real console, and
// records what the app actually does — the facts the multiplexed bridge is designed on (see the
// "capture spike" in docs/wing-protocol/03-native-binary-protocol.md).
//
//   npm run wing:capture -- --console 192.168.20.27 [--osc] [--name WING-CAPTURE]
//                            [--serial-mode derived|real] [--advertise-ip <ip>] [--out ./captures]
//                            [--allow-writes]
//   npm run wing:capture -- --console <ip> --verify-hash captures/<run>/nodes.json [--count 40]
//
// Safe on a console in use: the tablet's writes (values, clicks, steps on the control channel; OSC
// sets) are DROPPED unless --allow-writes is given, so the app can read and display everything but
// change nothing. Subscriptions on OSC are never forwarded either: the console takes only one OSC
// subscriber, and that one belongs to the running server. --verify-hash only sends OSC GETs.
//
// Needs the LAN, so run it from a real terminal (the Claude Code Bash sandbox cannot reach it), and
// on a host where nothing else holds UDP 2222/2223 or TCP 2222 (not next to fake-wing).

import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import osc from "osc";
import type { OscArgument } from "osc";
import { WebSocket, WebSocketServer } from "ws";
import { deriveSerial, formatDiscoveryReply, isDiscoveryQuery, pickAdvertiseAddress, plainIpv4 } from "../src/plugins/wing/wing-bridge-discovery.js";
import { discoverWingConsoles, type WingDiscoveryResult } from "../src/plugins/wing/wing-discovery.js";
import {
  describeNativeToken,
  isNavToken,
  isValueToken,
  isWriteToken,
  NativeTokenizer,
  type NativeNodeDef,
  type NativeToken,
} from "../src/plugins/wing/wing-native-codec.js";
import {
  encodeChannelSelect,
  encodeReportId,
  encodeUdpPortAnnouncement,
  escapeBytes,
  METER_GROUP_TABLE,
  MeterRequestParser,
  WingChannelDemuxer,
  type FlattenedGroup,
} from "../src/plugins/wing/wing-meter-protocol.js";

const CONTROL = 1;
const METERS = 3;
const ECHO_WINDOW_MS = 500;
const STARTUP_LULL_MS = 2000;
const SAMPLE_LIMIT = 20;

const { values: args } = parseArgs({
  options: {
    console: { type: "string" },
    name: { type: "string", default: "WING-CAPTURE" },
    "serial-mode": { type: "string", default: "derived" },
    "advertise-ip": { type: "string" },
    out: { type: "string", default: "./captures" },
    "allow-writes": { type: "boolean", default: false },
    osc: { type: "boolean", default: false },
    "verify-hash": { type: "string" },
    count: { type: "string", default: "40" },
    // Ports: what tablets reach (listen) and what the console answers on. Only change them to run
    // the relay on the same machine as fake-wing, e.g. --listen-native 3222 --listen-osc 3223.
    "listen-native": { type: "string", default: "2222" },
    "listen-osc": { type: "string", default: "2223" },
    "console-native": { type: "string", default: "2222" },
    "console-osc": { type: "string", default: "2223" },
  },
});

const LISTEN_NATIVE = Number(args["listen-native"]);
const LISTEN_OSC = Number(args["listen-osc"]);
const NATIVE_PORT = Number(args["console-native"]);
const OSC_PORT = Number(args["console-osc"]);

const consoleHost = args.console;
if (!consoleHost) {
  console.error("Missing --console <ip of the real WING>.");
  process.exit(2);
}
const allowWrites = args["allow-writes"] === true;

const localAddresses = new Set(
  Object.values(os.networkInterfaces())
    .flatMap((infos) => infos ?? [])
    .map((info) => info.address),
);
const consoleIsLocal = localAddresses.has(consoleHost) || consoleHost === "localhost";
if (consoleIsLocal && LISTEN_NATIVE === NATIVE_PORT) {
  console.error(`--console ${consoleHost} is this machine: the relay would answer itself. Point it at the real console.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Shared recording state
// ---------------------------------------------------------------------------------------------

const startedAt = Date.now();
const now = () => Date.now() - startedAt;
const hex = (bytes: Buffer | number[]) => Buffer.from(bytes).toString("hex");

interface MeterStats {
  conn: number;
  reportId: number;
  packets: number;
  sizes: Record<number, number>;
  firstPacketHex: string;
  consoleSourcePorts: number[];
  firstAt: number;
  lastAt: number;
}

interface ConnStats {
  id: number;
  client: string;
  openedAt: number;
  closedAt: number | null;
  firstBytes: { c2s: string; s2c: string };
  channels: { c2s: Record<number, number>; s2c: Record<number, number> };
  navTokens: Record<string, number>;
  dataRequests: number;
  defRequests: number;
  defRecords: number;
  requestEnds: number;
  maxOutstanding: number;
  requestTimes: number[];
  writes: { forwarded: number; blocked: number };
  echoes: number;
  unsolicitedValues: number;
  selects: { c2s: Record<number, number[]>; s2c: Record<number, number[]> };
  reportIdTimes: number[];
  meterCollections: { groups: string; expectedWords: number; unknownTokens: number[] }[];
  meterUdpPort: number | null;
  strays: { c2s: number[]; s2c: number[] };
  unknownTokens: { dir: string; byte: number; at: number }[];
  transport: "tcp" | "websocket";
  websocket: {
    path: string;
    request: Record<string, unknown>;
    response: { status: number; headers: Record<string, unknown> } | null;
    textMessages: { c2s: number; s2c: number };
  } | null;
}

const connections: ConnStats[] = [];
const discoveryQueries: { at: number; from: string; replied: string }[] = [];
const meterStats = new Map<string, MeterStats>();
const nodes = new Map<number, NativeNodeDef>();
const defErrors: string[] = [];
const replyShapes: string[] = [];
const unsolicitedSamples: string[] = [];
const valueTypesByNodeType: Record<string, number> = {};
const oscStats = { peers: new Set<string>(), forwarded: 0, blockedWrites: 0, subscribeAttempts: [] as string[], addresses: {} as Record<string, number> };

fs.mkdirSync(args.out ?? "./captures", { recursive: true });
const runDir = path.join(args.out ?? "./captures", new Date(startedAt).toISOString().replace(/[:.]/g, "-"));
const eventsPath = path.join(runDir, "events.jsonl");
let events: fs.WriteStream | null = null;

function record(event: Record<string, unknown>): void {
  events?.write(JSON.stringify({ t: now(), ...event }) + "\n");
}

const bump = (map: Record<string | number, number>, key: string | number, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

// ---------------------------------------------------------------------------------------------
// --verify-hash: are native ids the OSC /#<hex> hashes, and do def names spell the OSC path? (A7)
// ---------------------------------------------------------------------------------------------

async function oscGet(socket: dgram.Socket, address: string): Promise<unknown[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(null);
    }, 600);
    const onMessage = (msg: Buffer) => {
      try {
        const reply = osc.readMessage(msg, { metadata: true });
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve((reply.args as OscArgument[]).map((arg) => arg.value));
      } catch {
        // not OSC — keep waiting
      }
    };
    socket.on("message", onMessage);
    socket.send(osc.writeMessage({ address, args: [] }), OSC_PORT, consoleHost);
  });
}

async function verifyHashes(nodesFile: string, count: number): Promise<void> {
  const saved = JSON.parse(fs.readFileSync(nodesFile, "utf8")) as { id: number; path: string; type: string }[];
  const leaves = saved.filter((node) => node.type !== "node" && !node.path.startsWith("?")).slice(0, count);
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, resolve));
  let same = 0;
  for (const leaf of leaves) {
    const byPath = await oscGet(socket, leaf.path);
    const byHash = await oscGet(socket, `/#${leaf.id.toString(16).padStart(8, "0")}`);
    const match = byPath !== null && JSON.stringify(byPath) === JSON.stringify(byHash);
    if (match) same += 1;
    console.log(`${match ? "same" : "DIFF"}  ${leaf.path}  path=${JSON.stringify(byPath)}  hash=${JSON.stringify(byHash)}`);
  }
  console.log(`\n${same}/${leaves.length} leaves read the same by OSC path and by /#<native id>.`);
  socket.close();
}

if (args["verify-hash"]) {
  await verifyHashes(args["verify-hash"], Number(args.count));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Discovery responder (UDP 2222)
// ---------------------------------------------------------------------------------------------

const found = await discoverWingConsoles({ broadcastAddress: consoleHost, port: NATIVE_PORT, timeoutMs: 1500 });
const consoleIdentity: WingDiscoveryResult = found.find((c) => c.ip === consoleHost) ??
  found[0] ?? { ip: consoleHost, name: "WING", model: "ngc-full", serial: "", firmware: "" };
if (found.length === 0) {
  console.warn(`The console at ${consoleHost} did not answer WING? — advertising placeholder model/firmware.`);
}
const serialMode = args["serial-mode"] === "real" ? "real" : "derived";
const advertisedSerial = serialMode === "real" ? consoleIdentity.serial : deriveSerial(consoleIdentity.serial, "CAP");

fs.mkdirSync(runDir, { recursive: true });
events = fs.createWriteStream(eventsPath);
record({ kind: "start", console: consoleIdentity, allowWrites, serialMode, osc: args.osc === true });

const discovery = dgram.createSocket({ type: "udp4", reuseAddr: false });
discovery.on("message", (msg, rinfo) => {
  if (rinfo.address === consoleHost && !consoleIsLocal) return; // the console never queries us
  if (!isDiscoveryQuery(msg)) {
    record({ kind: "discovery-other", from: `${rinfo.address}:${rinfo.port}`, hex: hex(msg) });
    return;
  }
  const ip = args["advertise-ip"] ?? pickAdvertiseAddress(rinfo.address, os.networkInterfaces()) ?? "0.0.0.0";
  const reply = formatDiscoveryReply({ ...consoleIdentity, ip, name: args.name ?? "WING-CAPTURE", serial: advertisedSerial });
  discovery.send(reply, rinfo.port, rinfo.address);
  discoveryQueries.push({ at: now(), from: `${rinfo.address}:${rinfo.port}`, replied: reply });
  record({ kind: "discovery", from: `${rinfo.address}:${rinfo.port}`, reply });
});

// ---------------------------------------------------------------------------------------------
// Native relay (TCP 2222). The console serves two transports on that port: the raw native stream
// (WING Edit) and a WebSocket carrying it (WING-Q, a WebView app — found with this tool). The first
// bytes tell them apart: a WebSocket opens with an HTTP "GET". Either way ch1 is tokenized with
// writes dropped by default, and ch3 re-encoded (on raw TCP, with our UDP port so meters pass here).
// ---------------------------------------------------------------------------------------------

/**
 * Re-frames logical bytes onto the tablet->console direction, keeping channel selects explicit.
 * Buffers until flush(), so one incoming chunk (or WebSocket message) goes out as one.
 */
class ChannelWriter {
  private channel = -1;
  private parts: Buffer[] = [];
  constructor(private readonly sink: (bytes: Buffer) => void) {}
  select(chId: number): void {
    this.channel = chId;
    this.parts.push(encodeChannelSelect(chId));
  }
  write(chId: number, data: Buffer | number[]): void {
    if (data.length === 0) return;
    if (chId !== this.channel) {
      this.parts.push(encodeChannelSelect(chId));
      this.channel = chId;
    }
    this.parts.push(escapeBytes(data));
  }
  flush(): void {
    if (this.parts.length === 0) return;
    this.sink(Buffer.concat(this.parts));
    this.parts = [];
  }
}

let nextConnId = 1;

function expectedWords(groups: FlattenedGroup[]): number {
  return groups.reduce((sum, group) => sum + METER_GROUP_TABLE[group.type].wordCount, 0);
}

function describeGroups(groups: FlattenedGroup[]): string {
  const byType = new Map<string, number[]>();
  for (const group of groups) {
    const list = byType.get(group.type) ?? [];
    if (group.index !== undefined) list.push(group.index);
    byType.set(group.type, list);
  }
  return [...byType].map(([type, indices]) => (indices.length ? `${type}[${indices.join(",")}]` : type)).join(" ");
}

interface SessionTransport {
  kind: "tcp" | "websocket";
  peerIp: string;
  peerPort: number;
  /** Native-stream bytes for the console (already framed: selects + escapes). */
  toConsole(bytes: Buffer): void;
  /** Tears both sides down. */
  destroy(): void;
}

interface Session {
  stats: ConnStats;
  /** Native-stream bytes the tablet sent (a TCP chunk or a WebSocket message). */
  fromTablet(chunk: Buffer): void;
  /** Native-stream bytes the console sent; the transport has already passed them on unchanged. */
  fromConsole(chunk: Buffer): void;
  close(reason: string): void;
}

function openSession(transport: SessionTransport): Session {
  const id = nextConnId++;
  const stats: ConnStats = {
    id,
    transport: transport.kind,
    client: `${transport.peerIp}:${transport.peerPort}`,
    openedAt: now(),
    closedAt: null,
    firstBytes: { c2s: "", s2c: "" },
    channels: { c2s: {}, s2c: {} },
    navTokens: {},
    dataRequests: 0,
    defRequests: 0,
    defRecords: 0,
    requestEnds: 0,
    maxOutstanding: 0,
    requestTimes: [],
    writes: { forwarded: 0, blocked: 0 },
    echoes: 0,
    unsolicitedValues: 0,
    selects: { c2s: {}, s2c: {} },
    reportIdTimes: [],
    meterCollections: [],
    meterUdpPort: null,
    strays: { c2s: [], s2c: [] },
    unknownTokens: [],
    websocket: null,
  };
  connections.push(stats);
  record({ kind: "connect", conn: id, client: stats.client, transport: transport.kind });
  console.log(`[conn ${id}] ${stats.client} connected (${transport.kind})`);

  const toConsole = new ChannelWriter((bytes) => transport.toConsole(bytes));

  // Meter UDP from the console comes back here (our port replaces the tablet's in its 0xd3), and is
  // passed on from UDP 2222, the port the console itself sends from. WING-Q announces a UDP port too,
  // over its WebSocket (seen in a capture): the console sends meters to the connection's address.
  const meterSocket = dgram.createSocket("udp4");
  meterSocket.bind(0);
  meterSocket.on("message", (packet, rinfo) => {
    if (packet.length < 4) return;
    const reportId = packet.readUInt32BE(0);
    const key = `${id}:${reportId}`;
    const entry = meterStats.get(key) ?? {
      conn: id,
      reportId,
      packets: 0,
      sizes: {},
      firstPacketHex: hex(packet),
      consoleSourcePorts: [],
      firstAt: now(),
      lastAt: now(),
    };
    entry.packets += 1;
    entry.lastAt = now();
    bump(entry.sizes, packet.length);
    if (!entry.consoleSourcePorts.includes(rinfo.port)) entry.consoleSourcePorts.push(rinfo.port);
    meterStats.set(key, entry);
    if (stats.meterUdpPort !== null) discovery.send(packet, stats.meterUdpPort, transport.peerIp);
  });

  let outstanding = 0;
  let clientNode: number | null = null;
  let consoleNode: number | null = null;
  let shape: string[] = [];
  const recentWrites: { node: number | null; at: number }[] = [];

  const close = (reason: string) => {
    if (stats.closedAt !== null) return;
    stats.closedAt = now();
    record({ kind: "close", conn: id, reason });
    console.log(`[conn ${id}] closed (${reason})`);
    transport.destroy();
    meterSocket.close();
  };

  // --- tablet -> console ---
  const c2sDemux = new WingChannelDemuxer();
  const c2sTokens = new NativeTokenizer();
  const c2sMeters = new MeterRequestParser((event) => {
    switch (event.kind) {
      case "udpPort":
        stats.meterUdpPort = event.port;
        record({ kind: "meter-port", conn: id, port: event.port });
        toConsole.write(METERS, encodeUdpPortAnnouncement((meterSocket.address() as net.AddressInfo).port));
        break;
      case "reportId":
        stats.reportIdTimes.push(now());
        toConsole.write(METERS, encodeReportId(event.id));
        break;
      case "collection":
        stats.meterCollections.push({ groups: describeGroups(event.groups), expectedWords: expectedWords(event.groups), unknownTokens: event.unknownTokens });
        record({ kind: "meter-collection", conn: id, groups: describeGroups(event.groups), raw: hex(event.raw) });
        toConsole.write(METERS, event.raw);
        break;
      case "stray":
        stats.strays.c2s.push(event.byte);
        toConsole.write(METERS, [event.byte]);
        break;
    }
  });

  const onClientToken = (token: NativeToken) => {
    record({ dir: "c2s", conn: id, ch: CONTROL, tok: describeNativeToken(token) });
    if (isNavToken(token)) {
      bump(stats.navTokens, token.kind);
      clientNode = token.kind === "navId" ? token.id : null;
    }
    if (token.kind === "unknown") {
      stats.unknownTokens.push({ dir: "c2s", byte: token.byte, at: now() });
      if (!allowWrites) {
        // Lost sync: the next bytes could be a write we fail to recognise. Never let one through.
        close("unknown token from the tablet while writes are blocked");
        return;
      }
    }
    if (token.kind === "reqData" || token.kind === "reqDef") {
      if (token.kind === "reqData") stats.dataRequests += 1;
      else stats.defRequests += 1;
      stats.requestTimes.push(now());
      outstanding += 1;
      stats.maxOutstanding = Math.max(stats.maxOutstanding, outstanding);
    }
    if (isWriteToken(token)) {
      if (!allowWrites) {
        stats.writes.blocked += 1;
        record({ kind: "blocked-write", conn: id, node: clientNode, tok: describeNativeToken(token) });
        return;
      }
      stats.writes.forwarded += 1;
      recentWrites.push({ node: clientNode, at: now() });
    }
    toConsole.write(CONTROL, token.bytes);
  };

  // --- console -> tablet (forwarded untouched by the transport, decoded here for the record) ---
  const s2cDemux = new WingChannelDemuxer();
  const s2cTokens = new NativeTokenizer();
  const onConsoleToken = (token: NativeToken) => {
    record({ dir: "s2c", conn: id, ch: CONTROL, tok: describeNativeToken(token) });
    shape.push(token.kind);
    if (token.kind === "navId") consoleNode = token.id;
    if (token.kind === "unknown") stats.unknownTokens.push({ dir: "s2c", byte: token.byte, at: now() });
    if (token.kind === "def") {
      stats.defRecords += 1;
      if (token.def) nodes.set(token.def.id, token.def);
      else defErrors.push(`${token.error ?? "?"}: ${hex(token.bytes.subarray(0, 48))}`);
    }
    if (isValueToken(token)) {
      const nodeType = consoleNode !== null ? (nodes.get(consoleNode)?.type ?? "unseen") : "no-id";
      bump(valueTypesByNodeType, `${nodeType}:${token.kind}`);
      if (outstanding === 0) {
        stats.unsolicitedValues += 1;
        if (unsolicitedSamples.length < SAMPLE_LIMIT) unsolicitedSamples.push(`conn ${id} node ${consoleNode?.toString(16) ?? "?"} ${describeNativeToken(token)}`);
      }
      const cutoff = now() - ECHO_WINDOW_MS;
      if (recentWrites.some((w) => w.node === consoleNode && w.at >= cutoff)) stats.echoes += 1;
    }
    if (token.kind === "end") {
      stats.requestEnds += 1;
      outstanding = Math.max(0, outstanding - 1);
      // Shapes are kept short: a read on the root answers with the whole tree.
      if (replyShapes.length < SAMPLE_LIMIT) replyShapes.push(shape.length > 12 ? `${shape.slice(0, 8).join(" ")} … (${shape.length} tokens)` : shape.join(" "));
      shape = [];
    }
  };

  return {
    stats,
    close,
    fromTablet(chunk) {
      if (stats.firstBytes.c2s.length < 128) stats.firstBytes.c2s += hex(chunk.subarray(0, 64 - stats.firstBytes.c2s.length / 2));
      c2sDemux.feed(
        chunk,
        (ch, byte) => {
          if (stats.closedAt !== null) return;
          bump(stats.channels.c2s, ch);
          if (ch === CONTROL) c2sTokens.feedByte(byte, onClientToken);
          else if (ch === METERS) c2sMeters.feedByte(byte);
          else {
            record({ dir: "c2s", conn: id, ch, hex: hex([byte]) });
            toConsole.write(ch, [byte]);
          }
        },
        (ch) => {
          (stats.selects.c2s[ch] ??= []).push(now());
          toConsole.select(ch);
        },
      );
      if (stats.closedAt === null) toConsole.flush();
    },
    fromConsole(chunk) {
      if (stats.firstBytes.s2c.length < 128) stats.firstBytes.s2c += hex(chunk.subarray(0, 64 - stats.firstBytes.s2c.length / 2));
      s2cDemux.feed(
        chunk,
        (ch, byte) => {
          bump(stats.channels.s2c, ch);
          if (ch === CONTROL) s2cTokens.feedByte(byte, onConsoleToken);
          else if (ch !== METERS) record({ dir: "s2c", conn: id, ch, hex: hex([byte]) });
        },
        (ch) => {
          (stats.selects.s2c[ch] ??= []).push(now());
        },
      );
    },
  };
}

/** Raw native stream (WING Edit, libwing): one TCP connection to the console per tablet connection. */
function relayTcp(client: net.Socket, firstChunk: Buffer): void {
  const upstream = net.connect(NATIVE_PORT, consoleHost);
  upstream.setNoDelay(true);
  client.setNoDelay(true);
  const session = openSession({
    kind: "tcp",
    peerIp: plainIpv4(client.remoteAddress ?? ""),
    peerPort: client.remotePort ?? 0,
    toConsole: (bytes) => upstream.write(bytes),
    destroy: () => {
      client.destroy();
      upstream.destroy();
    },
  });
  upstream.on("data", (chunk: Buffer) => {
    client.write(chunk);
    session.fromConsole(chunk);
  });
  client.on("data", (chunk: Buffer) => session.fromTablet(chunk));
  client.on("close", () => session.close("tablet closed"));
  upstream.on("close", () => session.close("console closed"));
  client.on("error", (err) => session.close(`tablet error: ${err.message}`));
  upstream.on("error", (err) => session.close(`console error: ${err.message}`));
  session.fromTablet(firstChunk);
}

/**
 * The same stream inside a WebSocket (WING-Q). The upgrade is replayed to the console with the
 * tablet's path, origin and user agent, minus compression (so frames can be read and rewritten).
 */
const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wsHttp = http.createServer((_req, res) => {
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("WebSocket only");
});
wsHttp.on("upgrade", (req, socket, head) => {
  wsServer.handleUpgrade(req, socket, head, (tablet) => {
    const peerIp = plainIpv4(req.socket.remoteAddress ?? "");
    const upstream = new WebSocket(`ws://${consoleHost}:${NATIVE_PORT}${req.url ?? "/"}`, {
      perMessageDeflate: false,
      origin: req.headers.origin,
      headers: req.headers["user-agent"] ? { "User-Agent": req.headers["user-agent"] } : undefined,
    });
    const pending: { data: Buffer; binary: boolean }[] = [];
    const session = openSession({
      kind: "websocket",
      peerIp,
      peerPort: req.socket.remotePort ?? 0,
      toConsole: (bytes) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary: true });
        else pending.push({ data: bytes, binary: true });
      },
      destroy: () => {
        tablet.terminate();
        upstream.terminate();
      },
    });
    session.stats.websocket = { path: req.url ?? "/", request: req.headers, response: null, textMessages: { c2s: 0, s2c: 0 } };
    record({ kind: "ws-request", conn: session.stats.id, url: req.url, headers: req.headers });
    upstream.on("upgrade", (res) => {
      if (session.stats.websocket) session.stats.websocket.response = { status: res.statusCode ?? 0, headers: res.headers };
      record({ kind: "ws-response", conn: session.stats.id, status: res.statusCode, headers: res.headers });
    });
    upstream.on("unexpected-response", (_req2, res) => {
      record({ kind: "ws-refused", conn: session.stats.id, status: res.statusCode, headers: res.headers });
      session.close(`console refused the WebSocket: HTTP ${res.statusCode}`);
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary });
    });
    tablet.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        // Not the native stream: passed on as is, and recorded in full.
        if (session.stats.websocket) session.stats.websocket.textMessages.c2s += 1;
        record({ dir: "ws-c2s-text", conn: session.stats.id, text: data.toString("utf8").slice(0, 2000) });
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: false });
        else pending.push({ data, binary: false });
        return;
      }
      session.fromTablet(data);
    });
    upstream.on("message", (data: Buffer, isBinary: boolean) => {
      tablet.send(data, { binary: isBinary });
      if (!isBinary) {
        if (session.stats.websocket) session.stats.websocket.textMessages.s2c += 1;
        record({ dir: "ws-s2c-text", conn: session.stats.id, text: data.toString("utf8").slice(0, 2000) });
        return;
      }
      session.fromConsole(data);
    });
    tablet.on("close", (code) => session.close(`tablet closed the WebSocket (${code})`));
    upstream.on("close", (code) => session.close(`console closed the WebSocket (${code})`));
    tablet.on("error", (err) => session.close(`tablet error: ${err.message}`));
    upstream.on("error", (err) => session.close(`console error: ${err.message}`));
  });
});

const nativeServer = net.createServer((client) => {
  client.once("data", (first: Buffer) => {
    if (first.subarray(0, 4).toString("latin1") === "GET ") {
      // Hand the connection, first bytes included, to the HTTP server that does the upgrade.
      client.pause();
      client.unshift(first);
      wsHttp.emit("connection", client);
      client.resume();
      return;
    }
    relayTcp(client, first);
  });
  client.on("error", () => undefined);
});

// ---------------------------------------------------------------------------------------------
// Optional OSC relay (UDP 2223): reads pass, writes blocked by default, subscriptions never forwarded
// ---------------------------------------------------------------------------------------------

const oscServer = args.osc ? dgram.createSocket("udp4") : null;
const oscPeers = new Map<string, dgram.Socket>();

function isOscRead(oscArgs: OscArgument[]): boolean {
  return oscArgs.length === 0 || (oscArgs.length === 1 && oscArgs[0].type === "s" && ["*", "?", "#"].includes(String(oscArgs[0].value)));
}

oscServer?.on("message", (msg, rinfo) => {
  const peer = `${rinfo.address}:${rinfo.port}`;
  oscStats.peers.add(peer);
  let address = "?";
  let oscArgs: OscArgument[] = [];
  try {
    const parsed = osc.readMessage(msg, { metadata: true });
    address = parsed.address;
    oscArgs = Array.isArray(parsed.args) ? (parsed.args as OscArgument[]) : [];
  } catch {
    record({ dir: "osc-c2s", peer, hex: hex(msg), note: "not a plain OSC message" });
  }
  const bare = address.replace(/^\/%\d+/, "");
  bump(oscStats.addresses, bare);
  record({ dir: "osc-c2s", peer, address, args: oscArgs.map((a) => `${a.type}:${String(a.value)}`) });
  if (bare === "/*s" || bare === "/*S" || bare === "/*b") {
    oscStats.subscribeAttempts.push(`${peer} ${address}`);
    return;
  }
  if (!allowWrites && !isOscRead(oscArgs)) {
    oscStats.blockedWrites += 1;
    return;
  }
  let upstream = oscPeers.get(peer);
  if (!upstream) {
    const socket = dgram.createSocket("udp4");
    socket.bind(0);
    socket.on("message", (reply, from) => {
      if (from.address !== consoleHost) return;
      record({ dir: "osc-s2c", peer, hex: hex(reply.subarray(0, 96)) });
      oscServer.send(reply, rinfo.port, rinfo.address);
    });
    oscPeers.set(peer, socket);
    upstream = socket;
  }
  oscStats.forwarded += 1;
  upstream.send(msg, OSC_PORT, consoleHost);
});

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

function nodePath(id: number): string {
  const segments: string[] = [];
  let current = nodes.get(id);
  for (let depth = 0; current && depth < 24; depth++) {
    segments.unshift(current.name);
    const parent = nodes.get(current.parent);
    if (!parent) {
      if (current.parent !== 0) segments.unshift("?");
      break;
    }
    current = parent;
  }
  return "/" + segments.join("/");
}

function intervals(times: number[]): { count: number; medianMs: number | null; maxMs: number | null } {
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  return { count: times.length, medianMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null, maxMs: gaps.length ? gaps[gaps.length - 1] : null };
}

function startupMs(conn: ConnStats): number | null {
  const times = conn.requestTimes;
  if (times.length === 0) return null;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > STARTUP_LULL_MS) return times[i - 1] - conn.openedAt;
  }
  return times[times.length - 1] - conn.openedAt;
}

function buildSummary() {
  return {
    durationMs: now(),
    console: consoleIdentity,
    advertised: { name: args.name, serial: advertisedSerial, serialMode },
    allowWrites,
    A1_transports: {
      tcpConnections: connections.length,
      udpDiscoveryQueries: discoveryQueries.length,
      oscPeers: [...oscStats.peers],
      note: "A tablet that never shows up here may use another port or WebSocket — check with tcpdump.",
    },
    A2_discovery: { queries: discoveryQueries.slice(0, SAMPLE_LIMIT), cadence: intervals(discoveryQueries.map((q) => q.at)) },
    connections: connections.map((c) => ({
      id: c.id,
      client: c.client,
      transport: c.transport,
      websocket: c.websocket,
      openedAt: c.openedAt,
      durationMs: (c.closedAt ?? now()) - c.openedAt,
      handshake: c.firstBytes,
      channels: c.channels,
      A9_navTokens: c.navTokens,
      A5_A12_requests: {
        data: c.dataRequests,
        definitions: c.defRequests,
        defRecordsReceived: c.defRecords,
        ends: c.requestEnds,
        maxOutstanding: c.maxOutstanding,
        startupMs: startupMs(c),
      },
      A4_unsolicitedValues: c.unsolicitedValues,
      A6_echo: { writesForwarded: c.writes.forwarded, writesBlocked: c.writes.blocked, echoesWithin500ms: c.echoes },
      A10_keepalive: {
        c2sSelects: Object.fromEntries(Object.entries(c.selects.c2s).map(([ch, times]) => [ch, intervals(times)])),
        reportIds: intervals(c.reportIdTimes),
      },
      A11_meters: { udpPort: c.meterUdpPort, collections: c.meterCollections, strayBytes: c.strays.c2s },
      unknownTokens: c.unknownTokens.slice(0, SAMPLE_LIMIT),
    })),
    A5_replyShapes: replyShapes,
    A4_unsolicitedSamples: unsolicitedSamples,
    A3_valueTypesByNodeType: valueTypesByNodeType,
    A3_defParseErrors: defErrors.slice(0, SAMPLE_LIMIT),
    A11_meterPackets: [...meterStats.values()],
    nodesLearned: nodes.size,
    osc: { ...oscStats, peers: [...oscStats.peers] },
  };
}

let finishing = false;
function finish(): void {
  if (finishing) return;
  finishing = true;
  const summary = buildSummary();
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(runDir, "nodes.json"),
    JSON.stringify(
      [...nodes.values()].map((def) => ({ id: def.id, parent: def.parent, path: nodePath(def.id), index: def.index, type: def.type, readOnly: def.readOnly })),
      null,
      1,
    ),
  );
  for (const conn of summary.connections) {
    console.log(
      `[conn ${conn.id}] ${conn.client} ${Math.round(conn.durationMs / 1000)}s · nav ${JSON.stringify(conn.A9_navTokens)} · ` +
        `req data ${conn.A5_A12_requests.data} def ${conn.A5_A12_requests.definitions} (max in flight ${conn.A5_A12_requests.maxOutstanding}, startup ${conn.A5_A12_requests.startupMs} ms) · ` +
        `unsolicited ${conn.A4_unsolicitedValues} · writes blocked ${conn.A6_echo.writesBlocked} forwarded ${conn.A6_echo.writesForwarded} echoed ${conn.A6_echo.echoesWithin500ms}`,
    );
  }
  console.log(`Discovery queries: ${discoveryQueries.length}. Nodes learned: ${nodes.size}. Def parse errors: ${defErrors.length}.`);
  console.log(`Saved to ${runDir}`);
  events?.end(() => process.exit(0));
}

process.on("SIGINT", finish);
process.on("SIGTERM", finish);

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

await new Promise<void>((resolve, reject) => {
  discovery.once("error", reject);
  discovery.bind(LISTEN_NATIVE, "0.0.0.0", () => {
    discovery.setBroadcast(true);
    resolve();
  });
});
await new Promise<void>((resolve, reject) => {
  nativeServer.once("error", reject);
  nativeServer.listen(LISTEN_NATIVE, "0.0.0.0", resolve);
});
if (oscServer) {
  await new Promise<void>((resolve, reject) => {
    oscServer.once("error", reject);
    oscServer.bind(LISTEN_OSC, "0.0.0.0", resolve);
  });
}

console.log(`Relaying to ${consoleIdentity.name} (${consoleIdentity.model}, fw ${consoleIdentity.firmware}) at ${consoleHost}.`);
console.log(`Answering WING? as "${args.name}" serial ${advertisedSerial}. Native tcp/${LISTEN_NATIVE}${oscServer ? `, OSC udp/${LISTEN_OSC}` : ""}.`);
console.log(allowWrites ? "WRITES ARE FORWARDED (--allow-writes): only touch the parameter agreed for the echo test." : "Writes from the tablet are dropped. Reads and meters pass.");
console.log(`Recording to ${runDir}. Ctrl+C to stop and write the summary.`);
