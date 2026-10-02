import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import { EventBus } from "../../src/core/event-bus.js";
import { McpGatewayServer } from "../../src/core/mcp-gateway-server.js";
import type { McpPlugin, PluginHealth } from "../../src/core/plugin.js";
import { expectRefusal, openSocket } from "./ws-test-client.js";

class LivePlugin implements McpPlugin {
  readonly id = "live";
  readonly name = "Live Plugin";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getHealth(): Promise<PluginHealth> {
    return { status: "HEALTHY" };
  }
  registerTools(): void {}
  getConfigSchema(): object {
    return {};
  }
  getConfig(): unknown {
    return {};
  }
  async setConfig(): Promise<void> {}
  liveTopics() {
    return { ping: { channel: "control" as const } };
  }
}

describe("McpGatewayServer WebSocket endpoint", () => {
  let dir: string;
  let server: McpGatewayServer;
  let port: number;
  let bus: EventBus;
  const authToken = "ws-gateway-test-token";

  const mintTicket = async (): Promise<string> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/ws-ticket`, { method: "POST", headers: { authorization: "Bearer " + authToken } });
    expect(res.status).to.equal(200);
    return ((await res.json()) as { ticket: string }).ticket;
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-ws-gateway-"));
    const configStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await configStore.load();
    bus = new EventBus();
    server = new McpGatewayServer([new LivePlugin()], { port: 0, authToken, configStore, eventBus: bus, manageSignals: false, log: () => undefined });
    await server.init();
    port = server.port as number;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("only mints a ticket for an authenticated request", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/ws-ticket`, { method: "POST" });
    expect(res.status).to.equal(401);
  });

  it("pushes plugin topics and serves REST over the socket through the real routes", async () => {
    const socket = await openSocket(port, { ticket: await mintTicket(), protocol: "wing.control.v1.msgpack" });
    const hello = await socket.next((m) => m.t === "hello");
    expect(hello.topics).to.deep.equal(["live:ping"]);

    socket.send({ t: "sub", id: 1, topic: "live:ping" });
    await socket.next((m) => m.t === "ack");
    bus.publish({ pluginId: "live", type: "ping", payload: { n: 1 }, timestamp: 5 });
    expect((await socket.next((m) => m.t === "evt")).data).to.deep.equal({ n: 1 });

    socket.send({ t: "req", id: 2, method: "GET", path: "/api/plugins" });
    const res = await socket.next((m) => m.t === "res");
    expect(res.status).to.equal(200);
    expect((res.body as { id: string }[]).map((p) => p.id)).to.deep.equal(["live"]);
    await socket.close();
  });

  it("still serves plain HTTP normally once requests have been replayed", async () => {
    const socket = await openSocket(port, { ticket: await mintTicket(), protocol: "wing.control.v1.json" });
    await socket.next((m) => m.t === "hello");
    socket.send({ t: "req", id: 1, method: "GET", path: "/api/plugins" });
    await socket.next((m) => m.t === "res");
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins`, { headers: { authorization: "Bearer " + authToken } });
    expect(res.status).to.equal(200);
    await socket.close();
  });

  it("closes open sockets on stop() without hanging", async () => {
    const socket = await openSocket(port, { ticket: await mintTicket(), protocol: "wing.stream.v1.json" });
    await socket.next((m) => m.t === "hello");
    const started = Date.now();
    await server.stop();
    expect((await socket.closed).code).to.equal(1001);
    expect(Date.now() - started).to.be.below(2000);
  });

  it("refuses the upgrade on any other path", async () => {
    expect(await expectRefusal(port, { ticket: await mintTicket(), protocol: "wing.control.v1.json", path: "/mcp" })).to.equal(404);
  });
});
