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

/**
 * A real DCA `dump()` (per src/plugins/wing/tools/dca-mutegroup.ts's wing_dca_get_summary, which
 * only ever reads dump.name/dump.fdr/dump.mute) contains ONLY fdr/mute/name — no eq/gate/dyn/pan/
 * send/tags/in.* keys exist on this node at all. DCA 1 is the populated fixture; DCA 2 is a bare/
 * muted one used to exercise a falsy fader+muted+unnamed slot.
 */
interface DcaFixture {
  dump: Record<string, string | number>;
  ownName: string;
}

function buildDcaFixtures(): Map<number, DcaFixture> {
  const fixtures = new Map<number, DcaFixture>();
  fixtures.set(1, { dump: { fdr: -6, mute: 0, name: "Drums DCA" }, ownName: "Drums DCA" });
  fixtures.set(2, { dump: { fdr: 0, mute: 1, name: "" }, ownName: "" });
  return fixtures;
}

/**
 * A real mute-group node (per src/plugins/wing/tools/dca-mutegroup.ts — there is no fader tool at
 * all for mute groups, only wing_mutegroup_set/set_name/toggle) has ONLY mute+name — not even fdr.
 */
interface MutegroupFixture {
  dump: Record<string, string | number>;
  ownName: string;
}

function buildMutegroupFixtures(): Map<number, MutegroupFixture> {
  const fixtures = new Map<number, MutegroupFixture>();
  fixtures.set(1, { dump: { mute: 0, name: "Talkback Mute" }, ownName: "Talkback Mute" });
  return fixtures;
}

interface FakeClientHandle {
  client: WingOscClient;
  bulkSetCalls: Array<{ baseNode: string; assignments: Record<string, number | string> }>;
  setCalls: Array<{ path: string; value: number | string }>;
  getCalls: string[];
}

function createFakeWingClient(dcaFixtures: Map<number, DcaFixture>, mutegroupFixtures: Map<number, MutegroupFixture>): FakeClientHandle {
  const bulkSetCalls: FakeClientHandle["bulkSetCalls"] = [];
  const setCalls: FakeClientHandle["setCalls"] = [];
  const getCalls: string[] = [];
  const handle = { bulkSetCalls, setCalls, getCalls } as FakeClientHandle;

  function dcaOf(p: string): number | null {
    const m = /^\/dca\/(\d+)/.exec(p);
    return m ? Number(m[1]) : null;
  }
  function mutegroupOf(p: string): number | null {
    const m = /^\/mgrp\/(\d+)/.exec(p);
    return m ? Number(m[1]) : null;
  }

  const fakeClient = {
    async get(p: string): Promise<WingGetResult | WingBranchResult> {
      getCalls.push(p);
      const dca = dcaOf(p);
      const mgrp = mutegroupOf(p);

      if (dca !== null && p === `/dca/${dca}/name`) {
        return { path: p, kind: "leaf", valueKind: "string", value: dcaFixtures.get(dca)?.ownName ?? "" };
      }
      if (mgrp !== null && p === `/mgrp/${mgrp}/name`) {
        return { path: p, kind: "leaf", valueKind: "string", value: mutegroupFixtures.get(mgrp)?.ownName ?? "" };
      }
      // Anything else (tags/in.set.trim/clink/in.conn.grp/in.conn.in on either type) has
      // no real node on hardware for a DCA or mute group — a correct capture/restore must never ask
      // for these, so this deliberately answers with a generic empty branch rather than a plausible
      // leaf, and the tests assert directly on `getCalls` that these paths were never requested.
      return { path: p, kind: "branch", children: [] };
    },
    async set(p: string, value: number | string): Promise<void> {
      setCalls.push({ path: p, value });
    },
    async dump(p: string): Promise<Record<string, string | number>> {
      const dca = dcaOf(p);
      if (dca !== null) return { ...(dcaFixtures.get(dca)?.dump ?? {}) };
      const mgrp = mutegroupOf(p);
      if (mgrp !== null) return { ...(mutegroupFixtures.get(mgrp)?.dump ?? {}) };
      return {};
    },
    async describe(p: string): Promise<WingNodeDescription> {
      return { path: p, raw: "", lines: [] };
    },
    async bulkSet(baseNode: string, assignments: Record<string, number | string>): Promise<WingBulkSetResult> {
      bulkSetCalls.push({ baseNode, assignments });
      return { status: "OK", ok: true, raw: "OK" };
    },
    async toggle(): Promise<void> {},
  };

  handle.client = fakeClient as unknown as WingOscClient;
  return handle;
}

function createFakeContext(
  presetDir: string,
  dcaFixtures: Map<number, DcaFixture>,
  mutegroupFixtures: Map<number, MutegroupFixture>,
): { ctx: WingPluginContext; handle: FakeClientHandle } {
  const handle = createFakeWingClient(dcaFixtures, mutegroupFixtures);
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

describe("wing DCA & mute-group presets (end-to-end via a real McpServer/Client pair)", () => {
  let client: Client;
  let server: McpServer;
  let handle: FakeClientHandle;
  let presetDir: string;

  beforeEach(async () => {
    presetDir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-presets-"));
    const created = createFakeContext(presetDir, buildDcaFixtures(), buildMutegroupFixtures());
    handle = created.handle;

    server = new McpServer({ name: "wing-preset-dca-mutegroup-test-server", version: "0.0.0" });
    registerPresetTools(server, created.ctx);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "wing-preset-dca-mutegroup-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(presetDir, { recursive: true, force: true });
  });

  describe("dca", () => {
    const DCA_FORBIDDEN_PATHS = ["/dca/1/tags", "/dca/1/in/set/trim", "/dca/1/clink", "/dca/1/in/conn/grp", "/dca/1/in/conn/in"];

    it("saves, lists, and inspects a dca preset without ever reading tags/trim/srcauto/physical-input nodes", async () => {
      const save = await client.callTool({
        name: "wing_preset_save",
        arguments: { name: "Drums DCA Snap", type: "dca", indices: [1] },
      });
      expect(save.isError).to.not.equal(true);

      for (const p of DCA_FORBIDDEN_PATHS) {
        expect(handle.getCalls).to.not.include(p);
      }

      const list = await client.callTool({ name: "wing_preset_list", arguments: {} });
      const presets = (
        list.structuredContent as { presets: Array<{ name: string; type: string; slotCount: number; sourceIndices: number[] }> }
      ).presets;
      expect(presets).to.have.lengthOf(1);
      expect(presets[0]).to.include({ name: "Drums DCA Snap", type: "dca", slotCount: 1 });
      expect(presets[0].sourceIndices).to.deep.equal([1]);

      const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "Drums DCA Snap", includeRaw: true } });
      expect(get.isError).to.not.equal(true);
      const structured = get.structuredContent as {
        type: string;
        slots: Array<{
          sourceIndex: number;
          raw: Record<string, unknown>;
          corrected: Record<string, unknown>;
          preampGain: unknown;
        }>;
      };
      expect(structured.type).to.equal("dca");
      expect(structured.slots).to.have.lengthOf(1);
      // Nothing but fdr/mute survives into `raw` — no eq/gate/dyn/pan/send/tags/in.* keys exist on a
      // real DCA dump(), and `name` is deliberately stripped out of `raw` (it's restored separately).
      expect(structured.slots[0].raw).to.deep.equal({ fdr: -6, mute: 0 });
      expect(structured.slots[0].corrected).to.include({
        tags: "",
        inConnGrp: null,
        inConnIn: null,
        inSetTrim: null,
        inSetSrcauto: null,
        ownName: "Drums DCA",
        effectiveName: "Drums DCA",
      });
      expect(structured.slots[0].preampGain).to.equal(null);
    });

    it("loads a dca preset back onto itself with only fader/mute/name bulk-sets — no eq/gate/dyn/sends/gain/trim/groups activity", async () => {
      await client.callTool({ name: "wing_preset_save", arguments: { name: "Drums DCA Snap", type: "dca", indices: [1] } });
      handle.bulkSetCalls.length = 0;
      handle.setCalls.length = 0;
      handle.getCalls.length = 0;

      const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "Drums DCA Snap" } });
      expect(load.isError).to.not.equal(true);

      expect(handle.getCalls).to.have.lengthOf(0);
      expect(handle.setCalls).to.have.lengthOf(0);
      expect(handle.bulkSetCalls).to.have.lengthOf(3);
      expect(handle.bulkSetCalls.every((c) => c.baseNode === "/dca/1")).to.equal(true);

      const assignments = handle.bulkSetCalls.map((c) => c.assignments);
      expect(assignments).to.deep.include({ fdr: -6 });
      expect(assignments).to.deep.include({ mute: 0 });
      expect(assignments).to.deep.include({ name: "Drums DCA" });
      for (const a of assignments) {
        for (const key of Object.keys(a)) {
          expect(["fdr", "mute", "name"]).to.include(key);
        }
      }

      const structured = load.structuredContent as {
        summary: { total: number; ok: number; partial: number; failed: number };
        results: Array<{ sections: Array<{ section: string; status: string; detail?: string }> }>;
      };
      expect(structured.summary).to.deep.equal({ total: 1, ok: 1, partial: 0, failed: 0 });
      const trim = structured.results[0].sections.find((s) => s.section === "trim")!;
      const gain = structured.results[0].sections.find((s) => s.section === "gain")!;
      const groups = structured.results[0].sections.find((s) => s.section === "groups")!;
      expect(trim.status).to.equal("skipped");
      expect(gain.status).to.equal("skipped");
      expect(groups.status).to.equal("skipped");
    });

    it("reports gain/trim/groups as skipped-not-applicable, with a dca-specific detail, when explicitly requested", async () => {
      await client.callTool({ name: "wing_preset_save", arguments: { name: "Drums DCA Snap", type: "dca", indices: [1] } });
      handle.bulkSetCalls.length = 0;
      handle.setCalls.length = 0;
      handle.getCalls.length = 0;

      const load = await client.callTool({
        name: "wing_preset_load",
        arguments: { name: "Drums DCA Snap", sections: ["gain", "trim", "groups"] },
      });
      expect(load.isError).to.not.equal(true);

      // None of these sections apply to a dca, so nothing should ever reach the client.
      expect(handle.bulkSetCalls).to.have.lengthOf(0);
      expect(handle.setCalls).to.have.lengthOf(0);
      expect(handle.getCalls).to.have.lengthOf(0);

      const structured = load.structuredContent as {
        results: Array<{ sections: Array<{ section: string; status: string; detail?: string }> }>;
      };
      const sections = structured.results[0].sections;
      expect(sections).to.have.lengthOf(3);
      expect(sections.map((s) => s.section).sort()).to.deep.equal(["gain", "groups", "trim"]);
      for (const s of sections) {
        expect(s.status).to.equal("skipped");
        expect(s.detail).to.be.a("string");
        expect(s.detail!.toLowerCase()).to.include("dca");
      }
    });

    it("rejects a target dca index beyond DCA_COUNT (16) as a tool-visible error", async () => {
      await client.callTool({ name: "wing_preset_save", arguments: { name: "Drums DCA Snap", type: "dca", indices: [1] } });
      const load = await client.callTool({
        name: "wing_preset_load",
        arguments: { name: "Drums DCA Snap", targetIndex: 17 },
      });
      expect(load.isError).to.equal(true);
      const content = load.content as CallToolTextContent[];
      expect(content[0].text.toLowerCase()).to.include("out of range");
    });
  });

  describe("mutegroup", () => {
    const MUTEGROUP_FORBIDDEN_PATHS = [
      "/mgrp/1/tags",
      "/mgrp/1/in/set/trim",
      "/mgrp/1/clink",
      "/mgrp/1/in/conn/grp",
      "/mgrp/1/in/conn/in",
    ];

    it("saves, lists, and inspects a mutegroup preset (mute+name only — no fader concept at all)", async () => {
      const save = await client.callTool({
        name: "wing_preset_save",
        arguments: { name: "Talkback Mute Snap", type: "mutegroup", indices: [1] },
      });
      expect(save.isError).to.not.equal(true);

      for (const p of MUTEGROUP_FORBIDDEN_PATHS) {
        expect(handle.getCalls).to.not.include(p);
      }

      const list = await client.callTool({ name: "wing_preset_list", arguments: {} });
      const presets = (
        list.structuredContent as { presets: Array<{ name: string; type: string; slotCount: number; sourceIndices: number[] }> }
      ).presets;
      expect(presets).to.have.lengthOf(1);
      expect(presets[0]).to.include({ name: "Talkback Mute Snap", type: "mutegroup", slotCount: 1 });
      expect(presets[0].sourceIndices).to.deep.equal([1]);

      const get = await client.callTool({ name: "wing_preset_get", arguments: { name: "Talkback Mute Snap", includeRaw: true } });
      expect(get.isError).to.not.equal(true);
      const structured = get.structuredContent as {
        type: string;
        slots: Array<{ sourceIndex: number; raw: Record<string, unknown>; corrected: Record<string, unknown>; preampGain: unknown }>;
      };
      expect(structured.type).to.equal("mutegroup");
      // Not even `fdr` survives — a mute group has no fader node on real hardware at all.
      expect(structured.slots[0].raw).to.deep.equal({ mute: 0 });
      expect(structured.slots[0].corrected).to.include({
        tags: "",
        inConnGrp: null,
        inConnIn: null,
        inSetTrim: null,
        inSetSrcauto: null,
        ownName: "Talkback Mute",
        effectiveName: "Talkback Mute",
      });
      expect(structured.slots[0].preampGain).to.equal(null);
    });

    it("loads a mutegroup preset back with only mute+name bulk-sets — never a fader bulk-set", async () => {
      await client.callTool({ name: "wing_preset_save", arguments: { name: "Talkback Mute Snap", type: "mutegroup", indices: [1] } });
      handle.bulkSetCalls.length = 0;
      handle.setCalls.length = 0;
      handle.getCalls.length = 0;

      const load = await client.callTool({ name: "wing_preset_load", arguments: { name: "Talkback Mute Snap" } });
      expect(load.isError).to.not.equal(true);

      expect(handle.getCalls).to.have.lengthOf(0);
      expect(handle.setCalls).to.have.lengthOf(0);
      expect(handle.bulkSetCalls).to.have.lengthOf(2);
      expect(handle.bulkSetCalls.every((c) => c.baseNode === "/mgrp/1")).to.equal(true);

      const assignments = handle.bulkSetCalls.map((c) => c.assignments);
      expect(assignments).to.deep.include({ mute: 0 });
      expect(assignments).to.deep.include({ name: "Talkback Mute" });
      for (const a of assignments) {
        expect(a).to.not.have.property("fdr");
      }
    });

    it("reports gain/trim/groups as skipped-not-applicable, with a mutegroup-specific detail, when explicitly requested", async () => {
      await client.callTool({ name: "wing_preset_save", arguments: { name: "Talkback Mute Snap", type: "mutegroup", indices: [1] } });
      handle.bulkSetCalls.length = 0;
      handle.setCalls.length = 0;
      handle.getCalls.length = 0;

      const load = await client.callTool({
        name: "wing_preset_load",
        arguments: { name: "Talkback Mute Snap", sections: ["gain", "trim", "groups"] },
      });
      expect(load.isError).to.not.equal(true);

      expect(handle.bulkSetCalls).to.have.lengthOf(0);
      expect(handle.setCalls).to.have.lengthOf(0);
      expect(handle.getCalls).to.have.lengthOf(0);

      const structured = load.structuredContent as {
        results: Array<{ sections: Array<{ section: string; status: string; detail?: string }> }>;
      };
      const sections = structured.results[0].sections;
      expect(sections).to.have.lengthOf(3);
      expect(sections.map((s) => s.section).sort()).to.deep.equal(["gain", "groups", "trim"]);
      for (const s of sections) {
        expect(s.status).to.equal("skipped");
        expect(s.detail).to.be.a("string");
        expect(s.detail!.toLowerCase()).to.include("mutegroup");
      }
    });

    it("rejects a target mutegroup index beyond MUTEGROUP_COUNT (8) as a tool-visible error", async () => {
      await client.callTool({ name: "wing_preset_save", arguments: { name: "Talkback Mute Snap", type: "mutegroup", indices: [1] } });
      const load = await client.callTool({
        name: "wing_preset_load",
        arguments: { name: "Talkback Mute Snap", targetIndex: 9 },
      });
      expect(load.isError).to.equal(true);
      const content = load.content as CallToolTextContent[];
      expect(content[0].text.toLowerCase()).to.include("out of range");
    });
  });
});
