// The dashboard's REST routes (http-routes.ts), end to end: a real express router over a real
// WingOscClient talking to the loopback mock console. Until these existed the whole file — every
// route the dashboard drives the desk through — had no test at all.

import { expect } from "chai";
import express from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { registerWingHttpRoutes } from "../../../src/plugins/wing/http-routes.js";
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
});
