import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { registerWingTools } from "../../../src/plugins/wing/tools/index.js";
import type { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import type {
  WingBranchResult,
  WingBulkSetResult,
  WingGetResult,
  WingNodeDescription,
  WingOscClient,
} from "../../../src/plugins/wing/wing-osc-client.js";
import { WingPresetStore } from "../../../src/plugins/wing/wing-preset-store.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import type { RtaSnapshot, WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

type CallToolTextContent = { type: string; text: string };

/**
 * Canned GET replies for the paths exercised by this test. Keyed by the
 * exact OSC path a tool would request.
 */
const GET_FIXTURES: Record<string, WingGetResult> = {
  "/ch/1/fdr": { path: "/ch/1/fdr", kind: "leaf", valueKind: "float", display: "-6.0", raw: 0.53, value: -6 },
  "/ch/1/mute": { path: "/ch/1/mute", kind: "leaf", valueKind: "int", display: "0", raw: 0, value: 0 },
  "/dca/1/fdr": { path: "/dca/1/fdr", kind: "leaf", valueKind: "float", display: "0.0", raw: 0.72, value: 0 },
  // wing_list_names/wing_channel_get_summary read the "$name" shadow (the effective display name,
  // which mirrors a linked source's name when one is connected) rather than the plain "name" leaf.
  "/ch/1/$name": { path: "/ch/1/$name", kind: "leaf", valueKind: "string", value: "Kick" },
  "/dca/2/name": { path: "/dca/2/name", kind: "leaf", valueKind: "string", value: "Band" },
  // Channel 5 simulates a source-linked input (in/set/srcauto=1, connected to physical input A/3) —
  // used to exercise wing_channel_set_name's rename-the-source redirect. `in/conn/in`'s `value` is
  // deliberately 2, one below its `display` of "3" — verified live against real hardware that this
  // field's wire "int" arg is 0-indexed while `display` (and the /io/in/{group}/{n} addressing
  // convention) is 1-indexed; resolvePhysicalSource() must read `display`, not `value`.
  "/ch/5/in/set/srcauto": { path: "/ch/5/in/set/srcauto", kind: "leaf", valueKind: "int", value: 1 },
  "/ch/5/in/conn/grp": { path: "/ch/5/in/conn/grp", kind: "leaf", valueKind: "string", value: "A" },
  "/ch/5/in/conn/in": { path: "/ch/5/in/conn/in", kind: "leaf", valueKind: "int", display: "3", raw: 0.032, value: 2 },
  "/cfg/rta/rtasrc": { path: "/cfg/rta/rtasrc", kind: "leaf", valueKind: "int", value: 7 },
  "/cfg/rta/rtatap": { path: "/cfg/rta/rtatap", kind: "leaf", valueKind: "string", value: "PREEQ" },
};

interface FakeClientHandle {
  client: WingOscClient;
  bulkSetCalls: Array<{ baseNode: string; assignments: Record<string, number | string> }>;
  toggleCalls: string[];
  setCalls: Array<{ path: string; value: number | string }>;
}

/**
 * A lightweight in-file fake implementing just the `WingOscClient` methods
 * the tools call (get/dump/describe/bulkSet/toggle). Deliberately does not
 * depend on the real `WingOscClient` or `WingMockServer` — this test only
 * needs to prove the MCP tool surface behaves correctly given canned
 * protocol-shaped responses, independent of the other agent's client
 * implementation. Cast through `unknown` since `WingOscClient` is a
 * concrete class with private members that a plain object can't
 * structurally satisfy.
 */
function createFakeWingClient(): FakeClientHandle {
  const bulkSetCalls: Array<{ baseNode: string; assignments: Record<string, number | string> }> = [];
  const toggleCalls: string[] = [];
  const setCalls: Array<{ path: string; value: number | string }> = [];

  const fakeClient = {
    async get(path: string): Promise<WingGetResult | WingBranchResult> {
      // "/tags" is the one leaf this fake makes stateful: wing_set_group_membership reads it back
      // after a set() to verify the console applied the change, so it needs to see its own write.
      if (path.endsWith("/tags")) {
        const lastSet = [...setCalls].reverse().find((call) => call.path === path);
        return { path, kind: "leaf", valueKind: "string", value: lastSet ? String(lastSet.value) : "" };
      }
      return GET_FIXTURES[path] ?? { path, kind: "branch", children: ["fdr", "mute", "name"] };
    },
    async set(path: string, value: number | string): Promise<void> {
      setCalls.push({ path, value });
    },
    async dump(path: string): Promise<Record<string, string | number>> {
      // Channel 20's gate slot simulates a real Dynamic EQ plugin (mdl "DEQ2", confirmed live against
      // real hardware on channel 3) — used to exercise the bidirectional (boost-or-cut) handling that
      // every other verified gate/dyn model (STD/COMP/... below) doesn't need.
      if (path === "/ch/20/gate") {
        return { on: 1, mdl: "DEQ2", thr: -40, range: -60, att: 1, hld: 10, rel: 100, ratio: 4, mix: 100, gain: 0 };
      }
      // Channel 21's gate slot simulates the "GATE" model specifically — the one documented exception
      // (WING_Remote-Protocols-3.1-03.pdf p.98: "Standard Wing gate is 60 dB" full-scale range, vs the
      // 20dB default every other model uses) that wing-dynamics-models.ts's gainReductionScaleCorrection
      // must apply a 3x (60/20) correction for, on top of whatever the meter protocol itself parsed.
      if (path === "/ch/21/gate") {
        return { on: 1, mdl: "GATE", thr: 0, range: 60, att: 10, hld: 10, rel: 200, acc: 0, ratio: "gate", mix: 100, gain: 0 };
      }
      if (path.endsWith("/gate")) {
        return { on: 1, mdl: "STD", thr: -40, range: -60, att: 1, hld: 10, rel: 100, ratio: 4, mix: 100, gain: 0 };
      }
      // Channel 22's dyn slot simulates the real "76LA" model — verified live to have NO "thr" field
      // at all (it uses "in"/"out" gain-staging instead), exercising the model-aware validation that
      // rejects thresholdDb/ratio for a model that doesn't expose that control, instead of blindly
      // sending "thr" and getting back a cryptic console rejection.
      if (path === "/ch/22/dyn") {
        return { on: 1, mdl: "76LA", mix: 100, gain: 0, in: -26.5, out: -27, att: 2, rel: 2, ratio: 8 };
      }
      if (path.endsWith("/dyn")) {
        return { on: 1, mdl: "COMP", thr: -20, ratio: "4:1", knee: 2, det: "RMS", att: 5, hld: 0, rel: 150, mix: 100, gain: 2 };
      }
      return { name: "Kick", fdr: -6, mute: 0, pan: 0 };
    },
    async describe(path: string, _includeValues?: boolean): Promise<WingNodeDescription> {
      if (path === "/ch/22/dyn") {
        const lines = [
          "on int [0 .. 1]",
          "in lin [-48.0 .. 0.0 dB], 97 steps",
          "out lin [-48.0 .. 0.0 dB], 97 steps",
          "gain lin [-6.0 .. 12.0 dB], 37 steps",
          "ratio list [4, 8, 12, 20, ALL]",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path.endsWith("/dyn")) {
        const lines = [
          "on int [0 .. 1]",
          "thr lin [-60.0 .. 0.0 dB], 601 steps",
          "gain lin [-20.0 .. +20.0 dB], 401 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path.endsWith("/gate")) {
        const lines = [
          "on int [0 .. 1]",
          "thr lin [-80.0 .. 0.0 dB], 801 steps",
          "gain lin [-20.0 .. +20.0 dB], 401 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      const raw = "1?Show A/Scene 1~2?Show A/Scene 2";
      return { path, raw, lines: raw.split("~") };
    },
    async bulkSet(baseNode: string, assignments: Record<string, number | string>): Promise<WingBulkSetResult> {
      bulkSetCalls.push({ baseNode, assignments });
      // Simulates the plan's flagged open question: the bulk-set toggle
      // convention (mute=-1) is NOT acknowledged as OK by this console,
      // forcing wing_channel_toggle_mute through its documented fallback.
      if (assignments.mute === -1) {
        return { status: "VALUE ERROR", ok: false, raw: "VALUE ERROR" };
      }
      return { status: "OK", ok: true, raw: "OK" };
    },
    async toggle(path: string): Promise<void> {
      toggleCalls.push(path);
    },
  };

  return { client: fakeClient as unknown as WingOscClient, bulkSetCalls, toggleCalls, setCalls };
}

function createFakeContext(presetDir: string): {
  ctx: WingPluginContext;
  handle: FakeClientHandle;
  rta: { snapshot: RtaSnapshot | null };
  meterClient: EventEmitter;
} {
  const handle = createFakeWingClient();
  const rta: { snapshot: RtaSnapshot | null } = { snapshot: null };
  const meterClient = new EventEmitter();
  const ctx: WingPluginContext = {
    client: handle.client,
    meterClient: meterClient as unknown as WingMeterClient,
    cache: new WingStateCache(),
    eventBus: new EventBus(),
    getConfig: () => ({
      host: "127.0.0.1",
      oscPort: 2223,
      discoveryPort: 2222,
      meterTcpPort: 2222,
      meterUdpPort: 14135,
      warmCacheOnConnect: true,
    }),
    buildOverviewSnapshot: async () => ({}),
    getLastRta: () => rta.snapshot,
    presetStore: new WingPresetStore({ dir: presetDir }),
  };
  return { ctx, handle, rta, meterClient };
}

describe("wing plugin MCP tools (end-to-end via a real McpServer/Client pair)", () => {
  let client: Client;
  let server: McpServer;
  let handle: FakeClientHandle;
  let rta: { snapshot: RtaSnapshot | null };
  let meterClient: EventEmitter;
  let presetDir: string;

  beforeEach(async () => {
    presetDir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-presets-"));
    const created = createFakeContext(presetDir);
    handle = created.handle;
    rta = created.rta;
    meterClient = created.meterClient;

    server = new McpServer({ name: "wing-test-server", version: "0.0.0" });
    registerWingTools(server, created.ctx);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "wing-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(presetDir, { recursive: true, force: true });
  });

  it("lists the full wing tool surface", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).to.include.members([
      "wing_get",
      "wing_set",
      "wing_dump",
      "wing_describe",
      "wing_bulk_set",
      "wing_channel_get_fader",
      "wing_channel_set_fader",
      "wing_channel_toggle_mute",
      "wing_bus_get_fader",
      "wing_dca_get_fader",
      "wing_mutegroup_toggle",
      "wing_set_send",
      "wing_get_send",
      "wing_scene_recall",
      "wing_dynamics_status",
      "wing_auto_compress",
      "wing_auto_gate",
    ]);
  });

  it("wing_get reads a leaf value", async () => {
    const result = await client.callTool({ name: "wing_get", arguments: { path: "/ch/1/fdr" } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      path: "/ch/1/fdr",
      kind: "leaf",
      valueKind: "float",
      display: "-6.0",
      raw: 0.53,
      value: -6,
    });
  });

  it("wing_channel_set_fader issues a bulk-set and reports the ack", async () => {
    const result = await client.callTool({
      name: "wing_channel_set_fader",
      arguments: { channel: 1, db: -6 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { fdr: -6 } }]);
    expect(result.structuredContent).to.deep.equal({ channel: 1, db: -6, status: "OK", ok: true, raw: "OK" });
  });

  it("wing_channel_toggle_mute falls back to the primitive toggle when the bulk-set ack is not OK", async () => {
    const result = await client.callTool({
      name: "wing_channel_toggle_mute",
      arguments: { channel: 1 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { mute: -1 } }]);
    expect(handle.toggleCalls).to.deep.equal(["/ch/1/mute"]);
    expect(result.structuredContent).to.deep.equal({ channel: 1, ackOk: false });
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("no ack");
  });

  it("wing_channel_set_name renames the channel directly when its input isn't source-linked", async () => {
    // Channel 1 has no in/set/srcauto|in/conn/* fixture, so the fake client's default (branch)
    // reply makes resolveInputNameTarget() treat it as "link state unknown" and fall back to a
    // direct channel rename — the same behavior as before source-linking was handled at all.
    const result = await client.callTool({
      name: "wing_channel_set_name",
      arguments: { channel: 1, name: "Kick2" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { name: "Kick2" } }]);
    expect(result.structuredContent).to.include({ channel: 1, name: "Kick2", viaSource: false, baseNode: "/ch/1" });
  });

  it("wing_channel_set_name renames the connected physical input instead when the channel is source-linked", async () => {
    const result = await client.callTool({
      name: "wing_channel_set_name",
      arguments: { channel: 5, name: "Vocal 1" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/io/in/A/3", assignments: { name: "Vocal 1" } }]);
    expect(result.structuredContent).to.include({
      channel: 5,
      name: "Vocal 1",
      viaSource: true,
      baseNode: "/io/in/A/3",
    });
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("linked to its input source");
  });

  it("wing_mutegroup_set_name renames a mute group via an ACK'd bulk-set", async () => {
    const result = await client.callTool({
      name: "wing_mutegroup_set_name",
      arguments: { mutegroup: 1, name: "Vocals" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/mgrp/1", assignments: { name: "Vocals" } }]);
    expect(result.structuredContent).to.deep.equal({
      mutegroup: 1,
      name: "Vocals",
      status: "OK",
      ok: true,
      raw: "OK",
    });
  });

  it("wing_get_group_membership decodes #D/#M tags from the strip's tags field", async () => {
    const result = await client.callTool({
      name: "wing_get_group_membership",
      arguments: { type: "channel", index: 7 },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ type: "channel", index: 7, dca: [], mutegroups: [] });
  });

  it("wing_set_group_membership adds a #D tag, preserving other tags, and verifies by reading tags back", async () => {
    const result = await client.callTool({
      name: "wing_set_group_membership",
      arguments: { type: "channel", index: 7, kind: "dca", group: 3, on: true },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.setCalls).to.deep.equal([{ path: "/ch/7/tags", value: "#D3" }]);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 7,
      kind: "dca",
      group: 3,
      on: true,
      dca: [3],
      mutegroups: [],
    });
  });

  it("wing_set_group_membership rejects a DCA index out of range as a tool-visible error", async () => {
    const result = await client.callTool({
      name: "wing_set_group_membership",
      arguments: { type: "channel", index: 7, kind: "dca", group: 99, on: true },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("out of range");
    expect(handle.setCalls).to.deep.equal([]);
  });

  it("wing_dca_get_fader reads a DCA fader value", async () => {
    const result = await client.callTool({ name: "wing_dca_get_fader", arguments: { dca: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ dca: 1, db: 0 });
  });

  it("wing_scene_recall bulk-sets $actionidx and $action=GO on /$ctl/lib", async () => {
    const result = await client.callTool({
      name: "wing_scene_recall",
      arguments: { target: 5 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([
      { baseNode: "/$ctl/lib", assignments: { $actionidx: 5, $action: "GO" } },
    ]);
  });

  it("wing_dump rejects a root namespace before ever calling the client, as a tool-visible error", async () => {
    const result = await client.callTool({ name: "wing_dump", arguments: { path: "/ch" } });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("wing_dump only allows");
  });

  it("wing_list_names reads every channel/aux/bus/main/matrix/dca/mutegroup name leaf", async () => {
    const result = await client.callTool({ name: "wing_list_names" });
    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as { channels: { index: number; name: string }[]; dcas: { index: number; name: string }[] };
    // The fake client's default (branch) reply resolves to an empty name for any index not
    // explicitly stubbed in GET_FIXTURES — only /ch/1 and /dca/2 are stubbed above.
    expect(structured.channels).to.have.lengthOf(40);
    expect(structured.channels[0]).to.deep.equal({ index: 1, name: "Kick" });
    expect(structured.channels[1]).to.deep.equal({ index: 2, name: "" });
    expect(structured.dcas).to.have.lengthOf(16);
    expect(structured.dcas[1]).to.deep.equal({ index: 2, name: "Band" });
  });

  it("wing_fade starts a background ramp and reports the resolved from/to immediately", async () => {
    const result = await client.callTool({
      name: "wing_fade",
      arguments: { path: "/ch/1/fdr", durationMs: 100, direction: "out" },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      status: "started",
      path: "/ch/1/fdr",
      from: -6,
      to: -144,
      durationMs: 100,
      steps: 2,
    });

    // Cancel right away — the interval's first tick is 50ms out, so this runs well before any
    // step fires, proving the fade was actually registered as active rather than a no-op.
    const cancelResult = await client.callTool({ name: "wing_fade_cancel", arguments: { path: "/ch/1/fdr" } });
    expect(cancelResult.structuredContent).to.deep.equal({ status: "cancelled", path: "/ch/1/fdr", wasActive: true });
  });

  it("wing_fade_cancel on an idle path is a no-op, not an error", async () => {
    const result = await client.callTool({ name: "wing_fade_cancel", arguments: { path: "/ch/2/fdr" } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ status: "cancelled", path: "/ch/2/fdr", wasActive: false });
  });

  it("wing_get_rta reports unavailable before any RTA frame has been received", async () => {
    const result = await client.callTool({ name: "wing_get_rta" });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ available: false });
  });

  it("wing_get_rta returns the cached snapshot once one has arrived", async () => {
    rta.snapshot = { bandsDb: [-80, -40, -12, 0], receivedAt: 1000 };
    const result = await client.callTool({ name: "wing_get_rta" });
    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as { available: boolean; bandsDb: number[]; receivedAt: number; ageMs: number };
    expect(structured.available).to.equal(true);
    expect(structured.bandsDb).to.deep.equal([-80, -40, -12, 0]);
    expect(structured.receivedAt).to.equal(1000);
    expect(structured.ageMs).to.be.a("number");
  });

  it("wing_meter_stats samples the live meter stream and computes per-channel level statistics", async () => {
    const frames = [
      { type: "channel", index: 5, inputL_dB: -20, inputR_dB: -22, outputL_dB: -10, outputR_dB: -11, gateKey_dB: -30, gateGain_dB: -1, dynKey_dB: -25, dynGain_dB: -2 },
      // Below the default -50dB exclusion threshold — should count toward raw min but not minAboveThreshold.
      { type: "channel", index: 5, inputL_dB: -60, inputR_dB: -58, outputL_dB: -10, outputR_dB: -11, gateKey_dB: -30, gateGain_dB: -1, dynKey_dB: -25, dynGain_dB: -2 },
      { type: "channel", index: 5, inputL_dB: -10, inputR_dB: -12, outputL_dB: -10, outputR_dB: -11, gateKey_dB: -30, gateGain_dB: -1, dynKey_dB: -25, dynGain_dB: -2 },
      // A different index — must be ignored by the stats for channel 5.
      { type: "channel", index: 6, inputL_dB: 5, inputR_dB: 5, outputL_dB: 5, outputR_dB: 5, gateKey_dB: 5, gateGain_dB: 5, dynKey_dB: 5, dynGain_dB: 5 },
    ];
    let i = 0;
    const emitter = setInterval(() => {
      meterClient.emit("snapshot", { frames: [frames[i % frames.length]] });
      i++;
    }, 20);

    try {
      const result = await client.callTool({
        name: "wing_meter_stats",
        arguments: { type: "channel", index: 5, signal: "input", durationMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        sampleCount: number;
        excludeBelowDb: number;
        channels: { left: { min: number; max: number; minAboveThreshold: number | null }; right: unknown };
      };
      expect(structured.excludeBelowDb).to.equal(-50);
      expect(structured.sampleCount).to.be.greaterThan(0);
      expect(structured.channels.left.min).to.equal(-60);
      expect(structured.channels.left.max).to.equal(-10);
      expect(structured.channels.left.minAboveThreshold).to.equal(-20);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_meter_stats reports gate as separate key/gain stats rather than pooling them", async () => {
    // "gate" only exists on channel strips (see the "rejects...on a bus/main/matrix strip" test
    // below) — bus doesn't have one, so this uses "channel" like every other gate-signal test here.
    const frame = {
      type: "channel",
      index: 2,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -33,
      gateGain_dB: -4,
      dynKey_dB: -25,
      dynGain_dB: -2,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_meter_stats",
        arguments: { type: "channel", index: 2, signal: "gate", durationMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { channels: { key: { min: number }; gain: { min: number } } };
      expect(structured.channels.key.min).to.equal(-33);
      // Fake gate dump fixture is model "STD" (fictional placeholder, not a real firmware model
      // name) — not "GATE", so the correction factor is 1 and -4 passes through unchanged.
      expect(structured.channels.gain.min).to.equal(-4);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_meter_stats rejects signal: "gate" on a bus/main/matrix strip', async () => {
    const result = await client.callTool({
      name: "wing_meter_stats",
      arguments: { type: "bus", index: 2, signal: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('The "gate" slot only exists on channel strips');
  });

  it('wing_meter_stats applies the "GATE" model\'s documented 60dB (vs 20dB default) full-scale correction', async () => {
    const frame = {
      type: "channel",
      index: 21,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -33,
      gateGain_dB: -4, // default-scale reading; true value is -4 * 3 = -12dB for the "GATE" model
      dynKey_dB: -25,
      dynGain_dB: -2,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_meter_stats",
        arguments: { type: "channel", index: 21, signal: "gate", durationMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        channels: { gain: { min: number; max: number } };
        gainReductionFullScaleDb: number;
      };
      expect(structured.gainReductionFullScaleDb).to.equal(60);
      expect(structured.channels.gain.min).to.equal(-12);
      expect(structured.channels.gain.max).to.equal(-12);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_meter_stats fails clearly when no meter data arrives during the window", async () => {
    const result = await client.callTool({
      name: "wing_meter_stats",
      arguments: { type: "channel", index: 1, durationMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("No live meter data received");
  });

  it("wing_dynamics_status reports gate+dyn settings and the live gain reduction happening right now", async () => {
    const frame = {
      type: "channel",
      index: 7,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: -2,
      dynKey_dB: -25,
      dynGain_dB: -5,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "channel", index: 7, sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        blocks: {
          gate: { settings: Record<string, unknown>; live: { currentGainReductionDb: number; active: boolean } };
          dyn: { settings: Record<string, unknown>; live: { currentGainReductionDb: number; active: boolean } };
        };
      };
      expect(structured.blocks.gate.settings.thr).to.equal(-40);
      expect(structured.blocks.gate.live.currentGainReductionDb).to.equal(-2);
      expect(structured.blocks.gate.live.active).to.equal(true);
      expect(structured.blocks.dyn.settings.thr).to.equal(-20);
      expect(structured.blocks.dyn.live.currentGainReductionDb).to.equal(-5);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("reducing -2.0dB now");
      expect(content[0].text).to.include("reducing -5.0dB now");
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_dynamics_status silently reports dyn only (no gate) for aux, like bus/main/matrix", async () => {
    const frame = {
      type: "aux",
      index: 5,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: -2,
      dynKey_dB: -25,
      dynGain_dB: -5,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "aux", index: 5, sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { blocks: Record<string, unknown> };
      expect(Object.keys(structured.blocks)).to.deep.equal(["dyn"]);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_dynamics_status silently reports dyn only (no gate) for bus/main/matrix strips", async () => {
    const frame = {
      type: "bus",
      index: 3,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: -2,
      dynKey_dB: -25,
      dynGain_dB: -5,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "bus", index: 3, sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { blocks: Record<string, unknown> };
      expect(Object.keys(structured.blocks)).to.deep.equal(["dyn"]);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_dynamics_status rejects block: \"gate\" on a bus/main/matrix strip", async () => {
    const result = await client.callTool({
      name: "wing_dynamics_status",
      arguments: { type: "bus", index: 3, block: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('The "gate" slot only exists on channel strips');
  });

  it("wing_auto_compress sets a new threshold and compensates the measured reduction with makeup gain", async () => {
    const frame = {
      type: "channel",
      index: 9,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -10,
      dynGain_dB: -6,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 9, thresholdDb: -18, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        threshold: { old: number; new: number };
        makeupGain: { old: number; new: number; clamped: boolean };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.threshold).to.deep.equal({ old: -20, new: -18 });
      expect(structured.makeupGain).to.deep.equal({ old: 2, new: 8, clamped: false });
      expect(structured.measured.meanGainReductionDb).to.equal(-6);

      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/9/dyn", assignments: { thr: -18, on: 1 } });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/9/dyn", assignments: { gain: 8 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress works on aux strips (dyn only, no gate slot exists there)", async () => {
    const frame = {
      type: "aux",
      index: 6,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -10,
      dynGain_dB: -3,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "aux", index: 6, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        block: string;
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.block).to.equal("dyn");
      expect(structured.makeupGain).to.deep.equal({ old: 2, new: 5, clamped: false });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/aux/6/dyn", assignments: { gain: 5 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress can drive the \"gate\" slot instead of \"dyn\" when a compressor model is loaded there", async () => {
    const frame = {
      type: "channel",
      index: 12,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -10,
      gateGain_dB: -4,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 12, block: "gate", thresholdDb: -35, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        block: string;
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.block).to.equal("gate");
      // Fake gate dump fixture starts at gain: 0; measured mean reduction is -4dB, so makeup compensates by +4.
      expect(structured.makeupGain).to.deep.equal({ old: 0, new: 4, clamped: false });

      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/12/gate", assignments: { thr: -35, on: 1 } });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/12/gate", assignments: { gain: 4 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress treats a positive gain reading as idle detector noise, not negative reduction", async () => {
    // Verified against real hardware: some models idle with a slight *positive* wobble in their
    // own gain-reduction reading instead of a flat 0 — must not be treated as "gain reduction" (it
    // would otherwise nudge makeup gain in the wrong direction to "compensate" for pure noise).
    const frame = {
      type: "channel",
      index: 13,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -10,
      outputR_dB: -12,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -20,
      dynGain_dB: 0.5,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 13, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        measured: { meanGainReductionDb: number; peakGainReductionDb: number };
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.measured.meanGainReductionDb).to.equal(0);
      expect(structured.measured.peakGainReductionDb).to.equal(0);
      expect(structured.makeupGain).to.deep.equal({ old: 2, new: 2, clamped: false });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress rejects block: \"gate\" on a bus/main/matrix strip", async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "bus", index: 4, block: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('The "gate" slot only exists on channel strips');
  });

  it("wing_auto_compress fails clearly (without guessing a makeup value) when there's no real signal to measure", async () => {
    const frame = {
      type: "channel",
      index: 10,
      inputL_dB: -90,
      inputR_dB: -92,
      outputL_dB: -90,
      outputR_dB: -92,
      gateKey_dB: -90,
      gateGain_dB: 0,
      dynKey_dB: -90,
      dynGain_dB: -3,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 10, sampleMs: 500 },
      });
      expect(result.isError).to.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("No real signal was detected");
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress fails clearly when no live meter data arrives at all", async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 11, sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("no live meter data was received");
  });

  it('wing_dynamics_status reports a Dynamic EQ (mdl "DEQ2") boosting as active, not as idle noise', async () => {
    // A Dynamic EQ can legitimately boost a detected band, unlike every cut-only gate/compressor
    // model — a positive reading here must NOT be treated as detector wobble (see channel 4's gate
    // in the auto-compress idle-noise test below, which IS cut-only and must still clamp positives).
    const frame = {
      type: "channel",
      index: 20,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: 2.5,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "channel", index: 20, block: "gate", sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        blocks: { gate: { live: { currentGainReductionDb: number; active: boolean; bidirectional: boolean } } };
      };
      expect(structured.blocks.gate.live.bidirectional).to.equal(true);
      expect(structured.blocks.gate.live.currentGainReductionDb).to.equal(2.5);
      expect(structured.blocks.gate.live.active).to.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("boosting 2.5dB now");
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_dynamics_status reports a Dynamic EQ (mdl "DEQ2") cutting as "cutting", not "reducing"', async () => {
    const frame = {
      type: "channel",
      index: 20,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: -3,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "channel", index: 20, block: "gate", sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("cutting 3.0dB now");
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress does NOT clamp a Dynamic EQ (mdl "DEQ2") boost to zero like it would for a cut-only model', async () => {
    const frame = {
      type: "channel",
      index: 20,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -10,
      outputR_dB: -12,
      gateKey_dB: -20,
      gateGain_dB: 2,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 20, block: "gate", sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        model: string;
        measured: { meanGainReductionDb: number; peakGainReductionDb: number };
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.model).to.equal("DEQ2");
      // Unclamped: the real +2dB boost survives into the mean/peak instead of being flattened to 0.
      expect(structured.measured.meanGainReductionDb).to.equal(2);
      expect(structured.measured.peakGainReductionDb).to.equal(2);
      // Makeup gain compensates a net boost by going down, not up (old 0 -> new -2).
      expect(structured.makeupGain).to.deep.equal({ old: 0, new: -2, clamped: false });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/20/gate", assignments: { gain: -2 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_dynamics_status applies the "GATE" model\'s documented 60dB (vs 20dB default) full-scale correction', async () => {
    // -10dB here simulates what the meter protocol parsing layer itself would report using the
    // DEFAULT 20dB scale (it can't know the model) — the true value, once wing_dynamics_status looks
    // up mdl "GATE" and applies the documented 3x (60/20) correction, must be -30dB, not -10dB.
    const frame = {
      type: "channel",
      index: 21,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -61,
      gateGain_dB: -10,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "channel", index: 21, block: "gate", sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        blocks: { gate: { live: { currentGainReductionDb: number; peakGainReductionDb: number } } };
      };
      expect(structured.blocks.gate.live.currentGainReductionDb).to.equal(-30);
      expect(structured.blocks.gate.live.peakGainReductionDb).to.equal(-30);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("reducing -30.0dB now");
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress applies the "GATE" model\'s documented 60dB (vs 20dB default) full-scale correction to makeup gain', async () => {
    const frame = {
      type: "channel",
      index: 21,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -10,
      outputR_dB: -12,
      gateKey_dB: -61,
      gateGain_dB: -10, // default-scale reading; true value is -10 * 3 = -30dB for the "GATE" model
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 21, block: "gate", sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        model: string;
        measured: { meanGainReductionDb: number; peakGainReductionDb: number };
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.model).to.equal("GATE");
      expect(structured.measured.meanGainReductionDb).to.equal(-30);
      expect(structured.measured.peakGainReductionDb).to.equal(-30);
      expect(structured.makeupGain).to.deep.equal({ old: 0, new: 20, clamped: true });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/21/gate", assignments: { gain: 20 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress rejects thresholdDb for a model with no "thr" field (e.g. real "76LA")', async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 22, block: "dyn", thresholdDb: -20, sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Model 76LA");
    expect(content[0].text).to.include('has no "thr" field');
    expect(content[0].text).to.include("in, out"); // lists what IS actually available
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it('wing_auto_compress omitting thresholdDb still works fine on a model with no "thr" field', async () => {
    const frame = {
      type: "channel",
      index: 22,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -10,
      outputR_dB: -12,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -15,
      dynGain_dB: -2,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 22, block: "dyn", sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { model: string; makeupGain: { old: number; new: number } };
      expect(structured.model).to.equal("76LA");
      expect(structured.makeupGain).to.deep.equal({ old: 0, new: 2, clamped: false });
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress rejects ratio for a model with no "ratio" field in the fake fixture (channel 21\'s gate)', async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 21, block: "gate", ratio: "1:3", sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('has no "ratio" field');
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_auto_compress rejects passing both thresholdDb and targetReductionDb together", async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 9, thresholdDb: -18, targetReductionDb: -5, sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Pass either thresholdDb");
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it('wing_auto_compress rejects targetReductionDb for a model with no "thr" field (e.g. real "76LA")', async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 22, block: "dyn", targetReductionDb: -5, sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Model 76LA");
    expect(content[0].text).to.include('has no "thr" field');
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_auto_compress leaves the threshold untouched when it already produces the requested reduction", async () => {
    const frame = {
      type: "channel",
      index: 24,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -10,
      dynGain_dB: -6,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 24, targetReductionDb: -6, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        threshold: { old: number; new: number };
        target: { reductionDb: number; mode: string; converged: boolean; iterations: number; stopReason: string };
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.threshold).to.deep.equal({ old: -20, new: -20 });
      expect(structured.target).to.deep.equal({ reductionDb: -6, mode: "average", converged: true, iterations: 1, stopReason: "converged" });
      expect(structured.makeupGain).to.deep.equal({ old: 2, new: 8, clamped: false });
      // The current threshold already hits the target, so it's never rewritten — only the final
      // makeup-gain compensation is sent.
      expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/24/dyn", assignments: { gain: 8 } }]);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress searches toward an unreachable target and gives up once a move stops changing anything measurable", async () => {
    const frame = {
      type: "channel",
      index: 25,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -10,
      dynGain_dB: -6,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        // The fake meter always reports -6dB regardless of the threshold actually set, so a target
        // this far away can never be reached — every move produces no measurable change (still
        // -6dB either way). Each unresponsive streak now also grows the step size (to escape a
        // genuine dead zone faster — see AUTO_COMPRESS_TARGET_STEP_GROWTH), so the search escalates
        // all the way to the model's own thr boundary (0dB) before conceding there's nowhere left to
        // try, rather than giving up mid-range.
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 25, targetReductionDb: -30, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        threshold: { old: number; new: number };
        target: { reductionDb: number; mode: string; converged: boolean; iterations: number; stopReason: string };
      };
      expect(structured.threshold).to.deep.equal({ old: -20, new: 0 });
      expect(structured.target).to.deep.equal({ reductionDb: -30, mode: "average", converged: false, iterations: 4, stopReason: "range-exhausted" });
      expect(handle.bulkSetCalls.filter((c) => c.baseNode === "/ch/25/dyn" && "thr" in c.assignments)).to.have.length(3);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress empirically detects and corrects the wrong search direction for a gate-type model", async () => {
    // A downward compressor reduces MORE as the threshold drops; a gate/expander is the opposite —
    // it reduces MORE as the threshold RISES (more of the signal falls below it). This simulates a
    // simple gate-style transfer function (fixed input level, attenuates by (threshold - input) once
    // input is below threshold) so the search's first move — which always assumes compressor-style
    // polarity — is provably wrong here, and only converges if it empirically detects that and flips.
    // Fixed well below the generic "/gate" fixture's starting thr (-40) so the gate is already
    // engaged at the start — moving the threshold further down (the wrong, compressor-assumed first
    // move) shallows the gating instead of deepening it, giving the empirical check something real
    // to detect as "worse".
    const inputLevel = -50;
    function currentThr(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const call = handle.bulkSetCalls[i];
        if (call.baseNode === "/ch/26/gate" && typeof call.assignments.thr === "number") return call.assignments.thr as number;
      }
      return -40; // the generic "/gate" fixture's starting thr
    }
    function frame() {
      const thr = currentThr();
      const reduction = inputLevel < thr ? -(thr - inputLevel) : 0;
      return {
        type: "channel",
        index: 26,
        inputL_dB: inputLevel,
        inputR_dB: inputLevel,
        outputL_dB: inputLevel + reduction,
        outputR_dB: inputLevel + reduction,
        gateKey_dB: inputLevel,
        gateGain_dB: reduction,
        dynKey_dB: -30,
        dynGain_dB: 0,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);

    try {
      const result = await client.callTool({
        // maxIterations is higher than the default here because flipping polarity now requires two
        // consecutive worsened readings, not one (verified live against real, non-stationary music:
        // a single worsened round can just be the program material's own loudness drifting between
        // sampling windows, not proof the assumed direction is wrong) — that costs one extra round
        // before the search corrects course.
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 26, block: "gate", targetReductionDb: -20, sampleMs: 500, maxIterations: 10 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        target: { converged: boolean; stopReason: string };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.target.converged).to.equal(true);
      expect(structured.target.stopReason).to.equal("converged");
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-20, 0.75);

      const thrCalls = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/26/gate" && typeof c.assignments.thr === "number")
        .map((c) => c.assignments.thr as number);
      expect(thrCalls.length).to.be.greaterThan(1);
      // First move assumes compressor polarity and lowers the threshold — the wrong direction for a
      // gate, so it must eventually correct course by raising it again rather than drifting further down.
      expect(thrCalls[0]).to.be.lessThan(-40);
      expect(Math.max(...thrCalls.slice(1))).to.be.greaterThan(thrCalls[0]);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress probes the opposite direction when the very first move is already blocked by the model's own thr range", async () => {
    // Channel 21's gate fixture already starts at thr: 0 — the fixture's own thrMax (the "GATE"
    // model's describe() range is -80..0) — so the default compressor-assumed first move (which
    // would want to go even higher) is blocked before a single real measurement is ever taken.
    // Without the boundary-probe fallback this would report "range-exhausted" having learned
    // nothing; with it, the search tries the opposite direction once, discovers that's the right way
    // for this gate-style model, and converges normally. (mdl "GATE" also exercises the live
    // range-based 3x gain-reduction scale correction alongside the polarity fix — dividing by 3 here
    // so the simulated physics below lands on the intended real-dB numbers after that correction.)
    let liveThr = 0;
    const inputLevel = -50;
    function frame() {
      const reduction = inputLevel < liveThr ? -(liveThr - inputLevel) : 0;
      return {
        type: "channel",
        index: 21,
        inputL_dB: inputLevel,
        inputR_dB: inputLevel,
        outputL_dB: inputLevel + reduction,
        outputR_dB: inputLevel + reduction,
        gateKey_dB: inputLevel,
        gateGain_dB: reduction / 3,
        dynKey_dB: -30,
        dynGain_dB: 0,
      };
    }
    function currentThr(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const call = handle.bulkSetCalls[i];
        if (call.baseNode === "/ch/21/gate" && typeof call.assignments.thr === "number") return call.assignments.thr as number;
      }
      return 0;
    }
    const emitter = setInterval(() => {
      liveThr = currentThr();
      meterClient.emit("snapshot", { frames: [frame()] });
    }, 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 21, block: "gate", targetReductionDb: -5, sampleMs: 500, maxIterations: 6 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        target: { converged: boolean; stopReason: string };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.target.converged).to.equal(true);
      expect(structured.target.stopReason).to.equal("converged");
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-5, 0.75);

      const thrCalls = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/21/gate" && typeof c.assignments.thr === "number")
        .map((c) => c.assignments.thr as number);
      expect(thrCalls.length).to.be.greaterThan(0);
      // The search's very first real move must go DOWN from the boundary (the corrected,
      // gate-appropriate direction) rather than reporting defeat having tried nothing.
      expect(thrCalls[0]).to.be.lessThan(0);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress does not flip polarity on a single noisy/content-driven worsened reading", async () => {
    // Found via live testing against real (non-stationary) music: on genuinely dynamic program
    // material, the signal's OWN loudness can drift between two ~1-2s sampling windows by more than
    // AUTO_COMPRESS_TARGET_FLAT_EPS regardless of which way the threshold just moved — which, on a
    // model that's actually a correctly-behaving downward compressor, can look exactly like a single
    // "worsened" round and used to trigger a spurious polarity flip that then fought the correct
    // direction for the rest of the search. This simulates a real compressor transfer function (more
    // reduction as the threshold drops) plus a one-off, threshold-independent "content got louder"
    // spike injected only during the second sampling round, then verifies the search still converges
    // using the original (correct) polarity — i.e. the threshold only ever moves in the sensible
    // range around the target, never plunges toward the opposite extreme the way an incorrect flip
    // would send it.
    const signalLevel = -5;
    function currentThr(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const call = handle.bulkSetCalls[i];
        if (call.baseNode === "/ch/27/dyn" && typeof call.assignments.thr === "number") return call.assignments.thr as number;
      }
      return -20; // the generic "/dyn" fixture's starting thr
    }
    function roundIndex(): number {
      return handle.bulkSetCalls.filter((c) => c.baseNode === "/ch/27/dyn" && typeof c.assignments.thr === "number").length;
    }
    function frame() {
      const thr = currentThr();
      let reduction = thr < signalLevel ? -(signalLevel - thr) * 0.5 : 0;
      if (roundIndex() === 1) reduction -= 6; // one-off content-driven spike, only during round 2
      return {
        type: "channel",
        index: 27,
        inputL_dB: signalLevel,
        inputR_dB: signalLevel,
        outputL_dB: signalLevel + reduction,
        outputR_dB: signalLevel + reduction,
        gateKey_dB: -40,
        gateGain_dB: 0,
        dynKey_dB: signalLevel,
        dynGain_dB: reduction,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 27, targetReductionDb: -6, sampleMs: 500, maxIterations: 8 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        target: { converged: boolean; stopReason: string };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.target.converged).to.equal(true);
      expect(structured.target.stopReason).to.equal("converged");
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-6, 0.75);

      const thrCalls = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/27/dyn" && typeof c.assignments.thr === "number")
        .map((c) => c.assignments.thr as number);
      // A wrongly-triggered flip would send the threshold plunging toward the opposite extreme (well
      // past -30) chasing a "more reduction needed" reading that was actually just the injected spike
      // — instead every move should stay in the sensible neighborhood around the real target.
      for (const thr of thrCalls) {
        expect(thr).to.be.greaterThan(-25);
      }
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_gate measures the noise floor / signal peak and sets a threshold above the noise floor", async () => {
    // Cycles through mostly-quiet (key -50dB) samples with occasional loud (key -10dB) ones, so the
    // resulting distribution has a clear, predictable noise-floor/signal-peak split once sorted.
    let tick = 0;
    const emitter = setInterval(() => {
      const quiet = tick % 5 !== 0;
      tick++;
      meterClient.emit("snapshot", {
        frames: [
          {
            type: "channel",
            index: 23,
            inputL_dB: quiet ? -50 : -10,
            inputR_dB: quiet ? -50 : -10,
            outputL_dB: -20,
            outputR_dB: -20,
            gateKey_dB: quiet ? -50 : -10,
            gateGain_dB: 0,
            dynKey_dB: -30,
            dynGain_dB: 0,
          },
        ],
      });
    }, 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_gate",
        arguments: { type: "channel", index: 23, block: "gate", sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        measured: { noiseFloorDb: number; signalPeakDb: number; marginDb: number };
        threshold: { old: number; new: number; clamped: boolean };
      };
      expect(structured.measured.noiseFloorDb).to.equal(-50);
      expect(structured.measured.signalPeakDb).to.equal(-10);
      expect(structured.measured.marginDb).to.equal(6);
      // 6dB margin above the -50dB noise floor.
      expect(structured.threshold).to.deep.equal({ old: -40, new: -44, clamped: false });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/23/gate", assignments: { thr: -44, on: 1 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_gate fails clearly (nothing changed) when quiet/loud moments aren't clearly distinguishable", async () => {
    const frame = {
      type: "channel",
      index: 24,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -20,
      gateGain_dB: 0,
      dynKey_dB: -20,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_gate",
        arguments: { type: "channel", index: 24, block: "gate", sampleMs: 500 },
      });
      expect(result.isError).to.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("didn't show a clear enough difference between quiet and loud moments");
      expect(handle.bulkSetCalls).to.have.length(0);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_gate rejects a model with no "thr" field (e.g. real "76LA") instead of guessing', async () => {
    const result = await client.callTool({
      name: "wing_auto_gate",
      arguments: { type: "channel", index: 22, block: "dyn", sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Model 76LA");
    expect(content[0].text).to.include('has no "thr" field');
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it('wing_auto_gate rejects block: "gate" on a bus/main/matrix strip', async () => {
    const result = await client.callTool({
      name: "wing_auto_gate",
      arguments: { type: "bus", index: 4, block: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('The "gate" slot only exists on channel strips');
  });

  it("wing_auto_gate fails clearly when no live meter data arrives at all", async () => {
    const result = await client.callTool({
      name: "wing_auto_gate",
      arguments: { type: "channel", index: 25, block: "gate", sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("No live meter data was received");
  });

  it("wing_get_rta_source decodes the raw rtasrc index into a strip type + index", async () => {
    const result = await client.callTool({ name: "wing_get_rta_source" });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      rawIndex: 7,
      source: { type: "channel", index: 7 },
      tap: "PREEQ",
    });
  });

  it("wing_set_rta_source encodes type+index into rtasrc and bulk-sets it with the optional tap", async () => {
    const result = await client.callTool({
      name: "wing_set_rta_source",
      arguments: { type: "bus", index: 3, tap: "POST" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/rta", assignments: { rtasrc: 51, rtatap: "POST" } }]);
    expect(result.structuredContent).to.deep.equal({
      type: "bus",
      index: 3,
      rawIndex: 51,
      tap: "POST",
      status: "OK",
      ok: true,
      raw: "OK",
    });
  });

  it("wing_set_rta_source without a tap only writes rtasrc", async () => {
    const result = await client.callTool({
      name: "wing_set_rta_source",
      arguments: { type: "matrix", index: 1 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/rta", assignments: { rtasrc: 69 } }]);
  });

  it("wing_set_rta_source rejects an out-of-range index as a tool-visible error", async () => {
    const result = await client.callTool({
      name: "wing_set_rta_source",
      arguments: { type: "main", index: 9 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("out of range");
  });
});
