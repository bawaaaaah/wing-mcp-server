import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import { EventEmitter } from "node:events";
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
    async dump(_path: string): Promise<Record<string, string | number>> {
      return { name: "Kick", fdr: -6, mute: 0, pan: 0 };
    },
    async describe(path: string, _includeValues?: boolean): Promise<WingNodeDescription> {
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

function createFakeContext(): {
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
  };
  return { ctx, handle, rta, meterClient };
}

describe("wing plugin MCP tools (end-to-end via a real McpServer/Client pair)", () => {
  let client: Client;
  let server: McpServer;
  let handle: FakeClientHandle;
  let rta: { snapshot: RtaSnapshot | null };
  let meterClient: EventEmitter;

  beforeEach(async () => {
    const created = createFakeContext();
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
    // reply makes resolveChannelNameTarget() treat it as "link state unknown" and fall back to a
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
    const frame = {
      type: "bus",
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
        arguments: { type: "bus", index: 2, signal: "gate", durationMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { channels: { key: { min: number }; gain: { min: number } } };
      expect(structured.channels.key.min).to.equal(-33);
      expect(structured.channels.gain.min).to.equal(-4);
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
