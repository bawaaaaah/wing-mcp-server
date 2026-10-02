import { decode, encode } from "@msgpack/msgpack";
import { apiFetch } from "./client.js";

// The dashboard's side of the WebSocket protocol (docs/websocket-protocol.md): one connection per
// channel per tab, opened while something subscribes to it and closed a little after the last
// subscriber leaves. Components never touch a socket; they subscribe to a topic through the hooks
// in useLive.ts, and every subscription to the same topic is folded into one `sub` on the wire.

export type LiveChannel = "control" | "stream";
export type LiveStatus = "idle" | "connecting" | "open";

const PROTOCOL_VERSION = 1;
/** Retry delays after a connection drops, capped at the last one. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 15_000];
/** How long a connection with no subscriber stays open, so switching tabs does not churn sockets. */
const IDLE_CLOSE_MS = 5000;
/** A little over the server's own 60s bound on a replayed request. */
const REQUEST_TIMEOUT_MS = 65_000;

export interface LiveResponse {
  status: number;
  body: unknown;
}

/**
 * Why a request over the socket did not get a response. `notSent`: the server refused it without
 * running it (busy, forbidden, invalid) or it never left — safe to send again over HTTP. Otherwise
 * the route may or may not have run.
 */
export class LiveRequestError extends Error {
  constructor(
    message: string,
    readonly notSent: boolean,
  ) {
    super(message);
    this.name = "LiveRequestError";
  }
}

interface PendingRequest {
  resolve: (response: LiveResponse) => void;
  reject: (err: LiveRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

type WireMessage = Record<string, unknown> & { t: string };

/** How a topic's subscribers' params are folded into the one `sub` sent for it. */
export type ParamsMerger = (all: unknown[]) => unknown;

interface Subscriber {
  params: unknown;
  onEvent: (data: unknown, ack: unknown) => void;
}

interface TopicState {
  subscribers: Set<Subscriber>;
  merge?: ParamsMerger;
  /** The params last sent for this topic, serialized; undefined when nothing was sent yet. */
  sentParams: string | undefined;
  /** The topic's last `ack` data (the meter column layout, for instance). */
  ack: unknown;
}

class LiveConnection {
  private ws: WebSocket | undefined;
  private status: LiveStatus = "idle";
  private readonly topics = new Map<string, TopicState>();
  private readonly statusListeners = new Set<(status: LiveStatus) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private nextId = 1;
  private attempt = 0;
  private everOpened = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private flushQueued = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly channel: LiveChannel) {}

  getStatus(): LiveStatus {
    return this.status;
  }

  onStatus(listener: (status: LiveStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Called after a *re*-open: events published while the connection was down were missed. */
  onReconnected(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  subscribe(topic: string, subscriber: Subscriber, merge?: ParamsMerger): () => void {
    let state = this.topics.get(topic);
    if (!state) {
      state = { subscribers: new Set(), merge, sentParams: undefined, ack: undefined };
      this.topics.set(topic, state);
    }
    state.subscribers.add(subscriber);
    this.ensureOpen();
    this.queueFlush();
    return () => {
      state.subscribers.delete(subscriber);
      this.queueFlush();
      if (this.subscriberCount() === 0) this.scheduleIdleClose();
    };
  }

  /**
   * REST over WebSocket (docs/websocket-protocol.md): runs `method path` through the server's own
   * routes on this connection. Only valid while the connection is open — callers check getStatus()
   * and use HTTP otherwise.
   */
  request(method: string, path: string, query: Record<string, string> | undefined, body: unknown): Promise<LiveResponse> {
    if (this.status !== "open" || this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new LiveRequestError("the live connection is not open", true));
    }
    const id = this.nextId++;
    return new Promise<LiveResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LiveRequestError(`${method} ${path}: no response within ${REQUEST_TIMEOUT_MS / 1000}s`, false));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const message: WireMessage = { t: "req", id, method, path };
      if (query) message.query = query;
      if (body !== undefined) message.body = body;
      this.send(message);
    });
  }

  private settle(id: unknown, outcome: { response: LiveResponse } | { error: LiveRequestError }): boolean {
    const pending = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!pending) return false;
    this.pending.delete(id as number);
    clearTimeout(pending.timer);
    if ("response" in outcome) pending.resolve(outcome.response);
    else pending.reject(outcome.error);
    return true;
  }

  /** The connection dropped: nobody will answer what is still pending. */
  private failPending(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new LiveRequestError("the live connection closed before the response", false));
      this.pending.delete(id);
    }
  }

  private subscriberCount(): number {
    let count = 0;
    for (const state of this.topics.values()) count += state.subscribers.size;
    return count;
  }

  /** Many components mount in the same tick (a strip row, a meter grid): send one `sub` for all. */
  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.status !== "open") return;
    for (const [topic, state] of this.topics) {
      if (state.subscribers.size === 0) {
        if (state.sentParams !== undefined) this.send({ t: "unsub", id: this.nextId++, topic });
        this.topics.delete(topic);
        continue;
      }
      const params = state.merge ? state.merge([...state.subscribers].map((s) => s.params)) : undefined;
      const serialized = JSON.stringify(params ?? null);
      if (serialized === state.sentParams) continue;
      state.sentParams = serialized;
      this.send(params === undefined ? { t: "sub", id: this.nextId++, topic } : { t: "sub", id: this.nextId++, topic, params });
    }
  }

  private setStatus(status: LiveStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private ensureOpen(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.status !== "idle") return;
    void this.connect();
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.subscriberCount() > 0) return;
      this.shutdown();
    }, IDLE_CLOSE_MS);
  }

  private shutdown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
    this.failPending();
    this.everOpened = false;
    this.attempt = 0;
    this.setStatus("idle");
  }

  private scheduleReconnect(): void {
    if (this.subscriberCount() === 0) {
      this.shutdown();
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt += 1;
    this.setStatus("connecting");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    this.setStatus("connecting");
    let ticket: string;
    try {
      ({ ticket } = await apiFetch<{ ticket: string }>("/api/auth/ws-ticket", { method: "POST" }));
    } catch (err) {
      console.error(`liveSocket(${this.channel}): failed to obtain a ticket`, err);
      this.scheduleReconnect();
      return;
    }
    if (this.status !== "connecting") return;

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, `wing.${this.channel}.v${PROTOCOL_VERSION}.msgpack`);
    } catch (err) {
      console.error(`liveSocket(${this.channel}): failed to open`, err);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      let message: WireMessage;
      try {
        message = decode(new Uint8Array(event.data as ArrayBuffer)) as WireMessage;
      } catch (err) {
        console.error(`liveSocket(${this.channel}): undecodable frame`, err);
        return;
      }
      this.onMessage(message);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.failPending();
      for (const state of this.topics.values()) state.sentParams = undefined;
      this.scheduleReconnect();
    };
    // Followed by onclose, which handles the retry.
    ws.onerror = () => undefined;
  }

  private onMessage(message: WireMessage): void {
    switch (message.t) {
      case "hello": {
        this.attempt = 0;
        this.setStatus("open");
        const reopened = this.everOpened;
        this.everOpened = true;
        this.flush();
        if (reopened) for (const listener of this.reconnectListeners) listener();
        return;
      }
      case "ack": {
        const state = this.topics.get(String(message.topic));
        if (state && message.data !== undefined) state.ack = message.data;
        return;
      }
      case "evt": {
        const state = this.topics.get(String(message.topic));
        if (!state) return;
        for (const subscriber of state.subscribers) {
          try {
            subscriber.onEvent(message.data, state.ack);
          } catch (err) {
            console.error(`liveSocket(${this.channel}): a ${String(message.topic)} subscriber failed`, err);
          }
        }
        return;
      }
      case "res":
        this.settle(message.id, { response: { status: Number(message.status), body: message.body } });
        return;
      case "err": {
        // A refused or timed-out request: "timeout" means the route ran, or may still be running.
        const notSent = message.error !== "timeout";
        const detail = typeof message.detail === "string" ? ": " + message.detail : "";
        const error = new LiveRequestError(String(message.error) + detail, notSent);
        if (!this.settle(message.id, { error })) {
          console.error(`liveSocket(${this.channel}): server refused a message`, message);
        }
        return;
      }
    }
  }

  private send(message: WireMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(message));
  }
}

const connections: Record<LiveChannel, LiveConnection> = {
  control: new LiveConnection("control"),
  stream: new LiveConnection("stream"),
};

export function liveConnection(channel: LiveChannel): LiveConnection {
  return connections[channel];
}
