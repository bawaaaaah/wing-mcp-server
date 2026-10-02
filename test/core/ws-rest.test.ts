import { expect } from "chai";
import express, { type Express } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAuthMiddleware } from "../../src/core/auth.js";
import { EventBus } from "../../src/core/event-bus.js";
import { errorHandler, HttpError } from "../../src/core/http-errors.js";
import { createRateLimit } from "../../src/core/rate-limit.js";
import { WsHub, type WsRestRequest, type WsRestResponse } from "../../src/core/ws-hub.js";
import { replayThroughServer } from "../../src/core/ws-rest.js";
import { openSocket, type TestSocket } from "./ws-test-client.js";

const TOKEN = "ws-rest-test-token";

interface Harness {
  port: number;
  hub: WsHub;
  sessions: Set<string>;
  ticket(credential?: string): string;
  close(): Promise<void>;
}

function buildApp(auth: ReturnType<typeof createAuthMiddleware>, opts: { trustProxy?: number } = {}): Express {
  const app = express();
  if (opts.trustProxy !== undefined) app.set("trust proxy", opts.trustProxy);
  app.use(createRateLimit({ windowMs: 60_000, max: 3, countResponse: (res) => res.statusCode === 401 }));
  const requireAuth = auth.requireAuth();
  app.get("/api/echo/:id", requireAuth, (req, res) => {
    res.json({ id: req.params.id, query: req.query, ip: req.ip, kind: auth.authKind(req) });
  });
  app.post("/api/items", requireAuth, express.json(), (req, res, next) => {
    const body = req.body as { name?: unknown };
    if (typeof body?.name !== "string") {
      next(new HttpError(400, "name must be a string"));
      return;
    }
    res.status(201).json({ created: body.name });
  });
  app.delete("/api/items/:id", requireAuth, (_req, res) => res.status(204).end());
  app.get("/api/text", requireAuth, (_req, res) => res.type("text/plain").send("plain"));
  app.get("/api/auth/whatever", (_req, res) => res.json({ reached: true }));
  app.use(errorHandler());
  return app;
}

async function startHarness(
  opts: { trustProxy?: number; handleRequest?: (req: WsRestRequest) => Promise<WsRestResponse>; requestTimeoutMs?: number } = {},
): Promise<Harness & { httpPort: number }> {
  const sessions = new Set<string>();
  const auth = createAuthMiddleware(TOKEN, { isValidSessionToken: (candidate) => sessions.has(candidate) });
  const app = buildApp(auth, opts);
  const server = http.createServer(app);
  const hub = new WsHub({
    plugins: [],
    eventBus: new EventBus(),
    auth,
    handleRequest: opts.handleRequest ?? ((req) => replayThroughServer(server, req)),
    requestTimeoutMs: opts.requestTimeoutMs,
  });
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    httpPort: port,
    hub,
    sessions,
    ticket: (credential = TOKEN) => auth.issueStreamTicket(credential),
    async close() {
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("REST over WebSocket", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  const sockets: TestSocket[] = [];

  const open = async (protocol = "wing.control.v1.json", credential?: string) => {
    const socket = await openSocket(h.port, { ticket: h.ticket(credential), protocol });
    sockets.push(socket);
    await socket.next((m) => m.t === "hello");
    return socket;
  };
  const call = async (socket: TestSocket, id: number, req: Record<string, unknown>) => {
    socket.send({ t: "req", id, ...req });
    return socket.next((m) => (m.t === "res" || m.t === "err") && m.id === id);
  };

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await h.close();
  });

  describe("through the real routes", () => {
    beforeEach(async () => {
      h = await startHarness();
    });

    it("answers a GET with the same status and body as plain HTTP", async () => {
      const socket = await open("wing.control.v1.msgpack");
      const viaWs = await call(socket, 1, { method: "GET", path: "/api/echo/7", query: { x: "1" } });
      const viaHttp = await fetch(`http://127.0.0.1:${h.httpPort}/api/echo/7?x=1`, { headers: { authorization: "Bearer " + TOKEN } });
      expect(viaWs).to.deep.equal({ t: "res", id: 1, status: viaHttp.status, body: await viaHttp.json() });
    });

    it("runs a POST body through the route's own parsing and validation", async () => {
      const socket = await open();
      expect(await call(socket, 1, { method: "POST", path: "/api/items", body: { name: "kick" } })).to.deep.include({ status: 201, body: { created: "kick" } });
      expect(await call(socket, 2, { method: "POST", path: "/api/items", body: { name: 3 } })).to.deep.include({
        status: 400,
        body: { error: "name must be a string" },
      });
    });

    it("carries a 204 as a null body and a non-JSON body as text", async () => {
      const socket = await open();
      expect(await call(socket, 1, { method: "DELETE", path: "/api/items/9" })).to.deep.include({ status: 204, body: null });
      expect(await call(socket, 2, { method: "GET", path: "/api/text" })).to.deep.include({ status: 200, body: "plain" });
    });

    it("authenticates as the credential that minted the ticket, and 401s once a passkey session is revoked", async () => {
      h.sessions.add("session-a");
      const socket = await open("wing.control.v1.json", "session-a");
      expect(((await call(socket, 1, { method: "GET", path: "/api/echo/1" })).body as { kind: string }).kind).to.equal("session");
      h.sessions.delete("session-a");
      expect(await call(socket, 2, { method: "GET", path: "/api/echo/1" })).to.deep.include({ status: 401 });
    });

    it("is subject to the rate limiter, per client address", async () => {
      h.sessions.add("session-b");
      const socket = await open("wing.control.v1.json", "session-b");
      h.sessions.delete("session-b");
      const statuses: number[] = [];
      for (let id = 1; id <= 5; id++) statuses.push(Number((await call(socket, id, { method: "GET", path: "/api/echo/1" })).status));
      expect(statuses).to.deep.equal([401, 401, 401, 429, 429]);
    });

    it("sees the client's own address", async () => {
      const socket = await open();
      const { body } = await call(socket, 1, { method: "GET", path: "/api/echo/1" });
      expect((body as { ip: string }).ip).to.match(/127\.0\.0\.1$/);
    });

    for (const path of ["/api/auth/whatever", "/API/Auth/whatever", "/api//auth/whatever", "/api/%61uth/whatever", "/api/ws", "/mcp", "/api/../mcp", "/api/echo/1?x=1", "/api/%zz"]) {
      it(`refuses the path ${path}`, async () => {
        const socket = await open();
        expect(await call(socket, 1, { method: "GET", path })).to.deep.include({ t: "err", error: "invalid-message" });
      });
    }

    it("refuses a request on a stream connection", async () => {
      const socket = await open("wing.stream.v1.json");
      expect(await call(socket, 1, { method: "GET", path: "/api/echo/1" })).to.deep.include({ t: "err", error: "forbidden" });
    });
  });

  describe("behind a proxy", () => {
    beforeEach(async () => {
      h = await startHarness({ trustProxy: 1 });
    });

    it("derives the client address from the upgrade's X-Forwarded-For under trust proxy", async () => {
      const socket = await openSocket(h.port, {
        ticket: h.ticket(),
        protocol: "wing.control.v1.json",
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      sockets.push(socket);
      await socket.next((m) => m.t === "hello");
      const { body } = await call(socket, 1, { method: "GET", path: "/api/echo/1" });
      expect((body as { ip: string }).ip).to.equal("203.0.113.7");
    });
  });

  describe("bounds", () => {
    it("matches replies to their ids when they complete out of order", async () => {
      h = await startHarness({
        handleRequest: async (req) => {
          await delay(req.path === "/api/slow" ? 100 : 5);
          return { status: 200, body: req.path };
        },
      });
      const socket = await open();
      socket.send({ t: "req", id: 1, method: "GET", path: "/api/slow" });
      socket.send({ t: "req", id: 2, method: "GET", path: "/api/fast" });
      const first = await socket.next((m) => m.t === "res");
      const second = await socket.next((m) => m.t === "res");
      expect([first.id, first.body]).to.deep.equal([2, "/api/fast"]);
      expect([second.id, second.body]).to.deep.equal([1, "/api/slow"]);
    });

    it("answers busy past 32 requests in flight, and timeout when one never completes", async () => {
      h = await startHarness({ handleRequest: () => new Promise(() => undefined), requestTimeoutMs: 300 });
      const socket = await open();
      for (let id = 1; id <= 33; id++) socket.send({ t: "req", id, method: "GET", path: "/api/hang" });
      expect(await socket.next((m) => m.t === "err" && m.id === 33)).to.deep.include({ error: "busy" });
      expect(await socket.next((m) => m.t === "err" && m.id === 1, 2000)).to.deep.include({ error: "timeout" });
      // Slots free up once the timeouts fire.
      await delay(50);
      socket.send({ t: "req", id: 34, method: "GET", path: "/api/hang" });
      expect(await socket.next((m) => m.id === 34, 2000)).to.deep.include({ error: "timeout" });
    });

    it("turns a handler that throws into a 500", async () => {
      const originalError = console.error;
      console.error = () => undefined;
      try {
        h = await startHarness({
          handleRequest: () => {
            throw new Error("kaboom");
          },
        });
        const socket = await open();
        expect(await call(socket, 1, { method: "GET", path: "/api/x" })).to.deep.include({ status: 500, body: { error: "internal error" } });
      } finally {
        console.error = originalError;
      }
    });

    it("drops the reply of a client that left mid-request, without an error", async () => {
      let finished = false;
      h = await startHarness({
        handleRequest: async () => {
          await delay(100);
          finished = true;
          return { status: 200, body: "late" };
        },
      });
      const socket = await open();
      socket.send({ t: "req", id: 1, method: "GET", path: "/api/x" });
      await delay(10);
      await socket.close();
      await delay(150);
      expect(finished).to.equal(true);
      expect(h.hub.connectionCount).to.equal(0);
    });
  });
});
