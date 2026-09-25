// The dashboard's REST routes (http-routes/), end to end: a real express router over a real
// WingOscClient talking to the loopback mock console. Until these existed the whole file — every
// route the dashboard drives the desk through — had no test at all.

import { expect } from "chai";
import express from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { registerWingHttpRoutes } from "../../../src/plugins/wing/http-routes/index.js";
import type { WingConfig } from "../../../src/plugins/wing/wing-config.js";
import type { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import { WingMicCalibrationStore } from "../../../src/plugins/wing/wing-mic-calibration-store.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, DCA_COUNT, MAIN_COUNT, MATRIX_COUNT, MUTEGROUP_COUNT } from "../../../src/plugins/wing/wing-node-paths.js";
import { WingOscClient } from "../../../src/plugins/wing/wing-osc-client.js";
import { WingOscMirror } from "../../../src/plugins/wing/wing-osc-mirror.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";
import { WingPresetStore } from "../../../src/plugins/wing/wing-preset-store.js";
import { ROUTE_READ_CONCURRENCY } from "../../../src/plugins/wing/wing-read-budget.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import { WingWriteJournal } from "../../../src/plugins/wing/wing-write-journal.js";
import { WingMockServer } from "./wing-mock-server.js";

function baseConfig(): WingConfig {
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
  };
}

describe("WING REST routes", () => {
  let mock: WingMockServer;
  let oscClient: WingOscClient;
  let httpServer: Server;
  let base: string;
  let tmp: string;

  beforeEach(async () => {
    mock = new WingMockServer();
    const { oscPort } = await mock.start();
    for (let n = 1; n <= CHANNEL_COUNT; n++) {
      mock.setParam(`/ch/${n}/name`, `Ch ${n}`);
      mock.setParam(`/ch/${n}/fdr`, -10);
      mock.setParam(`/ch/${n}/mute`, 0);
    }
    oscClient = new WingOscClient({ host: "127.0.0.1", port: oscPort, requestTimeoutMs: 500 });
    await oscClient.connect();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wing-http-routes-"));
    let config = baseConfig();
    const ctx: WingPluginContext = {
      client: oscClient,
      meterClient: {} as WingMeterClient,
      cache: new WingStateCache(),
      eventBus: new EventBus(),
      getConfig: () => config,
      updateConfig: async (patch) => (config = { ...config, ...patch }),
      journal: new WingWriteJournal(),
      buildOverviewSnapshot: async () => ({}),
      getLastRta: () => null,
      presetStore: new WingPresetStore({ dir: path.join(tmp, "presets") }),
      micCalibrationStore: new WingMicCalibrationStore({ dir: path.join(tmp, "mics") }),
      oscMirror: new WingOscMirror(),
    };
    const app = express();
    const router = express.Router();
    registerWingHttpRoutes(router, ctx);
    app.use(router);
    httpServer = await new Promise<Server>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const address = httpServer.address();
    base = "http://127.0.0.1:" + (typeof address === "object" && address ? address.port : 0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await oscClient.close();
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("GET /mixer-state", () => {
    it("loads every strip without ever holding more than a few reads in the OSC queue", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const dump = oscClient.dump.bind(oscClient);
      oscClient.dump = async (p: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await dump(p);
        } finally {
          inFlight -= 1;
        }
      };

      const res = await fetch(base + "/mixer-state");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as Record<string, { index: number; name?: string }[]>;
      expect(body.channels).to.have.lengthOf(CHANNEL_COUNT);
      expect(body.channels[2]).to.include({ index: 3, name: "Ch 3" });
      expect(body.auxes).to.have.lengthOf(AUX_COUNT);
      expect(body.buses).to.have.lengthOf(BUS_COUNT);
      expect(body.mains).to.have.lengthOf(MAIN_COUNT);
      expect(body.matrices).to.have.lengthOf(MATRIX_COUNT);
      expect(body.dcas).to.have.lengthOf(DCA_COUNT);
      expect(body.mutegroups).to.have.lengthOf(MUTEGROUP_COUNT);
      expect(maxInFlight).to.be.at.most(ROUTE_READ_CONCURRENCY);
    });

    it("leaves room in the queue for a request made during the load (a tool call, a heartbeat)", async () => {
      const load = fetch(base + "/mixer-state");
      // Let the route enqueue its first reads, then ask for something else.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const concurrent = await oscClient.get("/ch/1/fdr");
      expect(concurrent.kind).to.equal("leaf");
      expect((await load).status).to.equal(200);
    });
  });

  async function post(route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  describe("POST /set and /bulk-set", () => {
    it("writes a validated value and reports the console's ack", async () => {
      const res = await post("/set", { path: "/ch/1/fdr", value: -6 });
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ ok: true, status: "OK" });
      expect(mock.getParam("/ch/1/fdr")).to.equal(-6);
    });

    it("refuses a malformed request before touching the console", async () => {
      expect((await post("/set", { path: "ch/1/fdr", value: 1 })).status).to.equal(400);
      expect((await post("/set", { path: "/ch/1/fdr", value: { nested: true } })).status).to.equal(400);
      expect((await post("/bulk-set", { baseNode: "/ch/1", assignments: [1, 2] })).status).to.equal(400);
    });

    it("refuses a value far outside the parameter's range", async () => {
      const res = await post("/set", { path: "/ch/1/fdr", value: 500 });
      expect(res.status).to.equal(422);
      expect(mock.getParam("/ch/1/fdr")).to.equal(-10);
    });

    it("refuses a key that would smuggle a second assignment into the bulk-set string", async () => {
      const res = await post("/bulk-set", { baseNode: "/ch/1", assignments: { "mute=1,x.name": "a" } });
      expect(res.status).to.equal(422);
      expect(mock.getParam("/ch/1/mute")).to.equal(0);
    });
  });

  describe("POST /fade", () => {
    it("refuses what the wing_fade tool's schema refuses: a missing field, a non-fader path, a target above +10 dB", async () => {
      expect((await post("/fade", { path: "/ch/1/fdr" })).status).to.equal(400);
      expect((await post("/fade", { path: "/ch/1/pan", durationMs: 200, direction: "out" })).status).to.equal(400);
      expect((await post("/fade", { path: "/ch/1/fdr", durationMs: 200, direction: "in", to: 20 })).status).to.equal(400);
      expect((await post("/fade", { path: "/ch/1/fdr", durationMs: 200, direction: "in", easing: "wobble" })).status).to.equal(400);
    });

    it("still answers 422 for what only the live value can tell: a relative target that lands above +10 dB", async () => {
      const res = await post("/fade", { path: "/ch/1/fdr", durationMs: 200, direction: "in", deltaDb: 25 });
      expect(res.status).to.equal(422);
      expect(mock.getParam("/ch/1/fdr")).to.equal(-10);
    });

    it("starts a fade and lands on the target", async () => {
      const res = await post("/fade", { path: "/ch/1/fdr", durationMs: 200, direction: "in", to: 0 });
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ status: "started", from: -10, to: 0 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(mock.getParam("/ch/1/fdr")).to.equal(0);
    });
  });

  describe("automation bodies (validated with the MCP tools' own schemas)", () => {
    it("refuses values the tools refuse, naming the field, instead of silently dropping them", async () => {
      const cases: [string, Record<string, unknown>, string][] = [
        ["/channels/1/dyn/auto-compress", { targetReductionDb: 5 }, "targetReductionDb"],
        ["/channels/1/dyn/auto-compress", { maxIterations: 40 }, "maxIterations"],
        ["/channels/1/dyn/auto-compress", { targetMode: "rms" }, "targetMode"],
        ["/strips/bus/1/dyn/auto-compress", { sampleMs: "3000" }, "sampleMs"],
        ["/channels/1/gate/auto-gate", { marginDb: 60 }, "marginDb"],
        ["/aux/1/dyn/auto-gate", { sampleMs: 100 }, "sampleMs"],
        ["/channels/1/autogain", { mode: "preamp" }, "mode"],
        ["/io/in/LCL/1/autogain", { meterType: "channel" }, "meterIndex"],
        ["/io/in/LCL/1/autogain", { meterType: "bus", meterIndex: 1 }, "meterType"],
        ["/io/in/LCL/1/autogain", { meterType: "aux", meterIndex: AUX_COUNT + 1 }, "meterIndex"],
        ["/auto-eq-balance", { zones: [] }, "micChannel"],
        ["/auto-eq-balance", { micChannel: 1, zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000, lowCut: { hz: 100, slope: "LR96" } }] }, "zones.0.lowCut.slope"],
      ];
      for (const [route, body, field] of cases) {
        const res = await post(route, body);
        expect(res.status, `${route} ${JSON.stringify(body)}`).to.equal(400);
        expect(String(res.body.error), route).to.include(field);
      }
    });

    it("lets a valid body (or none at all) through to the engine", async () => {
      // The fake meter client makes the run itself fail — but past validation, not with a 400.
      const res = await fetch(base + "/channels/1/autogain", { method: "POST" });
      expect(res.status).to.not.equal(400);
      expect((await post("/channels/1/autogain", { mode: "trim", targetDb: -20 })).status).to.not.equal(400);
    });
  });

  describe("index validation", () => {
    it("answers 400 for an out-of-range strip index instead of querying the console", async () => {
      for (const route of ["/channels/0/sends", "/channels/41/sends", "/aux/9/sends", "/bus/17/sends", "/main/5/sends"]) {
        const res = await fetch(base + route);
        expect(res.status, route).to.equal(400);
      }
    });
  });

  describe("OSC mirror", () => {
    it("reports its status, and refuses to enable without a target", async () => {
      const status = await fetch(base + "/osc-mirror");
      expect(status.status).to.equal(200);
      const res = await post("/osc-mirror", { enabled: true });
      expect(res.status).to.equal(422);
    });
  });

  describe("presets", () => {
    it("lists none on a fresh store, and refuses a save without a name or indices", async () => {
      const list = await fetch(base + "/presets");
      expect(await list.json()).to.deep.equal({ presets: [] });
      expect((await post("/presets", { indices: [1] })).status).to.equal(400);
      expect((await post("/presets", { name: "x", indices: [] })).status).to.equal(400);
      expect((await fetch(base + "/presets/nothing-here")).status).to.equal(404);
    });
  });
});
