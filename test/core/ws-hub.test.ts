import { expect } from "chai";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAuthMiddleware } from "../../src/core/auth.js";
import { EventBus } from "../../src/core/event-bus.js";
import type { LiveTopic, McpPlugin } from "../../src/core/plugin.js";
import { WS_CLOSE, WS_SOFT_LIMIT_BYTES, WsHub } from "../../src/core/ws-hub.js";
import { expectRefusal, openSocket, type TestSocket } from "./ws-test-client.js";

const TOKEN = "ws-hub-test-token";
const CONTROL = "wing.control.v1.json";
const CONTROL_MSGPACK = "wing.control.v1.msgpack";
const STREAM = "wing.stream.v1.json";
const STREAM_MSGPACK = "wing.stream.v1.msgpack";

/** The parts of McpPlugin the hub reads: an id and its topics. */
function topicPlugin(id: string, topics: Record<string, LiveTopic>): McpPlugin {
  return { id, liveTopics: () => topics } as unknown as McpPlugin;
}

interface Harness {
  port: number;
  bus: EventBus;
  hub: WsHub;
  sessions: Set<string>;
  ticket(credential?: string): string;
  publish(type: string, payload: unknown, pluginId?: string): void;
  close(): Promise<void>;
}

async function startHarness(
  opts: { heartbeatIntervalMs?: number; streamStallTimeoutMs?: number; topics?: Record<string, LiveTopic> } = {},
): Promise<Harness> {
  const sessions = new Set<string>();
  const auth = createAuthMiddleware(TOKEN, { isValidSessionToken: (candidate) => sessions.has(candidate) });
  const bus = new EventBus();
  const topics: Record<string, LiveTopic> = opts.topics ?? {
    "param-change": { channel: "control" },
    blob: { channel: "control" },
    levels: {
      channel: "stream",
      source: "meters",
      subscribe: (params) => {
        const { only } = (params ?? {}) as { only?: unknown };
        if (only !== undefined && typeof only !== "number") throw new Error("only must be a number");
        return { key: String(only ?? "all"), params: only, ack: { columns: ["level"] } };
      },
      encode: (payload, only) => {
        const levels = payload as number[];
        if (only === undefined) return levels;
        return levels[only as number] === undefined ? null : [levels[only as number]];
      },
    },
    explode: {
      channel: "stream",
      source: "meters",
      encode: () => {
        throw new Error("boom");
      },
    },
    bulk: { channel: "stream", compress: false },
  };
  const hub = new WsHub({
    plugins: [topicPlugin("wing", topics)],
    eventBus: bus,
    auth,
    allowedOrigins: ["https://allowed.example"],
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    streamStallTimeoutMs: opts.streamStallTimeoutMs ?? 200,
  });
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    bus,
    hub,
    sessions,
    ticket: (credential = TOKEN) => auth.issueStreamTicket(credential),
    publish: (type, payload, pluginId = "wing") => bus.publish({ pluginId, type, payload, timestamp: 42 }),
    async close() {
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The server side of the first connection opened with `protocol`, for tests that need to reach in. */
function serverSide(hub: WsHub, protocol: string): { ws: { bufferedAmount: number; send: unknown; protocol: string } } | undefined {
  const connections = (hub as unknown as { connections: Set<{ ws: { bufferedAmount: number; send: unknown; protocol: string } }> }).connections;
  return [...connections].find((conn) => conn.ws.protocol === protocol);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WsHub", () => {
  let h: Harness;
  const sockets: TestSocket[] = [];
  const open = async (protocol: string, extra: { origin?: string; autoPong?: boolean; perMessageDeflate?: boolean } = {}) => {
    const socket = await openSocket(h.port, { ticket: h.ticket(), protocol, ...extra });
    sockets.push(socket);
    await socket.next((m) => m.t === "hello");
    return socket;
  };

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close().catch(() => undefined)));
    await h.close();
  });

  describe("handshake", () => {
    it("refuses an upgrade without a ticket", async () => {
      expect(await expectRefusal(h.port, { protocol: CONTROL })).to.equal(401);
    });

    it("refuses a ticket that was already spent", async () => {
      const ticket = h.ticket();
      const first = await openSocket(h.port, { ticket, protocol: CONTROL });
      sockets.push(first);
      expect(await expectRefusal(h.port, { ticket, protocol: CONTROL })).to.equal(401);
    });

    it("refuses the real token passed as a ticket", async () => {
      expect(await expectRefusal(h.port, { ticket: TOKEN, protocol: CONTROL })).to.equal(401);
    });

    it("refuses a ticket minted by a passkey session that has since been revoked", async () => {
      h.sessions.add("session-1");
      const ticket = h.ticket("session-1");
      h.sessions.delete("session-1");
      expect(await expectRefusal(h.port, { ticket, protocol: CONTROL })).to.equal(401);
    });

    it("refuses another path", async () => {
      expect(await expectRefusal(h.port, { ticket: h.ticket(), protocol: CONTROL, path: "/api/other" })).to.equal(404);
    });

    it("refuses a missing or unknown subprotocol", async () => {
      expect(await expectRefusal(h.port, { ticket: h.ticket() })).to.equal(400);
      expect(await expectRefusal(h.port, { ticket: h.ticket(), protocol: "wing.control.v9.json" })).to.equal(400);
    });

    it("refuses a foreign Origin and accepts a same-host or allowlisted one", async () => {
      expect(await expectRefusal(h.port, { ticket: h.ticket(), protocol: CONTROL, origin: "https://evil.example" })).to.equal(403);
      await open(CONTROL, { origin: `http://127.0.0.1:${h.port}` });
      await open(CONTROL, { origin: "https://allowed.example" });
    });

    it("greets each channel with the topics it may subscribe to", async () => {
      const control = await openSocket(h.port, { ticket: h.ticket(), protocol: CONTROL });
      const stream = await openSocket(h.port, { ticket: h.ticket(), protocol: STREAM });
      sockets.push(control, stream);
      const controlHello = await control.next((m) => m.t === "hello");
      const streamHello = await stream.next((m) => m.t === "hello");
      expect(control.ws.protocol).to.equal(CONTROL);
      expect(controlHello).to.deep.include({ v: 1, channel: "control" });
      expect(controlHello.topics).to.have.members(["wing:param-change", "wing:blob"]);
      expect(streamHello.topics).to.have.members(["wing:levels", "wing:explode", "wing:bulk"]);
    });

    it("negotiates permessage-deflate", async () => {
      const socket = await open(CONTROL);
      expect(socket.ws.extensions).to.include("permessage-deflate");
    });
  });

  describe("subscriptions", () => {
    for (const protocol of [CONTROL, CONTROL_MSGPACK]) {
      it(`delivers a subscribed control topic (${protocol})`, async () => {
        const socket = await open(protocol);
        socket.send({ t: "sub", id: 1, topic: "wing:param-change" });
        expect(await socket.next((m) => m.t === "ack")).to.deep.equal({ t: "ack", id: 1, topic: "wing:param-change" });
        h.publish("param-change", { path: "/ch/1/fdr", value: -3 });
        const evt = await socket.next((m) => m.t === "evt");
        expect(evt).to.deep.equal({ t: "evt", topic: "wing:param-change", ts: 42, data: { path: "/ch/1/fdr", value: -3 } });
      });
    }

    it("sends nothing for a topic nobody subscribed to, nor another plugin's events", async () => {
      const socket = await open(CONTROL);
      socket.send({ t: "sub", id: 1, topic: "wing:param-change" });
      await socket.next((m) => m.t === "ack");
      h.publish("blob", { x: 1 });
      h.publish("param-change", { x: 2 }, "other-plugin");
      await delay(50);
      expect(socket.received.filter((m) => m.t === "evt")).to.deep.equal([]);
    });

    it("stops delivering after unsub", async () => {
      const socket = await open(CONTROL);
      socket.send({ t: "sub", id: 1, topic: "wing:param-change" });
      await socket.next((m) => m.t === "ack");
      socket.send({ t: "unsub", id: 2, topic: "wing:param-change" });
      await socket.next((m) => m.t === "ack" && m.id === 2);
      h.publish("param-change", { x: 1 });
      await delay(50);
      expect(socket.received.filter((m) => m.t === "evt")).to.deep.equal([]);
    });

    it("refuses a stream topic on a control connection and a control topic on a stream one", async () => {
      const control = await open(CONTROL);
      control.send({ t: "sub", id: 1, topic: "wing:levels" });
      expect(await control.next((m) => m.t === "err")).to.deep.include({ id: 1, error: "forbidden" });

      const stream = await open(STREAM);
      stream.send({ t: "sub", id: 1, topic: "wing:param-change" });
      expect(await stream.next((m) => m.t === "err")).to.deep.include({ id: 1, error: "forbidden" });
    });

    it("refuses an unknown topic", async () => {
      const socket = await open(CONTROL);
      socket.send({ t: "sub", id: 7, topic: "wing:nope" });
      expect(await socket.next((m) => m.t === "err")).to.deep.include({ id: 7, error: "unknown-topic" });
    });

    it("passes params to the topic, returns its ack data, and filters per subscriber", async () => {
      const all = await open(STREAM);
      const one = await open(STREAM_MSGPACK);
      all.send({ t: "sub", id: 1, topic: "wing:levels" });
      one.send({ t: "sub", id: 1, topic: "wing:levels", params: { only: 1 } });
      expect(await all.next((m) => m.t === "ack")).to.deep.equal({ t: "ack", id: 1, topic: "wing:levels", data: { columns: ["level"] } });
      await one.next((m) => m.t === "ack");

      h.publish("meters", [-10, -20, -30]);
      expect((await all.next((m) => m.t === "evt")).data).to.deep.equal([-10, -20, -30]);
      expect((await one.next((m) => m.t === "evt")).data).to.deep.equal([-20]);
    });

    it("rejects invalid params with the topic's message", async () => {
      const socket = await open(STREAM);
      socket.send({ t: "sub", id: 3, topic: "wing:levels", params: { only: "x" } });
      expect(await socket.next((m) => m.t === "err")).to.deep.equal({ t: "err", id: 3, error: "invalid-params", detail: "only must be a number" });
    });

    it("replaces a subscription's params when the same topic is subscribed again", async () => {
      const socket = await open(STREAM);
      socket.send({ t: "sub", id: 1, topic: "wing:levels", params: { only: 0 } });
      await socket.next((m) => m.t === "ack");
      socket.send({ t: "sub", id: 2, topic: "wing:levels", params: { only: 2 } });
      await socket.next((m) => m.t === "ack" && m.id === 2);
      h.publish("meters", [-10, -20, -30]);
      await delay(50);
      expect(socket.received.filter((m) => m.t === "evt").map((m) => m.data)).to.deep.equal([[-30]]);
    });

    it("sends nothing when the topic's encoder returns null", async () => {
      const socket = await open(STREAM);
      socket.send({ t: "sub", id: 1, topic: "wing:levels", params: { only: 9 } });
      await socket.next((m) => m.t === "ack");
      h.publish("meters", [-10]);
      await delay(50);
      expect(socket.received.filter((m) => m.t === "evt")).to.deep.equal([]);
    });

    it("carries bytes as msgpack bin and as {$b64} in json", async () => {
      const bytes = new Uint8Array([1, 2, 254, 255]);
      const msgpack = await open(STREAM_MSGPACK);
      const json = await open(STREAM);
      for (const s of [msgpack, json]) s.send({ t: "sub", id: 1, topic: "wing:bulk" });
      await msgpack.next((m) => m.t === "ack");
      await json.next((m) => m.t === "ack");
      h.publish("bulk", { bytes });
      const viaMsgpack = (await msgpack.next((m) => m.t === "evt")).data as { bytes: Uint8Array };
      expect(viaMsgpack.bytes).to.be.instanceOf(Uint8Array);
      expect(Array.from(viaMsgpack.bytes)).to.deep.equal([1, 2, 254, 255]);
      expect((await json.next((m) => m.t === "evt")).data).to.deep.equal({ bytes: { $b64: "AQL+/w==" } });
    });

    it("delivers a large frame intact through permessage-deflate", async () => {
      const socket = await open(CONTROL);
      socket.send({ t: "sub", id: 1, topic: "wing:blob" });
      await socket.next((m) => m.t === "ack");
      const big = { names: Array.from({ length: 2000 }, (_, i) => `Channel ${i}`) };
      h.publish("blob", big);
      expect((await socket.next((m) => m.t === "evt")).data).to.deep.equal(big);
    });
  });

  describe("robustness", () => {
    it("answers a malformed envelope with err and keeps the connection", async () => {
      const socket = await open(CONTROL);
      socket.send({ t: "sub", id: 5 });
      expect(await socket.next((m) => m.t === "err")).to.deep.include({ id: 5, error: "invalid-message" });
      socket.send({ t: "dance" });
      expect(await socket.next((m) => m.t === "err")).to.deep.include({ error: "invalid-message" });
      socket.send({ t: "sub", id: 6, topic: "wing:param-change" });
      expect(await socket.next((m) => m.t === "ack")).to.deep.include({ id: 6 });
    });

    it("closes 4400 on a frame that does not decode", async () => {
      const json = await open(CONTROL);
      json.sendRaw("{not json", false);
      expect((await json.closed).code).to.equal(WS_CLOSE.invalidMessage);

      const msgpack = await open(CONTROL_MSGPACK);
      msgpack.sendRaw(Buffer.from([0xc1]), true);
      expect((await msgpack.closed).code).to.equal(WS_CLOSE.invalidMessage);
    });

    it("closes 4429 on a flood of messages", async () => {
      const socket = await open(STREAM);
      for (let i = 0; i < 200; i++) socket.send({ t: "unsub", id: i, topic: "wing:levels" });
      expect((await socket.closed).code).to.equal(WS_CLOSE.tooManyMessages);
    });

    it("never throws into the EventBus publisher, and a failing topic does not stop the others", async () => {
      const socket = await open(STREAM);
      socket.send({ t: "sub", id: 1, topic: "wing:explode" });
      socket.send({ t: "sub", id: 2, topic: "wing:levels" });
      await socket.next((m) => m.t === "ack" && m.id === 2);
      const originalError = console.error;
      console.error = () => undefined;
      try {
        expect(() => h.publish("meters", [-1])).to.not.throw();
      } finally {
        console.error = originalError;
      }
      expect((await socket.next((m) => m.t === "evt")).topic).to.equal("wing:levels");
    });

    it("keeps delivering to the other subscribers when sending to one socket throws", async () => {
      const broken = await open(CONTROL);
      const healthy = await open(CONTROL);
      for (const s of [broken, healthy]) s.send({ t: "sub", id: 1, topic: "wing:param-change" });
      await broken.next((m) => m.t === "ack");
      await healthy.next((m) => m.t === "ack");

      // Reach into the hub for the server side of `broken` (connections are kept in the order they
      // were opened) and make its send throw.
      const victim = serverSide(h.hub, CONTROL)!;
      victim.ws.send = () => {
        throw new Error("socket exploded");
      };
      const originalError = console.error;
      console.error = () => undefined;
      try {
        expect(() => h.publish("param-change", { ok: true })).to.not.throw();
      } finally {
        console.error = originalError;
      }
      expect((await healthy.next((m) => m.t === "evt")).data).to.deep.equal({ ok: true });
      expect(h.hub.connectionCount).to.equal(1);
    });

    it("terminates a stream connection that stops reading, without touching the control one", async () => {
      const control = await open(CONTROL);
      const stream = await open(STREAM, { perMessageDeflate: false });
      stream.send({ t: "sub", id: 1, topic: "wing:bulk" });
      control.send({ t: "sub", id: 1, topic: "wing:param-change" });
      await stream.next((m) => m.t === "ack");
      await control.next((m) => m.t === "ack");

      // The client stops reading: the backlog passes the soft limit, frames are skipped from then
      // on (memory stays bounded), and once it has stalled past the timeout the socket is cut.
      (stream.ws as unknown as { _socket: { pause(): void } })._socket.pause();
      const chunk = new Uint8Array(256 * 1024);
      const deadline = Date.now() + 5000;
      while (h.hub.connectionCount > 1 && Date.now() < deadline) {
        h.publish("bulk", chunk);
        const backlog = serverSide(h.hub, STREAM)?.ws.bufferedAmount ?? 0;
        expect(backlog).to.be.below(WS_SOFT_LIMIT_BYTES + 2 * chunk.length);
        await delay(5);
      }
      expect(h.hub.connectionCount).to.equal(1);

      h.publish("param-change", { still: "alive" });
      expect((await control.next((m) => m.t === "evt")).data).to.deep.equal({ still: "alive" });
    });
  });

  describe("heartbeat", () => {
    beforeEach(async () => {
      await h.close();
      h = await startHarness({ heartbeatIntervalMs: 50 });
    });

    it("terminates a connection that does not answer pings", async () => {
      const silent = await open(CONTROL, { autoPong: false });
      const lively = await open(CONTROL);
      const { code } = await silent.closed;
      expect(code).to.equal(1006);
      expect(lively.ws.readyState).to.equal(lively.ws.OPEN);
    });

    it("closes 4401 once the passkey session behind the connection is revoked", async () => {
      h.sessions.add("session-2");
      const socket = await openSocket(h.port, { ticket: h.ticket("session-2"), protocol: CONTROL });
      sockets.push(socket);
      h.sessions.delete("session-2");
      expect((await socket.closed).code).to.equal(WS_CLOSE.credentialRevoked);
    });
  });

  it("closes every connection with 1001 on shutdown, without hanging", async () => {
    const socket = await open(CONTROL);
    const started = Date.now();
    await h.hub.close();
    expect((await socket.closed).code).to.equal(WS_CLOSE.goingAway);
    expect(Date.now() - started).to.be.below(1500);
    expect(await expectRefusal(h.port, { ticket: h.ticket(), protocol: CONTROL })).to.equal(503);
  });
});
