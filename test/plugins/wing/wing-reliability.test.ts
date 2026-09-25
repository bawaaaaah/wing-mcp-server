// Regression tests for the reliability pass of 2026-09-25 (field report from a concert prep): string
// encoding in bulk-sets, integer decoding, verified writes, the undo journal, stereo pairs, taps,
// channel copy planning, color/icon words. Hardware facts behind each expectation are documented in
// docs/wing-protocol/05-node-tree/io-patch.md.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { registerWingTools } from "../../../src/plugins/wing/tools/index.js";
import { planTransfer } from "../../../src/plugins/wing/wing-channel-copy.js";
import { resolveColor, resolveIcon, searchIcons } from "../../../src/plugins/wing/wing-color-icon.js";
import type { WingConfig } from "../../../src/plugins/wing/wing-config.js";
import { WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import { describeSourceRef } from "../../../src/plugins/wing/wing-identity.js";
import type { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import { WingMicCalibrationStore } from "../../../src/plugins/wing/wing-mic-calibration-store.js";
import { WingOscClient } from "../../../src/plugins/wing/wing-osc-client.js";
import { WingOscMirror } from "../../../src/plugins/wing/wing-osc-mirror.js";
import { boxPortFor, decodeTap } from "../../../src/plugins/wing/wing-patch.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";
import { WingPresetStore } from "../../../src/plugins/wing/wing-preset-store.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import {
  buildBulkSetString,
  encodeBulkSetValue,
  parseDumpNumber,
  parseFlatAssignmentString,
  parseOscGetReply,
  validateNodeValue,
} from "../../../src/plugins/wing/wing-value-codec.js";
import { valuesMatch } from "../../../src/plugins/wing/wing-write.js";
import { isAudiblePath, WingWriteJournal } from "../../../src/plugins/wing/wing-write-journal.js";
import { WingMockServer } from "./wing-mock-server.js";

describe("bulk-set string encoding", () => {
  it("quotes any value that is not a bare token, so the console keeps its spaces", () => {
    expect(encodeBulkSetValue("TB Samuel")).to.equal("'TB Samuel'");
    expect(encodeBulkSetValue("DM Morgane")).to.equal("'DM Morgane'");
    expect(encodeBulkSetValue("A B C")).to.equal("'A B C'");
    expect(encodeBulkSetValue("Chœur")).to.equal("'Chœur'");
    expect(encodeBulkSetValue("")).to.equal("''");
  });

  it("leaves numbers and enum-like tokens exactly as before", () => {
    expect(encodeBulkSetValue(-6.5)).to.equal("-6.5");
    for (const token of ["STD", "L+R", "M/S", "-oo", "GTR.A", "CH.7"]) {
      expect(encodeBulkSetValue(token)).to.equal(token);
    }
  });

  it("escapes a quote and a backslash inside the quotes", () => {
    expect(encodeBulkSetValue("L'orgue")).to.equal("'L\\'orgue'");
    expect(encodeBulkSetValue("a\\b")).to.equal("'a\\\\b'");
  });

  it("keeps commas and '=' inside one quoted assignment", () => {
    expect(buildBulkSetString({ name: "a,b=c", col: 5 })).to.equal("name='a,b=c',col=5");
  });

  it("rejects control characters, which the console drops even inside quotes", () => {
    expect(() => encodeBulkSetValue("tab\there")).to.throw(WingValueError);
  });

  it("refuses a key that would smuggle in another assignment, or is not a node path", () => {
    for (const key of ["fdr=10,x.name", "fdr,mute", "a b", "eq..on", ".on", "on.", "name'"]) {
      expect(() => buildBulkSetString({ [key]: "x" }), key).to.throw(WingValueError);
    }
    expect(buildBulkSetString({ "$fdr": 1, "eq.on": 1 })).to.equal("$fdr=1,eq.on=1");
  });
});

describe("name/tags byte budget", () => {
  it("accepts exactly 16 bytes and refuses 17", () => {
    expect(validateNodeValue("/io/in/USR/14/name", "1234567890123456")).to.equal("1234567890123456");
    expect(() => validateNodeValue("/io/in/USR/14/name", "12345678901234567")).to.throw(/17 bytes/);
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(() => validateNodeValue("/ch/1/name", "éééééééééééééééé")).to.throw(/32 bytes/);
    expect(validateNodeValue("/ch/1/name", "Chœur à 2")).to.equal("Chœur à 2");
  });

  it("accepts the empty string, to clear a name", () => {
    expect(validateNodeValue("/ch/1/name", "")).to.equal("");
  });
});

describe("integer reply decoding", () => {
  it("reads the display string: the int argument is an offset from the minimum", () => {
    const reply = parseOscGetReply([
      { type: "s", value: "10" },
      { type: "f", value: 0.1428 },
      { type: "i", value: 9 },
    ]);
    expect(reply.value).to.equal(10);
  });

  it("falls back to the int argument when the display is not an integer", () => {
    const reply = parseOscGetReply([
      { type: "s", value: "ON" },
      { type: "f", value: 1 },
      { type: "i", value: 1 },
    ]);
    expect(reply.value).to.equal(1);
  });
});

describe("dump parsing", () => {
  it("unescapes a quote inside a quoted value and keeps its commas", () => {
    expect(parseFlatAssignmentString("col=1,name='L\\'or, gue',icon=0")).to.deep.equal({ col: 1, name: "L'or, gue", icon: 0 });
  });

  it("keeps a quoted numeric-looking value a string", () => {
    expect(parseFlatAssignmentString("name='12',col=3")).to.deep.equal({ name: "12", col: 3 });
  });

  it("reads the console's number shorthands", () => {
    expect(parseDumpNumber("1k50")).to.equal(1500);
    expect(parseDumpNumber("-oo")).to.equal(-144);
    expect(parseDumpNumber("-6.0")).to.equal(-6);
    expect(parseDumpNumber("SEQ")).to.equal(null);
  });
});

describe("valuesMatch", () => {
  it("is exact for text", () => {
    expect(valuesMatch("TB Samuel", "TBSamuel")).to.equal(false);
    expect(valuesMatch("TB Samuel", "TB Samuel")).to.equal(true);
  });

  it("tolerates the console's quantization and shorthand for numbers", () => {
    expect(valuesMatch(100, 100.2)).to.equal(true);
    expect(valuesMatch("1k50", 1500)).to.equal(true);
    expect(valuesMatch(-144, "-oo")).to.equal(true);
    expect(valuesMatch(-6, -3)).to.equal(false);
  });
});

describe("audible vs cosmetic", () => {
  it("classifies name/col/icon/led/tags/clink as cosmetic and everything else as audible", () => {
    for (const p of ["/ch/1/name", "/ch/1/col", "/io/in/A/3/icon", "/ch/1/led", "/ch/1/tags", "/ch/1/clink"]) {
      expect(isAudiblePath(p), p).to.equal(false);
    }
    for (const p of ["/ch/1/fdr", "/ch/1/mute", "/io/in/A/3/mode", "/bus/2/busmono", "/io/in/USR/5/user/in"]) {
      expect(isAudiblePath(p), p).to.equal(true);
    }
  });
});

describe("stereo pairs and taps", () => {
  it("reports a stereo source by its pair's first member, keeping the stored index", () => {
    expect(describeSourceRef("A", 10, "ST")).to.deep.include({ group: "A", index: 9, storedIndex: 10, stereo: true, pair: [9, 10], label: "A9-10" });
    expect(describeSourceRef("A", 9, "ST")).to.deep.include({ index: 9, pair: [9, 10] });
    expect(describeSourceRef("A", 11, "M")).to.deep.include({ index: 11, stereo: false, label: "A11" });
  });

  it("decodes internal taps as L/R pairs: BUS in=7 is bus 4 left", () => {
    expect(decodeTap("BUS", 7)).to.deep.equal({ strip: "bus", stripIndex: 4, side: "L" });
    expect(decodeTap("BUS", 8)).to.deep.equal({ strip: "bus", stripIndex: 4, side: "R" });
    expect(decodeTap("MAIN", 1)).to.deep.equal({ strip: "main", stripIndex: 1, side: "L" });
    expect(decodeTap("MON", 3)).to.deep.equal({ strip: "monitor", stripIndex: 2, side: "L" });
    expect(decodeTap("A", 3)).to.equal(null);
  });

  it("maps an AES50 port to its stage box connector", () => {
    const boxMap = { A: [{ range: [1, 8] as [number, number], device: "DL8-1" }, { range: [9, 16] as [number, number], device: "DL8-2" }] };
    expect(boxPortFor(boxMap, "A", 11)).to.deep.equal({ device: "DL8-2", devicePort: 3 });
    expect(boxPortFor({ "AES50-A": boxMap.A }, "A", 2)).to.deep.equal({ device: "DL8-1", devicePort: 2 });
    expect(boxPortFor(boxMap, "B", 2)).to.equal(null);
  });
});

describe("channel copy planning", () => {
  const source = { "in.conn.grp": "A", "in.conn.in": 2, name: "Fatouma", clink: 0, col: 12, fdr: 1, mute: 0, "eq.on": 1, tags: "#D1,#M2" };
  const target = { "in.conn.grp": "A", "in.conn.in": 3, name: "Marisa", clink: 0, col: 5, fdr: -3, mute: 1, "eq.on": 0, tags: "#D4" };

  it("takes only the keys of the chosen scopes", () => {
    expect(planTransfer(source, target, ["name", "fader"])).to.deep.equal({ name: "Fatouma", clink: 0, fdr: 1 });
  });

  it("moves DCA and mute group tags independently", () => {
    expect(planTransfer(source, target, ["dcaTags"])).to.deep.equal({ tags: "#D1" });
    expect(planTransfer(source, target, ["muteGroups"])).to.deep.equal({ tags: "#D4,#M2" });
    expect(planTransfer(source, target, ["all"]).tags).to.equal("#D1,#M2");
  });
});

describe("color and icon words", () => {
  it("maps French and English color words, and pink to Magenta", () => {
    expect(resolveColor("rose")).to.include({ col: 11, colorName: "Magenta" });
    expect(resolveColor("Violet")).to.include({ col: 12 });
    expect(resolveColor("bleu ciel")).to.include({ col: 14 });
    expect(resolveColor(7)).to.include({ col: 7, colorName: "Yellow" });
    expect(() => resolveColor("noir")).to.throw(/no pink or black/);
  });

  it("finds icons by word", () => {
    expect(searchIcons("femme")[0]).to.include({ id: 113 });
    expect(resolveIcon("batterie")).to.include({ icon: 210 });
    expect(resolveIcon(114)).to.include({ icon: 114, iconName: "Chanteur (homme)" });
  });
});

describe("WingWriteJournal", () => {
  it("keeps a batch only when it wrote something, and counts changes since the last scene", async () => {
    const journal = new WingWriteJournal();
    await journal.runBatch("nothing", async () => undefined);
    await journal.runBatch("wing_set", async () => {
      journal.record([{ path: "/ch/1/name", previous: "a", next: "b", audible: false }]);
    });
    expect(journal.history().map((b) => b.origin)).to.deep.equal(["wing_set"]);
    expect(journal.unsavedChanges().count).to.equal(1);
    journal.noteSceneEvent("load", "scene 3");
    expect(journal.unsavedChanges()).to.deep.include({ count: 0 });
  });

  it("counts a parameter once, however many writes and pushes report it", () => {
    const journal = new WingWriteJournal();
    // One fader write: the write itself, then the console's push of it on the plain address and on
    // its $ shadow (canonicalized to the same path by the OSC client).
    journal.record([{ path: "/ch/1/fdr", previous: -10, next: -5, audible: true }]);
    journal.noteChanged(["/ch/1/fdr"]);
    journal.noteChanged(["/ch/1/fdr"]);
    journal.noteChanged(["/ch/1/fdr", "/ch/2/mute"]);
    expect(journal.unsavedChanges().count).to.equal(2);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: real WingOscClient against the loopback mock console, through the MCP tools.

function baseConfig(overrides: Partial<WingConfig> = {}): WingConfig {
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
    showMode: false,
    boxMap: {},
    ...overrides,
  };
}

describe("verified writes and undo (real client, mock console)", () => {
  let mock: WingMockServer;
  let oscClient: WingOscClient;
  let server: McpServer;
  let client: Client;
  let config: WingConfig;
  let tmp: string;

  beforeEach(async () => {
    mock = new WingMockServer();
    const { oscPort } = await mock.start();
    mock.setParam("/io/in/USR/14/name", "");
    mock.setParam("/io/in/USR/14/col", 1);
    oscClient = new WingOscClient({ host: "127.0.0.1", port: oscPort, requestTimeoutMs: 300 });
    await oscClient.connect();
    const journal = new WingWriteJournal();
    oscClient.setJournal(journal);
    config = baseConfig();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wing-reliability-"));
    const ctx: WingPluginContext = {
      client: oscClient,
      meterClient: {} as WingMeterClient,
      cache: new WingStateCache(),
      eventBus: new EventBus(),
      getConfig: () => config,
      updateConfig: async (patch) => (config = { ...config, ...patch }),
      journal,
      buildOverviewSnapshot: async () => ({}),
      getLastRta: () => null,
      presetStore: new WingPresetStore({ dir: tmp }),
      micCalibrationStore: new WingMicCalibrationStore({ dir: `${tmp}-mics` }),
      oscMirror: new WingOscMirror(),
    };
    server = new McpServer({ name: "t", version: "0" });
    registerWingTools(server, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await oscClient.close();
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes \"TB Samuel\" and reads back exactly \"TB Samuel\"", async () => {
    const result = await client.callTool({ name: "wing_set", arguments: { path: "/io/in/USR/14/name", value: "TB Samuel" } });
    expect(result.isError).to.not.equal(true);
    const s = result.structuredContent as { status: string; results: Record<string, unknown>[] };
    expect(s.status).to.equal("OK");
    expect(s.results[0]).to.include({ previous: "", sent: "TB Samuel", stored: "TB Samuel", match: true, audible: false });
    expect(mock.getParam("/io/in/USR/14/name")).to.equal("TB Samuel");
  });

  it("reports MISMATCH, not OK, when the console stores something else", async () => {
    mock.stringTransform = (v) => v.replace(/\s+/g, "");
    const result = await client.callTool({ name: "wing_set", arguments: { path: "/io/in/USR/14/name", value: "TB Samuel" } });
    expect(result.isError).to.equal(true);
    const s = result.structuredContent as { status: string; results: Record<string, unknown>[] };
    expect(s.status).to.equal("MISMATCH");
    expect(s.results[0]).to.include({ stored: "TBSamuel", match: false });
  });

  it("makes a typed setter's name write fail visibly too", async () => {
    mock.stringTransform = (v) => v.replace(/\s+/g, "");
    const ack = await oscClient.bulkSet("/io/in/USR/14", { name: "TB Samuel" });
    expect(ack).to.deep.include({ status: "MISMATCH", ok: false });
    expect(ack.mismatches).to.deep.equal([{ key: "name", requested: "TB Samuel", stored: "TBSamuel" }]);
  });

  it("does not write on a dry run", async () => {
    const result = await client.callTool({ name: "wing_bulk_set", arguments: { baseNode: "/io/in/USR/14", assignments: { name: "X", col: 5 }, dryRun: true } });
    expect((result.structuredContent as { status: string }).status).to.equal("DRY RUN");
    expect(mock.getParam("/io/in/USR/14/name")).to.equal("");
  });

  it("undoes the last batch, then an older one by id", async () => {
    const first = await client.callTool({ name: "wing_bulk_set", arguments: { baseNode: "/io/in/USR/14", assignments: { name: "One", col: 5 } } });
    const firstBatch = (first.structuredContent as { batchId: string }).batchId;
    await client.callTool({ name: "wing_set", arguments: { path: "/io/in/USR/14/name", value: "Two" } });
    expect(mock.getParam("/io/in/USR/14/name")).to.equal("Two");

    await client.callTool({ name: "wing_undo", arguments: {} });
    expect(mock.getParam("/io/in/USR/14/name")).to.equal("One");

    const undo = await client.callTool({ name: "wing_undo", arguments: { batchId: firstBatch } });
    expect(undo.isError).to.not.equal(true);
    expect(mock.getParam("/io/in/USR/14/name")).to.equal("");
    expect(mock.getParam("/io/in/USR/14/col")).to.equal(1);

    const again = await client.callTool({ name: "wing_undo", arguments: { batchId: firstBatch } });
    expect(again.isError).to.equal(true);
  });

  it("refuses an audible write in show mode unless confirmed, but lets a cosmetic one through", async () => {
    config = { ...config, showMode: true };
    const audible = await client.callTool({ name: "wing_set", arguments: { path: "/ch/1/fdr", value: -10 } });
    expect(audible.isError).to.equal(true);
    expect(mock.getParam("/ch/1/fdr")).to.equal(-6);
    const confirmed = await client.callTool({ name: "wing_set", arguments: { path: "/ch/1/fdr", value: -10, confirm: true } });
    expect(confirmed.isError).to.not.equal(true);
    const cosmetic = await client.callTool({ name: "wing_set", arguments: { path: "/io/in/USR/14/name", value: "ok" } });
    expect(cosmetic.isError).to.not.equal(true);
  });

  it("holds the typed setters to show mode too, and leaves them alone otherwise", async () => {
    config = { ...config, showMode: true };
    const refused = await client.callTool({ name: "wing_channel_set_fader", arguments: { channel: 1, db: -20 } });
    expect(refused.isError).to.equal(true);
    expect(mock.getParam("/ch/1/fdr")).to.equal(-6);
    const confirmed = await client.callTool({ name: "wing_channel_set_fader", arguments: { channel: 1, db: -20, confirm: true } });
    expect(confirmed.isError).to.not.equal(true);
    expect(mock.getParam("/ch/1/fdr")).to.equal(-20);
    config = { ...config, showMode: false };
    const plain = await client.callTool({ name: "wing_channel_set_fader", arguments: { channel: 1, db: -6 } });
    expect(plain.isError).to.not.equal(true);
    expect(mock.getParam("/ch/1/fdr")).to.equal(-6);
  });

  it("journals a typed setter, so wing_undo reverts it", async () => {
    await client.callTool({ name: "wing_channel_set_fader", arguments: { channel: 1, db: -30 } });
    expect(mock.getParam("/ch/1/fdr")).to.equal(-30);
    await client.callTool({ name: "wing_undo", arguments: {} });
    expect(mock.getParam("/ch/1/fdr")).to.equal(-6);
  });
});
