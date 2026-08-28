import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import type { ScopedConfigStore } from "../../../src/core/config-store.js";
import { EventBus } from "../../../src/core/event-bus.js";
import { WingPlugin } from "../../../src/plugins/wing/wing-plugin.js";

function createFakeConfigStore(initial: unknown): ScopedConfigStore {
  let stored = initial;
  return {
    get: () => stored,
    set: async (config: unknown) => {
      stored = config;
    },
  };
}

async function connectClient(plugin: WingPlugin): Promise<Client> {
  const server = new McpServer({ name: "wing-plugin-test-server", version: "0.0.0" });
  plugin.registerTools(server);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wing-plugin-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * Exercises the real WingPlugin (not a fake ctx) to prove the config-file/dashboard path actually
 * reaches the shared oscMirror singleton — the wiring added in wing-plugin.ts's start()/setConfig()
 * (applyOscMirrorConfig). `host` is deliberately left empty in every fixture: connectClients() skips
 * connecting entirely when host is unset, so start()/setConfig() resolve immediately without ever
 * touching a real console — only the oscMirror wiring under test actually runs.
 */
describe("WingPlugin OSC mirror config wiring", () => {
  it("applies a persisted mirror config at start()", async () => {
    const configStore = createFakeConfigStore({ host: "", oscMirrorEnabled: true, oscMirrorHost: "10.0.0.5", oscMirrorPort: 9000 });
    const plugin = new WingPlugin(configStore, new EventBus());
    await plugin.start();

    const client = await connectClient(plugin);
    try {
      const result = await client.callTool({ name: "wing_get_osc_mirror_status", arguments: {} });
      expect(result.structuredContent).to.deep.include({ enabled: true, host: "10.0.0.5", port: 9000 });
    } finally {
      await client.close();
      await plugin.stop();
    }
  });

  it("leaves the mirror disabled by default on a fresh boot with nothing persisted yet", async () => {
    const configStore = createFakeConfigStore(undefined);
    const plugin = new WingPlugin(configStore, new EventBus());
    await plugin.start();

    const client = await connectClient(plugin);
    try {
      const result = await client.callTool({ name: "wing_get_osc_mirror_status", arguments: {} });
      expect(result.structuredContent).to.deep.include({ enabled: false });
    } finally {
      await client.close();
      await plugin.stop();
    }
  });

  it("applies a live setConfig() change (dashboard Config tab / config file save) to the mirror", async () => {
    const configStore = createFakeConfigStore({ host: "" });
    const plugin = new WingPlugin(configStore, new EventBus());
    await plugin.start();

    const client = await connectClient(plugin);
    try {
      await plugin.setConfig({ host: "", oscMirrorEnabled: true, oscMirrorHost: "192.168.1.99", oscMirrorPort: 8000 });
      const result = await client.callTool({ name: "wing_get_osc_mirror_status", arguments: {} });
      expect(result.structuredContent).to.deep.include({ enabled: true, host: "192.168.1.99", port: 8000 });
    } finally {
      await client.close();
      await plugin.stop();
    }
  });

  it("rejects a setConfig() call enabling the mirror without a host, leaving the previous state untouched", async () => {
    const configStore = createFakeConfigStore({ host: "" });
    const plugin = new WingPlugin(configStore, new EventBus());
    await plugin.start();

    const client = await connectClient(plugin);
    try {
      let error: unknown;
      try {
        await plugin.setConfig({ host: "", oscMirrorEnabled: true, oscMirrorPort: 9000 });
      } catch (err) {
        error = err;
      }
      expect(error).to.not.equal(undefined);

      const result = await client.callTool({ name: "wing_get_osc_mirror_status", arguments: {} });
      expect(result.structuredContent).to.deep.include({ enabled: false });
    } finally {
      await client.close();
      await plugin.stop();
    }
  });
});
