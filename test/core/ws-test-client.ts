import { decode, encode } from "@msgpack/msgpack";
import WebSocket from "ws";

/**
 * A small promise-based WebSocket client for the hub's tests: opens with a subprotocol, decodes
 * every frame with the matching codec, and lets a test await the next message matching a predicate.
 */
export type WireMessage = Record<string, unknown> & { t: string };

export interface TestSocket {
  ws: WebSocket;
  codec: "msgpack" | "json";
  /** Every decoded message received so far, in order. */
  received: WireMessage[];
  send(message: unknown): void;
  sendRaw(data: string | Buffer, binary: boolean): void;
  next(predicate?: (m: WireMessage) => boolean, timeoutMs?: number): Promise<WireMessage>;
  closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

export interface OpenOptions {
  ticket?: string;
  protocol?: string | string[];
  origin?: string;
  path?: string;
  autoPong?: boolean;
  perMessageDeflate?: boolean;
  headers?: Record<string, string>;
}

/** Resolves with the HTTP status when the server refuses the upgrade. */
export function expectRefusal(port: number, opts: OpenOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildUrl(port, opts), opts.protocol ?? [], wsOptions(opts));
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      ws.terminate();
    });
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("expected the upgrade to be refused, but it was accepted"));
    });
    ws.on("error", () => undefined);
  });
}

export function openSocket(port: number, opts: OpenOptions): Promise<TestSocket> {
  const protocol = typeof opts.protocol === "string" ? opts.protocol : (opts.protocol?.[0] ?? "");
  const codec = protocol.endsWith(".json") ? "json" : "msgpack";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildUrl(port, opts), opts.protocol ?? [], wsOptions(opts));
    const received: WireMessage[] = [];
    const waiters: { predicate: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void }[] = [];
    let consumed = 0;

    const closed = new Promise<{ code: number; reason: string }>((resolveClosed) => {
      ws.on("close", (code, reason) => resolveClosed({ code, reason: reason.toString() }));
    });

    ws.on("message", (data: Buffer, isBinary) => {
      // A frame of the wrong kind is recorded as such, for the test to fail on, rather than thrown.
      const message =
        codec === "json" && isBinary
          ? { t: "<binary frame on a json connection>" }
          : ((codec === "json" ? JSON.parse(data.toString("utf8")) : decode(data)) as WireMessage);
      received.push(message);
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].predicate(message)) {
          const [waiter] = waiters.splice(i, 1);
          waiter.resolve(message);
          return;
        }
      }
    });
    ws.on("error", reject);
    ws.on("unexpected-response", (_req, res) => reject(new Error("upgrade refused: " + res.statusCode)));
    ws.on("open", () => {
      resolve({
        ws,
        codec,
        received,
        send(message) {
          ws.send(codec === "json" ? JSON.stringify(message) : encode(message), { binary: codec !== "json" });
        },
        sendRaw(data, binary) {
          ws.send(data, { binary });
        },
        next(predicate = () => true, timeoutMs = 2000) {
          // Messages already received but not yet consumed by an earlier next() are matched first.
          for (let i = consumed; i < received.length; i++) {
            if (predicate(received[i])) {
              consumed = i + 1;
              return Promise.resolve(received[i]);
            }
          }
          return new Promise((resolveNext, rejectNext) => {
            const timer = setTimeout(() => rejectNext(new Error("timed out waiting for a message")), timeoutMs);
            waiters.push({
              predicate,
              resolve: (m) => {
                clearTimeout(timer);
                consumed = received.length;
                resolveNext(m);
              },
            });
          });
        },
        closed,
        async close() {
          if (ws.readyState === WebSocket.CLOSED) return;
          ws.close();
          // A peer that stopped reading never completes the closing handshake.
          const timer = setTimeout(() => ws.terminate(), 500);
          await closed;
          clearTimeout(timer);
        },
      });
    });
  });
}

function buildUrl(port: number, opts: OpenOptions): string {
  const url = new URL(`ws://127.0.0.1:${port}${opts.path ?? "/api/ws"}`);
  if (opts.ticket !== undefined) url.searchParams.set("ticket", opts.ticket);
  return url.toString();
}

function wsOptions(opts: OpenOptions): WebSocket.ClientOptions {
  return {
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    autoPong: opts.autoPong ?? true,
    perMessageDeflate: opts.perMessageDeflate ?? true,
  };
}
