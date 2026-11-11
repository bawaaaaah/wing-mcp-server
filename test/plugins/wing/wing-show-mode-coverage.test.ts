// Table-driven guard for show mode: walks every MCP tool the WING plugin registers and checks that
// each write tool either refuses an unconfirmed call while show mode is on, or is on a reviewed
// exemption list — and that the exempt "per-key" tools still refuse an audible write themselves.
//
// The registration is captured with a stand-in server, so each tool's final (wrapped) handler is
// called directly. Every context member except the config and the journal is a proxy that throws
// on first use: a tool that refuses touches nothing, and a tool that does not refuse fails loudly
// instead of reaching anything real.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import { registerWingTools } from "../../../src/plugins/wing/tools/index.js";
import { bridgeConfigDefaults, type WingConfig } from "../../../src/plugins/wing/wing-config.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";
import { WingWriteJournal } from "../../../src/plugins/wing/wing-write-journal.js";

type Handler = (...args: unknown[]) => unknown;
interface CapturedTool {
  name: string;
  config: { annotations?: { readOnlyHint?: boolean }; inputSchema?: Record<string, unknown> };
  handler: Handler;
}
interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

/**
 * Write tools that legitimately run without the generic show-mode gate, and why. This mirrors
 * SHOW_MODE_EXEMPT_TOOLS in src/plugins/wing/tools/index.ts on purpose: adding a tool there without
 * adding it here (with a reason) fails this test, so every exemption gets a second look.
 */
const PER_KEY: Record<string, string> = {
  wing_set: "checks the written path with isAudiblePath",
  wing_bulk_set: "checks each assignment key",
  wing_usr_set: "checks each user-signal key",
  wing_copy_identity: "identity keys are cosmetic, linked/source keys are checked",
  wing_clear_identity: "identity keys are cosmetic, linked/source keys are checked",
  wing_bus_set_mono: "checks the mono key",
  wing_set_send: "checks each send key",
  wing_channel_copy: "refuses on the destination strip",
  wing_channel_swap: "refuses on both strips",
  wing_undo: "refuses when the batch holds an audible entry",
  wing_wlive_format_sd_card: "refuses without confirm:true itself, show mode or not",
};

const INAUDIBLE: Record<string, string> = {
  wing_channel_set_name: "strip name",
  wing_mutegroup_set_name: "mute group name",
  wing_set_scribble: "scribble label/colour",
  wing_set_srcauto: "clink: which name the strip displays",
  wing_set_selected_strip: "surface selection",
  wing_set_lighting: "desk lamps/LEDs",
  wing_set_box_map: "server-side stage-box labels",
  wing_set_osc_mirror: "server-side packet forwarding",
  wing_bridge_configure: "server-side bridge settings",
  wing_bridge_set_safes: "server-side bridge safes",
  wing_bridge_set_profiles: "server-side bridge profiles",
  wing_set_autosave_config: "console autosave interval",
  wing_save_to_flash: "persists current state, changes no value",
  wing_clear_link_errors: "resets AES50 error counters",
  wing_preset_save: "server-side preset file",
  wing_preset_delete: "server-side preset file",
  wing_mic_calibration_save: "server-side calibration file",
  wing_mic_calibration_delete: "server-side calibration file",
  wing_fade_cancel: "stops a running fade where it is (a safety stop, writes nothing)",
};

/** Name fragments that always mean an audible change; an inaudible exemption must not match one. */
const AUDIBLE_NAME = /fader|mute(?!group_set_name)|_pan|send|patch|recall|_proc|_eq|gain|compress|gate|_play|record|delay|insert|source(?!_list)|solo|talkback|monitor|alt_|matrix_direct|fade$/;

/** An audible call for every per-key tool (wing_undo is covered separately with a seeded batch). */
const AUDIBLE_CALLS: Record<string, Record<string, unknown>> = {
  wing_set: { path: "/ch/1/fdr", value: -10 },
  wing_bulk_set: { baseNode: "/ch/1", assignments: { fdr: -10, mute: 1 } },
  wing_bus_set_mono: { type: "bus", index: 1, mono: true },
};

function throwingProxy(label: string): never {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined; // not a thenable
        throw new Error(`show-mode test: ${label}.${String(prop)} was used`);
      },
    },
  ) as never;
}

function captureTools(config: WingConfig, journal: WingWriteJournal): CapturedTool[] {
  const tools: CapturedTool[] = [];
  const server = {
    registerTool(name: string, toolConfig: CapturedTool["config"], handler: Handler) {
      tools.push({ name, config: toolConfig, handler });
      return { enable() {}, disable() {}, remove() {}, update() {} };
    },
  } as unknown as McpServer;
  const ctx: WingPluginContext = {
    client: throwingProxy("client"),
    meterClient: throwingProxy("meterClient"),
    cache: throwingProxy("cache"),
    eventBus: throwingProxy("eventBus"),
    getConfig: () => config,
    updateConfig: () => Promise.reject(new Error("show-mode test: updateConfig was used")),
    journal,
    buildOverviewSnapshot: () => Promise.reject(new Error("show-mode test: buildOverviewSnapshot was used")),
    getLastRta: () => null,
    presetStore: throwingProxy("presetStore"),
    micCalibrationStore: throwingProxy("micCalibrationStore"),
    oscMirror: throwingProxy("oscMirror"),
    bridge: throwingProxy("bridge"),
  };
  registerWingTools(server, ctx);
  return tools;
}

function showModeConfig(): WingConfig {
  return {
    host: "127.0.0.1",
    oscPort: 2223,
    discoveryPort: 2222,
    meterTcpPort: 2222,
    meterUdpPort: 14135,
    warmCacheOnConnect: false,
    oscMirrorEnabled: false,
    oscMirrorHost: "",
    oscMirrorPort: 0,
    showMode: true,
    boxMap: {},
    ...bridgeConfigDefaults(),
  };
}

async function call(tool: CapturedTool, args: Record<string, unknown>): Promise<{ result?: ToolResult; thrown?: unknown }> {
  try {
    return { result: (await tool.handler(args, {})) as ToolResult };
  } catch (err) {
    return { thrown: err };
  }
}

function text(outcome: { result?: ToolResult; thrown?: unknown }): string {
  if (outcome.thrown !== undefined) {
    return outcome.thrown instanceof Error ? outcome.thrown.message : JSON.stringify(outcome.thrown);
  }
  return (outcome.result?.content ?? []).map((part) => part.text ?? "").join("\n");
}

const REFUSAL = /Show mode is on/;

describe("show mode covers every write tool", () => {
  const journal = new WingWriteJournal();
  const tools = captureTools(showModeConfig(), journal);
  const writeTools = tools.filter((tool) => !tool.config.annotations?.readOnlyHint);
  const exempt = new Set([...Object.keys(PER_KEY), ...Object.keys(INAUDIBLE)]);

  it("registers a plausible tool surface", () => {
    expect(tools.length).to.be.greaterThan(100);
    expect(writeTools.length).to.be.greaterThan(40);
  });

  it("names only registered write tools on the exemption lists", () => {
    const writeNames = new Set(writeTools.map((tool) => tool.name));
    expect([...exempt].filter((name) => !writeNames.has(name))).to.deep.equal([]);
  });

  for (const tool of writeTools) {
    if (exempt.has(tool.name)) continue;
    it(`${tool.name} refuses an unconfirmed call and offers confirm`, async () => {
      expect(tool.config.inputSchema ?? {}, "confirm parameter").to.have.property("confirm");
      const outcome = await call(tool, {});
      expect(outcome.result?.isError, text(outcome)).to.equal(true);
      expect(text(outcome)).to.match(REFUSAL);
    });
  }

  it("lets exactly the reviewed exemptions through the generic gate", async () => {
    const unexpected: string[] = [];
    for (const tool of writeTools) {
      if (exempt.has(tool.name)) continue;
      const outcome = await call(tool, {});
      if (!REFUSAL.test(text(outcome))) unexpected.push(tool.name);
    }
    expect(unexpected, "write tools that ran without confirm in show mode").to.deep.equal([]);
  });

  it("exempts as inaudible only tools whose name does not suggest a sound change", () => {
    expect(Object.keys(INAUDIBLE).filter((name) => AUDIBLE_NAME.test(name))).to.deep.equal([]);
  });

  for (const [name, args] of Object.entries(AUDIBLE_CALLS)) {
    it(`${name} (checked per key) still refuses an audible write without confirm`, async () => {
      const tool = writeTools.find((t) => t.name === name);
      expect(tool, name).to.not.equal(undefined);
      const outcome = await call(tool!, args);
      expect(text(outcome)).to.match(REFUSAL);
    });
  }

  it("wing_wlive_format_sd_card refuses without confirm:true even outside show mode", async () => {
    const tool = writeTools.find((t) => t.name === "wing_wlive_format_sd_card");
    expect(tool).to.not.equal(undefined);
    const outcome = await call(tool!, { card: 1 });
    expect(text(outcome)).to.match(/confirm/i);
  });

  it("wing_undo refuses to revert an audible batch without confirm", async () => {
    const tool = writeTools.find((t) => t.name === "wing_undo");
    expect(tool).to.not.equal(undefined);
    await journal.runBatch("test_seed", async () => {
      journal.record([{ path: "/ch/1/fdr", previous: -6, next: -10, audible: true }]);
    });
    const outcome = await call(tool!, {});
    expect(text(outcome)).to.match(REFUSAL);
  });
});
