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

type CallToolTextContent = { type: string; text: string };

interface AuxFixture {
  dump: Record<string, string | number>;
  tags: string;
  trim: number | null;
  clink: number;
  ownName: string;
  effectiveName: string;
  connGrp: string | null;
  connIn: number | null; // display value, 1-indexed — same convention as resolvePhysicalSource()
}

/**
 * Aux 1 ("AuxOne") is the single-aux preset fixture, live-routed to physical input A/1, full
 * processing (eq/dyn/sends), with a pre-existing group tag. Aux 2 is a distinct target with its OWN
 * routing (A/6) — used to prove gain restore follows the TARGET's live routing, not the preset's
 * captured source. Aux 3 is source-linked (clink=1, routed to A/4) — used to prove name restore
 * renames the linked physical source rather than the aux strip itself.
 */
function buildAuxFixtures(): Map<number, AuxFixture> {
  const fixtures = new Map<number, AuxFixture>();
  fixtures.set(1, {
    dump: {
      fdr: -8,
      mute: 0,
      pan: -5,
      wid: 0,
      "eq.on": 1,
      "eq.1g": 2.5,
      "eq.1f": 150,
      "eq.1q": 0.8,
      "gate.on": 1,
      "gate.thr": -35,
      "dyn.on": 1,
      "dyn.ratio": 3,
      "send.5.lvl": -6,
      "send.5.on": 1,
      "main.2.lvl": 0,
      "main.2.on": 1,
    },
    tags: "#D2",
    trim: 1.5,
    clink: 0,
    ownName: "AuxOne",
    effectiveName: "AuxOne",
    connGrp: "A",
    connIn: 1,
  });
  fixtures.set(2, {
    dump: { fdr: -15, mute: 0, pan: 0 },
    tags: "",
    trim: 0,
    clink: 0,
    ownName: "",
    effectiveName: "",
    connGrp: "A",
    connIn: 6,
  });
  fixtures.set(3, {
    dump: { fdr: 0, mute: 0 },
    tags: "",
    trim: 0,
    clink: 1,
    ownName: "",
    effectiveName: "Linked Aux Source",
    connGrp: "A",
    connIn: 4,
  });
  return fixtures;
}

const IO_GAIN: Record<string, number> = { "A/1": -7, "A/4": 3, "A/6": 9 };

interface FakeClientHandle {
  client: WingOscClient;
  bulkSetCalls: { baseNode: string; assignments: Record<string, number | string> }[];
  setCalls: { path: string; value: number | string }[];
  getCalls: string[];
  /** When set, the next bulkSet whose baseNode/assignments match this returns a non-OK ack instead. */
  failBulkSetWhen?: (baseNode: string, assignments: Record<string, number | string>) => boolean;
}

function createFakeWingClient(fixtures: Map<number, AuxFixture>): FakeClientHandle {
  const bulkSetCalls: FakeClientHandle["bulkSetCalls"] = [];
  const setCalls: FakeClientHandle["setCalls"] = [];
  const getCalls: string[] = [];
  const handle = { bulkSetCalls, setCalls, getCalls } as FakeClientHandle;

  function auxOf(p: string): number | null {
    const m = /^\/aux\/(\d+)/.exec(p);
    return m ? Number(m[1]) : null;
  }

  function currentTags(aux: number, fallback: string): string {
    const last = [...setCalls].reverse().find((c) => c.path === `/aux/${aux}/tags`);
    return last ? String(last.value) : fallback;
  }

  const fakeClient = {
    async get(p: string): Promise<WingGetResult | WingBranchResult> {
      getCalls.push(p);
      const aux = auxOf(p);
      const fixture = aux !== null ? fixtures.get(aux) : undefined;

      if (aux !== null && p === `/aux/${aux}/tags`) {
        return { path: p, kind: "leaf", valueKind: "string", value: currentTags(aux, fixture?.tags ?? "") };
      }
      if (aux !== null && p === `/aux/${aux}/in/set/trim`) {
        return { path: p, kind: "leaf", valueKind: "float", value: fixture?.trim ?? 0 };
      }
      if (aux !== null && p === `/aux/${aux}/clink`) {
        return { path: p, kind: "leaf", valueKind: "int", value: fixture?.clink ?? 0 };
      }
      if (aux !== null && p === `/aux/${aux}/name`) {
        return { path: p, kind: "leaf", valueKind: "string", value: fixture?.ownName ?? "" };
      }
      if (aux !== null && p === `/aux/${aux}/$name`) {
        return { path: p, kind: "leaf", valueKind: "string", value: fixture?.effectiveName ?? "" };
      }
      if (aux !== null && p === `/aux/${aux}/in/conn/grp`) {
        return { path: p, kind: "leaf", valueKind: "string", value: fixture?.connGrp ?? "OFF" };
      }
      if (aux !== null && p === `/aux/${aux}/in/conn/in`) {
        const display = fixture?.connIn ?? 1;
        return { path: p, kind: "leaf", valueKind: "int", display: String(display), value: display };
      }
      const io = /^\/io\/in\/([^/]+)\/(\d+)\/g$/.exec(p);
      if (io) {
        return { path: p, kind: "leaf", valueKind: "float", value: IO_GAIN[`${io[1]}/${io[2]}`] ?? 0 };
      }
      return { path: p, kind: "branch", children: [] };
    },
    async set(p: string, value: number | string): Promise<void> {
      setCalls.push({ path: p, value });
    },
    async dump(p: string): Promise<Record<string, string | number>> {
      const aux = auxOf(p);
      const fixture = aux !== null ? fixtures.get(aux) : undefined;
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

function createFakeContext(presetDir: string, fixtures: Map<number, AuxFixture>): { ctx: WingPluginContext; handle: FakeClientHandle } {
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

/** Every recorded get/set/bulkSet path must target /aux/N (or /io/in/...) — never /ch/N. */
function assertNoChannelPaths(handle: FakeClientHandle): void {
  for (const p of handle.getCalls) {
    expect(p, `unexpected /ch/ get() call: ${p}`).to.not.match(/^\/ch\//);
  }
  for (const c of handle.setCalls) {
    expect(c.path, `unexpected /ch/ set() call: ${c.path}`).to.not.match(/^\/ch\//);
  }
  for (const c of handle.bulkSetCalls) {
    expect(c.baseNode, `unexpected /ch/ bulkSet() call: ${c.baseNode}`).to.not.match(/^\/ch\//);
  }
}

describe("wing aux presets (end-to-end via a real McpServer/Client pair)", () => {
  let client: Client;
  let server: McpServer;
  let handle: FakeClientHandle;
  let presetDir: string;

  beforeEach(async () => {
    presetDir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-presets-aux-"));
    const created = createFakeContext(presetDir, buildAuxFixtures());
    handle = created.handle;

    server = new McpServer({ name: "wing-preset-aux-test-server", version: "0.0.0" });
    registerPresetTools(server, created.ctx);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "wing-preset-aux-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    assertNoChannelPaths(handle);
    await client.close();
    await server.close();
    fs.rmSync(presetDir, { recursive: true, force: true });
  });

  it("saves, lists, and inspects a single-aux preset", async () => {
    const save = await client.callTool({
      name: "wing_preset_save",
      arguments: { name: "AuxOne Preset", type: "aux", indices: [1] },
    });
    expect(save.isError).to.not.equal(true);

    const list = await client.callTool({ name: "wing_preset_list", arguments: {} });
    const presets = (
      list.structuredContent as { presets: { name: string; type: string; slotCount: number; sourceIndices: number[] }[] }
    ).presets;
    expect(presets).to.have.lengthOf(1);
    expect(presets[0]).to.include({ name: "AuxOne Preset", type: "aux", slotCount: 1 });
    expect(presets[0].sourceIndices).to.deep.equal([1]);

    const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "AuxOne Preset" } });
    expect(get.isError).to.not.equal(true);
    const structured = get.structuredContent as { type: string; slots: Record<string, unknown>[] };
    expect(structured.type).to.equal("aux");
    expect(structured.slots[0]).to.include({
      sourceIndex: 1,
      name: "AuxOne",
      fader: -8,
      mute: false,
      pan: -5,
      trim: 1.5,
      gain: -7,
      eqOn: true,
      gateOn: true,
      dynOn: true,
    });
  });

  it("reapplies onto the same aux by default", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "AuxOne Preset", type: "aux", indices: [1] } });
    const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "AuxOne Preset" } });
    expect(load.isError).to.not.equal(true);

    const structured = load.structuredContent as { type: string; summary: { total: number; ok: number; partial: number; failed: number } };
    expect(structured.type).to.equal("aux");
    expect(structured.summary).to.deep.equal({ total: 1, ok: 1, partial: 0, failed: 0 });

    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/aux/1" && c.assignments.name === "AuxOne")).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/aux/1/in/set" && c.assignments.trim === 1.5)).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/io/in/A/1" && c.assignments.g === -7)).to.equal(true);
  });

  it("applies gain to the TARGET aux's current physical input, not the source's", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "AuxOne Preset", type: "aux", indices: [1] } });
    const load = await client.callTool({
      name: "wing_preset_load",
      arguments: { name: "AuxOne Preset", targetIndex: 2 },
    });
    expect(load.isError).to.not.equal(true);

    // Aux 2 is live-routed to A/6, not aux 1's A/1 — gain must follow aux 2's own routing.
    const gainCalls = handle.bulkSetCalls.filter((c) => c.baseNode.startsWith("/io/in/"));
    expect(gainCalls).to.deep.equal([{ baseNode: "/io/in/A/6", assignments: { g: -7 } }]);

    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/aux/2" && c.assignments.name === "AuxOne")).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/aux/2/in/set" && c.assignments.trim === 1.5)).to.equal(true);
  });

  it("renames the linked physical source instead of the aux when the target is source-linked", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "AuxOne Preset", type: "aux", indices: [1] } });
    const load = await client.callTool({
      name: "wing_preset_load",
      arguments: { name: "AuxOne Preset", targetIndex: 3, sections: ["name"] },
    });
    expect(load.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/io/in/A/4", assignments: { name: "AuxOne" } }]);
  });

  it("sections: ['eq'] applies only eq.* keys and touches nothing else, on the correct /aux/N baseNode", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "AuxOne Preset", type: "aux", indices: [1] } });
    handle.bulkSetCalls.length = 0;
    handle.setCalls.length = 0;
    handle.getCalls.length = 0;

    const load = await client.callTool({
      name: "wing_preset_load",
      arguments: { name: "AuxOne Preset", targetIndex: 2, sections: ["eq"] },
    });
    expect(load.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.have.lengthOf(1);
    expect(handle.bulkSetCalls[0].baseNode).to.equal("/aux/2");
    expect(Object.keys(handle.bulkSetCalls[0].assignments).sort()).to.deep.equal(["eq.1f", "eq.1g", "eq.1q", "eq.on"]);
    expect(handle.setCalls).to.have.lengthOf(0);
  });

  it("wing_preset_delete removes an aux preset", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "AuxOne Preset", type: "aux", indices: [1] } });
    const del = await client.callTool({ name: "wing_preset_delete", arguments: { name: "AuxOne Preset" } });
    expect(del.isError).to.not.equal(true);
    const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "AuxOne Preset" } });
    expect(get.isError).to.equal(true);
  });

  it("rejects saving over an existing aux preset name without overwrite", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Auxes", type: "aux", indices: [1] } });
    const second = await client.callTool({ name: "wing_preset_save", arguments: { name: "Auxes", type: "aux", indices: [2] } });
    expect(second.isError).to.equal(true);
    const content = second.content as CallToolTextContent[];
    expect(content[0].text).to.include("overwrite: true");
  });
});
