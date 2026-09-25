// A real (loopback UDP) in-memory stand-in for a WING console's OSC control
// plane, used only by wing-osc-client.test.ts. Speaks enough of the protocol
// documented in docs/wing-protocol/02-osc-protocol.md to exercise every
// WingOscClient method: bare-address GET (leaf + branch), the compact
// bulk-set-with-acknowledgement form, dump ("*"), describe ("?"/"#"), and
// the "/*S"/"/*s" subscribe forms (including their 10s-style inactivity
// timeout, made configurably short here so tests don't have to wait 10s).
// Also answers the raw (non-OSC-framed) "WING?" discovery datagram.
//
// Uses the real "osc" package (default import — see osc.d.ts for why) for
// OSC framing, and a plain dgram socket for the non-OSC discovery datagram.

import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import osc from "osc";
import type { OscArgument, OscMessage, OscRemoteInfo, UDPPort } from "osc";

export interface WingMockServerOptions {
  /** OSC control port to bind. Default: 0 (OS-assigned ephemeral port). */
  port?: number;
  /** Discovery ("WING?") port to bind. Default: 0 (OS-assigned ephemeral port). */
  discoveryPort?: number;
  /**
   * How long a subscription may go without a renewal before it's dropped.
   * The real console uses ~10s; tests should pass something much shorter
   * (e.g. 300ms) so a renewal-keeps-it-alive assertion doesn't take forever.
   */
  subscriptionInactivityTimeoutMs?: number;
}

type LeafKind = "f" | "i" | "s";

interface LeafEntry {
  kind: LeafKind;
  value: number | string;
}

interface BranchEntry {
  kind: "branch";
  children: string[];
}

type NodeEntry = LeafEntry | BranchEntry;

type SubscriptionMode = "/*S" | "/*s" | "/*b";

interface Subscriber {
  address: string;
  port: number;
  mode: SubscriptionMode;
  timer: NodeJS.Timeout;
}

const DISCOVERY_QUERY = "WING?";
const DISCOVERY_REPLY = "WING,127.0.0.1,MockWing,ngc-full,MOCK-SN-0001,3.1.0";
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10_000;

/** Mirrors osc.js's `unpackSingleArgs` behavior: a single arg arrives unwrapped, not as a 1-element array. */
/** Splits a bulk-set payload on commas outside single quotes (a quoted value may contain one). */
function splitQuotedAssignments(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] as string;
    if (inQuotes && char === "\\") {
      current += char + (raw[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === "'") inQuotes = !inQuotes;
    if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function normalizeArgs(raw: OscMessage["args"]): OscArgument[] {
  if (Array.isArray(raw)) {
    return raw as OscArgument[];
  }
  if (raw === undefined || raw === null) {
    return [];
  }
  return [raw as OscArgument];
}

/**
 * "/ch/1/mute" -> "/ch/1/$mute" — the read-only "shadow" address subscription pushes are delivered
 * on. A path whose last segment already starts with "$" (a permanent-$-only node like
 * "/$ctl/lib/$actidx" — see PERMANENT_SHADOW_ONLY_ADDRESSES in wing-osc-client.ts) has no separate
 * shadow variant to mirror onto — it's returned unchanged instead of doubling the "$" into the
 * nonsensical "/$ctl/lib/$$actidx", which nothing on real hardware (or this mock) actually pushes.
 */
function toShadowAddress(path: string): string {
  const idx = path.lastIndexOf("/");
  const lastSegment = idx < 0 ? path : path.slice(idx + 1);
  if (lastSegment.startsWith("$")) {
    return path;
  }
  if (idx < 0) {
    return `$${path}`;
  }
  return `${path.slice(0, idx)}/$${path.slice(idx + 1)}`;
}

export class WingMockServer {
  private readonly opts: WingMockServerOptions;
  private readonly inactivityTimeoutMs: number;
  private readonly nodes = new Map<string, NodeEntry>();
  private readonly subscribers = new Map<string, Subscriber>();
  /** Applied to every string a bulk-set stores — lets a test make the "console" store something else. */
  stringTransform: (value: string) => string = (value) => value;

  private oscPort: UDPPort | null = null;
  private discoverySocket: dgram.Socket | null = null;
  private boundOscPort = 0;
  private boundDiscoveryPort = 0;

  constructor(opts: WingMockServerOptions = {}) {
    this.opts = opts;
    this.inactivityTimeoutMs = opts.subscriptionInactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.seedDefaults();
  }

  async start(): Promise<{ oscPort: number; discoveryPort: number }> {
    await Promise.all([this.startOscPort(), this.startDiscoverySocket()]);
    return { oscPort: this.boundOscPort, discoveryPort: this.boundDiscoveryPort };
  }

  async stop(): Promise<void> {
    for (const sub of this.subscribers.values()) {
      clearTimeout(sub.timer);
    }
    this.subscribers.clear();

    const port = this.oscPort;
    this.oscPort = null;
    if (port) {
      port.close();
    }

    const socket = this.discoverySocket;
    this.discoverySocket = null;
    if (socket) {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  }

  setParam(path: string, value: number | string): void {
    this.applyAndBroadcast(path, value);
  }

  getParam(path: string): number | string | undefined {
    const node = this.nodes.get(path);
    return node && node.kind !== "branch" ? node.value : undefined;
  }

  // --- seed data -----------------------------------------------------------

  private seedDefaults(): void {
    this.setLeaf("/ch/1/name", "s", "Kick");
    this.setLeaf("/ch/1/mute", "i", 0);
    this.setLeaf("/ch/1/fdr", "f", -6);
    this.setLeaf("/ch/1/pan", "f", 0);

    this.setLeaf("/ch/2/name", "s", "Snare");
    this.setLeaf("/ch/2/mute", "i", 1);
    this.setLeaf("/ch/2/fdr", "f", -144); // "-oo"
    this.setLeaf("/ch/2/pan", "f", -20);

    this.setLeaf("/ch/3/name", "s", "Bass");
    this.setLeaf("/ch/3/mute", "i", 0);
    this.setLeaf("/ch/3/fdr", "f", 0);
    this.setLeaf("/ch/3/pan", "f", 10);

    this.setLeaf("/bus/1/name", "s", "Drums");
    this.setLeaf("/bus/1/mute", "i", 0);
    this.setLeaf("/bus/1/fdr", "f", -3);

    this.setLeaf("/dca/1/name", "s", "Band");
    this.setLeaf("/dca/1/mute", "i", 0);
    this.setLeaf("/dca/1/fdr", "f", 0);

    this.setLeaf("/mgrp/1/name", "s", "All Mics");
    this.setLeaf("/mgrp/1/mute", "i", 0);

    this.setLeaf("/$ctl/lib/$scenes", "s", "Scene 1");
    this.setLeaf("/$ctl/lib/$actidx", "i", 0);
    this.setLeaf("/$ctl/lib/$active", "s", "Scene 1");

    this.nodes.set("/", { kind: "branch", children: ["ch", "bus", "main", "mtx", "dca", "mgrp", "$ctl"] });
    this.nodes.set("/ch/1", { kind: "branch", children: ["name", "mute", "fdr", "pan"] });
  }

  private setLeaf(path: string, kind: LeafKind, value: number | string): void {
    this.nodes.set(path, { kind, value });
  }

  // --- transport setup -------------------------------------------------------

  private startOscPort(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new osc.UDPPort({
        localAddress: "127.0.0.1",
        localPort: this.opts.port ?? 0,
        metadata: true,
      });
      port.once("ready", () => {
        this.oscPort = port;
        this.boundOscPort = port.socket?.address().port ?? 0;
        port.on("message", this.handleOscMessage);
        port.on("error", (err: Error) => {
          console.error("[wing-mock-server] OSC socket error:", err);
        });
        resolve();
      });
      port.once("error", reject);
      port.open();
    });
  }

  private startDiscoverySocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      let settled = false;

      socket.on("error", (err) => {
        console.error("[wing-mock-server] discovery socket error:", err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      socket.on("message", (msg, rinfo) => {
        if (msg.toString("ascii") === DISCOVERY_QUERY) {
          socket.send(Buffer.from(DISCOVERY_REPLY, "ascii"), rinfo.port, rinfo.address, (err) => {
            if (err) {
              console.error("[wing-mock-server] failed to send discovery reply:", err);
            }
          });
        }
      });

      socket.bind(this.opts.discoveryPort ?? 0, "127.0.0.1", () => {
        settled = true;
        this.discoverySocket = socket;
        this.boundDiscoveryPort = (socket.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  // --- OSC message dispatch ---------------------------------------------

  private handleOscMessage = (message: OscMessage, _timeTag: unknown, info: OscRemoteInfo): void => {
    const address = message.address;
    const args = normalizeArgs(message.args);

    if (address === "/*S" || address === "/*s" || address === "/*b") {
      this.handleSubscribe(address, info);
      return;
    }

    if (args.length === 0) {
      this.handleGet(address, info);
      return;
    }

    if (args.length === 1 && args[0].type === "s") {
      const value = String(args[0].value);
      if (value === "*") {
        this.handleDump(address, info);
        return;
      }
      if (value === "?" || value === "#") {
        this.handleDescribe(address, value, info);
        return;
      }
      this.handleBulkSet(address, value, info);
      return;
    }

    // A plain SET (",f"/",i"/",s" directly on a leaf) or any other shape
    // this mock doesn't need to model — fire-and-forget, no reply expected.
  };

  /**
   * "/ch/1/$name" -> "/ch/1/name" — the plain leaf a shadow address mirrors when nothing has ever
   * given the shadow its own distinct value. Mirrors `toShadowAddress()`'s naming convention in
   * reverse.
   */
  private static plainAddressOf(address: string): string | null {
    const idx = address.lastIndexOf("/$");
    return idx < 0 ? null : `${address.slice(0, idx + 1)}${address.slice(idx + 2)}`;
  }

  private handleGet(address: string, info: OscRemoteInfo): void {
    let node = this.nodes.get(address);
    if (!node) {
      // Real hardware answers a GET on a "$"-shadow leaf directly (e.g. "/ch/1/$name"), mirroring
      // the plain leaf's value unless something has explicitly diverged it (this mock never models
      // that divergence — only the DCA/mutegroup-adjusted-fader and source-linked-name subscription
      // behaviors it's actually asked to exercise, which go through `applyAndBroadcast`/tests
      // setting the shadow node directly instead). An address with no node at all — shadow or
      // plain — still gets no response, matching real console behavior for an invalid address.
      const plainAddress = WingMockServer.plainAddressOf(address);
      const plainNode = plainAddress ? this.nodes.get(plainAddress) : undefined;
      if (!plainNode || plainNode.kind === "branch") {
        return;
      }
      node = plainNode;
    }
    if (node.kind === "branch") {
      this.reply(address, node.children.map((child) => ({ type: "s", value: child })), info);
      return;
    }
    this.reply(address, this.leafTripletArgs(node), info);
  }

  private handleDump(baseAddress: string, info: OscRemoteInfo): void {
    const prefix = baseAddress.endsWith("/") ? baseAddress : `${baseAddress}/`;
    const pairs: string[] = [];
    for (const [path, node] of this.nodes) {
      if (node.kind === "branch" || !path.startsWith(prefix)) {
        continue;
      }
      const relKey = path.slice(prefix.length).replace(/\//g, ".");
      pairs.push(`${relKey}=${node.value}`);
    }
    this.reply(baseAddress, [{ type: "s", value: pairs.join(",") }], info);
  }

  private handleDescribe(address: string, mode: "?" | "#", info: OscRemoteInfo): void {
    const node = this.nodes.get(address);
    const lines = [`path=${address}`, `type=${node?.kind ?? "unknown"}`];
    if (mode === "#" && node && node.kind !== "branch") {
      lines.push(`value=${node.value}`);
    }
    this.reply(address, [{ type: "s", value: `${lines.join("~")}~` }], info);
  }

  private handleBulkSet(baseAddress: string, raw: string, info: OscRemoteInfo): void {
    // Verified against real hardware: bulk-set is always acked on "/*", regardless of the
    // target node's depth (see the identical comment on WingOscClient.bulkSet).
    const ackAddress = "/*";
    const prefix = baseAddress === "/" ? "/" : `${baseAddress}/`;
    const assignments = splitQuotedAssignments(raw)
      .map((pair) => pair.trim())
      .filter((pair) => pair.length > 0);

    if (assignments.length === 0) {
      this.reply(ackAddress, [{ type: "s", value: "INCOMPLETE DATA" }], info);
      return;
    }

    const resolved: Array<{ path: string; kind: LeafKind; newValue: number | string }> = [];
    for (const assignment of assignments) {
      const eqIdx = assignment.indexOf("=");
      if (eqIdx < 0) {
        this.reply(ackAddress, [{ type: "s", value: "INCOMPLETE DATA" }], info);
        return;
      }
      const key = assignment.slice(0, eqIdx).trim();
      const rawValue = assignment.slice(eqIdx + 1).trim();
      const path = prefix + key.replace(/\./g, "/");
      const node = this.nodes.get(path);

      if (!node) {
        this.reply(ackAddress, [{ type: "s", value: "NODE NOT FOUND" }], info);
        return;
      }
      if (node.kind === "branch") {
        this.reply(ackAddress, [{ type: "s", value: "NODE IS NOT PAR" }], info);
        return;
      }

      let newValue: number | string;
      if (node.kind === "s") {
        // Like the real console: a quoted value is taken verbatim (with \-escapes), an unquoted one
        // loses every whitespace character.
        const quoted = rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'");
        newValue = quoted ? rawValue.slice(1, -1).replace(/\\(.)/g, "$1") : rawValue.replace(/\s+/g, "");
        newValue = this.stringTransform(newValue);
      } else {
        const num = Number(rawValue);
        if (!Number.isFinite(num)) {
          this.reply(ackAddress, [{ type: "s", value: "VALUE ERROR" }], info);
          return;
        }
        newValue = node.kind === "i" ? Math.round(num) : num;
      }
      resolved.push({ path, kind: node.kind, newValue });
    }

    for (const { path, newValue } of resolved) {
      this.applyAndBroadcast(path, newValue);
    }
    this.reply(ackAddress, [{ type: "s", value: "OK" }], info);
  }

  private handleSubscribe(mode: SubscriptionMode, info: OscRemoteInfo): void {
    const key = `${info.address}:${info.port}`;
    const existing = this.subscribers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.subscribers.delete(key);
    }, this.inactivityTimeoutMs);
    this.subscribers.set(key, { address: info.address, port: info.port, mode, timer });
  }

  // --- broadcasting changes to subscribers --------------------------------

  private applyAndBroadcast(path: string, value: number | string): void {
    const existing = this.nodes.get(path);
    const kind: LeafKind =
      existing && existing.kind !== "branch"
        ? existing.kind
        : typeof value === "string"
          ? "s"
          : Number.isInteger(value)
            ? "i"
            : "f";
    const node: LeafEntry = { kind, value };
    this.nodes.set(path, node);
    this.broadcastChange(path, node);
  }

  /**
   * Verified against real hardware (see canonicalizeShadowAddress's doc in wing-osc-client.ts): a
   * `/*S`/`/*s` subscription only ever pushes a change on the shadow ("$"-prefixed) address, never
   * on the plain one — even for a plain write with no DCA/mutegroup involved. Pushing on `path` too
   * used to mask a real class of bug: any regression in the client's own shadow-address
   * canonicalization would go unnoticed here, since the redundant plain-address push would still
   * land the change under its canonical key regardless of whether the shadow handling actually
   * worked.
   */
  private broadcastChange(path: string, node: LeafEntry): void {
    if (this.subscribers.size === 0) {
      return;
    }
    const shadowPath = toShadowAddress(path);
    for (const sub of this.subscribers.values()) {
      const target: OscRemoteInfo = { address: sub.address, port: sub.port };
      if (sub.mode === "/*S") {
        const compact: OscArgument[] = [{ type: node.kind, value: node.value }];
        this.reply(shadowPath, compact, target);
      } else if (sub.mode === "/*s") {
        const triplet = this.leafTripletArgs(node);
        this.reply(shadowPath, triplet, target);
      }
      // "/*b" (binary-encoded pushes) is documented as available but this
      // mock does not implement it — nothing in this project's client uses
      // that form (see wing-osc-client.ts's WingOscClientOptions).
    }
  }

  private leafTripletArgs(node: LeafEntry): OscArgument[] {
    if (node.kind === "f") {
      const numeric = node.value as number;
      const display = numeric <= -144 ? "-oo" : numeric.toFixed(1);
      return [
        { type: "s", value: display },
        { type: "f", value: 0.5 },
        { type: "f", value: numeric },
      ];
    }
    if (node.kind === "i") {
      return [
        { type: "s", value: String(node.value) },
        { type: "f", value: 0.5 },
        { type: "i", value: node.value },
      ];
    }
    return [{ type: "s", value: String(node.value) }];
  }

  private reply(address: string, args: OscArgument[], info: { address: string; port: number }): void {
    if (!this.oscPort) {
      return;
    }
    try {
      this.oscPort.send({ address, args }, info.address, info.port);
    } catch (err) {
      console.error("[wing-mock-server] failed to send reply:", err);
    }
  }
}
