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
import { bridgeConfigDefaults, type WingConfig } from "../../../src/plugins/wing/wing-config.js";
import type { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import { WingMicCalibrationStore } from "../../../src/plugins/wing/wing-mic-calibration-store.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, DCA_COUNT, MAIN_COUNT, MATRIX_COUNT, MUTEGROUP_COUNT } from "../../../src/plugins/wing/wing-node-paths.js";
import { WingOscClient } from "../../../src/plugins/wing/wing-osc-client.js";
import { WingOscMirror } from "../../../src/plugins/wing/wing-osc-mirror.js";
import { WingBridge } from "../../../src/plugins/wing/wing-bridge.js";
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
    ...bridgeConfigDefaults(),
  };
}

describe("WING REST routes", () => {
  let mock: WingMockServer;
  let oscClient: WingOscClient;
  let httpServer: Server;
  let base: string;
  let tmp: string;
  let currentConfig: () => WingConfig;
  let patchConfig: (change: Partial<WingConfig>) => void;

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
    currentConfig = () => config;
    patchConfig = (change) => {
      config = { ...config, ...change };
    };
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
      bridge: new WingBridge(new WingStateCache()),
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

    it("shows a linked strip's source name, colour and icon, and where every strip is patched from", async () => {
      // Channel 12 follows AES50 A 12: the console shows the source's identity on the `$` shadows,
      // while the strip's own leaves (all a dump returns) keep a name nobody sees.
      mock.setParam("/ch/12/name", "old own name");
      mock.setParam("/ch/12/col", 1);
      mock.setParam("/ch/12/clink", 1);
      mock.setParam("/ch/12/in/conn/grp", "A");
      mock.setParam("/ch/12/in/conn/in", 12);
      mock.setParam("/ch/12/$name", "Bass Amp");
      mock.setParam("/ch/12/$col", 3);
      mock.setParam("/ch/12/$icon", 501);
      mock.setParam("/ch/13/clink", 0);
      mock.setParam("/ch/13/in/conn/grp", "OFF");
      mock.setParam("/ch/13/in/conn/in", 1);

      const res = await fetch(base + "/mixer-state");
      const body = (await res.json()) as { channels: Record<string, unknown>[] };
      expect(body.channels[11]).to.deep.include({ index: 12, name: "Bass Amp", col: 3, icon: 501, srcAuto: true, source: { group: "A", index: 12 } });
      expect(body.channels[12]).to.deep.include({ index: 13, name: "Ch 13", srcAuto: false, source: null });
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

  describe("GET /group-members", () => {
    it("inverts every strip's #D/#M tags into each group's member list", async () => {
      // Every strip has a tags field on the console; the mock only answers those it was given.
      const counts: [string, number][] = [["ch", CHANNEL_COUNT], ["aux", AUX_COUNT], ["bus", BUS_COUNT], ["main", MAIN_COUNT], ["mtx", MATRIX_COUNT]];
      for (const [prefix, count] of counts) for (let n = 1; n <= count; n++) mock.setParam(`/${prefix}/${n}/tags`, "");
      mock.setParam("/ch/1/tags", "#D1,#M2");
      mock.setParam("/ch/3/tags", "vocal,#D1");
      mock.setParam("/aux/2/tags", "#M2");
      mock.setParam("/bus/4/tags", "#D7");

      const res = await fetch(base + "/group-members");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as { dca: Record<string, unknown[]>; mutegroups: Record<string, unknown[]> };
      expect(body.dca["1"]).to.deep.equal([
        { type: "channel", index: 1 },
        { type: "channel", index: 3 },
      ]);
      expect(body.dca["7"]).to.deep.equal([{ type: "bus", index: 4 }]);
      expect(body.mutegroups["2"]).to.deep.equal([
        { type: "channel", index: 1 },
        { type: "aux", index: 2 },
      ]);
      expect(body.dca).to.not.have.property("2");
    });
  });

  describe("GET /solo-states", () => {
    it("lists the soloed strips of each type", async () => {
      const counts: [string, number][] = [["ch", CHANNEL_COUNT], ["aux", AUX_COUNT], ["bus", BUS_COUNT], ["main", MAIN_COUNT], ["mtx", MATRIX_COUNT], ["dca", DCA_COUNT]];
      for (const [prefix, count] of counts) for (let n = 1; n <= count; n++) mock.setParam(`/${prefix}/${n}/$solo`, 0);
      mock.setParam("/ch/5/$solo", 1);
      mock.setParam("/ch/12/$solo", 1);
      mock.setParam("/bus/3/$solo", 1);

      const res = await fetch(base + "/solo-states");
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({ channel: [5, 12], aux: [], bus: [3], main: [], matrix: [], dca: [] });
    });
  });

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

  describe("write bodies (validated with the MCP tools' own shapes)", () => {
    it("refuses a string where the source tool takes a boolean — \"false\" must not switch 48V on", async () => {
      mock.setParam("/io/in/LCL/1/vph", 0);
      mock.setParam("/io/in/LCL/1/g", 10);
      const res = await post("/io/in/LCL/1/props", { phantom48v: "false" });
      expect(res.status).to.equal(400);
      expect(String(res.body.error)).to.include("phantom48v");
      expect((await post("/io/in/LCL/1/props", { gain: "60" })).status).to.equal(400);
      expect((await post("/io/in/LCL/1/props", { col: 19 })).status).to.equal(400);
      expect(mock.getParam("/io/in/LCL/1/vph")).to.equal(0);
      expect(mock.getParam("/io/in/LCL/1/g")).to.equal(10);
    });

    it("still writes a well-typed source change", async () => {
      mock.setParam("/io/in/LCL/1/vph", 0);
      const res = await post("/io/in/LCL/1/props", { phantom48v: true });
      expect(res.status).to.equal(200);
      expect(mock.getParam("/io/in/LCL/1/vph")).to.equal(1);
    });

    it("refuses mistyped fields on the scribble, insert, delay, solo, USB and OSC-mirror routes", async () => {
      const cases: [string, Record<string, unknown>, string][] = [
        ["/channels/1/scribble", { led: "1" }, "led"],
        ["/channels/1/scribble", { icon: 1000 }, "icon"],
        ["/channels/1/insert/pre", { on: "true" }, "on"],
        ["/channels/1/insert/post", { w: 20 }, "w"],
        ["/channels/1/insert/pre", { fx: "FX99" }, "fx"],
        ["/channels/1/delay", { mode: "XX" }, "mode"],
        ["/channels/1/delay", { value: "5" }, "value"],
        ["/channels/1/solo", { solo: "false" }, "solo"],
        ["/media/play", { action: "EJECT" }, "action"],
        ["/media/play", { action: "PLAYFILE", index: 0 }, "index"],
        ["/media/rec", {}, "action"],
        ["/osc-mirror", { port: 70000 }, "port"],
      ];
      for (const [route, body, field] of cases) {
        const res = await post(route, body);
        expect(res.status, `${route} ${JSON.stringify(body)}`).to.equal(400);
        expect(String(res.body.error), route).to.include(field);
      }
    });

    it("answers a POST with no JSON body with a 4xx, not a 500", async () => {
      for (const route of ["/set", "/bulk-set", "/fade/cancel", "/channels/1/proc", "/io/altsw", "/channels/1/scribble", "/media/repeat"]) {
        const res = await fetch(base + route, { method: "POST" });
        expect(res.status, route).to.be.within(400, 499);
      }
    });

    it("refuses a bulk-set key that is not a node name before validating its value", async () => {
      const res = await post("/bulk-set", { baseNode: "/ch/1", assignments: { "../2/mute": 1 } });
      expect(res.status).to.equal(422);
      expect(String(res.body.error)).to.include("not a node key");
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

    it("saves an accepted change into the plugin config", async () => {
      const res = await post("/osc-mirror", { enabled: true, host: "10.0.0.9", port: 9100 });
      expect(res.status).to.equal(200);
      expect(currentConfig()).to.deep.include({ oscMirrorEnabled: true, oscMirrorHost: "10.0.0.9", oscMirrorPort: 9100 });
      await post("/osc-mirror", { enabled: false });
    });
  });

  describe("bridge", () => {
    async function send(method: "PUT" | "POST", route: string, body: unknown) {
      const res = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    it("reports its status", async () => {
      const res = await fetch(base + "/bridge");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).to.include.keys("enabled", "osc", "safes", "clients", "recentBlocks");
    });

    it("saves configuration and safes through the plugin config", async () => {
      expect((await post("/bridge", { enabled: true, oscPort: 3223, protectGlobal: false })).status).to.equal(200);
      expect(currentConfig()).to.include({ bridgeEnabled: true, bridgeOscPort: 3223, bridgeProtectGlobal: false });

      expect((await send("PUT", "/bridge/safes", { ch: [3, 1, 3], bus: [16] })).status).to.equal(200);
      expect(currentConfig().bridgeSafes).to.deep.include({ ch: [1, 3], bus: [16], dca: [] });
      // POST adds by default; PUT replaces, clearing kinds left out.
      expect((await post("/bridge/safes", { dca: [2] })).status).to.equal(200);
      expect(currentConfig().bridgeSafes).to.deep.include({ ch: [1, 3], bus: [16], dca: [2] });
      expect((await post("/bridge/safes", { mode: "remove", ch: [1] })).status).to.equal(200);
      expect(currentConfig().bridgeSafes.ch).to.deep.equal([3]);
      expect((await send("PUT", "/bridge/safes", { mtx: [1] })).status).to.equal(200);
      expect(currentConfig().bridgeSafes).to.deep.include({ ch: [], bus: [], dca: [], mtx: [1] });
    });

    it("refuses out-of-range indexes and an empty configure", async () => {
      expect((await send("PUT", "/bridge/safes", { ch: [41] })).status).to.equal(400);
      expect((await send("PUT", "/bridge/safes", { mode: "toggle" })).status).to.equal(400);
      expect((await post("/bridge", { oscPort: 70000 })).status).to.equal(400);
      expect((await post("/bridge", {})).status).to.equal(422);
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

  describe("patch sheet routes", () => {
    it("lists the known boxes for the Patch tab's editor", async () => {
      const res = await fetch(base + "/io/boxmap/models");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as { models: { id: string; size: number }[]; groupLimits: Record<string, number>; groups: string[] };
      expect(body.models.find((m) => m.id === "midas-dl8")).to.include({ size: 8 });
      expect(body.groupLimits).to.include({ A: 48, SC: 32 });
      expect(body.groups).to.include("LCL");
    });

    it("answers 400 with where to fix it when the saved box map cannot be drawn", async () => {
      patchConfig({ boxMap: { A: [{ range: [1, 8], device: "DL8", model: "Midas DL8" }], B: [{ range: [1, 8], device: "DL8", model: "Midas DL8" }] } });
      const res = await fetch(base + "/io/patch.pdf?render=table&lang=en");
      expect(res.status).to.equal(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).to.contain("cannot be drawn").and.to.contain('The name "DL8" is used by 2 boxes');
    });

    it("does not take paths or headers from the query", async () => {
      patchConfig({ boxMap: { A: [{ range: [1, 8], device: "X", model: "Midas DL8" }], B: [{ range: [1, 8], device: "X", model: "Midas DL8" }] } });
      const res = await fetch(base + "/io/patch.pdf?naming=../../etc/passwd&render=%0d%0aX-Evil:1&lang=zz");
      expect(res.headers.get("x-evil")).to.equal(null);
      expect(res.status).to.equal(400);
    });
  });
});
