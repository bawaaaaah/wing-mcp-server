import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMicCalibrationTools } from "../../../src/plugins/wing/tools/mic-calibration.js";
import { WingMicCalibrationStore } from "../../../src/plugins/wing/wing-mic-calibration-store.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

const POINTS = [
  { hz: 20, db: -0.07 },
  { hz: 100, db: 0.49 },
  { hz: 1000, db: 0 },
  { hz: 10000, db: 0.39 },
  { hz: 20000, db: -4 },
];
const CURVE = { sourceFiles: ["ECM8000.zip"], points: POINTS };

describe("WingMicCalibrationStore", () => {
  let dir: string;
  let store: WingMicCalibrationStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-mics-"));
    store = new WingMicCalibrationStore({ dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a mic and summarizes its curves", async () => {
    await store.save({ name: " ECM8000 ", serial: "A1", notes: "generic file", curves: { deg0: CURVE, deg90: null } });
    expect(fs.existsSync(path.join(dir, "ecm8000.json"))).to.equal(true);
    const file = await store.get("ECM8000");
    expect(file).to.include({ name: "ECM8000", serial: "A1", notes: "generic file" });
    expect(file!.curves).to.deep.equal({ deg0: CURVE, deg90: null });
    expect(await store.list()).to.deep.equal([
      {
        name: "ECM8000",
        serial: "A1",
        notes: "generic file",
        createdAt: file!.createdAt,
        updatedAt: file!.updatedAt,
        orientations: [0],
        ranges: { deg0: { minHz: 20, maxHz: 20000, pointCount: 5 } },
      },
    ]);
  });

  it("requires a curve, refuses to overwrite by default, and deletes", async () => {
    const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (err: Error) => err);
    expect((await rejection(store.save({ name: "UMIK", curves: { deg0: null, deg90: null } })))?.message).to.match(
      /at least one calibration curve/,
    );

    const first = await store.save({ name: "UMIK", curves: { deg0: null, deg90: CURVE } });
    expect((await rejection(store.save({ name: "umik", curves: { deg0: CURVE, deg90: null } })))?.message).to.match(
      /A mic named "UMIK" already exists \(umik.json\)/,
    );

    const second = await store.save({ name: "UMIK", curves: { deg0: CURVE, deg90: CURVE } }, { overwrite: true });
    expect(second.createdAt).to.equal(first.createdAt);
    expect((await store.list())[0].orientations).to.deep.equal([0, 90]);

    expect(await store.delete("UMIK")).to.equal(true);
    expect(await store.delete("UMIK")).to.equal(false);
    expect(await store.list()).to.deep.equal([]);
  });

  it("quarantines a mic file without any curve", async () => {
    fs.writeFileSync(
      path.join(dir, "empty.json"),
      JSON.stringify({ formatVersion: 1, name: "Empty", serial: "", notes: "", createdAt: "x", updatedAt: "x", curves: { deg0: null, deg90: null } }),
    );
    expect(await store.list()).to.deep.equal([]);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"))).to.have.length(1);
  });
});

describe("wing_mic_calibration_* MCP tools", () => {
  let dir: string;
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-test-mic-tools-"));
    const ctx = { micCalibrationStore: new WingMicCalibrationStore({ dir }) } as unknown as WingPluginContext;
    server = new McpServer({ name: "mic-test", version: "0.0.0" });
    registerMicCalibrationTools(server, ctx);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "mic-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0].text;

  it("saves a mic from a calibration file's text, lists it with its points, and deletes it", async () => {
    const content = "* REW cal\n" + POINTS.map((p) => `${p.hz} ${p.db} 0`).join("\n");
    const saved = await client.callTool({
      name: "wing_mic_calibration_save",
      arguments: { name: "ECM8000", serial: "B1", curve0: { fileName: "ecm.txt", content }, curve90: { points: POINTS } },
    });
    expect(saved.isError, text(saved)).to.not.equal(true);
    expect(text(saved)).to.equal("Saved mic ECM8000 (SN B1): 0° 5 pts 20-20000 Hz, 90° 5 pts 20-20000 Hz");

    const one = await client.callTool({ name: "wing_mic_calibration_list", arguments: { name: "ECM8000" } });
    expect((one.structuredContent as { curves: { deg0: unknown } }).curves.deg0).to.deep.equal({ sourceFiles: ["ecm.txt"], points: POINTS });

    const again = await client.callTool({ name: "wing_mic_calibration_save", arguments: { name: "ECM8000", curve0: { points: POINTS } } });
    expect(again.isError).to.equal(true);
    expect(text(again)).to.match(/already exists/);

    expect(text(await client.callTool({ name: "wing_mic_calibration_delete", arguments: { name: "ECM8000" } }))).to.equal('Deleted mic "ECM8000".');
    expect(text(await client.callTool({ name: "wing_mic_calibration_list", arguments: {} }))).to.equal("No measurement mics saved yet.");
  });

  it("reports an unreadable calibration file", async () => {
    const result = await client.callTool({
      name: "wing_mic_calibration_save",
      arguments: { name: "Bad", curve0: { fileName: "notes.txt", content: "no numbers here" } },
    });
    expect(result.isError).to.equal(true);
    expect(text(result)).to.match(/No calibration curve found in "notes.txt"/);
  });
});
