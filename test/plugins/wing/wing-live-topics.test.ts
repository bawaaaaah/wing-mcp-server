import { encode } from "@msgpack/msgpack";
import { expect } from "chai";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createAuthMiddleware } from "../../../src/core/auth.js";
import { EventBus } from "../../../src/core/event-bus.js";
import type { McpPlugin } from "../../../src/core/plugin.js";
import { WsHub } from "../../../src/core/ws-hub.js";
import { METER_COLUMNS, encodeRtaBands, wingLiveTopics } from "../../../src/plugins/wing/wing-live-topics.js";
import type { MeterFrame, MeterSnapshot } from "../../../src/plugins/wing/wing-meter-types.js";
import { decodeMeterFrames, decodeRtaBands, type MetersAck, type MetersWireFrame, type RtaWireFrame } from "../../../web/src/api/live-codec.js";
import { openSocket, type TestSocket } from "../../core/ws-test-client.js";

const topics = wingLiveTopics();

function stripFrame(type: "channel" | "bus" | "aux" | "main" | "matrix", index: number, level: number): MeterFrame {
  return {
    type,
    index,
    inputL_dB: level,
    inputR_dB: level - 1,
    outputL_dB: level - 2,
    outputR_dB: level - 3,
    gateKey_dB: -60,
    gateGain_dB: 0,
    dynKey_dB: -40,
    dynGain_dB: -4.25,
  };
}

/** What the plugin's default console subscription produces: every strip, every DCA, the RTA. */
function fullSnapshot(level = -20): MeterSnapshot {
  const frames: MeterFrame[] = [];
  const add = (type: "channel" | "bus" | "aux" | "main" | "matrix", count: number) => {
    for (let i = 1; i <= count; i++) frames.push(stripFrame(type, i, level - i / 10));
  };
  add("channel", 40);
  add("aux", 8);
  add("bus", 16);
  add("main", 4);
  add("matrix", 8);
  for (let i = 1; i <= 16; i++) frames.push({ type: "dca", index: i, preFaderL_dB: -10, preFaderR_dB: -11, postFaderL_dB: -12, postFaderR_dB: -13 });
  frames.push({ type: "monitor", soloL_dB: -30, soloR_dB: -31, mon1L_dB: -32, mon1R_dB: -33, mon2L_dB: -34, mon2R_dB: -35 });
  frames.push({ type: "rta", bands_dB: Array.from({ length: 120 }, (_, i) => -90 + i / 2) });
  return { reportId: 1, receivedAt: 1234, frames };
}

describe("wing live topics", () => {
  describe("meters", () => {
    const meters = topics.meters;

    it("is a stream topic and acks with the column layout", () => {
      expect(meters.channel).to.equal("stream");
      const { ack } = meters.subscribe!({ strips: "all" });
      expect(ack).to.deep.equal({ columns: METER_COLUMNS, scale: 10 });
    });

    it("refuses params that are not a strip list", () => {
      expect(() => meters.subscribe!(undefined)).to.throw(/strips/);
      expect(() => meters.subscribe!({ strips: [{ type: "rta", index: 0 }] })).to.throw();
      expect(() => meters.subscribe!({ strips: [{ type: "channel", index: 1, extra: true }] })).to.throw();
      expect(() => meters.subscribe!({ strips: Array.from({ length: 600 }, () => ({ type: "channel", index: 1 })) })).to.throw();
    });

    it("groups equivalent strip lists under one key, whatever their order", () => {
      const a = meters.subscribe!({ strips: [{ type: "channel", index: 1 }, { type: "bus", index: 2 }] });
      const b = meters.subscribe!({ strips: [{ type: "bus", index: 2 }, { type: "channel", index: 1 }, { type: "channel", index: 1 }] });
      expect(a.key).to.equal(b.key);
      expect(a.key).to.not.equal(meters.subscribe!({ strips: "all" }).key);
    });

    it("encodes only the requested strips, as tuples in tenths of a dB", () => {
      const { params, ack } = meters.subscribe!({ strips: [{ type: "channel", index: 3 }, { type: "dca", index: 2 }] });
      const data = meters.encode!(fullSnapshot(), params) as MetersWireFrame;
      expect(data.receivedAt).to.equal(1234);
      expect(data.frames).to.have.length(2);
      expect(data.frames[0]).to.deep.equal(["channel", 3, -203, -213, -223, -233, -600, 0, -400, -42]);

      const readings = decodeMeterFrames(data, ack as MetersAck);
      expect(readings[0]).to.deep.include({ type: "channel", index: 3 });
      expect(readings[0].values.dynGain_dB).to.be.closeTo(-4.2, 1e-9);
      expect(readings[1].values).to.deep.equal({ preFaderL_dB: -10, preFaderR_dB: -11, postFaderL_dB: -12, postFaderR_dB: -13 });
    });

    it("never carries the RTA, carries booleans as 0/1 and non-finite readings as null", () => {
      const { params } = meters.subscribe!({ strips: "all" });
      const snapshot: MeterSnapshot = {
        reportId: 1,
        receivedAt: 1,
        frames: [
          {
            type: "channelV2",
            index: 1,
            inputL_dB: Number.NEGATIVE_INFINITY,
            inputR_dB: 0,
            outputL_dB: 0,
            outputR_dB: 0,
            gateKey_dB: 0,
            gateGain_dB: 0,
            gateLed: true,
            dynKey_dB: 0,
            dynGain_dB: 0,
            dynActive: false,
            automixGain_dB: 0,
          },
          { type: "rta", bands_dB: [0] },
        ],
      };
      const data = meters.encode!(snapshot, params) as MetersWireFrame;
      expect(data.frames).to.deep.equal([["channelV2", 1, null, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]]);
    });

    it("sends nothing when none of the requested strips is in the snapshot", () => {
      const { params } = meters.subscribe!({ strips: [{ type: "fx", index: 1 }] });
      expect(meters.encode!(fullSnapshot(), params)).to.equal(null);
    });

    it("is several times smaller than the same snapshot as JSON", () => {
      const snapshot = fullSnapshot();
      const { params } = meters.subscribe!({ strips: "all" });
      const sse = JSON.stringify({ pluginId: "wing", type: "meters", payload: snapshot, timestamp: 0 }).length;
      const ws = encode({ t: "evt", topic: "wing:meters", ts: 0, data: meters.encode!(snapshot, params) }).byteLength;
      expect(ws * 5).to.be.below(sse);
    });
  });

  describe("rta", () => {
    it("is a stream topic built from the plugin's own rta event, never compressed", () => {
      expect(topics.rta).to.deep.include({ channel: "stream", compress: false });
      expect(topics.rta.source).to.equal(undefined);
    });

    it("round-trips bands through the dashboard's decoder, losslessly at 1/128 dB", () => {
      const bandsDb = Array.from({ length: 120 }, (_, i) => -100 + i * (1 / 128) * 37);
      const data = topics.rta.encode!({ bandsDb, receivedAt: 99 }, undefined) as RtaWireFrame;
      expect(data.bands.byteLength).to.equal(240);
      expect(data).to.deep.include({ receivedAt: 99, scale: 128 });
      const decoded = Array.from(decodeRtaBands(data));
      decoded.forEach((db, i) => expect(db).to.be.closeTo(bandsDb[i], 1e-4));
    });

    it("clamps to the int16 range and maps non-finite bands to the floor", () => {
      const bytes = encodeRtaBands([1000, -1000, Number.NEGATIVE_INFINITY, Number.NaN]);
      const decoded = Array.from(decodeRtaBands({ receivedAt: 0, scale: 128, bands: bytes }));
      expect(decoded).to.deep.equal([32767 / 128, -256, -256, -256]);
    });

    it("decodes a bin that sits at an odd byte offset", () => {
      const inner = encodeRtaBands([-12.5, -3]);
      const padded = new Uint8Array(inner.length + 1);
      padded.set(inner, 1);
      const decoded = decodeRtaBands({ receivedAt: 0, scale: 128, bands: padded.subarray(1) });
      expect(Array.from(decoded)).to.deep.equal([-12.5, -3]);
    });
  });

  it("offers the plugin's one-shot events on the control channel", () => {
    for (const name of ["param-change", "connection", "cache-invalidated"]) {
      expect(topics[name].channel, name).to.equal("control");
    }
  });

  describe("over the hub", () => {
    const token = "live-topics-token";
    let bus: EventBus;
    let hub: WsHub;
    let server: http.Server;
    let port: number;
    let ticket: () => string;
    const sockets: TestSocket[] = [];

    beforeEach(async () => {
      const auth = createAuthMiddleware(token);
      ticket = () => auth.issueStreamTicket(token);
      bus = new EventBus();
      hub = new WsHub({ plugins: [{ id: "wing", liveTopics: () => wingLiveTopics() } as unknown as McpPlugin], eventBus: bus, auth });
      server = http.createServer();
      server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
      await Promise.all(sockets.splice(0).map((s) => s.close()));
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const openStream = async () => {
      const socket = await openSocket(port, { ticket: ticket(), protocol: "wing.stream.v1.msgpack" });
      sockets.push(socket);
      await socket.next((m) => m.t === "hello");
      return socket;
    };

    it("delivers the RTA and a single strip's meters, decodable by the dashboard", async () => {
      const socket = await openStream();
      socket.send({ t: "sub", id: 1, topic: "wing:rta" });
      socket.send({ t: "sub", id: 2, topic: "wing:meters", params: { strips: [{ type: "bus", index: 4 }] } });
      await socket.next((m) => m.t === "ack" && m.id === 1);
      const ack = (await socket.next((m) => m.t === "ack" && m.id === 2)).data as MetersAck;

      const snapshot = fullSnapshot();
      bus.publish({ pluginId: "wing", type: "meters", payload: snapshot, timestamp: 1 });
      bus.publish({ pluginId: "wing", type: "rta", payload: { bandsDb: [-50, -40], receivedAt: 5 }, timestamp: 2 });

      const meters = await socket.next((m) => m.t === "evt" && m.topic === "wing:meters");
      expect(decodeMeterFrames(meters.data as MetersWireFrame, ack).map((r) => [r.type, r.index])).to.deep.equal([["bus", 4]]);
      const rta = await socket.next((m) => m.t === "evt" && m.topic === "wing:rta");
      expect(Array.from(decodeRtaBands(rta.data as RtaWireFrame))).to.deep.equal([-50, -40]);
    });

    it("keeps the event loop responsive while streaming 20 Hz RTA and 10 Hz meters to 10 clients", async function () {
      this.timeout(10_000);
      const clients = await Promise.all(Array.from({ length: 10 }, () => openStream()));
      for (const client of clients) {
        client.send({ t: "sub", id: 1, topic: "wing:rta" });
        client.send({ t: "sub", id: 2, topic: "wing:meters", params: { strips: "all" } });
      }
      await Promise.all(clients.map((c) => c.next((m) => m.t === "ack" && m.id === 2)));

      const histogram = monitorEventLoopDelay({ resolution: 1 });
      histogram.enable();
      const snapshot = fullSnapshot();
      const rta = { bandsDb: (snapshot.frames.at(-1) as { bands_dB: number[] }).bands_dB, receivedAt: 0 };
      const rtaTimer = setInterval(() => bus.publish({ pluginId: "wing", type: "rta", payload: rta, timestamp: Date.now() }), 50);
      const metersTimer = setInterval(() => bus.publish({ pluginId: "wing", type: "meters", payload: snapshot, timestamp: Date.now() }), 100);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      clearInterval(rtaTimer);
      clearInterval(metersTimer);
      histogram.disable();

      const received = clients[0].received.filter((m) => m.t === "evt").length;
      expect(received).to.be.greaterThan(40);
      const p99Ms = histogram.percentile(99) / 1e6;
      expect(p99Ms, `event-loop delay p99 ${p99Ms.toFixed(1)} ms`).to.be.below(25);
    });
  });
});
