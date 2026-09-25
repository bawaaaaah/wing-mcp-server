// `server.tools` used to be applied by the HTTP gateway only, so a stdio client — the usual way a
// desktop client runs this server — got every tool whatever the operator chose, the read-only
// `safe` profile included. These pin that the stdio session honours the same choice, and follows a
// live change the way an HTTP session does.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ConfigStore } from "../../src/core/config-store.js";
import type { McpPlugin, PluginHealth } from "../../src/core/plugin.js";
import { StdioEndpoint } from "../../src/core/stdio-endpoint.js";
import type { PluginToolCatalogue } from "../../src/core/tool-catalogue.js";
import { ToolVisibilityController } from "../../src/core/tool-visibility-controller.js";

class ReadWritePlugin implements McpPlugin {
  readonly id = "fake";
  readonly name = "Fake";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getHealth(): Promise<PluginHealth> {
    return { status: "HEALTHY" };
  }
  registerTools(server: McpServer): void {
    for (const name of ["thing_get", "thing_set"]) {
      server.registerTool(name, { description: name, inputSchema: {} }, async () => ({ content: [{ type: "text", text: name }] }));
    }
  }
  async getToolCatalogue(): Promise<PluginToolCatalogue> {
    return {
      pluginId: this.id,
      groups: [{ id: "thing", label: "Thing", description: "" }],
      tools: [
        { name: "thing_get", group: "thing", bytes: 1, readOnly: true },
        { name: "thing_set", group: "thing", bytes: 1, readOnly: false },
      ],
      profiles: [{ id: "safe", label: "Read-only", description: "", groups: [], readOnlyOnly: true }],
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

/** The client half of a stdio pipe, over in-memory streams instead of a child process. */
class StreamClientTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly toServer: PassThrough,
    private readonly fromServer: PassThrough,
  ) {}

  async start(): Promise<void> {
    this.fromServer.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) {
        this.onmessage?.(message);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

describe("StdioEndpoint tool visibility", () => {
  let dir: string;
  let configStore: ConfigStore;
  let endpoint: StdioEndpoint;
  let client: Client;
  let visibility: ToolVisibilityController;

  async function connect(): Promise<void> {
    const plugin = new ReadWritePlugin();
    visibility = new ToolVisibilityController([plugin], configStore);
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    endpoint = new StdioEndpoint({
      plugins: [plugin],
      onClientDisconnect: () => undefined,
      stdin: toServer,
      stdout: fromServer,
      toolVisibility: visibility,
    });
    await endpoint.start();
    client = new Client({ name: "stdio-visibility-test", version: "0" });
    await client.connect(new StreamClientTransport(toServer, fromServer));
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-stdio-visibility-"));
    configStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await configStore.load();
  });

  afterEach(async () => {
    await client?.close();
    await endpoint?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hides what server.tools hides, and refuses calling it", async () => {
    await configStore.setServerTools({ profile: "safe" });
    await connect();

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).to.deep.equal(["thing_get"]);
    const refused = await client.callTool({ name: "thing_set", arguments: {} }).catch((err: unknown) => err);
    const refusedText = refused instanceof Error ? refused.message : JSON.stringify(refused);
    expect(refusedText).to.match(/disabled/i);
  });

  it("follows a live change with one tools/list_changed", async () => {
    await connect();
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });
    expect((await client.listTools()).tools).to.have.lengthOf(2);

    expect(await visibility.update({ profile: "safe" })).to.equal(1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notifications).to.equal(1);
    expect((await client.listTools()).tools.map((tool) => tool.name)).to.deep.equal(["thing_get"]);
  });
});
