// GET/PUT /api/tools end to end: the REST surface, persistence, and — the part that actually
// matters for a client that never reconnects — that a live session gets exactly one
// notifications/tools/list_changed and its tools/call is refused for whatever just got hidden.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import { EventBus } from "../../src/core/event-bus.js";
import { McpGatewayServer } from "../../src/core/mcp-gateway-server.js";
import type { McpPlugin, PluginHealth } from "../../src/core/plugin.js";
import type { PluginToolCatalogue } from "../../src/core/tool-catalogue.js";

/** Two groups of two tools each — enough to exercise group- and tool-level visibility. */
class FakeCatalogPlugin implements McpPlugin {
  readonly id = "fake";
  readonly name = "Fake Plugin";

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getHealth(): Promise<PluginHealth> {
    return { status: "HEALTHY" };
  }

  registerTools(server: McpServer): void {
    for (const name of ["alpha_one", "alpha_two", "beta_one", "beta_two"]) {
      server.registerTool(name, { description: name, inputSchema: {} }, async () => ({
        content: [{ type: "text", text: name }],
      }));
    }
  }

  async getToolCatalogue(): Promise<PluginToolCatalogue> {
    return {
      pluginId: this.id,
      groups: [
        { id: "alpha", label: "Alpha", description: "Alpha tools" },
        { id: "beta", label: "Beta", description: "Beta tools" },
      ],
      tools: [
        { name: "alpha_one", group: "alpha", bytes: 10, readOnly: false },
        { name: "alpha_two", group: "alpha", bytes: 10, readOnly: false },
        { name: "beta_one", group: "beta", bytes: 10, readOnly: false },
        { name: "beta_two", group: "beta", bytes: 10, readOnly: false },
      ],
      profiles: [
        { id: "all", label: "All", description: "", groups: ["alpha", "beta"] },
        { id: "none", label: "None", description: "", groups: [] },
      ],
    };
  }

  getConfigSchema(): object {
    return {};
  }
  getConfig(): unknown {
    return {};
  }
  async setConfig(): Promise<void> {}
}

describe("GET/PUT /api/tools", () => {
  let dir: string;
  let configPath: string;
  let server: McpGatewayServer;
  let port: number;
  const authToken = "tool-visibility-test-token";

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-tool-visibility-api-"));
    configPath = path.join(dir, "config.json");
    const configStore = new ConfigStore({ filePath: configPath });
    await configStore.load();
    const eventBus = new EventBus();

    server = new McpGatewayServer([new FakeCatalogPlugin()], {
      port: 0,
      authToken,
      configStore,
      eventBus,
    });
    await server.init();
    port = server.port as number;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = () => "http://127.0.0.1:" + port;
  const auth = { Authorization: "Bearer " + authToken };

  it("rejects GET without a bearer token", async () => {
    const res = await fetch(base() + "/api/tools");
    expect(res.status).to.equal(401);
  });

  it("reports every tool enabled with correct totals when nothing is configured", async () => {
    const res = await fetch(base() + "/api/tools", { headers: auth });
    expect(res.status).to.equal(200);
    const body = (await res.json()) as {
      tools: { name: string; enabled: boolean; bytes: number }[];
      totals: {
        tools: number;
        enabledTools: number;
        bytes: number;
        enabledBytes: number;
        instructionsBytes: number;
        approxTokens: number;
        approxEnabledTokens: number;
      };
    };
    expect(body.tools).to.have.lengthOf(4);
    expect(body.tools.every((t) => t.enabled)).to.equal(true);
    expect(body.totals.tools).to.equal(4);
    expect(body.totals.enabledTools).to.equal(4);
    expect(body.totals.bytes).to.equal(40);
    expect(body.totals.enabledBytes).to.equal(40);
    expect(body.totals.approxTokens).to.equal(10);
    expect(body.totals.approxEnabledTokens).to.equal(10);
  });

  it("rejects a PUT whose body has the wrong shape", async () => {
    const res = await fetch(base() + "/api/tools", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enable: "not-an-array" }),
    });
    expect(res.status).to.equal(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).to.be.a("string");
  });

  it("refuses an unknown profile rather than silently falling back, and persists nothing", async () => {
    const res = await fetch(base() + "/api/tools", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "no-such-profile" }),
    });
    expect(res.status).to.equal(400);
    expect(((await res.json()) as { error: string }).error).to.include("no-such-profile");
    const persisted = (fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {}) as { server?: { tools?: unknown } };
    expect(persisted.server?.tools).to.be.undefined;
  });

  it("tolerates an unknown group/tool id: 200, echoed under unknown, nothing else disabled", async () => {
    const res = await fetch(base() + "/api/tools", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ disable: ["no-such-group"] }),
    });
    expect(res.status).to.equal(200);
    const body = (await res.json()) as { unknown: string[]; totals: { enabledTools: number } };
    expect(body.unknown).to.deep.equal(["no-such-group"]);
    expect(body.totals.enabledTools).to.equal(4);
  });

  it("persists a PUT to data/config.json", async () => {
    const res = await fetch(base() + "/api/tools", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ disable: ["beta"] }),
    });
    expect(res.status).to.equal(200);

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8")) as { server: { tools?: unknown } };
    expect(onDisk.server.tools).to.deep.equal({ disable: ["beta"] });
  });

  it("hides a disabled group's tools from a subsequent GET", async () => {
    await fetch(base() + "/api/tools", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ disable: ["beta"] }),
    });

    const res = await fetch(base() + "/api/tools", { headers: auth });
    const body = (await res.json()) as { tools: { name: string; enabled: boolean }[] };
    const byName = new Map(body.tools.map((t) => [t.name, t.enabled]));
    expect(byName.get("alpha_one")).to.equal(true);
    expect(byName.get("beta_one")).to.equal(false);
    expect(byName.get("beta_two")).to.equal(false);
  });

  async function connectClient(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(base() + "/mcp"), {
      requestInit: { headers: auth },
    });
    const client = new Client({ name: "tool-visibility-test-client", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  it("registers only the enabled tools for a session created after a PUT", async () => {
    await fetch(base() + "/api/tools", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ disable: ["beta"] }),
    });

    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).to.deep.equal(["alpha_one", "alpha_two"]);
    } finally {
      await client.close();
    }
  });

  it("notifies an already-open session exactly once, updates its list, and refuses the hidden tool", async () => {
    const client = await connectClient();
    const notifications: unknown[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
      notifications.push(notification);
    });

    try {
      const before = await client.listTools();
      expect(before.tools.map((t) => t.name).sort()).to.deep.equal(["alpha_one", "alpha_two", "beta_one", "beta_two"]);

      const putRes = await fetch(base() + "/api/tools", {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ disable: ["beta"] }),
      });
      const putBody = (await putRes.json()) as { liveSessions: number };
      expect(putBody.liveSessions).to.equal(1);

      // The notification is a fire-and-forget server push; give the event loop a turn to deliver it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(notifications).to.have.lengthOf(1);

      const after = await client.listTools();
      expect(after.tools.map((t) => t.name).sort()).to.deep.equal(["alpha_one", "alpha_two"]);

      // The SDK reports a disabled tool as an ordinary (non-throwing) CallToolResult with
      // isError: true, not a protocol-level rejection — see mcp.js's CallToolRequestSchema
      // handler, which wraps any McpError other than UrlElicitationRequired into a tool result.
      const refusal = await client.callTool({ name: "beta_one", arguments: {} });
      expect(refusal.isError).to.equal(true);
      const refusalContent = refusal.content as { type: string; text: string }[];
      expect(refusalContent[0]?.text.toLowerCase()).to.include("disabled");

      // A still-visible tool must be entirely unaffected by the disable of the other group.
      const alphaResult = await client.callTool({ name: "alpha_one", arguments: {} });
      const content = alphaResult.content as { type: string; text: string }[];
      expect(content[0]).to.deep.equal({ type: "text", text: "alpha_one" });
    } finally {
      await client.close();
    }
  });

  it("re-enabling restores a hidden group on the same live session", async () => {
    const client = await connectClient();
    try {
      await fetch(base() + "/api/tools", {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ disable: ["beta"] }),
      });
      await fetch(base() + "/api/tools", {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).to.deep.equal(["alpha_one", "alpha_two", "beta_one", "beta_two"]);
    } finally {
      await client.close();
    }
  });

  it("does not throw when applying visibility to a session whose client vanished without a clean teardown", async () => {
    // client.close() only tears down the client side — it does not send DELETE /mcp, so the
    // server-side entry (and its stored McpServer/toolHandles) is still in this.transports until
    // the idle sweep or an explicit DELETE removes it. That gap is exactly the case
    // applyToolVisibilityToLiveSessions() must survive: a snapshot iteration hitting an entry whose
    // transport can no longer actually deliver anything.
    const client = await connectClient();
    await client.close();

    const res = await fetch(base() + "/api/tools", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ disable: ["beta"] }),
    });
    expect(res.status).to.equal(200);
    const body = (await res.json()) as { liveSessions: number };
    expect(body.liveSessions).to.equal(1);
  });
});
