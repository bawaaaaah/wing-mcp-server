import http, { type Server as HttpServer } from "node:http";
import { duplexPair } from "node:stream";
import type { WsRestRequest, WsRestResponse } from "./ws-hub.js";

/**
 * REST over WebSocket: a `req` from a control connection is replayed as a real HTTP request into
 * this server's own HTTP listener, over an in-memory stream pair rather than a socket. It goes
 * through Node's HTTP parser and the whole Express stack exactly like any other request, with the
 * connection's own credential: every route's auth, rate limit, body parsing, validation and write
 * semantics apply unchanged, and no route knows or cares which transport it was reached by.
 *
 * (Not light-my-request: to inject into an Express app it rewrites Express's shared request and
 * response prototypes, which breaks every real HTTP request the same app serves afterwards.)
 */
export function replayThroughServer(server: HttpServer, req: WsRestRequest): Promise<WsRestResponse> {
  return new Promise<WsRestResponse>((resolve, reject) => {
    const [clientSide, serverSide] = duplexPair();
    // What Express reads req.ip (and the rate limiter its bucket) from, absent trust proxy.
    Object.defineProperty(serverSide, "remoteAddress", { value: req.remoteAddress });
    server.emit("connection", serverSide);

    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) search.append(key, item);
    }
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);

    const outgoing = http.request(
      {
        method: req.method,
        path: req.path + (search.size > 0 ? "?" + search.toString() : ""),
        headers: {
          ...req.headers,
          authorization: "Bearer " + req.credential,
          connection: "close",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        createConnection: () => clientSide as never,
        signal: req.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          if (text.length > 0) {
            try {
              parsed = String(res.headers["content-type"] ?? "").includes("json") ? (JSON.parse(text) as unknown) : text;
            } catch {
              parsed = text;
            }
          }
          resolve({ status: res.statusCode ?? 500, body: parsed });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
