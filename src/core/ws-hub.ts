import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type PerMessageDeflateOptions, type RawData, type WebSocket } from "ws";
import { z } from "zod";
import type { AuthMiddleware } from "./auth.js";
import type { EventBus, PluginEvent } from "./event-bus.js";
import type { LiveChannel, LiveTopic, McpPlugin } from "./plugin.js";
import { WS_CODECS, type WsCodec, type WsCodecName } from "./ws-codec.js";

/**
 * The dashboard's live channel: a WebSocket endpoint at `/api/ws` whose subprotocol declares what a
 * connection may do. Its wire contract is docs/websocket-protocol.md — keep the two in step.
 *
 * This runs in the same process as the console's OSC and meter clients, so nothing here may throw
 * into a caller or wait on a client: EventBus fan-out is synchronous and isolated per socket,
 * every async handler is caught, every table and queue is bounded, and every wait has a timeout.
 */

export const WS_PATH = "/api/ws";
export const WS_PROTOCOL_VERSION = 1;

interface ProtocolSpec {
  channel: LiveChannel;
  codec: WsCodecName;
}

/** `wing.<channel>.v<version>.<codec>` — every subprotocol this server speaks. */
export const WS_SUBPROTOCOLS: Record<string, ProtocolSpec> = Object.fromEntries(
  (["control", "stream"] as const).flatMap((channel) =>
    (["msgpack", "json"] as const).map((codec) => [`wing.${channel}.v${WS_PROTOCOL_VERSION}.${codec}`, { channel, codec }]),
  ),
);

/** Application close codes (docs/websocket-protocol.md). */
export const WS_CLOSE = {
  goingAway: 1001,
  internalError: 1011,
  invalidMessage: 4400,
  credentialRevoked: 4401,
  tooManyMessages: 4429,
} as const;

/** Per-channel limits. Control carries REST bodies; stream only ever receives small sub/unsub. */
const LIMITS: Record<LiveChannel, { maxPayload: number; ratePerSecond: number; burst: number }> = {
  control: { maxPayload: 1024 * 1024, ratePerSecond: 100, burst: 300 },
  stream: { maxPayload: 16 * 1024, ratePerSecond: 20, burst: 50 },
};

/**
 * A client that stops reading (a laptop lid closed on a dashboard tab, a stalled proxy) must not
 * make this process hold its backlog. Past the soft limit a stream connection's frames are skipped
 * — the next one supersedes them anyway — and if it stays there for the stall timeout it is
 * terminated. Past the hard limit any connection is terminated; only control traffic (which is
 * never skipped) can get there.
 */
export const WS_SOFT_LIMIT_BYTES = 256 * 1024;
export const WS_HARD_LIMIT_BYTES = 4 * 1024 * 1024;
const STREAM_STALL_TIMEOUT_MS = 5_000;

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_CONNECTIONS = 64;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 64;

/**
 * permessage-deflate (RFC 7692), negotiated by every browser on its own. Below the threshold zlib
 * costs more than it saves (a param-change, an RTA frame); above it — a dump, the full meter
 * snapshot — it pays. Level 1 because frames go out at up to 20 Hz. ws runs zlib asynchronously on
 * the libuv threadpool, so compression never blocks the event loop.
 */
const PER_MESSAGE_DEFLATE: PerMessageDeflateOptions = {
  threshold: 1024,
  zlibDeflateOptions: { level: 1 },
};

/**
 * REST over WebSocket: a `req` is replayed through the server's own REST routes (see
 * `WsHubOptions.handleRequest`), so every route keeps its auth, validation and write semantics. Only
 * `/api/` is reachable, never the WebSocket endpoint itself nor the auth routes (tickets, passkeys,
 * OAuth clients): none of those belong on an already-authenticated socket.
 */
const REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const MAX_IN_FLIGHT_REQUESTS = 32;
/** Above the long-running tools' own 45s budget (plugins/wing/long-running.ts), plus latency. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * What Express could route `path` to, for the allowlist check: it matches case-insensitively and
 * does not collapse slashes, and the check must hold for the percent-decoded form too. undefined
 * when it does not decode.
 */
function routesOf(path: string): string[] | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  return [path, decoded].map((p) => p.toLowerCase().replace(/\/{2,}/g, "/"));
}

const RequestPath = z
  .string()
  .max(2048)
  .refine(
    (path) => {
      const routes = routesOf(path);
      return (
        routes !== undefined &&
        !path.includes("?") &&
        !path.includes("#") &&
        routes.every(
          (route) =>
            route.startsWith("/api/") &&
            !route.startsWith("/api/auth/") &&
            route !== WS_PATH &&
            !route.startsWith(WS_PATH + "/") &&
            !/\/\.\.?(\/|$)/.test(route),
        )
      );
    },
    { message: "path must be under /api/, outside /api/auth/ and /api/ws, without dot segments; pass the query separately" },
  );

const TopicName = z.string().min(1).max(128);
const MessageId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ClientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), id: MessageId, topic: TopicName, params: z.unknown().optional() }),
  z.object({ t: z.literal("unsub"), id: MessageId, topic: TopicName }),
  z.object({
    t: z.literal("req"),
    id: MessageId,
    method: z.enum(REQUEST_METHODS),
    path: RequestPath,
    query: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    body: z.unknown().optional(),
  }),
]);
type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** What `err` carries in its `error` field. */
export type WsErrorCode =
  | "invalid-message"
  | "forbidden"
  | "unknown-topic"
  | "invalid-params"
  | "too-many-subscriptions"
  | "busy"
  | "timeout"
  | "internal";

/** A `req`, as handed to `WsHubOptions.handleRequest`. */
export interface WsRestRequest {
  method: (typeof REQUEST_METHODS)[number];
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  /** The bearer credential the connection authenticated with — never sent back over the wire. */
  credential: string;
  remoteAddress: string | undefined;
  /** From the upgrade request, so a replayed request sees the same client as an HTTP one would. */
  headers: Record<string, string>;
  /** Aborted when the hub gives up on the request (timeout) or the client goes away. */
  signal: AbortSignal;
}

export interface WsRestResponse {
  status: number;
  body: unknown;
}

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

interface Connection {
  readonly ws: WebSocket;
  readonly channel: LiveChannel;
  readonly codec: WsCodec;
  readonly credential: string;
  alive: boolean;
  /** When a stream connection's backlog first went past the soft limit, while it stays there. */
  congestedSince: number | undefined;
  /** topic id → the group it sits in */
  readonly subscriptions: Map<string, SubscriberGroup>;
  readonly bucket: TokenBucket;
  readonly remoteAddress: string | undefined;
  readonly forwardedHeaders: Record<string, string>;
  inFlight: number;
  /** Aborted when the connection goes away, so its in-flight requests stop with it. */
  readonly gone: AbortController;
}

interface SubscriberGroup {
  readonly key: string;
  readonly params: unknown;
  readonly members: Set<Connection>;
}

interface TopicEntry {
  readonly id: string;
  readonly pluginId: string;
  readonly topic: LiveTopic;
  /** group key → group */
  readonly groups: Map<string, SubscriberGroup>;
  /** Set once an encode failure has been logged, so a failing topic does not log at 20 Hz. */
  warned: boolean;
}

export interface WsHubOptions {
  plugins: McpPlugin[];
  eventBus: EventBus;
  auth: AuthMiddleware;
  /** Origins accepted besides the request's own host and the public URL's (security.allowedOrigins). */
  allowedOrigins?: string[];
  publicUrl?: URL;
  /**
   * Serves REST-over-WS `req`s on control connections. Absent: `req` is answered `forbidden`.
   * Must resolve (never reject) with the route's status and body; the hub bounds it with a timeout.
   */
  handleRequest?: (req: WsRestRequest) => Promise<WsRestResponse>;
  /** Test seams. */
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  streamStallTimeoutMs?: number;
}

export class WsHub {
  private readonly servers: Record<LiveChannel, WebSocketServer>;
  private readonly connections = new Set<Connection>();
  private readonly topics = new Map<string, TopicEntry>();
  /** `${pluginId}:${eventType}` → the topics built from that event */
  private readonly topicsBySource = new Map<string, TopicEntry[]>();
  private readonly unsubscribeBus: () => void;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly opts: WsHubOptions) {
    this.servers = {
      control: this.createServer("control"),
      stream: this.createServer("stream"),
    };

    for (const plugin of opts.plugins) {
      const offered = plugin.liveTopics?.() ?? {};
      for (const [name, topic] of Object.entries(offered)) {
        const entry: TopicEntry = { id: `${plugin.id}:${name}`, pluginId: plugin.id, topic, groups: new Map(), warned: false };
        this.topics.set(entry.id, entry);
        const sourceKey = `${plugin.id}:${topic.source ?? name}`;
        const list = this.topicsBySource.get(sourceKey) ?? [];
        list.push(entry);
        this.topicsBySource.set(sourceKey, list);
      }
    }

    this.unsubscribeBus = opts.eventBus.subscribe((event) => this.onBusEvent(event));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** The `upgrade` listener for the HTTP server. Never throws; every refusal is an HTTP status. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // An 'error' with no listener would crash the process; a client resetting mid-handshake is
    // ordinary.
    socket.on("error", () => socket.destroy());
    try {
      this.upgrade(req, socket, head);
    } catch (err) {
      console.error("[ws] upgrade failed:", err);
      refuse(socket, 500, "Internal Server Error");
    }
  }

  /** Closes every connection (1001) and stops listening to the bus. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    this.unsubscribeBus();
    for (const conn of this.connections) {
      try {
        conn.ws.close(WS_CLOSE.goingAway, "server shutting down");
      } catch {
        conn.ws.terminate();
      }
    }
    // Whatever has not finished its closing handshake shortly after is cut, so shutdown never waits
    // on a client.
    const deadline = setTimeout(() => {
      for (const conn of this.connections) conn.ws.terminate();
    }, 1000);
    deadline.unref?.();
    await Promise.all(
      (Object.values(this.servers) as WebSocketServer[]).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    for (const conn of this.connections) conn.ws.terminate();
    clearTimeout(deadline);
  }

  private createServer(channel: LiveChannel): WebSocketServer {
    const server = new WebSocketServer({
      noServer: true,
      maxPayload: LIMITS[channel].maxPayload,
      perMessageDeflate: PER_MESSAGE_DEFLATE,
      // The protocol was already chosen (and validated) in upgrade(); this only echoes it.
      handleProtocols: (protocols) => {
        for (const protocol of protocols) {
          if (WS_SUBPROTOCOLS[protocol]?.channel === channel) return protocol;
        }
        return false;
      },
    });
    server.on("error", (err) => console.error(`[ws] ${channel} server error:`, err));
    return server;
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.pathname !== WS_PATH) {
      refuse(socket, 404, "Not Found");
      return;
    }
    if (this.closed) {
      refuse(socket, 503, "Service Unavailable");
      return;
    }

    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const protocol = offered.find((p) => WS_SUBPROTOCOLS[p] !== undefined);
    if (!protocol) {
      refuse(socket, 400, "Bad Request", `expected one of the subprotocols: ${Object.keys(WS_SUBPROTOCOLS).join(", ")}`);
      return;
    }

    if (!this.originAllowed(req)) {
      refuse(socket, 403, "Forbidden");
      return;
    }

    const ticket = url.searchParams.get("ticket");
    const credential = ticket ? this.opts.auth.consumeStreamTicket(ticket) : undefined;
    if (credential === undefined || !this.opts.auth.isValidCredential(credential)) {
      refuse(socket, 401, "Unauthorized");
      return;
    }

    if (this.connections.size >= MAX_CONNECTIONS) {
      refuse(socket, 503, "Service Unavailable");
      return;
    }

    const spec = WS_SUBPROTOCOLS[protocol];
    this.servers[spec.channel].handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, spec, credential, req);
    });
  }

  /**
   * Cross-site WebSocket hijacking: a browser lets any page open a WebSocket to any host, sending
   * its own Origin. The ticket already stops a third-party page (it cannot mint one without the
   * token), so this is a second layer. A request without an Origin is not from a browser page.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (this.opts.allowedOrigins?.includes(origin)) return true;
    if (this.opts.publicUrl && origin === this.opts.publicUrl.origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private onConnection(ws: WebSocket, spec: ProtocolSpec, credential: string, upgrade: IncomingMessage): void {
    const conn: Connection = {
      ws,
      channel: spec.channel,
      codec: WS_CODECS[spec.codec],
      credential,
      alive: true,
      congestedSince: undefined,
      subscriptions: new Map(),
      bucket: { tokens: LIMITS[spec.channel].burst, updatedAt: Date.now() },
      remoteAddress: upgrade.socket.remoteAddress,
      forwardedHeaders: pickHeaders(upgrade, FORWARDED_HEADERS),
      inFlight: 0,
      gone: new AbortController(),
    };
    this.connections.add(conn);

    ws.on("error", (err) => {
      // Oversized frames and protocol violations land here; ws closes the socket itself.
      console.warn(`[ws] ${conn.channel} connection error: ${err.message}`);
    });
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("close", () => this.dropConnection(conn));
    ws.on("message", (data, isBinary) => {
      try {
        this.onMessage(conn, data, isBinary);
      } catch (err) {
        console.error("[ws] message handler failed:", err);
        this.closeConnection(conn, WS_CLOSE.internalError, "internal error");
      }
    });

    this.send(conn, {
      t: "hello",
      v: WS_PROTOCOL_VERSION,
      channel: conn.channel,
      topics: [...this.topics.values()].filter((entry) => entry.topic.channel === conn.channel).map((entry) => entry.id),
    });
  }

  private dropConnection(conn: Connection): void {
    if (!this.connections.delete(conn)) return;
    conn.gone.abort();
    for (const [topicId, group] of conn.subscriptions) {
      this.leaveGroup(topicId, group, conn);
    }
    conn.subscriptions.clear();
  }

  private closeConnection(conn: Connection, code: number, reason: string): void {
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
    this.dropConnection(conn);
  }

  private takeToken(conn: Connection): boolean {
    const limits = LIMITS[conn.channel];
    const now = Date.now();
    const bucket = conn.bucket;
    bucket.tokens = Math.min(limits.burst, bucket.tokens + ((now - bucket.updatedAt) / 1000) * limits.ratePerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    if (!this.connections.has(conn)) return;
    if (!this.takeToken(conn)) {
      this.closeConnection(conn, WS_CLOSE.tooManyMessages, "too many messages");
      return;
    }

    let decoded: unknown;
    try {
      decoded = conn.codec.decode(toBuffer(data), isBinary);
    } catch {
      this.closeConnection(conn, WS_CLOSE.invalidMessage, "undecodable message");
      return;
    }

    const parsed = ClientMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      const id = MessageId.safeParse((decoded as { id?: unknown } | null)?.id);
      this.sendError(conn, id.success ? id.data : undefined, "invalid-message", parsed.error.issues[0]?.message);
      return;
    }

    const message: ClientMessage = parsed.data;
    switch (message.t) {
      case "sub":
        this.subscribe(conn, message.id, message.topic, message.params);
        return;
      case "unsub":
        this.unsubscribe(conn, message.id, message.topic);
        return;
      case "req":
        this.request(conn, message);
        return;
    }
  }

  /**
   * Requests run concurrently: dispatched in arrival order, but a slow one (an auto-EQ run, a dump)
   * never holds up the next. Each is bounded by a timeout, and its reply is dropped if the client
   * left meanwhile.
   */
  private request(conn: Connection, message: Extract<ClientMessage, { t: "req" }>): void {
    const handle = this.opts.handleRequest;
    if (conn.channel !== "control" || !handle) {
      this.sendError(conn, message.id, "forbidden", "requests are only served on a control connection");
      return;
    }
    if (conn.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      this.sendError(conn, message.id, "busy", `at most ${MAX_IN_FLIGHT_REQUESTS} requests in flight`);
      return;
    }
    conn.inFlight += 1;

    const giveUp = new AbortController();
    const signal = AbortSignal.any([giveUp.signal, conn.gone.signal]);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        giveUp.abort();
        resolve("timeout");
      }, this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    const work = Promise.resolve()
      .then(() =>
        handle({
          method: message.method,
          path: message.path,
          query: message.query,
          body: message.body,
          credential: conn.credential,
          remoteAddress: conn.remoteAddress,
          headers: conn.forwardedHeaders,
          signal,
        }),
      )
      .catch((err: unknown): WsRestResponse => {
        if (!signal.aborted) console.error(`[ws] ${message.method} ${message.path} failed:`, err);
        return { status: 500, body: { error: "internal error" } };
      });

    void Promise.race([work, timeout])
      .then((outcome) => {
        if (outcome === "timeout") {
          this.sendError(conn, message.id, "timeout", `no response within ${(this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) / 1000}s`);
        } else {
          this.send(conn, { t: "res", id: message.id, status: outcome.status, body: outcome.body });
        }
      })
      .catch((err: unknown) => console.error("[ws] replying to a request failed:", err))
      .finally(() => {
        clearTimeout(timer);
        conn.inFlight -= 1;
      });
  }

  private subscribe(conn: Connection, id: number, topicId: string, params: unknown): void {
    const entry = this.topics.get(topicId);
    if (!entry) {
      this.sendError(conn, id, "unknown-topic", topicId);
      return;
    }
    if (entry.topic.channel !== conn.channel) {
      this.sendError(conn, id, "forbidden", `${topicId} is only available on a ${entry.topic.channel} connection`);
      return;
    }
    if (!conn.subscriptions.has(topicId) && conn.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      this.sendError(conn, id, "too-many-subscriptions");
      return;
    }

    let resolved: { key: string; params: unknown; ack?: unknown };
    try {
      resolved = entry.topic.subscribe ? entry.topic.subscribe(params) : { key: "", params: undefined };
    } catch (err) {
      this.sendError(conn, id, "invalid-params", err instanceof Error ? err.message : String(err));
      return;
    }

    // A second `sub` on the same topic replaces the first — that is how a client changes which
    // strips it watches without a gap.
    const previous = conn.subscriptions.get(topicId);
    if (previous) this.leaveGroup(topicId, previous, conn);

    let group = entry.groups.get(resolved.key);
    if (!group) {
      group = { key: resolved.key, params: resolved.params, members: new Set() };
      entry.groups.set(resolved.key, group);
    }
    group.members.add(conn);
    conn.subscriptions.set(topicId, group);

    this.send(conn, resolved.ack === undefined ? { t: "ack", id, topic: topicId } : { t: "ack", id, topic: topicId, data: resolved.ack });
  }

  private unsubscribe(conn: Connection, id: number, topicId: string): void {
    const group = conn.subscriptions.get(topicId);
    if (group) {
      this.leaveGroup(topicId, group, conn);
      conn.subscriptions.delete(topicId);
    }
    this.send(conn, { t: "ack", id, topic: topicId });
  }

  private leaveGroup(topicId: string, group: SubscriberGroup, conn: Connection): void {
    group.members.delete(conn);
    if (group.members.size === 0) this.topics.get(topicId)?.groups.delete(group.key);
  }

  /**
   * Runs on the publisher's stack — the WING plugin's OSC and meter handlers. It must never throw
   * back into them and never wait: each group's frame is built once, serialized once per codec,
   * then handed to each socket inside its own try/catch.
   */
  private onBusEvent(event: PluginEvent): void {
    const entries = this.topicsBySource.get(`${event.pluginId}:${event.type}`);
    if (!entries) return;
    for (const entry of entries) {
      for (const group of entry.groups.values()) {
        if (group.members.size === 0) continue;
        let data: unknown;
        try {
          data = entry.topic.encode ? entry.topic.encode(event.payload, group.params) : event.payload;
        } catch (err) {
          if (!entry.warned) {
            entry.warned = true;
            console.error(`[ws] encoding ${entry.id} failed (further failures are not logged):`, err);
          }
          continue;
        }
        if (data === null || data === undefined) continue;

        const message = { t: "evt", topic: entry.id, ts: event.timestamp, data };
        const serialized = new Map<WsCodecName, Uint8Array | string>();
        for (const conn of group.members) {
          try {
            if (conn.channel === "stream" && this.congested(conn)) continue;
            let frame = serialized.get(conn.codec.name);
            if (frame === undefined) {
              frame = conn.codec.encode(message);
              serialized.set(conn.codec.name, frame);
            }
            this.sendRaw(conn, frame, entry.topic.compress ?? true);
          } catch (err) {
            console.error(`[ws] delivering ${entry.id} failed:`, err);
            this.terminate(conn);
          }
        }
      }
    }
  }

  /** True when a stream frame should be skipped for this connection; terminates it once stalled. */
  private congested(conn: Connection): boolean {
    if (conn.ws.bufferedAmount <= WS_SOFT_LIMIT_BYTES) {
      conn.congestedSince = undefined;
      return false;
    }
    const now = Date.now();
    conn.congestedSince ??= now;
    if (now - conn.congestedSince > (this.opts.streamStallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS)) {
      this.terminate(conn);
    }
    return true;
  }

  private heartbeat(): void {
    for (const conn of this.connections) {
      try {
        if (!conn.alive) {
          this.terminate(conn);
          continue;
        }
        // A passkey session can be revoked or expire while its socket stays open.
        if (!this.opts.auth.isValidCredential(conn.credential)) {
          this.closeConnection(conn, WS_CLOSE.credentialRevoked, "credential no longer valid");
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      } catch (err) {
        console.error("[ws] heartbeat failed:", err);
        this.terminate(conn);
      }
    }
  }

  private terminate(conn: Connection): void {
    conn.ws.terminate();
    this.dropConnection(conn);
  }

  private sendError(conn: Connection, id: number | undefined, error: WsErrorCode, detail?: string): void {
    const message: Record<string, unknown> = { t: "err", error };
    if (id !== undefined) message.id = id;
    if (detail !== undefined) message.detail = detail;
    this.send(conn, message);
  }

  private send(conn: Connection, message: unknown): void {
    this.sendRaw(conn, conn.codec.encode(message), true);
  }

  /** Never throws for a socket that went away meanwhile; a reply to a departed client is dropped. */
  private sendRaw(conn: Connection, frame: Uint8Array | string, compress: boolean): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > WS_HARD_LIMIT_BYTES) {
      this.terminate(conn);
      return;
    }
    conn.ws.send(frame, { binary: conn.codec.binary, compress }, (err) => {
      if (err) this.dropConnection(conn);
    });
  }
}

/**
 * Carried from the upgrade onto every replayed request: Express derives req.ip (and with it the
 * rate limiter's bucket) from these under `trust proxy`, and req.hostname from Host.
 */
const FORWARDED_HEADERS = ["host", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded"];

function pickHeaders(req: IncomingMessage, names: string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = req.headers[name];
    if (typeof value === "string") picked[name] = value;
    else if (Array.isArray(value)) picked[name] = value.join(", ");
  }
  return picked;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function refuse(socket: Duplex, status: number, statusText: string, body = ""): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  // Destroyed once the response is flushed, not before — or the client sees a reset, not the status.
  socket.once("finish", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
