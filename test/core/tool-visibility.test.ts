// Tool visibility follows the same contract as server.security: absent means every tool is
// advertised, a persisted block wins outright over the environment, and a malformed block is
// reported and skipped rather than taking the whole config file down. resolveEnabledTools then
// resolves that plugin-agnostic choice against one plugin's actual catalogue — the two are
// tested separately because the first knows nothing about groups or tools, and the second knows
// nothing about config.json or the environment.

import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import type { PluginToolCatalogue } from "../../src/core/tool-catalogue.js";
import {
  describeToolVisibility,
  normalizeToolVisibility,
  resolveEnabledTools,
  resolveToolVisibility,
  type ToolVisibility,
} from "../../src/core/tool-visibility.js";

const TOOL_ENV_VARS = ["MCP_TOOL_PROFILE", "MCP_TOOLS_ENABLE", "MCP_TOOLS_DISABLE"] as const;

describe("resolveToolVisibility", () => {
  let dir: string;
  let filePath: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-tool-visibility-"));
    filePath = path.join(dir, "config.json");
    saved = Object.fromEntries(TOOL_ENV_VARS.map((name) => [name, process.env[name]]));
    for (const name of TOOL_ENV_VARS) delete process.env[name];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function store(): Promise<ConfigStore> {
    const configStore = new ConfigStore({ filePath });
    await configStore.load();
    return configStore;
  }

  it("is empty when nothing is configured anywhere", async () => {
    expect(resolveToolVisibility(await store())).to.deep.equal({});
  });

  it("reads the environment when no block is persisted", async () => {
    process.env.MCP_TOOL_PROFILE = "core";
    process.env.MCP_TOOLS_ENABLE = "wing_meter_stats, auto-eq";
    process.env.MCP_TOOLS_DISABLE = "lighting";

    const visibility = resolveToolVisibility(await store());
    expect(visibility.profile).to.equal("core");
    expect(visibility.enable).to.deep.equal(["wing_meter_stats", "auto-eq"]);
    expect(visibility.disable).to.deep.equal(["lighting"]);
  });

  it("lets a persisted block win over the environment", async () => {
    process.env.MCP_TOOL_PROFILE = "core";
    const configStore = await store();
    await configStore.setServerTools({ profile: "none" });

    expect(resolveToolVisibility(configStore).profile).to.equal("none");
  });

  it("keeps reading the environment on every boot rather than persisting it once", async () => {
    process.env.MCP_TOOL_PROFILE = "core";
    const first = await store();
    expect(resolveToolVisibility(first).profile).to.equal("core");

    process.env.MCP_TOOL_PROFILE = "none";
    const second = await store();
    expect(resolveToolVisibility(second).profile).to.equal("none");
    expect(second.getServerTools(), "nothing should have been written to the config file").to.be.undefined;
  });

  it("falls back to the environment when a persisted block is malformed, rather than throwing", async () => {
    process.env.MCP_TOOL_PROFILE = "core";
    const configStore = await store();
    await configStore.setServerTools({ enable: "not-an-array" });

    expect(resolveToolVisibility(configStore).profile).to.equal("core");
  });
});

describe("normalizeToolVisibility", () => {
  it("trims, dedupes and sorts, and drops keys that end up empty", () => {
    const normalized = normalizeToolVisibility({
      profile: "  core  ",
      enable: [" b ", "a", "a", ""],
      disable: [],
    });
    expect(normalized).to.deep.equal({ profile: "core", enable: ["a", "b"] });
  });

  it("returns an empty object for an empty input", () => {
    expect(normalizeToolVisibility({})).to.deep.equal({});
  });
});

describe("resolveEnabledTools", () => {
  // A tiny two-group, four-tool stand-in catalogue — enough to exercise every resolution rule
  // without depending on the real WING tool surface (that's wing-tool-groups.test.ts's job).
  const catalogue: Pick<PluginToolCatalogue, "groups" | "tools" | "profiles"> = {
    groups: [
      { id: "alpha", label: "Alpha", description: "" },
      { id: "beta", label: "Beta", description: "" },
    ],
    tools: [
      { name: "alpha_one", group: "alpha", bytes: 1, readOnly: false },
      { name: "alpha_two", group: "alpha", bytes: 1, readOnly: false },
      { name: "beta_one", group: "beta", bytes: 1, readOnly: false },
      { name: "beta_two", group: "beta", bytes: 1, readOnly: false },
    ],
    profiles: [
      { id: "all", label: "All", description: "", groups: ["alpha", "beta"] },
      { id: "alpha-only", label: "Alpha only", description: "", groups: ["alpha"] },
      { id: "none", label: "None", description: "", groups: [] },
    ],
  };

  function enabledOf(visibility: ToolVisibility): string[] {
    return [...resolveEnabledTools(visibility, catalogue).enabledNames].sort();
  }

  it("enables everything when nothing is configured", () => {
    expect(enabledOf({})).to.deep.equal(["alpha_one", "alpha_two", "beta_one", "beta_two"]);
  });

  it("applies a named profile", () => {
    expect(enabledOf({ profile: "alpha-only" })).to.deep.equal(["alpha_one", "alpha_two"]);
    expect(enabledOf({ profile: "none" })).to.deep.equal([]);
  });

  it("falls back to every group enabled for an unresolvable profile id (fail open)", () => {
    const resolved = resolveEnabledTools({ profile: "does-not-exist" }, catalogue);
    expect([...resolved.enabledNames].sort()).to.deep.equal(["alpha_one", "alpha_two", "beta_one", "beta_two"]);
    expect(resolved.unknown).to.include("does-not-exist");
  });

  it("enable at group level overrides the profile", () => {
    expect(enabledOf({ profile: "none", enable: ["alpha"] })).to.deep.equal(["alpha_one", "alpha_two"]);
  });

  it("disable at group level overrides the profile", () => {
    expect(enabledOf({ profile: "all", disable: ["beta"] })).to.deep.equal(["alpha_one", "alpha_two"]);
  });

  it("a tool-level entry overrides its group's resolution", () => {
    expect(enabledOf({ profile: "none", enable: ["alpha_one"] })).to.deep.equal(["alpha_one"]);
    expect(enabledOf({ profile: "all", disable: ["alpha_one"] })).to.deep.equal(["alpha_two", "beta_one", "beta_two"]);
  });

  it("disable wins over enable at the same level", () => {
    // Same id in both lists is a contradiction the caller made, not us — disable is the safer default.
    expect(enabledOf({ profile: "none", enable: ["alpha"], disable: ["alpha"] })).to.deep.equal([]);
  });

  it("a tool-level disable wins even when its group was force-enabled", () => {
    expect(enabledOf({ profile: "none", enable: ["alpha"], disable: ["alpha_two"] })).to.deep.equal(["alpha_one"]);
  });

  it("tolerates unknown group/tool ids instead of throwing, and reports them", () => {
    const resolved = resolveEnabledTools({ enable: ["no-such-group"], disable: ["no-such-tool"] }, catalogue);
    expect([...resolved.enabledNames].sort()).to.deep.equal(["alpha_one", "alpha_two", "beta_one", "beta_two"]);
    expect(resolved.unknown.sort()).to.deep.equal(["no-such-group", "no-such-tool"]);
  });

  it("reports hidden groups and hidden tools for the banner/REST response", () => {
    const resolved = resolveEnabledTools({ disable: ["beta", "alpha_one"] }, catalogue);
    expect(resolved.hiddenGroups).to.deep.equal(["beta"]);
    expect(resolved.hiddenTools.sort()).to.deep.equal(["alpha_one", "beta_one", "beta_two"]);
  });
});

describe("describeToolVisibility", () => {
  it("says 'all' when nothing is hidden", () => {
    expect(describeToolVisibility(116, 116)).to.equal("all 116 enabled");
  });

  it("shows the count when something is hidden", () => {
    expect(describeToolVisibility(116, 43)).to.equal("43/116 enabled");
  });
});
