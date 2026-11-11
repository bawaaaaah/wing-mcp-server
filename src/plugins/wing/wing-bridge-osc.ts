import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import osc from "osc";
import type { OscArgument } from "osc";
import { normalizeBridgePath, type ClientPolicy } from "./wing-bridge-safes.js";
import { joinNodePath } from "./wing-osc-client.js";
import { createDropReporter, isFromConsole, resolveConsoleSources, type ConsoleSources } from "./wing-source-filter.js";
import { splitTopLevelAssignments } from "./wing-value-codec.js";

export type BridgeSubscriptionMode = "/*s" | "/*S";

/** One OSC app talking to the bridge, keyed by where its replies go (`ip:port`). */
export interface BridgeOscClientInfo {
  address: string;
  port: number;
  firstSeenAt: number;
  lastSeenAt: number;
  messages: number;
  writesForwarded: number;
  writesBlocked: number;
  subscription: BridgeSubscriptionMode | null;
}

export interface BridgeBlockedWrite {
  at: number;
  transport: "osc" | "native";
  client: string;
  path: string;
  reason: string;
}

export interface WingBridgeOscOptions {
  port: number;
  /** Empty or omitted: every interface. */
  bindAddress?: string;
  consoleHost: string;
  consolePort: number;
  /**
   * The policy of the client writing, read on every write so a change applies to the next datagram;
   * null while the client is being identified (its writes are refused meanwhile).
   */
  getPolicy: (client: { address: string }) => ClientPolicy | null;
  onBlocked?: (blocked: BridgeBlockedWrite) => void;
  /** An upstream socket (and a client without a subscription) is dropped after this long unused. */
  idleTimeoutMs?: number;
  /** Like the console: a subscription not renewed within this window ends. */
  subscriptionTimeoutMs?: number;
  /** How long after a refused write the bridge reads the real value back to the client. */
  snapBackDelayMs?: number;
  /**
   * Clients (`ip:port` reply targets, each with its own upstream socket) one IP may hold at once. A
   * `/%port/` prefix picks the reply port freely, so without a cap one host could open sockets
   * without end; past it, that IP's least recently seen client is let go.
   */
  maxClientsPerAddress?: number;
  /** Clients held at once in all; past it, messages from new clients are dropped until one idles out. */
  maxClients?: number;
}

export interface WingBridgeOscStats {
  listening: boolean;
  port: number;
  upstreamSockets: number;
  messagesIn: number;
  forwarded: number;
  blocked: number;
  pushesSent: number;
  dropped: number;
  lastError: string | null;
}

/** What a client datagram asks for. */
export type OscRequestKind =
  | { kind: "subscribe"; mode: BridgeSubscriptionMode }
  | { kind: "ignore" }
  | { kind: "read" }
  | {
      kind: "write";
      /** Every node the write touches; a bulk-set's keys joined onto its base node. */
      paths: string[];
      bulk: boolean;
      /** A key the bridge cannot place (relative `..key`, or a `/#hash` node id). */
      unresolved: boolean;
    };

const READ_ARGS = new Set(["*", "?", "#"]);

/**
 * Sorts a client message into what the bridge must do with it. A bulk-set is a single string
 * argument holding `key=value` pairs; a plain SET or toggle (`-1`) is any other argument.
 */
export function classifyOscRequest(address: string, args: OscArgument[]): OscRequestKind {
  if (address === "/*s" || address === "/*S") return { kind: "subscribe", mode: address };
  // Binary subscriptions are not served, and a bare "/*" is the console's own ack address.
  if (address === "/*b" || address === "/*") return { kind: "ignore" };
  if (args.length === 0) return { kind: "read" };
  const unresolved = address.startsWith("/#");
  if (args.length === 1 && args[0]?.type === "s") {
    const text = String(args[0].value);
    if (READ_ARGS.has(text)) return { kind: "read" };
    const pairs = splitTopLevelAssignments(text).filter((pair) => pair.trim().length > 0);
    // Judged as a bulk-set as soon as ANY pair assigns: the console may apply the pairs that do even
    // when others don't parse, so "ch.5.fdr=-144,x" must not pass as a plain write to `address`.
    const assignments = pairs.filter((pair) => pair.includes("="));
    if (assignments.length > 0) {
      // A pair with no "=", or a key that is not a plain node path, cannot be placed: fail closed.
      let unplaceable = assignments.length !== pairs.length;
      const paths = assignments.map((pair) => {
        const key = pair.slice(0, pair.indexOf("=")).trim();
        if (key.startsWith(".") || !BULK_KEY.test(key)) unplaceable = true;
        return joinNodePath(address, key.replace(/^\.+/, ""));
      });
      return { kind: "write", paths, bulk: true, unresolved: unresolved || unplaceable };
    }
  }
  return { kind: "write", paths: [address], bulk: false, unresolved };
}

/** A bulk-set key the bridge can place: `fdr`, `$fdr`, `ch.5.fdr`, `send.MX1.lvl` (relative `..` keys are flagged apart). */
const BULK_KEY = /^\.*[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;

/** True when `path` names the console's root node (`/`, `//`, `/%9000/`...). */
function isRootPath(path: string): boolean {
  return normalizeBridgePath(path).length === 0;
}

/** `/%9000/ch/1/fdr` -> port 9000 and `/ch/1/fdr`: the console's "reply to this port instead". */
export function splitReplyPortPrefix(address: string): { replyPort: number | null; address: string } {
  const match = /^\/%(\d{1,5})(\/.*)$/.exec(address);
  if (!match) return { replyPort: null, address };
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return { replyPort: null, address };
  return { replyPort: port, address: match[2] as string };
}

/** `/ch/1/fdr` -> `/ch/1/$fdr`, the address the console's own pushes use. */
function shadowAddress(path: string): string {
  const idx = path.lastIndexOf("/");
  const last = path.slice(idx + 1);
  return last.startsWith("$") ? path : `${path.slice(0, idx + 1)}$${last}`;
}

interface ClientState extends BridgeOscClientInfo {
  subscriptionExpiresAt: number;
  upstream: dgram.Socket | null;
  /** Paths read back after a refused write, so their answer is also pushed to a subscriber. */
  snapBacks: Map<string, number>;
}

const MAX_SNAPBACK_PATHS = 16;
const MAX_CLIENTS_PER_ADDRESS = 8;
const MAX_CLIENTS = 64;

/**
 * The OSC side of the bridge (UDP, 2223 by default): apps talk to this server as if it were the
 * console.
 *
 * Requests go upstream on one socket per client, so the console's replies (which carry no request
 * id) route back to exactly the app that asked: the bridge never has to match them itself. The
 * console takes a single subscriber, which the plugin already holds, so `/*s` and `/*S` are never
 * forwarded: the bridge records them and fans the plugin's own pushes out (`handleConsolePush`).
 *
 * Writes are judged against the safe rules first. A refused one never reaches the console: a
 * bulk-set gets `PROTECTED` on `/*` as its ack, and a moment later the real value is read back to
 * the app (and pushed, if it subscribes) so its control snaps back to where the console is.
 */
export class WingBridgeOsc {
  private readonly opts: Required<Omit<WingBridgeOscOptions, "onBlocked" | "bindAddress">> &
    Pick<WingBridgeOscOptions, "onBlocked" | "bindAddress">;
  private socket: dgram.Socket | null = null;
  private boundPort = 0;
  private consoleSources: ConsoleSources = null;
  private readonly reportDrop: (address: string | undefined) => void;
  private readonly clients = new Map<string, ClientState>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stats = { messagesIn: 0, forwarded: 0, blocked: 0, pushesSent: 0, dropped: 0 };
  private lastError: string | null = null;

  constructor(opts: WingBridgeOscOptions) {
    this.opts = {
      idleTimeoutMs: 30_000,
      subscriptionTimeoutMs: 10_000,
      snapBackDelayMs: 120,
      maxClientsPerAddress: MAX_CLIENTS_PER_ADDRESS,
      maxClients: MAX_CLIENTS,
      ...opts,
    };
    this.reportDrop = createDropReporter("wing-bridge-osc", opts.consoleHost);
  }

  async start(): Promise<void> {
    this.consoleSources = await resolveConsoleSources(this.opts.consoleHost);
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(this.opts.port, this.opts.bindAddress || undefined, () => {
        socket.off("error", reject);
        resolve();
      });
    });
    socket.on("error", (err) => {
      this.lastError = err.message;
    });
    socket.on("message", (buf, rinfo) => this.onClientMessage(buf, rinfo));
    this.socket = socket;
    this.boundPort = (socket.address() as AddressInfo).port;
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(5_000, this.opts.idleTimeoutMs));
    this.sweepTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const client of this.clients.values()) this.closeUpstream(client);
    this.clients.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  get port(): number {
    return this.boundPort;
  }

  getClients(): BridgeOscClientInfo[] {
    const now = Date.now();
    return [...this.clients.values()].map((client) => ({
      address: client.address,
      port: client.port,
      firstSeenAt: client.firstSeenAt,
      lastSeenAt: client.lastSeenAt,
      messages: client.messages,
      writesForwarded: client.writesForwarded,
      writesBlocked: client.writesBlocked,
      subscription: client.subscription && client.subscriptionExpiresAt > now ? client.subscription : null,
    }));
  }

  getStats(): WingBridgeOscStats {
    return {
      listening: this.socket !== null,
      port: this.boundPort,
      upstreamSockets: [...this.clients.values()].filter((client) => client.upstream !== null).length,
      ...this.stats,
      lastError: this.lastError,
    };
  }

  /** One push from the plugin's own subscription, fanned out to every subscribed client. */
  handleConsolePush(address: string, args: OscArgument[]): void {
    if (!this.socket || address.startsWith("/*")) return;
    const now = Date.now();
    let full: Uint8Array | null = null;
    let compact: Uint8Array | null = null;
    for (const client of this.clients.values()) {
      if (!client.subscription || client.subscriptionExpiresAt <= now) continue;
      try {
        let packet: Uint8Array;
        if (client.subscription === "/*s") {
          packet = full ??= osc.writeMessage({ address, args }, { metadata: true });
        } else {
          // "/*S" is the bare value: the third member of a (display, raw, value) triplet.
          packet = compact ??= osc.writeMessage({ address, args: args.length === 3 ? [args[2] as OscArgument] : args }, { metadata: true });
        }
        this.sendToClient(client, packet);
        this.stats.pushesSent += 1;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  private onClientMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    this.stats.messagesIn += 1;
    let message: { address: string; args: OscArgument[] };
    try {
      const parsed = osc.readMessage(buf, { metadata: true });
      const args = Array.isArray(parsed.args) ? (parsed.args as OscArgument[]) : parsed.args ? [parsed.args as OscArgument] : [];
      message = { address: parsed.address, args };
    } catch {
      this.stats.dropped += 1;
      return;
    }
    if (typeof message.address !== "string" || !message.address.startsWith("/")) {
      this.stats.dropped += 1;
      return;
    }

    const { replyPort, address } = splitReplyPortPrefix(message.address);
    const client = this.clientFor(rinfo.address, replyPort ?? rinfo.port);
    if (!client) {
      this.stats.dropped += 1;
      return;
    }
    client.messages += 1;
    client.lastSeenAt = Date.now();

    const request = classifyOscRequest(address, message.args);
    switch (request.kind) {
      case "subscribe":
        client.subscription = request.mode;
        client.subscriptionExpiresAt = Date.now() + this.opts.subscriptionTimeoutMs;
        return;
      case "ignore":
        return;
      case "read":
        this.forward(client, replyPort === null ? buf : null, { address, args: message.args });
        return;
      case "write": {
        const reason = this.refusal(request, client);
        if (reason === null) {
          client.writesForwarded += 1;
          this.forward(client, replyPort === null ? buf : null, { address, args: message.args });
          return;
        }
        this.block(client, request, address, reason);
      }
    }
  }

  private refusal(request: Extract<OscRequestKind, { kind: "write" }>, client: { address: string }): string | null {
    const policy = this.opts.getPolicy(client);
    if (policy === null) return "identifying the device";
    if (policy.empty) return null;
    // A `/#<hash>` address or a relative key names no path. The native proxy's node map could place a
    // hash if hashes are native ids (unverified, A7 in docs/bridge.md); until then it is refused.
    if (request.unresolved) return "node not resolvable while strips are safe";
    // Only a bulk-set's keys can be judged under the root; anything else written there is not.
    if (request.paths.some(isRootPath)) return "write to the root not classifiable while strips are safe";
    for (const path of request.paths) {
      const reason = policy.refusalFor(path);
      if (reason !== null) return reason;
    }
    return null;
  }

  private block(client: ClientState, request: Extract<OscRequestKind, { kind: "write" }>, address: string, reason: string): void {
    client.writesBlocked += 1;
    this.stats.blocked += 1;
    this.opts.onBlocked?.({
      at: Date.now(),
      transport: "osc",
      client: `${client.address}:${client.port}`,
      path: request.bulk ? request.paths.join(", ") : address,
      reason,
    });
    if (request.bulk) {
      this.sendToClient(client, osc.writeMessage({ address: "/*", args: [{ type: "s", value: "PROTECTED" }] }, { metadata: true }));
    }
    const paths = request.unresolved ? [address] : request.paths;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      for (const path of paths.slice(0, MAX_SNAPBACK_PATHS)) {
        client.snapBacks.set(path, Date.now() + 2_000);
        this.forward(client, null, { address: path, args: [] });
      }
    }, this.opts.snapBackDelayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** The client replying to `address:port`, created if new; null when the client caps are reached. */
  private clientFor(address: string, port: number): ClientState | null {
    const key = `${address}:${port}`;
    let client = this.clients.get(key);
    if (!client) {
      const sameHost = [...this.clients.entries()].filter(([, c]) => c.address === address);
      if (sameHost.length >= this.opts.maxClientsPerAddress) {
        // The same device asking with yet another reply port: its oldest one goes.
        const [oldestKey, oldest] = sameHost.reduce((a, b) => (b[1].lastSeenAt < a[1].lastSeenAt ? b : a));
        this.closeUpstream(oldest);
        this.clients.delete(oldestKey);
      }
      if (this.clients.size >= this.opts.maxClients) {
        this.lastError = `too many OSC clients (${this.opts.maxClients}): ignoring ${key}`;
        return null;
      }
      const now = Date.now();
      client = {
        address,
        port,
        firstSeenAt: now,
        lastSeenAt: now,
        messages: 0,
        writesForwarded: 0,
        writesBlocked: 0,
        subscription: null,
        subscriptionExpiresAt: 0,
        upstream: null,
        snapBacks: new Map(),
      };
      this.clients.set(key, client);
    }
    return client;
  }

  /** Sends `raw` as is when it can, otherwise re-encodes `message` (a `/%port/` prefix was removed). */
  private forward(client: ClientState, raw: Buffer | null, message: { address: string; args: OscArgument[] }): void {
    // A client let go meanwhile (cap eviction, idle sweep) gets no new upstream socket from a late snap-back.
    if (!this.opts.consoleHost || this.clients.get(`${client.address}:${client.port}`) !== client) {
      this.stats.dropped += 1;
      return;
    }
    let payload: Uint8Array;
    try {
      payload = raw ?? osc.writeMessage(message, { metadata: true });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.stats.dropped += 1;
      return;
    }
    const upstream = this.upstreamFor(client);
    try {
      upstream.send(payload, this.opts.consolePort, this.opts.consoleHost, (err) => {
        if (err) this.lastError = err.message;
      });
      this.stats.forwarded += 1;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private upstreamFor(client: ClientState): dgram.Socket {
    if (client.upstream) return client.upstream;
    const upstream = dgram.createSocket("udp4");
    upstream.on("error", (err) => {
      this.lastError = err.message;
    });
    upstream.on("message", (buf, rinfo) => {
      if (!isFromConsole(this.consoleSources, rinfo.address)) {
        this.reportDrop(rinfo.address);
        return;
      }
      this.sendToClient(client, buf);
      if (client.snapBacks.size > 0) this.pushSnapBack(client, buf);
    });
    upstream.bind(0);
    upstream.unref();
    client.upstream = upstream;
    return upstream;
  }

  /** The answer to a snap-back read, also delivered as a push to a client that subscribes. */
  private pushSnapBack(client: ClientState, buf: Buffer): void {
    let reply: { address: string; args: OscArgument[] };
    try {
      const parsed = osc.readMessage(buf, { metadata: true });
      reply = { address: parsed.address, args: Array.isArray(parsed.args) ? (parsed.args as OscArgument[]) : [] };
    } catch {
      return;
    }
    const expiresAt = client.snapBacks.get(reply.address);
    if (expiresAt === undefined) return;
    client.snapBacks.delete(reply.address);
    if (expiresAt < Date.now() || !client.subscription || client.subscriptionExpiresAt < Date.now()) return;
    const args = client.subscription === "/*S" && reply.args.length === 3 ? [reply.args[2] as OscArgument] : reply.args;
    try {
      this.sendToClient(client, osc.writeMessage({ address: shadowAddress(reply.address), args }, { metadata: true }));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private sendToClient(client: ClientState, payload: Uint8Array): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(payload, client.port, client.address, (err) => {
        if (err) this.lastError = err.message;
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private closeUpstream(client: ClientState): void {
    if (!client.upstream) return;
    try {
      client.upstream.close();
    } catch {
      // Already closed.
    }
    client.upstream = null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, client] of this.clients) {
      for (const [path, expiresAt] of client.snapBacks) if (expiresAt < now) client.snapBacks.delete(path);
      if (now - client.lastSeenAt < this.opts.idleTimeoutMs) continue;
      this.closeUpstream(client);
      if (!client.subscription || client.subscriptionExpiresAt <= now) this.clients.delete(key);
    }
  }
}
