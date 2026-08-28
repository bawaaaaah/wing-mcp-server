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
import { WingPresetStore } from "../../../src/plugins/wing/wing-preset-store.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import type { RtaSnapshot, WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

type CallToolTextContent = { type: string; text: string };

interface ChannelFixture {
  dump: Record<string, string | number>;
  tags: string;
  trim: number | null;
  srcauto: number;
  ownName: string;
  effectiveName: string;
  connGrp: string | null;
  connIn: number | null; // display value, 1-indexed — same convention as resolvePhysicalSource()
}

/**
 * Channel 1 ("Morgane") is the single-channel preset fixture, live-routed to physical input A/1.
 * Channel 3 is a distinct target with its OWN routing (A/5) — used to prove gain restore follows the
 * TARGET's live routing, not the preset's captured source. Channel 5 mirrors the source-linked fixture
 * from wing-plugin-tools.test.ts (srcauto=1, routed to A/3). Channel 7 carries a pre-existing free-form
 * tag, used to prove group-membership restore preserves it. Channels 17-24 are the "Drums" group fixture.
 */
function buildDefaultFixtures(): Map<number, ChannelFixture> {
  const fixtures = new Map<number, ChannelFixture>();
  fixtures.set(1, {
    dump: {
      fdr: -6,
      mute: 0,
      pan: 0,
      wid: 0,
      "eq.on": 1,
      "eq.1g": 3.2,
      "eq.1f": 200,
      "eq.1q": 1,
      "gate.on": 1,
      "gate.thr": -40,
      "dyn.on": 1,
      "dyn.ratio": 4,
      "send.3.lvl": -10,
      "send.3.on": 1,
      "main.1.lvl": 0,
      "main.1.on": 1,
    },
    tags: "#D3,#D9",
    trim: 2,
    srcauto: 0,
    ownName: "Morgane",
    effectiveName: "Morgane",
    connGrp: "A",
    connIn: 1,
  });
  fixtures.set(3, {
    dump: { fdr: -20, mute: 0, pan: 0 },
    tags: "",
    trim: 0,
    srcauto: 0,
    ownName: "",
    effectiveName: "",
    connGrp: "A",
    connIn: 5,
  });
  fixtures.set(5, {
    dump: { fdr: 0, mute: 0 },
    tags: "",
    trim: 0,
    srcauto: 1,
    ownName: "",
    effectiveName: "Vocal Source",
    connGrp: "A",
    connIn: 3,
  });
  fixtures.set(7, {
    dump: { fdr: -10, mute: 0, pan: 0 },
    tags: "TALKA.ON",
    trim: 0,
    srcauto: 0,
    ownName: "",
    effectiveName: "",
    connGrp: "A",
    connIn: 7,
  });
  for (let i = 0; i < 8; i++) {
    const ch = 17 + i;
    fixtures.set(ch, {
      dump: { fdr: -3, mute: 0, pan: 0, "eq.on": 1, "gate.on": 1, "dyn.on": 1 },
      tags: "",
      trim: 1,
      srcauto: 0,
      ownName: `Drum${ch}`,
      effectiveName: `Drum${ch}`,
      connGrp: "A",
      connIn: 10 + i,
    });
  }
  return fixtures;
}

const IO_GAIN: Record<string, number> = { "A/1": -10, "A/3": 8, "A/5": 5, "A/7": 0 };
for (let i = 0; i < 8; i++) {
  IO_GAIN[`A/${10 + i}`] = 12;
}

interface FakeClientHandle {
  client: WingOscClient;
  bulkSetCalls: Array<{ baseNode: string; assignments: Record<string, number | string> }>;
  setCalls: Array<{ path: string; value: number | string }>;
  getCalls: string[];
  /** When set, the next bulkSet whose baseNode/assignments match this returns a non-OK ack instead. */
  failBulkSetWhen?: (baseNode: string, assignments: Record<string, number | string>) => boolean;
}

function createFakeWingClient(fixtures: Map<number, ChannelFixture>): FakeClientHandle {
  const bulkSetCalls: FakeClientHandle["bulkSetCalls"] = [];
  const setCalls: FakeClientHandle["setCalls"] = [];
  const getCalls: string[] = [];
  const handle = { bulkSetCalls, setCalls, getCalls } as FakeClientHandle;

  function channelOf(p: string): number | null {
    const m = /^\/ch\/(\d+)/.exec(p);
    return m ? Number(m[1]) : null;
  }

  function currentTags(ch: number, fallback: string): string {
    const last = [...setCalls].reverse().find((c) => c.path === `/ch/${ch}/tags`);
    return last ? String(last.value) : fallback;
  }

  const fakeClient = {
    async get(p: string): Promise<WingGetResult | WingBranchResult> {
      getCalls.push(p);
      const ch = channelOf(p);
      const fixture = ch !== null ? fixtures.get(ch) : undefined;

      if (ch !== null && p === `/ch/${ch}/tags`) {
        return { path: p, kind: "leaf", valueKind: "string", value: currentTags(ch, fixture?.tags ?? "") };
      }
      if (ch !== null && p === `/ch/${ch}/in/set/trim`) {
        return { path: p, kind: "leaf", valueKind: "float", value: fixture?.trim ?? 0 };
      }
      if (ch !== null && p === `/ch/${ch}/in/set/srcauto`) {
        return { path: p, kind: "leaf", valueKind: "int", value: fixture?.srcauto ?? 0 };
      }
      if (ch !== null && p === `/ch/${ch}/name`) {
        return { path: p, kind: "leaf", valueKind: "string", value: fixture?.ownName ?? "" };
      }
      if (ch !== null && p === `/ch/${ch}/$name`) {
        return { path: p, kind: "leaf", valueKind: "string", value: fixture?.effectiveName ?? "" };
      }
      if (ch !== null && p === `/ch/${ch}/in/conn/grp`) {
        return { path: p, kind: "leaf", valueKind: "string", value: fixture?.connGrp ?? "OFF" };
      }
      if (ch !== null && p === `/ch/${ch}/in/conn/in`) {
        const display = fixture?.connIn ?? 1;
        return { path: p, kind: "leaf", valueKind: "int", display: String(display), value: display - 1 };
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
      const ch = channelOf(p);
      const fixture = ch !== null ? fixtures.get(ch) : undefined;
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

function createFakeContext(presetDir: string, fixtures: Map<number, ChannelFixture>): { ctx: WingPluginContext; handle: FakeClientHandle } {
  const handle = createFakeWingClient(fixtures);
  const ctx: WingPluginContext = {
    client: handle.client,
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
    }),
    buildOverviewSnapshot: async () => ({}),
    getLastRta: (): RtaSnapshot | null => null,
    presetStore: new WingPresetStore({ dir: presetDir }),
    oscMirror: new WingOscMirror(),
  };
  return { ctx, handle };
}

describe("wing channel presets (end-to-end via a real McpServer/Client pair)", () => {
  let client: Client;
  let server: McpServer;
  let handle: FakeClientHandle;
  let presetDir: string;

  beforeEach(async () => {
    presetDir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-presets-"));
    const created = createFakeContext(presetDir, buildDefaultFixtures());
    handle = created.handle;

    server = new McpServer({ name: "wing-preset-test-server", version: "0.0.0" });
    registerPresetTools(server, created.ctx);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "wing-preset-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(presetDir, { recursive: true, force: true });
  });

  it("saves, lists, and inspects a single-channel preset", async () => {
    const save = await client.callTool({
      name: "wing_preset_save",
      arguments: { name: "Morgane Micro KSM9", indices: [1] },
    });
    expect(save.isError).to.not.equal(true);

    const list = await client.callTool({ name: "wing_preset_list", arguments: {} });
    const presets = (
      list.structuredContent as { presets: Array<{ name: string; slotCount: number; sourceIndices: number[] }> }
    ).presets;
    expect(presets).to.have.lengthOf(1);
    expect(presets[0]).to.include({ name: "Morgane Micro KSM9", slotCount: 1 });
    expect(presets[0].sourceIndices).to.deep.equal([1]);

    const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "Morgane Micro KSM9" } });
    expect(get.isError).to.not.equal(true);
    const structured = get.structuredContent as { slots: Array<Record<string, unknown>> };
    expect(structured.slots[0]).to.include({
      sourceIndex: 1,
      name: "Morgane",
      fader: -6,
      mute: false,
      pan: 0,
      trim: 2,
      gain: -10,
      eqOn: true,
      gateOn: true,
      dynOn: true,
    });
  });

  it("reapplies onto the same channel by default", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Morgane Micro KSM9", indices: [1] } });
    const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "Morgane Micro KSM9" } });
    expect(load.isError).to.not.equal(true);

    const structured = load.structuredContent as { summary: { total: number; ok: number; partial: number; failed: number } };
    expect(structured.summary).to.deep.equal({ total: 1, ok: 1, partial: 0, failed: 0 });

    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/1" && c.assignments.name === "Morgane")).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/1/in/set" && c.assignments.trim === 2)).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/io/in/A/1" && c.assignments.g === -10)).to.equal(true);
  });

  it("applies gain to the TARGET channel's current physical input, not the source's", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Morgane Micro KSM9", indices: [1] } });
    const load = await client.callTool({
      name: "wing_preset_load",
      arguments: { name: "Morgane Micro KSM9", targetIndex: 3 },
    });
    expect(load.isError).to.not.equal(true);

    // Channel 3 is live-routed to A/5, not channel 1's A/1 — gain must follow channel 3's own routing.
    const gainCalls = handle.bulkSetCalls.filter((c) => c.baseNode.startsWith("/io/in/"));
    expect(gainCalls).to.deep.equal([{ baseNode: "/io/in/A/5", assignments: { g: -10 } }]);

    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/3" && c.assignments.name === "Morgane")).to.equal(true);
    expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/3/in/set" && c.assignments.trim === 2)).to.equal(true);
  });

  it("renames the linked physical source instead of the channel when the target is source-linked", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Morgane Micro KSM9", indices: [1] } });
    const load = await client.callTool({
      name: "wing_preset_load",
      arguments: { name: "Morgane Micro KSM9", targetIndex: 5, sections: ["name"] },
    });
    expect(load.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/io/in/A/3", assignments: { name: "Morgane" } }]);
  });

  it("sections: ['eq'] applies only eq.* keys and touches nothing else", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Morgane Micro KSM9", indices: [1] } });
    handle.bulkSetCalls.length = 0;
    handle.setCalls.length = 0;
    handle.getCalls.length = 0;

    const load = await client.callTool({
      name: "wing_preset_load",
      arguments: { name: "Morgane Micro KSM9", targetIndex: 3, sections: ["eq"] },
    });
    expect(load.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.have.lengthOf(1);
    expect(handle.bulkSetCalls[0].baseNode).to.equal("/ch/3");
    expect(Object.keys(handle.bulkSetCalls[0].assignments).sort()).to.deep.equal(["eq.1f", "eq.1g", "eq.1q", "eq.on"]);
    expect(handle.setCalls).to.have.lengthOf(0);
  });

  it("shifts a whole group preset by an offset (Drums 17-24 loaded onto base channel 9)", async () => {
    await client.callTool({
      name: "wing_preset_save",
      arguments: { name: "Drums", indices: [17, 18, 19, 20, 21, 22, 23, 24] },
    });
    const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "Drums", targetIndex: 9 } });
    expect(load.isError).to.not.equal(true);

    const structured = load.structuredContent as { results: Array<{ sourceIndex: number; targetIndex: number }> };
    expect(structured.results.map((r) => [r.sourceIndex, r.targetIndex])).to.deep.equal([
      [17, 9],
      [18, 10],
      [19, 11],
      [20, 12],
      [21, 13],
      [22, 14],
      [23, 15],
      [24, 16],
    ]);
  });

  it("reports a partial outcome when one section's ack fails, without affecting other sections/channels", async () => {
    await client.callTool({
      name: "wing_preset_save",
      arguments: { name: "Drums", indices: [17, 18, 19, 20, 21, 22, 23, 24] },
    });
    handle.failBulkSetWhen = (baseNode, assignments) => baseNode === "/ch/20" && "gate.on" in assignments;

    const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "Drums" } });
    expect(load.isError).to.not.equal(true);
    const structured = load.structuredContent as {
      results: Array<{ targetIndex: number; status: string; sections: Array<{ section: string; status: string }> }>;
    };

    const ch20 = structured.results.find((r) => r.targetIndex === 20)!;
    expect(ch20.status).to.equal("partial");
    expect(ch20.sections.find((s) => s.section === "gate")!.status).to.equal("error");
    expect(ch20.sections.find((s) => s.section === "eq")!.status).to.equal("applied");

    const ch17 = structured.results.find((r) => r.targetIndex === 17)!;
    expect(ch17.status).to.equal("ok");
  });

  it("replaces DCA/mute-group membership on load while preserving the target's free-form tags", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Morgane Micro KSM9", indices: [1] } });
    const load = await client.callTool({
      name: "wing_preset_load",
      arguments: { name: "Morgane Micro KSM9", targetIndex: 7, sections: ["groups"] },
    });
    expect(load.isError).to.not.equal(true);
    expect(handle.setCalls).to.deep.equal([{ path: "/ch/7/tags", value: "TALKA.ON,#D3,#D9" }]);
  });

  it("wing_preset_delete removes a preset", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Drums", indices: [17] } });
    const del = await client.callTool({ name: "wing_preset_delete", arguments: { name: "Drums" } });
    expect(del.isError).to.not.equal(true);
    const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "Drums" } });
    expect(get.isError).to.equal(true);
  });

  it("rejects saving over an existing name without overwrite", async () => {
    await client.callTool({ name: "wing_preset_save", arguments: { name: "Drums", indices: [17] } });
    const second = await client.callTool({ name: "wing_preset_save", arguments: { name: "Drums", indices: [18] } });
    expect(second.isError).to.equal(true);
    const content = second.content as CallToolTextContent[];
    expect(content[0].text).to.include("overwrite: true");
  });
});
