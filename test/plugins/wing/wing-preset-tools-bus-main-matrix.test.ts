import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { registerPresetTools } from "../../../src/plugins/wing/tools/presets.js";
import type { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import { resolveStripPath } from "../../../src/plugins/wing/wing-node-paths.js";
import type {
  WingBranchResult,
  WingBulkSetResult,
  WingGetResult,
  WingNodeDescription,
  WingOscClient,
} from "../../../src/plugins/wing/wing-osc-client.js";
import { WingOscMirror } from "../../../src/plugins/wing/wing-osc-mirror.js";
import { WingMicCalibrationStore } from "../../../src/plugins/wing/wing-mic-calibration-store.js";
import { WingPresetStore } from "../../../src/plugins/wing/wing-preset-store.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import { WingWriteJournal } from "../../../src/plugins/wing/wing-write-journal.js";
import type { RtaSnapshot, WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

type StripKind = "bus" | "main" | "matrix";

interface StripFixture {
  dump: Record<string, string | number>;
  tags: string;
  ownName: string;
  effectiveName: string;
}

/**
 * bus 2 ("FOH Sub") is the primary bus fixture: has bus-to-bus (send.5.*), bus-to-matrix
 * (send.MX2.*), and bus-to-main (main.1.*) sends — a bus can reach all three per
 * tools/routing.ts's SOURCE_ALLOWED_DESTINATIONS. bus 4 ("Sub4") is a distinct target with its
 * own pre-existing free-form tag (no #D/#M tokens), used to prove a groups-only load replaces
 * DCA/mute-group tokens while preserving it — mirrors channel 7 in wing-preset-tools.test.ts.
 *
 * main 1 ("Main LR") deliberately has ONLY send.MX1.* — per routing.ts a main only ever sends to
 * a matrix, never to another bus or main, so its dump must never contain a bare "send.<n>.*" or
 * "main.<n>.*" key.
 *
 * matrix 3 ("Rec Mix") has no send/main keys at all: a matrix is never a valid send source
 * anywhere in this codebase (SEND_SOURCES excludes "mtx" entirely) — it's a terminal output, not
 * something that routes further downstream.
 *
 * None of the three carry any in/conn or in/set fields — they have no physical input at all — and
 * the fake client below has no special-case branch for those paths on bus/main/matrix, so any
 * such read simply falls through to a generic "branch, no children" response, exactly like a real
 * console asked for a node that doesn't exist there.
 */
function buildDefaultFixtures(): Map<string, StripFixture> {
  const fixtures = new Map<string, StripFixture>();
  fixtures.set("bus:2", {
    dump: {
      fdr: -4,
      mute: 0,
      pan: 0.3,
      "eq.on": 1,
      "eq.1g": 2.5,
      "eq.1f": 500,
      "eq.1q": 1.2,
      "dyn.on": 1,
      "dyn.ratio": 3,
      "send.5.lvl": -6,
      "send.5.on": 1,
      "send.MX2.lvl": -3,
      "send.MX2.on": 1,
      "main.1.lvl": 0,
      "main.1.on": 1,
    },
    tags: "#D3,BusFree",
    ownName: "FOH Sub",
    effectiveName: "FOH Sub",
  });
  fixtures.set("bus:4", {
    dump: { fdr: -8, mute: 0, pan: 0 },
    tags: "BusFreeForm",
    ownName: "Sub4",
    effectiveName: "Sub4",
  });
  fixtures.set("main:1", {
    dump: {
      fdr: 0,
      mute: 0,
      pan: 0,
      "eq.on": 1,
      "eq.1g": 1,
      "eq.1f": 100,
      "eq.1q": 0.7,
      "dyn.on": 0,
      "send.MX1.lvl": -5,
      "send.MX1.on": 1,
    },
    tags: "#M2",
    ownName: "Main LR",
    effectiveName: "Main LR",
  });
  fixtures.set("matrix:3", {
    dump: {
      fdr: -2,
      mute: 0,
      pan: 0,
      "eq.on": 1,
      "eq.1g": 0.5,
      "eq.1f": 1000,
      "eq.1q": 1,
      "dyn.on": 1,
      "dyn.thr": -20,
    },
    tags: "#D5",
    ownName: "Rec Mix",
    effectiveName: "Rec Mix",
  });
  return fixtures;
}

function fixtureKey(type: StripKind, index: number): string {
  return `${type}:${index}`;
}

/** Parses an OSC path's strip type/index — note the "matrix" preset `type` addresses as "/mtx/N" on the wire. */
function parseStripPath(p: string): { type: StripKind; index: number } | null {
  let m = /^\/bus\/(\d+)/.exec(p);
  if (m) return { type: "bus", index: Number(m[1]) };
  m = /^\/main\/(\d+)/.exec(p);
  if (m) return { type: "main", index: Number(m[1]) };
  m = /^\/mtx\/(\d+)/.exec(p);
  if (m) return { type: "matrix", index: Number(m[1]) };
  return null;
}

interface FakeClientHandle {
  client: WingOscClient;
  bulkSetCalls: Array<{ baseNode: string; assignments: Record<string, number | string> }>;
  setCalls: Array<{ path: string; value: number | string }>;
  getCalls: string[];
  failBulkSetWhen?: (baseNode: string, assignments: Record<string, number | string>) => boolean;
}

function createFakeWingClient(fixtures: Map<string, StripFixture>): FakeClientHandle {
  const bulkSetCalls: FakeClientHandle["bulkSetCalls"] = [];
  const setCalls: FakeClientHandle["setCalls"] = [];
  const getCalls: string[] = [];
  const handle = { bulkSetCalls, setCalls, getCalls } as FakeClientHandle;

  function currentTags(type: StripKind, index: number, fallback: string): string {
    const tagsPath = `${resolveStripPath(type, index)}/tags`;
    const last = [...setCalls].reverse().find((c) => c.path === tagsPath);
    return last ? String(last.value) : fallback;
  }

  const fakeClient = {
    async get(p: string): Promise<WingGetResult | WingBranchResult> {
      getCalls.push(p);
      const parsed = parseStripPath(p);
      const fixture = parsed ? fixtures.get(fixtureKey(parsed.type, parsed.index)) : undefined;

      if (parsed && p === `${resolveStripPath(parsed.type, parsed.index)}/tags`) {
        return { path: p, kind: "leaf", valueKind: "string", value: currentTags(parsed.type, parsed.index, fixture?.tags ?? "") };
      }
      if (parsed && p === `${resolveStripPath(parsed.type, parsed.index)}/name`) {
        return { path: p, kind: "leaf", valueKind: "string", value: fixture?.ownName ?? "" };
      }
      if (parsed && p === `${resolveStripPath(parsed.type, parsed.index)}/$name`) {
        return { path: p, kind: "leaf", valueKind: "string", value: fixture?.effectiveName ?? "" };
      }
      // No special-case for in/conn, in/set, or /io/in/ — bus/main/matrix have no physical input,
      // so a real console would answer with an empty branch listing for a node that doesn't exist.
      return { path: p, kind: "branch", children: [] };
    },
    async set(p: string, value: number | string): Promise<void> {
      setCalls.push({ path: p, value });
    },
    async dump(p: string): Promise<Record<string, string | number>> {
      const parsed = parseStripPath(p);
      const fixture = parsed ? fixtures.get(fixtureKey(parsed.type, parsed.index)) : undefined;
      return { ...(fixture?.dump ?? {}) };
    },
    async describe(p: string): Promise<WingNodeDescription> {
      return { path: p, raw: "", lines: [] };
    },
    async bulkSet(baseNode: string, assignments: Record<string, number | string>): Promise<WingBulkSetResult> {
      bulkSetCalls.push({ baseNode, assignments });
      if (handle.failBulkSetWhen?.(baseNode, assignments)) {
        return { status: "VALUE ERROR", ok: false, raw: "VALUE ERROR" };
      }
      return { status: "OK", ok: true, raw: "OK" };
    },
    async toggle(): Promise<void> {},
  };

  handle.client = fakeClient as unknown as WingOscClient;
  return handle;
}

function createFakeContext(
  presetDir: string,
  fixtures: Map<string, StripFixture>,
): { ctx: WingPluginContext; handle: FakeClientHandle } {
  const handle = createFakeWingClient(fixtures);
  const ctx: WingPluginContext = {
    client: handle.client,
    journal: new WingWriteJournal(),
    updateConfig: async () => {
      throw new Error("updateConfig is not wired in this test");
    },
    meterClient: {} as WingMeterClient,
    cache: new WingStateCache(),
    eventBus: new EventBus(),
    getConfig: () => ({
      host: "127.0.0.1",
      oscPort: 2223,
      discoveryPort: 2222,
      meterTcpPort: 2222,
      meterUdpPort: 14135,
      warmCacheOnConnect: true,
      oscMirrorEnabled: false,
      oscMirrorHost: "",
      oscMirrorPort: 0,
      showMode: false,
      boxMap: {},
    }),
    buildOverviewSnapshot: async () => ({}),
    getLastRta: (): RtaSnapshot | null => null,
    presetStore: new WingPresetStore({ dir: presetDir }),
    micCalibrationStore: new WingMicCalibrationStore({ dir: presetDir + "-mics" }),
    oscMirror: new WingOscMirror(),
  };
  return { ctx, handle };
}

describe("wing bus/main/matrix presets (end-to-end via a real McpServer/Client pair)", () => {
  let client: Client;
  let server: McpServer;
  let handle: FakeClientHandle;
  let presetDir: string;

  beforeEach(async () => {
    presetDir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-presets-bmm-"));
    const created = createFakeContext(presetDir, buildDefaultFixtures());
    handle = created.handle;

    server = new McpServer({ name: "wing-preset-bmm-test-server", version: "0.0.0" });
    registerPresetTools(server, created.ctx);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "wing-preset-bmm-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(presetDir, { recursive: true, force: true });
  });

  it("saves, lists, and inspects a bus preset", async () => {
    const save = await client.callTool({
      name: "wing_preset_save",
      arguments: { name: "FOH Sub Snapshot", type: "bus", indices: [2] },
    });
    expect(save.isError).to.not.equal(true);
    expect(save.structuredContent).to.include({ name: "FOH Sub Snapshot", type: "bus" });

    const list = await client.callTool({ name: "wing_preset_list", arguments: {} });
    const presets = (
      list.structuredContent as { presets: Array<{ name: string; type: string; slotCount: number; sourceIndices: number[] }> }
    ).presets;
    expect(presets).to.have.lengthOf(1);
    expect(presets[0]).to.include({ name: "FOH Sub Snapshot", type: "bus", slotCount: 1 });
    expect(presets[0].sourceIndices).to.deep.equal([2]);

    const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "FOH Sub Snapshot" } });
    expect(get.isError).to.not.equal(true);
    const structured = get.structuredContent as { type: string; slots: Array<Record<string, unknown>> };
    expect(structured.type).to.equal("bus");
    expect(structured.slots[0]).to.include({
      sourceIndex: 2,
      name: "FOH Sub",
      fader: -4,
      mute: false,
      pan: 0.3,
      trim: null,
      gain: null,
      eqOn: true,
      dynOn: true,
    });
  });

  it("saves, lists, and inspects a main preset", async () => {
    const save = await client.callTool({
      name: "wing_preset_save",
      arguments: { name: "Main LR Snapshot", type: "main", indices: [1] },
    });
    expect(save.isError).to.not.equal(true);
    expect(save.structuredContent).to.include({ name: "Main LR Snapshot", type: "main" });

    const list = await client.callTool({ name: "wing_preset_list", arguments: {} });
    const presets = (
      list.structuredContent as { presets: Array<{ name: string; type: string; slotCount: number; sourceIndices: number[] }> }
    ).presets;
    expect(presets[0]).to.include({ name: "Main LR Snapshot", type: "main", slotCount: 1 });
    expect(presets[0].sourceIndices).to.deep.equal([1]);

    const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "Main LR Snapshot" } });
    expect(get.isError).to.not.equal(true);
    const structured = get.structuredContent as { type: string; slots: Array<Record<string, unknown>> };
    expect(structured.type).to.equal("main");
    expect(structured.slots[0]).to.include({
      sourceIndex: 1,
      name: "Main LR",
      fader: 0,
      mute: false,
      pan: 0,
      trim: null,
      gain: null,
      eqOn: true,
      dynOn: false,
    });
  });

  it("saves, lists, and inspects a matrix preset", async () => {
    const save = await client.callTool({
      name: "wing_preset_save",
      arguments: { name: "Rec Mix Snapshot", type: "matrix", indices: [3] },
    });
    expect(save.isError).to.not.equal(true);
    expect(save.structuredContent).to.include({ name: "Rec Mix Snapshot", type: "matrix" });

    const list = await client.callTool({ name: "wing_preset_list", arguments: {} });
    const presets = (
      list.structuredContent as { presets: Array<{ name: string; type: string; slotCount: number; sourceIndices: number[] }> }
    ).presets;
    expect(presets[0]).to.include({ name: "Rec Mix Snapshot", type: "matrix", slotCount: 1 });
    expect(presets[0].sourceIndices).to.deep.equal([3]);

    const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "Rec Mix Snapshot" } });
    expect(get.isError).to.not.equal(true);
    const structured = get.structuredContent as { type: string; slots: Array<Record<string, unknown>> };
    expect(structured.type).to.equal("matrix");
    expect(structured.slots[0]).to.include({
      sourceIndex: 3,
      name: "Rec Mix",
      fader: -2,
      mute: false,
      pan: 0,
      trim: null,
      gain: null,
      eqOn: true,
      dynOn: true,
    });
  });

  it("reapplies a bus preset onto the same bus: fader/mute/pan/eq/dyn/sends/name land on /bus/N, gain/trim are skipped", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "FOH Sub Snapshot", type: "bus", indices: [2] } });
    const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "FOH Sub Snapshot" } });
    expect(load.isError).to.not.equal(true);

    const structured = load.structuredContent as {
      summary: { total: number; ok: number; partial: number; failed: number };
      results: Array<{ sections: Array<{ section: string; status: string; detail?: string }> }>;
    };
    expect(structured.summary).to.deep.equal({ total: 1, ok: 1, partial: 0, failed: 0 });

    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/bus/2" && c.assignments.fdr === -4)).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/bus/2" && c.assignments.mute === 0)).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/bus/2" && c.assignments.pan === 0.3)).to.equal(true);

    const eqCall = handle.bulkSetCalls.find((c) => c.baseNode === "/bus/2" && "eq.on" in c.assignments);
    expect(eqCall?.assignments).to.deep.equal({ "eq.on": 1, "eq.1g": 2.5, "eq.1f": 500, "eq.1q": 1.2 });

    const sendsCall = handle.bulkSetCalls.find((c) => c.baseNode === "/bus/2" && "send.5.lvl" in c.assignments);
    expect(sendsCall?.assignments).to.deep.equal({
      "send.5.lvl": -6,
      "send.5.on": 1,
      "send.MX2.lvl": -3,
      "send.MX2.on": 1,
      "main.1.lvl": 0,
      "main.1.on": 1,
    });

    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/bus/2" && c.assignments.name === "FOH Sub")).to.equal(true);

    const outcome = structured.results[0];
    expect(outcome.sections.find((s) => s.section === "groups")?.status).to.equal("applied");
    expect(outcome.sections.find((s) => s.section === "gain")).to.include({ status: "skipped", detail: "not applicable to a bus" });
    expect(outcome.sections.find((s) => s.section === "trim")).to.include({ status: "skipped", detail: "not applicable to a bus" });
  });

  it("reapplies a main preset onto the same main, restricting sends to send.MX* only (no send-to-bus/main keys)", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Main LR Snapshot", type: "main", indices: [1] } });
    const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "Main LR Snapshot" } });
    expect(load.isError).to.not.equal(true);

    const sendsCall = handle.bulkSetCalls.find((c) => c.baseNode === "/main/1" && "send.MX1.lvl" in c.assignments);
    expect(sendsCall?.assignments).to.deep.equal({ "send.MX1.lvl": -5, "send.MX1.on": 1 });

    // A main only ever sends to a matrix — never a bare bus-send ("send.<n>") or main-send ("main.<n>") key.
    const hasIllegalSendKey = handle.bulkSetCalls.some((c) =>
      Object.keys(c.assignments).some((k) => /^send\.\d/.test(k) || /^main\.\d/.test(k)),
    );
    expect(hasIllegalSendKey).to.equal(false);

    const eqCall = handle.bulkSetCalls.find((c) => c.baseNode === "/main/1" && "eq.on" in c.assignments);
    expect(eqCall?.assignments).to.deep.equal({ "eq.on": 1, "eq.1g": 1, "eq.1f": 100, "eq.1q": 0.7 });
  });

  it("reapplies a matrix preset and issues bulk-sets against the OSC path /mtx/N, never /matrix/N", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Rec Mix Snapshot", type: "matrix", indices: [3] } });
    const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "Rec Mix Snapshot" } });
    expect(load.isError).to.not.equal(true);

    expect(handle.bulkSetCalls.length).to.be.greaterThan(0);
    expect(handle.bulkSetCalls.every((c) => !c.baseNode.startsWith("/matrix/"))).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/mtx/3" && c.assignments.fdr === -2)).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/mtx/3" && c.assignments.name === "Rec Mix")).to.equal(true);
  });

  it("sections:['gain'] is skipped as not-applicable for bus/main/matrix and never touches physical-input paths", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "FOH Sub Snapshot", type: "bus", indices: [2] } });
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Main LR Snapshot", type: "main", indices: [1] } });
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Rec Mix Snapshot", type: "matrix", indices: [3] } });
    handle.bulkSetCalls.length = 0;
    handle.setCalls.length = 0;
    handle.getCalls.length = 0;

    for (const name of ["FOH Sub Snapshot", "Main LR Snapshot", "Rec Mix Snapshot"]) {
      const load = await client.callTool({ name: "wing_preset_load", arguments: { name, sections: ["gain"] } });
      expect(load.isError).to.not.equal(true);
      const structured = load.structuredContent as {
        type: string;
        results: Array<{ sections: Array<{ section: string; status: string; detail?: string }> }>;
      };
      const sections = structured.results[0].sections;
      expect(sections).to.have.lengthOf(1);
      expect(sections[0].section).to.equal("gain");
      expect(sections[0].status).to.equal("skipped");
      expect(sections[0].detail).to.include(`not applicable to a ${structured.type}`);
    }

    expect(handle.bulkSetCalls).to.have.lengthOf(0);
    expect(handle.getCalls.every((p) => !/in\/(conn|set)/.test(p) && !p.startsWith("/io/in/"))).to.equal(true);
  });

  it("sections:['trim'] is skipped as not-applicable for bus/main/matrix and never touches physical-input paths", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "FOH Sub Snapshot", type: "bus", indices: [2] } });
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Main LR Snapshot", type: "main", indices: [1] } });
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Rec Mix Snapshot", type: "matrix", indices: [3] } });
    handle.bulkSetCalls.length = 0;
    handle.setCalls.length = 0;
    handle.getCalls.length = 0;

    for (const name of ["FOH Sub Snapshot", "Main LR Snapshot", "Rec Mix Snapshot"]) {
      const load = await client.callTool({ name: "wing_preset_load", arguments: { name, sections: ["trim"] } });
      expect(load.isError).to.not.equal(true);
      const structured = load.structuredContent as {
        type: string;
        results: Array<{ sections: Array<{ section: string; status: string; detail?: string }> }>;
      };
      const sections = structured.results[0].sections;
      expect(sections).to.have.lengthOf(1);
      expect(sections[0].section).to.equal("trim");
      expect(sections[0].status).to.equal("skipped");
      expect(sections[0].detail).to.include(`not applicable to a ${structured.type}`);
    }

    expect(handle.bulkSetCalls).to.have.lengthOf(0);
    expect(handle.getCalls.every((p) => !/in\/(conn|set)/.test(p) && !p.startsWith("/io/in/"))).to.equal(true);
  });

  it("replaces DCA/mute-group membership on a bus load while preserving the target's free-form tags", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "FOH Sub Snapshot", type: "bus", indices: [2] } });
    const load = await client.callTool({
      name: "wing_preset_load",
      arguments: { name: "FOH Sub Snapshot", targetIndex: 4, sections: ["groups"] },
    });
    expect(load.isError).to.not.equal(true);
    // bus 2's captured tags are "#D3,BusFree" -> DCA membership [3]; bus 4's own tags are
    // "BusFreeForm" (no #D/#M tokens) and must survive untouched, with the DCA token appended.
    expect(handle.setCalls).to.deep.equal([{ path: "/bus/4/tags", value: "BusFreeForm,#D3" }]);
  });
});
