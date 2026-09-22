import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import type { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ConfigStore } from "../../src/core/config-store.js";
import { EventBus } from "../../src/core/event-bus.js";
import { McpGatewayServer } from "../../src/core/mcp-gateway-server.js";
import type { McpPlugin, PluginHealth } from "../../src/core/plugin.js";

class FakePlugin implements McpPlugin {
  readonly id = "fake";
  readonly name = "Fake Plugin";
  private config: unknown = { greeting: "hello" };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async getHealth(): Promise<PluginHealth> {
    return { status: "HEALTHY", detail: { info: "all good" } };
  }

  getInstructions(): string {
    return "Fake plugin guidance.";
  }

  registerTools(server: McpServer): void {
    server.registerTool(
      "echo",
      {
        description: "Echoes the provided message back",
        inputSchema: { message: z.string() },
      },
      async ({ message }) => ({
        content: [{ type: "text", text: message }],
      }),
    );
  }

  getConfigSchema(): object {
    return { type: "object", properties: { greeting: { type: "string" } } };
  }

  getConfig(): unknown {
    return this.config;
  }

  async setConfig(config: unknown): Promise<void> {
    this.config = config;
  }

  // A trivial custom route is enough to make the gateway mount this plugin's router at
  // "/api/plugins/fake" — necessary to reproduce the ordering bug below, since it only manifests
  // once that prefix mount actually exists.
  registerHttpRoutes(router: Router): void {
    router.get("/ping", (_req, res) => res.json({ pong: true }));
  }
}

describe("McpGatewayServer", () => {
  let dir: string;
  let server: McpGatewayServer;
  let port: number;
  const authToken = "gateway-test-token";

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-gateway-test-"));
    const configStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await configStore.load();
    const eventBus = new EventBus();

    server = new McpGatewayServer([new FakePlugin()], {
      port: 0,
      authToken,
      configStore,
      eventBus,
    });
    await server.init();

    port = server.port as number;
  });

  after(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("responds to GET /health without authentication", async () => {
    const res = await fetch("http://127.0.0.1:" + port + "/health");
    expect(res.status).to.equal(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).to.equal("HEALTHY");
  });

  it("rejects /api/status without a bearer token", async () => {
    const res = await fetch("http://127.0.0.1:" + port + "/api/status");
    expect(res.status).to.equal(401);
  });

  it("serves /api/status with server + plugin details when authenticated", async () => {
    const res = await fetch("http://127.0.0.1:" + port + "/api/status", {
      headers: { Authorization: "Bearer " + authToken },
    });
    expect(res.status).to.equal(200);
    const body = (await res.json()) as {
      server: { uptimeSeconds: number; version: string; nodeVersion: string };
      plugins: { id: string; name: string; health: PluginHealth }[];
    };
    expect(body.server.nodeVersion).to.equal(process.version);
    expect(body.plugins).to.have.lengthOf(1);
    expect(body.plugins[0].id).to.equal("fake");
    expect(body.plugins[0].health.status).to.equal("HEALTHY");
  });

  it("gets and sets plugin config via the REST API", async () => {
    const getRes = await fetch("http://127.0.0.1:" + port + "/api/plugins/fake/config", {
      headers: { Authorization: "Bearer " + authToken },
    });
    expect(getRes.status).to.equal(200);
    expect(await getRes.json()).to.deep.equal({
      schema: { type: "object", properties: { greeting: { type: "string" } } },
      config: { greeting: "hello" },
    });

    const putRes = await fetch("http://127.0.0.1:" + port + "/api/plugins/fake/config", {
      method: "PUT",
      headers: { Authorization: "Bearer " + authToken, "Content-Type": "application/json" },
      body: JSON.stringify({ greeting: "bonjour" }),
    });
    expect(putRes.status).to.equal(200);
    expect(await putRes.json()).to.deep.equal({ config: { greeting: "bonjour" } });
  });

  it("authenticates the SSE events route via a query-param ticket, not just a bearer header", async () => {
    // Regression test: a plugin's own router is mounted at "/api/plugins/<id>" with a blanket,
    // header-only requireAuth() (see mountPluginHttpRoutes). Because that's an app.use() prefix
    // mount, it matches every sub-path underneath it, including "/api/plugins/<id>/events" — the
    // core's generic SSE route, which must accept a query-param ticket instead since a browser's
    // native EventSource can never send a custom header. If the plugin mount were registered before
    // the core routes, its header-only check would 401 the request before the core route (with the
    // correct requireAuth({allowQueryTicket:true})) ever got a chance to run.
    const ticketRes = await fetch("http://127.0.0.1:" + port + "/api/auth/sse-ticket", {
      method: "POST",
      headers: { Authorization: "Bearer " + authToken },
    });
    expect(ticketRes.status).to.equal(200);
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const controller = new AbortController();
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/api/plugins/fake/events?ticket=" + ticket, {
        signal: controller.signal,
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.include("text/event-stream");
    } finally {
      controller.abort();
    }
  });

  it("rejects the SSE events route's query param if it's the real token instead of a ticket", async () => {
    const res = await fetch("http://127.0.0.1:" + port + "/api/plugins/fake/events?token=" + authToken);
    expect(res.status).to.equal(401);
  });

  it("still rejects the SSE events route with no ticket at all", async () => {
    const res = await fetch("http://127.0.0.1:" + port + "/api/plugins/fake/events");
    expect(res.status).to.equal(401);
  });

  it("returns 404 for config requests on an unknown plugin", async () => {
    const res = await fetch("http://127.0.0.1:" + port + "/api/plugins/nope/config", {
      headers: { Authorization: "Bearer " + authToken },
    });
    expect(res.status).to.equal(404);
  });

  it("returns the plugins' instructions on initialize", async () => {
    // Without this the handshake carried no guidance at all, leaving a model to infer the shape of
    // a 116-tool surface from tool names alone. The gateway composes what the plugins supply; it
    // knows nothing about any particular console itself.
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + authToken } },
    });
    const client = new Client({ name: "instructions-client", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getInstructions()).to.equal("Fake plugin guidance.");
    } finally {
      await client.close();
    }
  });

  async function connectClientAndEcho(message: string): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + authToken } },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).to.include("echo");

      const result = await client.callTool({ name: "echo", arguments: { message } });
      const content = result.content as { type: string; text: string }[];
      expect(content[0]).to.deep.equal({ type: "text", text: message });
    } finally {
      await client.close();
    }
  }

  it("handles a full MCP tools/list + tools/call round trip over Streamable HTTP", async () => {
    await connectClientAndEcho("ping");
  });

  it("accepts a second, independent session after the first one has closed", async () => {
    // Regression test: the gateway used to hand every session the same shared McpServer instance.
    // The SDK's Server.connect() only ever allows one transport per Server for its whole lifetime,
    // so the first session's client.close() (which closes its transport but not the underlying
    // McpServer) left the shared instance permanently "connected" — every subsequent session's
    // initialize request then failed server-side with "Already connected to a transport", a 500
    // that looked to any real MCP client (verified against Hermes) like the server refusing to
    // connect at all. Each session must get its own fresh McpServer instance.
    await connectClientAndEcho("first session");
    await connectClientAndEcho("second session");
    await connectClientAndEcho("third session");
  });
});
