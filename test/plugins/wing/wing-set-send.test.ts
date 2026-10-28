// wing_set_send against the real send node shapes, read live off a WING Rack (fw 3.1.1, 2026-10-28):
// a channel/aux send to a bus or matrix is {on, lvl, pon, mode[PRE,POST,GRP], plink, pan}; every other
// send (channel/aux -> main, bus -> bus/matrix/main, main -> matrix) is {on, lvl, pre}. The console
// answers a key the node lacks with NODE NOT FOUND after storing the keys before it — which the mock
// console reproduces — so these run the real client against it, through the MCP tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { registerWingTools } from "../../../src/plugins/wing/tools/index.js";
import type { WingConfig } from "../../../src/plugins/wing/wing-config.js";
import type { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import { WingMicCalibrationStore } from "../../../src/plugins/wing/wing-mic-calibration-store.js";
import { WingOscClient } from "../../../src/plugins/wing/wing-osc-client.js";
import { WingOscMirror } from "../../../src/plugins/wing/wing-osc-mirror.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";
import { WingPresetStore } from "../../../src/plugins/wing/wing-preset-store.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import type { WingWriteResult } from "../../../src/plugins/wing/wing-write.js";
import { WingWriteJournal } from "../../../src/plugins/wing/wing-write-journal.js";
import { WingMockServer } from "./wing-mock-server.js";

type TextContent = { type: string; text: string };

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

/** The {on, lvl, pon, mode, plink, pan} node of a channel/aux send to a bus or matrix. */
function defineTapSend(mock: WingMockServer, base: string, opts: { withPon?: boolean; plink?: number; pan?: number } = {}): void {
  mock.defineLeaf(`${base}/on`, "i", 0);
  mock.defineLeaf(`${base}/lvl`, "f", -144);
  if (opts.withPon !== false) mock.defineLeaf(`${base}/pon`, "i", 0);
  mock.defineLeaf(`${base}/mode`, "s", "POST");
  mock.defineLeaf(`${base}/plink`, "i", opts.plink ?? 0);
  mock.defineLeaf(`${base}/pan`, "f", opts.pan ?? 0);
}

/** The {on, lvl, pre} node of every other send. */
function definePreSend(mock: WingMockServer, base: string): void {
  mock.defineLeaf(`${base}/on`, "i", 1);
  mock.defineLeaf(`${base}/lvl`, "f", 0);
  mock.defineLeaf(`${base}/pre`, "i", 0);
}

describe("wing_set_send (real client, mock console)", () => {
  let mock: WingMockServer;
  let oscClient: WingOscClient;
  let journal: WingWriteJournal;
  let server: McpServer;
  let client: Client;
  let config: WingConfig;
  let tmp: string;

  beforeEach(async () => {
    mock = new WingMockServer();
    const { oscPort } = await mock.start();
    oscClient = new WingOscClient({ host: "127.0.0.1", port: oscPort, requestTimeoutMs: 300 });
    await oscClient.connect();
    journal = new WingWriteJournal();
    oscClient.setJournal(journal);
    config = baseConfig();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wing-set-send-"));
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

  const setSend = (args: Record<string, unknown>) => client.callTool({ name: "wing_set_send", arguments: args });
  const text = (result: Awaited<ReturnType<typeof setSend>>) => (result.content as TextContent[])[0]?.text ?? "";

  it("refuses pan on a send to a main up front, naming the fields it has, and writes nothing", async () => {
    // The exact call that, on hardware, came back "updated (on, lvl, pan): NODE NOT FOUND" — not
    // flagged as an error — with on/lvl changed and nothing journaled.
    definePreSend(mock, "/ch/40/main/1");
    const result = await setSend({ source: "channel", sourceIndex: 40, destination: "main", destinationIndex: 1, on: false, levelDb: -20, pan: 10 });
    expect(result.isError).to.equal(true);
    expect(text(result)).to.include("has no pan").and.to.include("{on, lvl, pre}").and.to.include("on, levelDb, pre");
    expect(mock.getParam("/ch/40/main/1/on")).to.equal(1);
    expect(mock.getParam("/ch/40/main/1/lvl")).to.equal(0);
    expect(journal.history()).to.deep.equal([]);
  });

  it("refuses the bus/matrix-only fields on every {on, lvl, pre} send, and pre on the others", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ source: "aux", sourceIndex: 2, destination: "main", destinationIndex: 1, mode: "PRE" }, "has no mode"],
      [{ source: "bus", sourceIndex: 3, destination: "bus", destinationIndex: 4, pan: 0 }, "has no pan"],
      [{ source: "bus", sourceIndex: 3, destination: "mtx", destinationIndex: 2, pon: true }, "has no pon"],
      [{ source: "bus", sourceIndex: 3, destination: "main", destinationIndex: 1, pan: 5, mode: "GRP" }, "has no mode or pan"],
      [{ source: "main", sourceIndex: 1, destination: "mtx", destinationIndex: 1, pan: -5 }, "has no pan"],
      [{ source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, pre: true }, "has no pre"],
      [{ source: "aux", sourceIndex: 1, destination: "mtx", destinationIndex: 3, on: true, pre: false }, "has no pre"],
    ];
    for (const [args, expected] of cases) {
      const result = await setSend(args);
      expect(result.isError, JSON.stringify(args)).to.equal(true);
      expect(text(result), JSON.stringify(args)).to.include(expected).and.to.include("Nothing was written");
    }
    expect(journal.history()).to.deep.equal([]);
  });

  it("sets pre on a send to a main, reads every field back, and wing_undo reverts it", async () => {
    definePreSend(mock, "/ch/40/main/1");
    const result = await setSend({ source: "channel", sourceIndex: 40, destination: "main", destinationIndex: 1, on: false, levelDb: -20, pre: true });
    expect(result.isError, text(result)).to.not.equal(true);
    const s = result.structuredContent as unknown as WingWriteResult;
    expect(s.status).to.equal("OK");
    expect(s.results.map((r) => [r.key, r.sent, r.stored, r.match])).to.deep.equal([
      ["on", 0, 0, true],
      ["lvl", -20, -20, true],
      ["pre", 1, 1, true],
    ]);
    expect(s.batchId).to.be.a("string");
    expect(mock.getParam("/ch/40/main/1/pre")).to.equal(1);

    const undo = await client.callTool({ name: "wing_undo", arguments: {} });
    expect(undo.isError).to.not.equal(true);
    expect(mock.getParam("/ch/40/main/1/on")).to.equal(1);
    expect(mock.getParam("/ch/40/main/1/lvl")).to.equal(0);
    expect(mock.getParam("/ch/40/main/1/pre")).to.equal(0);
  });

  it("sets pre on a bus's and a main's sends to a matrix", async () => {
    definePreSend(mock, "/bus/3/send/MX2");
    definePreSend(mock, "/main/1/send/MX1");
    const bus = await setSend({ source: "bus", sourceIndex: 3, destination: "mtx", destinationIndex: 2, pre: true });
    const main = await setSend({ source: "main", sourceIndex: 1, destination: "mtx", destinationIndex: 1, levelDb: -3, pre: true });
    expect(bus.isError, text(bus)).to.not.equal(true);
    expect(main.isError, text(main)).to.not.equal(true);
    expect(mock.getParam("/bus/3/send/MX2/pre")).to.equal(1);
    expect(mock.getParam("/main/1/send/MX1/pre")).to.equal(1);
    expect(mock.getParam("/main/1/send/MX1/lvl")).to.equal(-3);
  });

  it("sets mode, pon and pan on a channel's send to a bus", async () => {
    defineTapSend(mock, "/ch/1/send/2");
    const result = await setSend({ source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, mode: "GRP", pon: true, pan: 10 });
    expect(result.isError, text(result)).to.not.equal(true);
    expect((result.structuredContent as unknown as WingWriteResult).status).to.equal("OK");
    expect(mock.getParam("/ch/1/send/2/mode")).to.equal("GRP");
    expect(mock.getParam("/ch/1/send/2/pon")).to.equal(1);
    expect(mock.getParam("/ch/1/send/2/pan")).to.equal(10);
  });

  // Verified on hardware (2026-10-28): with LINK PAN ON or REV the console acks a pan write OK and keeps
  // the linked pan, so the write would only ever come back as a MISMATCH.
  it("refuses pan while the send's LINK PAN is on, and writes nothing", async () => {
    defineTapSend(mock, "/ch/1/send/2", { plink: 2, pan: 27 });
    const result = await setSend({ source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, levelDb: -3, pan: 40 });
    expect(result.isError).to.equal(true);
    expect(text(result)).to.include("has LINK PAN REV").and.to.include('plink: "OFF"').and.to.include("Nothing was written");
    expect(mock.getParam("/ch/1/send/2/lvl")).to.equal(-144);
    expect(mock.getParam("/ch/1/send/2/pan")).to.equal(27);
  });

  it("refuses pan given together with LINK PAN ON", async () => {
    defineTapSend(mock, "/ch/1/send/2");
    const result = await setSend({ source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, plink: "ON", pan: 40 });
    expect(result.isError).to.equal(true);
    expect(text(result)).to.include("has LINK PAN ON");
    expect(mock.getParam("/ch/1/send/2/plink")).to.equal(0);
  });

  it("unlinks and pans in one call, writing plink before pan", async () => {
    defineTapSend(mock, "/ch/1/send/2", { plink: 1 });
    const result = await setSend({ source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, plink: "OFF", pan: 20 });
    expect(result.isError, text(result)).to.not.equal(true);
    expect((result.structuredContent as unknown as WingWriteResult).results.map((r) => r.key)).to.deep.equal(["plink", "pan"]);
    expect(mock.getParam("/ch/1/send/2/plink")).to.equal(0);
    expect(mock.getParam("/ch/1/send/2/pan")).to.equal(20);
  });

  it("links the pan and reports the pan the console now holds", async () => {
    // The mock does not rewrite the pan as the console does; -27 stands in for the channel's pan.
    defineTapSend(mock, "/ch/1/send/2", { pan: -27 });
    const result = await setSend({ source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, plink: "REV" });
    expect(result.isError, text(result)).to.not.equal(true);
    expect(mock.getParam("/ch/1/send/2/plink")).to.equal(2);
    expect(result.structuredContent).to.include({ linkedPan: -27 });
    expect(text(result)).to.include("pan now follows the channel (inverted): -27");
    const read = await client.callTool({ name: "wing_get_send", arguments: { source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2 } });
    expect(read.structuredContent).to.include({ plink: "REV" });
    expect((read.content as TextContent[])[0]?.text).to.include("(linked REV)");
  });

  it("refuses a mode the console does not have before sending anything", async () => {
    defineTapSend(mock, "/ch/1/send/2");
    const result = await setSend({ source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, mode: "SIDE" });
    expect(result.isError).to.equal(true);
    expect(mock.getParam("/ch/1/send/2/mode")).to.equal("POST");
  });

  it("clamps a level above +10 dB the way the console does, and says what it asked for", async () => {
    definePreSend(mock, "/bus/3/send/4");
    const result = await setSend({ source: "bus", sourceIndex: 3, destination: "bus", destinationIndex: 4, levelDb: 50 });
    expect(result.isError, text(result)).to.not.equal(true);
    const [lvl] = (result.structuredContent as unknown as WingWriteResult).results;
    expect(lvl).to.include({ requested: 50, sent: 10, stored: 10, match: true });
  });

  it("reports a write the console rejected part-way as an error, says what it kept, and makes that undoable", async () => {
    // A tap send whose node is missing `pon`: the console stores on and lvl, then answers NODE NOT
    // FOUND for pon — the same partial write the pan-on-a-main case caused on hardware.
    defineTapSend(mock, "/ch/1/send/2", { withPon: false });
    const result = await setSend({ source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, on: true, levelDb: -3, pon: true });
    expect(result.isError).to.equal(true);
    const s = result.structuredContent as unknown as WingWriteResult;
    expect(s.status).to.equal("NODE NOT FOUND");
    expect(s.applied).to.deep.equal(["/ch/1/send/2/on", "/ch/1/send/2/lvl"]);
    expect(text(result)).to.include("had already stored /ch/1/send/2/on, /ch/1/send/2/lvl").and.to.include("wing_undo reverts them");
    expect(mock.getParam("/ch/1/send/2/on")).to.equal(1);
    expect(mock.getParam("/ch/1/send/2/lvl")).to.equal(-3);
    expect(journal.history().map((b) => [b.origin, b.batchId])).to.deep.equal([["wing_set_send", s.batchId]]);

    const undo = await client.callTool({ name: "wing_undo", arguments: {} });
    expect(undo.isError, (undo.content as TextContent[])[0]?.text).to.not.equal(true);
    expect(mock.getParam("/ch/1/send/2/on")).to.equal(0);
    expect(mock.getParam("/ch/1/send/2/lvl")).to.equal(-144);
  });

  it("holds the write to show mode, and lets a confirmed one through", async () => {
    definePreSend(mock, "/ch/40/main/1");
    config = { ...config, showMode: true };
    const refused = await setSend({ source: "channel", sourceIndex: 40, destination: "main", destinationIndex: 1, levelDb: -10 });
    expect(refused.isError).to.equal(true);
    expect(text(refused)).to.include("Show mode is on");
    expect(mock.getParam("/ch/40/main/1/lvl")).to.equal(0);
    const confirmed = await setSend({ source: "channel", sourceIndex: 40, destination: "main", destinationIndex: 1, levelDb: -10, confirm: true });
    expect(confirmed.isError, text(confirmed)).to.not.equal(true);
    expect(mock.getParam("/ch/40/main/1/lvl")).to.equal(-10);
  });

  it("reads back the fields each shape has", async () => {
    defineTapSend(mock, "/ch/1/send/2");
    definePreSend(mock, "/ch/40/main/1");
    const tap = await client.callTool({ name: "wing_get_send", arguments: { source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2 } });
    expect(tap.structuredContent).to.include({ on: false, levelDb: -144, pan: 0, mode: "POST", pon: false, plink: "OFF" });
    const pre = await client.callTool({ name: "wing_get_send", arguments: { source: "channel", sourceIndex: 40, destination: "main", destinationIndex: 1 } });
    expect(pre.structuredContent).to.include({ on: true, levelDb: 0, pre: false });
    expect((pre.content as TextContent[])[0]?.text).to.include("POST");
  });
});

describe("wing_bulk_set on a write the console rejects part-way (real client, mock console)", () => {
  let mock: WingMockServer;
  let oscClient: WingOscClient;
  let journal: WingWriteJournal;
  let server: McpServer;
  let client: Client;
  let tmp: string;

  beforeEach(async () => {
    mock = new WingMockServer();
    const { oscPort } = await mock.start();
    oscClient = new WingOscClient({ host: "127.0.0.1", port: oscPort, requestTimeoutMs: 300 });
    await oscClient.connect();
    journal = new WingWriteJournal();
    oscClient.setJournal(journal);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wing-bulk-partial-"));
    const config = baseConfig();
    const ctx: WingPluginContext = {
      client: oscClient,
      meterClient: {} as WingMeterClient,
      cache: new WingStateCache(),
      eventBus: new EventBus(),
      getConfig: () => config,
      updateConfig: async () => config,
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

  it("reads back and journals the keys before the rejected one, and only those", async () => {
    // /ch/1/fdr and /ch/1/mute exist in the mock's seed; "nope" does not, and comes between them.
    const result = await client.callTool({
      name: "wing_bulk_set",
      arguments: { baseNode: "/ch/1", assignments: { fdr: -20, nope: 1, mute: 1 } },
    });
    expect(result.isError).to.equal(true);
    const s = result.structuredContent as unknown as WingWriteResult;
    expect(s.status).to.equal("NODE NOT FOUND");
    expect(s.applied).to.deep.equal(["/ch/1/fdr"]);
    expect(s.results.map((r) => [r.key, r.stored ?? "unread", r.match ?? "unread"])).to.deep.equal([
      ["fdr", -20, true],
      ["nope", "unread", "unread"],
      ["mute", 0, false],
    ]);
    expect(mock.getParam("/ch/1/mute")).to.equal(0);

    await client.callTool({ name: "wing_undo", arguments: {} });
    expect(mock.getParam("/ch/1/fdr")).to.equal(-6);
  });

  it("says nothing changed when the rejected key came first", async () => {
    const result = await client.callTool({
      name: "wing_bulk_set",
      arguments: { baseNode: "/ch/1", assignments: { nope: 1, fdr: -20 } },
    });
    expect(result.isError).to.equal(true);
    const s = result.structuredContent as unknown as WingWriteResult;
    expect(s.applied).to.deep.equal([]);
    expect(s.batchId).to.equal(undefined);
    expect((result.content as TextContent[])[0]?.text).to.include("no key that could be read back changed");
    expect(journal.history()).to.deep.equal([]);
  });
});
