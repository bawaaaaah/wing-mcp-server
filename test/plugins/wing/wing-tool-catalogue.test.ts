// buildWingToolCatalogue() is what GET /api/tools and the dashboard's Tools page are built on. It
// must be byte-exact (it drives a "how many tokens am I paying" number), it must never touch a
// console, and it must not rebuild itself on every call — the whole surface is ~100 KiB of JSON
// Schema, and this runs on every session's boot path.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import { buildWingToolCatalogue, resetWingToolCatalogueCacheForTests } from "../../../src/plugins/wing/tool-catalogue.js";
import { registerWingTools } from "../../../src/plugins/wing/tools/index.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

describe("buildWingToolCatalogue", () => {
  afterEach(() => {
    resetWingToolCatalogueCacheForTests();
  });

  it("touches no console: {} as WingPluginContext is enough to build it", async () => {
    // If this needed a real client/meterClient it would throw reading an undefined property
    // rather than returning — the absence of a throw here is the assertion.
    const catalogue = await buildWingToolCatalogue();
    expect(catalogue.tools.length).to.be.greaterThan(0);
  });

  it("reports every tool tools/list actually advertises, with byte-exact sizes", async () => {
    const catalogue = await buildWingToolCatalogue();

    const server = new McpServer({ name: "catalogue-cross-check", version: "0.0.0" });
    registerWingTools(server, {} as unknown as WingPluginContext);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalogue-cross-check-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(catalogue.tools.map((t) => t.name).sort()).to.deep.equal(tools.map((t) => t.name).sort());

      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const entry of catalogue.tools) {
        expect(entry.bytes).to.equal(Buffer.byteLength(JSON.stringify(byName.get(entry.name))));
        expect(entry.bytes).to.be.greaterThan(0);
      }

      // `bytes` is deliberately per-tool (so the dashboard can sum a subset), so summing it omits
      // the array's own JSON punctuation: two brackets plus one comma per tool after the first.
      const totalFromCatalogue = catalogue.tools.reduce((sum, t) => sum + t.bytes, 0);
      const arrayOverhead = 2 + (tools.length - 1);
      const totalFromRealList = Buffer.byteLength(JSON.stringify(tools));
      expect(totalFromCatalogue + arrayOverhead).to.equal(totalFromRealList);
    } finally {
      await client.close();
    }
  });

  it("marks readOnly from the tool's own readOnlyHint annotation", async () => {
    const catalogue = await buildWingToolCatalogue();
    const read = catalogue.tools.find((t) => t.name === "wing_channel_get_fader");
    const write = catalogue.tools.find((t) => t.name === "wing_channel_set_fader");
    expect(read?.readOnly).to.equal(true);
    expect(write?.readOnly).to.equal(false);
  });

  it("clips summaries to a sane length", async () => {
    const catalogue = await buildWingToolCatalogue();
    for (const tool of catalogue.tools) {
      if (tool.summary) expect(tool.summary.length).to.be.at.most(140);
    }
  });

  it("declares the built-in profiles, with 'all' covering every group", async () => {
    const catalogue = await buildWingToolCatalogue();
    const byId = new Map(catalogue.profiles.map((p) => [p.id, p]));
    expect(byId.get("all")?.groups.sort()).to.deep.equal(catalogue.groups.map((g) => g.id).sort());
    expect(byId.get("none")?.groups).to.deep.equal([]);
    expect(byId.get("core")?.groups.length).to.be.greaterThan(0);
    // Every group a profile names must actually exist — a typo here would silently enable nothing.
    const groupIds = new Set(catalogue.groups.map((g) => g.id));
    for (const profile of catalogue.profiles) {
      for (const groupId of profile.groups) expect(groupIds.has(groupId), `${profile.id} -> ${groupId}`).to.equal(true);
    }
  });

  it("is memoized: two calls return the same object without rebuilding", async () => {
    const first = await buildWingToolCatalogue();
    const second = await buildWingToolCatalogue();
    expect(first).to.equal(second);
  });

  it("rebuilds after the test-only cache reset", async () => {
    const first = await buildWingToolCatalogue();
    resetWingToolCatalogueCacheForTests();
    const second = await buildWingToolCatalogue();
    expect(first).to.not.equal(second);
    expect(first.tools.length).to.equal(second.tools.length);
  });
});
