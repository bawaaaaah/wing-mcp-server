// The native half of the tablet bridge: WING-Q / Co-Pilot / WING Edit connect here (the console's
// port 2222 protocol, raw over TCP or inside a WebSocket — WING-Q uses the latter) and all of them
// share ONE upstream connection to the console.
//
// How sharing one connection works (design and the assumptions behind it: docs/bridge.md):
// - Every tablet has its own navigation position. Each request or write it sends goes upstream as one
//   self-contained unit — the position replayed (`0xd7 id`, or its exact steps), then the action — so
//   tablets never inherit each other's position.
// - Requests are answered in order. Definition records and the closing 0xde go back to whoever asked;
//   values (`0xd7 id value`) go to every tablet: they are state, the same thing the console pushes to
//   every client when anything changes.
// - A tablet's accepted write is passed on to the other tablets at once (the console does not echo a
//   connection's own write to it, so on a shared connection nobody else would hear of it) and read
//   back shortly after so everyone converges on what the console actually stored.
// - With safes set, a write to a protected node never leaves the bridge; the node is read back
//   instead, which snaps the tablet's control back to the real value.

import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { encodeChannelSelect, escapeBytes, WingChannelDemuxer } from "./wing-meter-protocol.js";
import {
  CONTROL_CHANNEL_ID,
  encodeNodeId,
  frameControl,
  isNavToken,
  isValueToken,
  isWriteToken,
  NativeTokenizer,
  TOKEN_DATA_REQUEST,
  TOKEN_DEF_REQUEST,
  TOKEN_REQUEST_END,
  TOKEN_ROOT,
  type NativeNodeDef,
  type NativeToken,
} from "./wing-native-codec.js";
import { NativeNodeMap, NativePosition, nativeWriteVerdict, walkNodeMap } from "./wing-native-node-map.js";
import type { ClientPolicy } from "./wing-bridge-safes.js";
import { plainIpv4 } from "./wing-bridge-discovery.js";

const METER_CHANNEL_ID = 3;
const KEEPALIVE_MS = 5000;
const REQUEST_TIMEOUT_MS = 3000;
const MAX_CONSECUTIVE_TIMEOUTS = 3;
const IN_FLIGHT_WINDOW = 64;
const SESSION_IDLE_MS = 30_000;
const UPSTREAM_LINGER_MS = 30_000;
const READBACK_DELAY_MS = 250;
const SNAPBACK_DELAY_MS = 150;
const MAX_SESSIONS = 32;
/** How long a new connection may stay silent before it is taken as raw TCP rather than a WebSocket. */
const SNIFF_MS = 300;
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** A connected tablet as the policy sees it. */
export interface NativeClientInfo {
  address: string;
  port: number;
  /** WING-Q's WebView sends one (it names the device model); a raw TCP client none. */
  userAgent?: string;
}

/** What decides which writes are refused. Owned by the bridge; may change at any time. */
export interface NativeSafety {
  /** Anything restricted for anyone (global safes or device profiles): writes then wait for the map. */
  hasSafes(): boolean;
  /** This tablet's policy, or null while it is being identified (its writes are refused meanwhile). */
  policyFor(client: NativeClientInfo): ClientPolicy | null;
  /** Node patterns to map before writes are allowed: "/ch/5/**", "/ch/*\/send/3/**", ... */
  walkTargets(): string[];
}

/** Per-tablet meter handling (channel 3); the bridge's meter fan-out provides it. */
export interface NativeMeterSession {
  feedByte(byte: number): void;
  close(): void;
}

export interface NativeProxyOptions {
  consoleHost: () => string;
  consolePort: () => number;
  listenPort: number;
  bindAddress?: string;
  safety: NativeSafety;
  createMeterSession?: (peer: { address: string; port: number }) => NativeMeterSession;
  /** Test hooks. */
  timing?: Partial<{ keepaliveMs: number; requestTimeoutMs: number; readbackDelayMs: number; snapbackDelayMs: number; upstreamLingerMs: number; sessionIdleMs: number }>;
}

export interface NativeBlockedWrite {
  at: number;
  client: string;
  path: string | null;
  /** The node id written, when the position was resolved (useful when `path` is not known). */
  id: number | null;
  reason: string;
}

export interface NativeSessionStatus {
  id: number;
  address: string;
  transport: "tcp" | "websocket";
  userAgent: string | null;
  since: number;
  requests: number;
  writesForwarded: number;
  writesBlocked: number;
  metering: boolean;
}

export interface NativeProxyStatus {
  listening: boolean;
  listenPort: number;
  upstream: "connected" | "connecting" | "disconnected";
  sessions: NativeSessionStatus[];
  map: { state: "idle" | "walking" | "ready" | "error"; nodes: number; stale: boolean; lastError: string | null };
  lastError: string | null;
}

/**
 * Who a request's reply goes to. An internal requester's `onEnd` says whether the reply really ended
 * (`completed`: the console's 0xde arrived) or was cut short (timed out, connection dropped): a cut
 * listing is partial and must never be taken as a node's full child list.
 */
type Requester =
  | { kind: "session"; session: NativeSession }
  | { kind: "internal"; onDef: (def: NativeNodeDef) => void; onEnd: (completed: boolean) => void };

interface PendingRequest {
  action: "data" | "def";
  /** The node the request was made on, when known (for attributing a reply value, and marking a list complete). */
  targetId: number | null;
  /** True when made on the root (0xda): its definition records name the root id. */
  atRoot: boolean;
  requester: Requester;
  bytes: Buffer;
  timer: NodeJS.Timeout | null;
}

/** One shared connection to the console's control channel. */
class NativeUpstream extends EventEmitter {
  private socket: net.Socket | null = null;
  private readonly demuxer = new WingChannelDemuxer();
  private readonly tokenizer = new NativeTokenizer();
  private keepalive: NodeJS.Timeout | null = null;
  private readonly waiting: PendingRequest[] = [];
  private readonly inFlight: PendingRequest[] = [];
  /** Writes made while the connection was still opening. */
  private readonly pendingWrites: Buffer[] = [];
  /** Node of the last `0xd7` received, until the reply it belongs to ends. */
  private rxNode: number | null = null;
  private consecutiveTimeouts = 0;
  state: "connected" | "connecting" | "disconnected" = "disconnected";
  private connecting: Promise<void> | null = null;

  constructor(private readonly opts: { host: () => string; port: () => number; keepaliveMs: number; requestTimeoutMs: number }) {
    super();
  }

  connect(): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.state = "connecting";
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.opts.port(), this.opts.host());
      socket.setNoDelay(true);
      socket.once("connect", () => {
        this.socket = socket;
        this.state = "connected";
        this.demuxer.reset();
        this.tokenizer.reset();
        socket.write(encodeChannelSelect(CONTROL_CHANNEL_ID));
        this.keepalive = setInterval(() => socket.write(encodeChannelSelect(CONTROL_CHANNEL_ID)), this.opts.keepaliveMs);
        this.keepalive.unref?.();
        resolve();
        // What tablets sent while it was opening.
        for (const bytes of this.pendingWrites.splice(0)) socket.write(escapeBytes(bytes));
        this.pump();
      });
      socket.on("data", (chunk: Buffer) =>
        this.demuxer.feed(chunk, (ch, byte) => {
          if (ch === CONTROL_CHANNEL_ID) this.tokenizer.feedByte(byte, (token) => this.onToken(token));
        }),
      );
      socket.on("error", (err) => {
        this.emit("error", err);
        if (this.state === "connecting") reject(err);
      });
      socket.on("close", () => this.onClosed());
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  close(): void {
    this.socket?.destroy();
    this.onClosed();
  }

  private onClosed(): void {
    if (this.state === "disconnected") return;
    this.state = "disconnected";
    this.socket = null;
    this.pendingWrites.length = 0;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    const dropped = [...this.inFlight.splice(0), ...this.waiting.splice(0)];
    for (const request of dropped) {
      if (request.timer) clearTimeout(request.timer);
      if (request.requester.kind === "internal") request.requester.onEnd(false);
    }
    this.emit("closed");
  }

  /** A write: no reply, so it skips the request queue — order on the wire is all that matters. */
  write(position: Buffer, value: Buffer): void {
    const bytes = Buffer.concat([position, value]);
    if (this.socket) this.socket.write(escapeBytes(bytes));
    else if (this.state === "connecting") this.pendingWrites.push(bytes);
  }

  request(request: Omit<PendingRequest, "timer">): void {
    this.waiting.push({ ...request, timer: null });
    this.pump();
  }

  /** Waiting requests are sent round-robin across requesters, so one tablet's start-up sync can't starve the rest. */
  private pump(): void {
    while (this.socket && this.inFlight.length < IN_FLIGHT_WINDOW && this.waiting.length > 0) {
      const last = this.inFlight[this.inFlight.length - 1]?.requester;
      let index = this.waiting.findIndex((r) => r.requester !== last);
      if (index < 0) index = 0;
      const [request] = this.waiting.splice(index, 1);
      this.inFlight.push(request);
      this.socket.write(escapeBytes(request.bytes));
      this.armTimer();
    }
  }

  private armTimer(): void {
    const head = this.inFlight[0];
    if (!head || head.timer) return;
    head.timer = setTimeout(() => {
      head.timer = null;
      this.consecutiveTimeouts += 1;
      this.finishHead(false);
      if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        // Replies no longer line up with requests: nothing routed from here on could be trusted.
        this.emit("desync");
        this.close();
      }
    }, this.opts.requestTimeoutMs);
  }

  /** `completed`: the reply's 0xde arrived (false: the request timed out). */
  private finishHead(completed: boolean): void {
    const head = this.inFlight.shift();
    if (!head) return;
    if (head.timer) clearTimeout(head.timer);
    this.rxNode = null;
    if (head.requester.kind === "internal") head.requester.onEnd(completed);
    else head.requester.session.deliverEnd();
    this.armTimer();
    this.pump();
  }

  private onToken(token: NativeToken): void {
    const head = this.inFlight[0];
    if (token.kind === "navId") {
      this.rxNode = token.id;
      return;
    }
    if (isValueToken(token)) {
      // A value with no 0xd7 before it can only be the reply to a data request on a single node.
      const id = this.rxNode ?? (head?.action === "data" ? head.targetId : null);
      // One value per 0xd7: a later bare value belongs to the head request, not to this node.
      this.rxNode = null;
      if (id !== null) this.emit("value", id, token.bytes);
      return;
    }
    if (token.kind === "def") {
      if (token.def) this.emit("def", token.def, head);
      if (head?.action === "def") {
        if (head.requester.kind === "internal") {
          if (token.def) head.requester.onDef(token.def);
        } else {
          head.requester.session.deliver(token.bytes);
        }
      }
      return;
    }
    if (token.kind === "end") {
      this.consecutiveTimeouts = 0;
      if (head?.action === "def") this.emit("listed", head);
      this.finishHead(true);
    }
  }

  pendingFor(session: NativeSession): number {
    return [...this.waiting, ...this.inFlight].filter((r) => r.requester.kind === "session" && r.requester.session === session).length;
  }

  forget(session: NativeSession): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const r = this.waiting[i].requester;
      if (r.kind === "session" && r.session === session) this.waiting.splice(i, 1);
    }
  }
}

/**
 * How a tablet is connected. The console serves the native stream two ways on the same port, and so
 * does the bridge: raw over TCP (WING Edit, libwing), or as binary messages of a WebSocket opened on
 * "/" (WING-Q, a WebView app — found by capture). The bytes inside are the same.
 */
interface TabletLink {
  kind: "tcp" | "websocket";
  peer: { address: string; port: number };
  userAgent?: string;
  send(bytes: Buffer): void;
  /** Bytes queued and not yet sent. */
  backlog(): number;
  destroy(): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: () => void): void;
}

function tcpLink(socket: net.Socket): TabletLink {
  socket.setNoDelay(true);
  return {
    kind: "tcp",
    peer: { address: plainIpv4(socket.remoteAddress ?? ""), port: socket.remotePort ?? 0 },
    send: (bytes) => socket.write(bytes),
    backlog: () => socket.writableLength,
    destroy: () => socket.destroy(),
    onData: (listener) => socket.on("data", listener),
    onClose: (listener) => {
      socket.on("close", listener);
      socket.on("error", listener);
    },
  };
}

function webSocketLink(ws: WebSocket, req: http.IncomingMessage): TabletLink {
  return {
    kind: "websocket",
    peer: { address: plainIpv4(req.socket.remoteAddress ?? ""), port: req.socket.remotePort ?? 0 },
    userAgent: req.headers["user-agent"],
    send: (bytes) => ws.send(bytes, { binary: true }),
    backlog: () => ws.bufferedAmount,
    destroy: () => ws.terminate(),
    onData: (listener) =>
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        // Only binary messages carry the native stream; nothing else has been seen from WING-Q.
        if (isBinary) listener(data);
      }),
    onClose: (listener) => {
      ws.on("close", listener);
      ws.on("error", listener);
    },
  };
}

/** One connected tablet. */
class NativeSession {
  readonly id: number;
  readonly address: string;
  readonly peer: { address: string; port: number };
  readonly since = Date.now();
  private readonly demuxer = new WingChannelDemuxer();
  private readonly tokenizer = new NativeTokenizer();
  readonly position: NativePosition;
  private meters: NativeMeterSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  requests = 0;
  writesForwarded = 0;
  writesBlocked = 0;
  closed = false;

  constructor(
    id: number,
    readonly link: TabletLink,
    private readonly proxy: WingNativeProxy,
    map: NativeNodeMap,
    private readonly idleMs: number,
  ) {
    this.id = id;
    this.peer = link.peer;
    this.address = `${this.peer.address}:${this.peer.port}`;
    this.position = new NativePosition(map);
    link.onData((chunk) => this.onData(chunk));
    link.onClose(() => this.close());
    this.touch();
  }

  get metering(): boolean {
    return this.meters !== null;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  private onData(chunk: Buffer): void {
    this.touch();
    this.demuxer.feed(chunk, (ch, byte) => {
      if (this.closed) return;
      if (ch === CONTROL_CHANNEL_ID) {
        this.tokenizer.feedByte(byte, (token) => this.proxy.handleToken(this, token));
      } else if (ch === METER_CHANNEL_ID) {
        this.meters ??= this.proxy.createMeters(this);
        this.meters?.feedByte(byte);
      }
      // Other channels are not used by the console (spec: n/u) — dropped.
    });
  }

  /** Sends logical control-channel bytes to the tablet. */
  deliver(logical: Buffer): void {
    if (this.closed) return;
    if (this.link.backlog() > MAX_BUFFERED_BYTES) {
      // A tablet that stopped reading: dropping it beats buffering the console's traffic forever.
      this.close();
      return;
    }
    this.link.send(frameControl(logical));
  }

  deliverEnd(): void {
    this.deliver(Buffer.from([TOKEN_REQUEST_END]));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.meters?.close();
    this.link.destroy();
    this.proxy.sessionClosed(this);
  }
}

export class WingNativeProxy extends EventEmitter {
  private server: net.Server | null = null;
  /** Upgrades the connections that open with an HTTP GET (WING-Q) to WebSockets. */
  private readonly upgrades = http.createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("WebSocket only");
  });
  private readonly webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly sessions = new Set<NativeSession>();
  private nextSessionId = 1;
  private readonly upstream: NativeUpstream;
  readonly map = new NativeNodeMap();
  private mapState: NativeProxyStatus["map"]["state"] = "idle";
  private mapStale = false;
  private mapError: string | null = null;
  private walking: Promise<void> | null = null;
  private lastError: string | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;
  private readonly readbacks = new Map<number, NodeJS.Timeout>();
  private readonly snapbacks = new Map<number, NodeJS.Timeout>();
  readonly blocked: NativeBlockedWrite[] = [];
  private readonly timing: Required<NonNullable<NativeProxyOptions["timing"]>>;

  constructor(private readonly opts: NativeProxyOptions) {
    super();
    this.timing = {
      keepaliveMs: KEEPALIVE_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      readbackDelayMs: READBACK_DELAY_MS,
      snapbackDelayMs: SNAPBACK_DELAY_MS,
      upstreamLingerMs: UPSTREAM_LINGER_MS,
      sessionIdleMs: SESSION_IDLE_MS,
      ...opts.timing,
    };
    this.upstream = new NativeUpstream({
      host: opts.consoleHost,
      port: opts.consolePort,
      keepaliveMs: this.timing.keepaliveMs,
      requestTimeoutMs: this.timing.requestTimeoutMs,
    });
    this.upstream.on("value", (id: number, value: Buffer) => this.broadcast(Buffer.concat([encodeNodeId(id), value])));
    this.upstream.on("def", (def: NativeNodeDef) => this.map.learn(def));
    this.upstream.on("listed", (request: PendingRequest) => {
      // A tablet's own listing completes the map too — only when it really ended, never on a timeout.
      if (request.requester.kind === "session" && request.targetId !== null && !request.atRoot) this.map.markComplete(request.targetId);
    });
    this.upstream.on("error", (err: Error) => (this.lastError = err.message));
    this.upstream.on("desync", () => (this.lastError = "replies from the console stopped matching requests; reconnecting"));
    this.upstream.on("closed", () => {
      // Every tablet's view now lags the console; closing makes them reconnect and resync, as after a
      // console reboot. The map is kept: ids are stable for a firmware.
      for (const session of [...this.sessions]) session.close();
      this.markMapStale();
    });
  }

  async start(): Promise<void> {
    this.upgrades.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      this.webSockets.handleUpgrade(req, socket, head, (ws) => this.accept(webSocketLink(ws, req)));
    });
    const server = net.createServer((socket) => {
      socket.on("error", () => socket.destroy());
      // The first bytes tell the transports apart: a WebSocket opens with an HTTP request. A raw
      // client may wait to be spoken to, so silence past a moment means raw TCP.
      const asRaw = setTimeout(() => {
        socket.off("data", onFirst);
        this.accept(tcpLink(socket));
      }, SNIFF_MS);
      const onFirst = (first: Buffer): void => {
        clearTimeout(asRaw);
        socket.pause();
        socket.unshift(first);
        if (first.subarray(0, 4).toString("latin1") === "GET ") {
          this.upgrades.emit("connection", socket);
        } else {
          this.accept(tcpLink(socket));
        }
        socket.resume();
      };
      socket.once("data", onFirst);
      socket.once("close", () => clearTimeout(asRaw));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.listenPort, this.opts.bindAddress ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => (this.lastError = err.message));
    this.server = server;
  }

  get port(): number {
    return (this.server?.address() as net.AddressInfo | null)?.port ?? this.opts.listenPort;
  }

  async stop(): Promise<void> {
    for (const session of [...this.sessions]) session.close();
    for (const timer of [...this.readbacks.values(), ...this.snapbacks.values()]) clearTimeout(timer);
    this.readbacks.clear();
    this.snapbacks.clear();
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.upstream.close();
    for (const ws of this.webSockets.clients) ws.terminate();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getStatus(): NativeProxyStatus {
    return {
      listening: this.server !== null,
      listenPort: this.port,
      upstream: this.upstream.state,
      sessions: [...this.sessions].map((s) => ({
        id: s.id,
        address: s.address,
        transport: s.link.kind,
        userAgent: s.link.userAgent ?? null,
        since: s.since,
        requests: s.requests,
        writesForwarded: s.writesForwarded,
        writesBlocked: s.writesBlocked,
        metering: s.metering,
      })),
      map: { state: this.mapState, nodes: this.map.size, stale: this.mapStale, lastError: this.mapError },
      lastError: this.lastError,
    };
  }

  /**
   * The safes changed, or something under them did (a model change renumbers nodes; a re-patch moves
   * a channel's source): writes wait until the targets are mapped again.
   */
  markMapStale(): void {
    this.mapStale = true;
    if (this.sessions.size > 0) void this.ensureMap();
  }

  /** Called when the console's node tree under `path` changed shape (e.g. `/ch/5/dyn/mdl` was set). */
  forgetSubtree(path: string): void {
    const id = this.map.idOf(path);
    if (id !== null) this.map.forgetBelow(id);
    this.markMapStale();
  }

  /** Maps the safe targets; resolves when done (or failed — writes then stay blocked). */
  ensureMap(): Promise<void> {
    if (!this.opts.safety.hasSafes()) {
      this.mapState = "ready";
      this.mapStale = false;
      return Promise.resolve();
    }
    if (this.walking) return this.walking;
    if (this.mapState === "ready" && !this.mapStale) return Promise.resolve();
    this.mapState = "walking";
    this.walking = (async () => {
      try {
        await this.upstream.connect();
        // A stale map is re-walked from scratch for the targets: lists already complete are reused,
        // forgotten ones (forgetSubtree) are listed again.
        this.mapStale = false;
        await walkNodeMap(this.map, (target) => this.requestDefinitions(target), this.opts.safety.walkTargets());
        this.mapState = this.mapStale ? "walking" : "ready";
        this.mapError = null;
      } catch (err) {
        this.mapState = "error";
        this.mapError = err instanceof Error ? err.message : String(err);
      } finally {
        this.walking = null;
      }
      if (this.mapStale && this.sessions.size > 0) await this.ensureMap();
    })();
    return this.walking;
  }

  private requestDefinitions(target: number | "root"): Promise<NativeNodeDef[]> {
    return new Promise((resolve, reject) => {
      if (this.upstream.state !== "connected") {
        reject(new Error("console connection lost while mapping the safe strips"));
        return;
      }
      const defs: NativeNodeDef[] = [];
      this.upstream.request({
        action: "def",
        targetId: target === "root" ? null : target,
        atRoot: target === "root",
        requester: {
          kind: "internal",
          onDef: (def) => defs.push(def),
          // A listing cut short is partial: failing the walk keeps writes blocked (map state "error")
          // rather than letting walkNodeMap mark an incomplete child list complete.
          onEnd: (completed) =>
            completed ? resolve(defs) : reject(new Error("a definition listing from the console was cut short (timed out or connection lost)")),
        },
        bytes: Buffer.concat([target === "root" ? Buffer.from([TOKEN_ROOT]) : encodeNodeId(target), Buffer.from([TOKEN_DEF_REQUEST])]),
      });
    });
  }

  private accept(link: TabletLink): void {
    if (this.sessions.size >= MAX_SESSIONS) {
      link.destroy();
      return;
    }
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    const session = new NativeSession(this.nextSessionId++, link, this, this.map, this.timing.sessionIdleMs);
    this.sessions.add(session);
    this.emit("session", session.address);
    this.upstream.connect().then(
      () => void this.ensureMap(),
      (err: unknown) => {
        this.lastError = `cannot reach the console: ${err instanceof Error ? err.message : String(err)}`;
        session.close();
      },
    );
  }

  /** @internal */
  sessionClosed(session: NativeSession): void {
    this.sessions.delete(session);
    this.upstream.forget(session);
    if (this.sessions.size === 0 && !this.lingerTimer) {
      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null;
        if (this.sessions.size === 0) this.upstream.close();
      }, this.timing.upstreamLingerMs);
      this.lingerTimer.unref?.();
    }
  }

  /** @internal */
  createMeters(session: NativeSession): NativeMeterSession | null {
    return this.opts.createMeterSession?.(session.peer) ?? null;
  }

  private broadcast(logical: Buffer, except?: NativeSession): void {
    for (const session of this.sessions) {
      if (session !== except) session.deliver(logical);
    }
  }

  /** @internal Every control-channel token a tablet sends. */
  handleToken(session: NativeSession, token: NativeToken): void {
    if (isNavToken(token)) {
      session.position.apply(token);
      return;
    }
    if (token.kind === "reqData" || token.kind === "reqDef") {
      session.requests += 1;
      this.upstream.request({
        action: token.kind === "reqData" ? "data" : "def",
        targetId: session.position.unresolved ? null : session.position.id,
        atRoot: session.position.id !== null && session.position.id === this.map.rootId,
        requester: { kind: "session", session },
        bytes: Buffer.concat([session.position.replay(), Buffer.from([token.kind === "reqData" ? TOKEN_DATA_REQUEST : TOKEN_DEF_REQUEST])]),
      });
      return;
    }
    if (isWriteToken(token)) {
      this.handleWrite(session, token);
      return;
    }
    if (token.kind === "unknown") {
      // The tablet's stream no longer parses: a write could be hiding in what follows.
      this.lastError = `closed ${session.address}: unknown token 0x${token.byte.toString(16)}`;
      session.close();
    }
    // end / def from a tablet mean nothing to the console — dropped.
  }

  private handleWrite(session: NativeSession, token: NativeToken): void {
    const verdict = nativeWriteVerdict({
      map: this.map,
      position: session.position,
      policy: this.opts.safety.policyFor({ ...session.peer, userAgent: session.link.userAgent }),
      mapReady: this.mapState === "ready",
      mapStale: this.mapStale,
    });
    const id = session.position.unresolved ? null : session.position.id;
    if (!verdict.allow) {
      session.writesBlocked += 1;
      const entry = { at: Date.now(), client: session.address, path: verdict.path, id, reason: verdict.reason };
      this.blocked.unshift(entry);
      this.blocked.length = Math.min(this.blocked.length, 20);
      this.emit("blocked", entry);
      if (id !== null) this.scheduleRead(this.snapbacks, id, this.timing.snapbackDelayMs);
      return;
    }
    session.writesForwarded += 1;
    this.upstream.write(session.position.replay(), token.bytes);
    if (id !== null) {
      if (isValueToken(token)) this.broadcast(Buffer.concat([encodeNodeId(id), token.bytes]), session);
      this.scheduleRead(this.readbacks, id, this.timing.readbackDelayMs);
    }
  }

  /** A trailing read of `id`: its reply reaches every tablet, so they all settle on the console's value. */
  private scheduleRead(timers: Map<number, NodeJS.Timeout>, id: number, delayMs: number): void {
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(id);
      if (this.upstream.state !== "connected") return;
      this.upstream.request({
        action: "data",
        targetId: id,
        atRoot: false,
        requester: { kind: "internal", onDef: () => undefined, onEnd: () => undefined },
        bytes: Buffer.concat([encodeNodeId(id), Buffer.from([TOKEN_DATA_REQUEST])]),
      });
    }, delayMs);
    timer.unref?.();
    timers.set(id, timer);
  }
}
