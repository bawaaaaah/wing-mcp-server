import { expect } from "chai";
import { aggregateHealth } from "../../src/core/health.js";
import type { McpPlugin, PluginHealth } from "../../src/core/plugin.js";

function makePlugin(id: string, getHealth: () => Promise<PluginHealth>): McpPlugin {
  return {
    id,
    name: id,
    async start() {},
    async stop() {},
    getHealth,
    registerTools() {},
    getConfigSchema() {
      return {};
    },
    getConfig() {
      return {};
    },
    async setConfig() {},
  };
}

describe("aggregateHealth", () => {
  it("reports HEALTHY when every plugin is healthy", async () => {
    const plugins = [
      makePlugin("a", async () => ({ status: "HEALTHY" })),
      makePlugin("b", async () => ({ status: "HEALTHY" })),
    ];

    const result = await aggregateHealth(plugins);

    expect(result.status).to.equal("HEALTHY");
    expect(result.plugins.a.status).to.equal("HEALTHY");
    expect(result.plugins.b.status).to.equal("HEALTHY");
  });

  it("worst status wins: DEGRADED beats HEALTHY", async () => {
    const plugins = [
      makePlugin("a", async () => ({ status: "HEALTHY" })),
      makePlugin("b", async () => ({ status: "DEGRADED" })),
    ];

    const result = await aggregateHealth(plugins);

    expect(result.status).to.equal("DEGRADED");
  });

  it("worst status wins: ERROR beats DEGRADED and HEALTHY", async () => {
    const plugins = [
      makePlugin("a", async () => ({ status: "HEALTHY" })),
      makePlugin("b", async () => ({ status: "DEGRADED" })),
      makePlugin("c", async () => ({ status: "ERROR" })),
    ];

    const result = await aggregateHealth(plugins);

    expect(result.status).to.equal("ERROR");
  });

  it("treats a thrown/rejected getHealth() as an ERROR entry", async () => {
    const plugins = [
      makePlugin("a", async () => ({ status: "HEALTHY" })),
      makePlugin("broken", async () => {
        throw new Error("boom");
      }),
    ];

    const result = await aggregateHealth(plugins);

    expect(result.status).to.equal("ERROR");
    expect(result.plugins.broken.status).to.equal("ERROR");
    expect(result.plugins.broken.errorMessage).to.include("boom");
  });
});
