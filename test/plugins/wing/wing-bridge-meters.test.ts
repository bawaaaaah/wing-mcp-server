import { expect } from "chai";
import dgram from "node:dgram";
import { WingBridgeMeters } from "../../../src/plugins/wing/wing-bridge-meters.js";
import { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import { encodeMeterCollection, encodeReportId, encodeUdpPortAnnouncement } from "../../../src/plugins/wing/wing-meter-protocol.js";
import type { MeterRequest } from "../../../src/plugins/wing/wing-meter-types.js";
import { WingMeterSimulator } from "./wing-meter-simulator.js";

async function waitFor(condition: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: ${what} not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A tablet's meter side: a UDP socket to receive on, and the channel-3 bytes it would send. */
async function tablet(meters: WingBridgeMeters, reportId: number, requests: MeterRequest[]) {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  const packets: Buffer[] = [];
  socket.on("message", (msg) => packets.push(msg));
  const session = meters.createSession({ address: "127.0.0.1", port: 50000 });
  const feed = (bytes: Buffer) => bytes.forEach((b) => session.feedByte(b));
  feed(encodeUdpPortAnnouncement(socket.address().port));
  feed(encodeReportId(reportId));
  feed(encodeMeterCollection(requests));
  return { socket, packets, session, keepalive: () => feed(encodeReportId(reportId)) };
}

describe("WingBridgeMeters (tablet meters from the server's own subscription)", () => {
  let simulator: WingMeterSimulator;
  let client: WingMeterClient;
  let meters: WingBridgeMeters;
  const sockets: dgram.Socket[] = [];

  beforeEach(async () => {
    simulator = new WingMeterSimulator({ keepaliveTimeoutMs: 5000, meterIntervalMs: 30 });
    const { tcpPort } = await simulator.start();
    client = new WingMeterClient({ host: "127.0.0.1", tcpPort, udpListenPort: 26000 + Math.floor(Math.random() * 3000), keepaliveIntervalMs: 100 });
    client.on("error", () => undefined);
    await client.connect();
    await client.subscribe([{ type: "channel", indices: [1, 2] }]);
    meters = new WingBridgeMeters({ addDebounceMs: 10, removeDebounceMs: 10, keepaliveTimeoutMs: 400 });
    meters.attachMeterClient(client);
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    meters.close();
    await client.disconnect();
    await simulator.stop();
  });

  it("sends each tablet its own packet: its report id, its groups in its order", async () => {
    const a = await tablet(meters, 0xa0a0a0a0, [{ type: "dca", indices: [2] }, { type: "channel", indices: [2] }]);
    const b = await tablet(meters, 0xb0b0b0b0, [{ type: "rta" }]);
    sockets.push(a.socket, b.socket);

    await waitFor(() => a.packets.length > 0 && b.packets.length > 0, 3000, "both tablets receive");
    const pa = a.packets[a.packets.length - 1];
    const pb = b.packets[b.packets.length - 1];
    expect(pa.readUInt32BE(0)).to.equal(0xa0a0a0a0);
    expect(pa.length).to.equal(4 + (4 + 8) * 2);
    expect(pb.readUInt32BE(0)).to.equal(0xb0b0b0b0);
    expect(pb.length).to.equal(4 + 120 * 2);
    // The base subscription is kept; only what tablets lack was added after it.
    expect(client.getSubscribedGroups()).to.deep.equal([
      { type: "channel", index: 1 },
      { type: "channel", index: 2 },
      { type: "dca", index: 2 },
      { type: "rta" },
    ]);
  });

  it("copies the console's words for a group the base already has", async () => {
    const frames: Buffer[] = [];
    client.on("frame", (frame: { packet: Buffer }) => frames.push(frame.packet));
    const a = await tablet(meters, 7, [{ type: "channel", indices: [2] }]);
    sockets.push(a.socket);
    await waitFor(() => a.packets.length > 2 && frames.length > 2);
    // channel 2 is the second base group: words 8..15 of the console's packet.
    const consoleWords = frames.map((f) => f.subarray(4 + 8 * 2, 4 + 16 * 2).toString("hex"));
    const tabletWords = a.packets.map((p) => p.subarray(4).toString("hex"));
    expect(consoleWords).to.include(tabletWords[tabletWords.length - 1]);
  });

  it("stops a tablet's stream when its keepalive lapses, and drops its extra groups when it leaves", async () => {
    const a = await tablet(meters, 9, [{ type: "bus", indices: [4] }]);
    sockets.push(a.socket);
    await waitFor(() => a.packets.length > 0);
    await waitFor(() => meters.getStatus().streaming === 0, 2000, "stream stopped after the keepalive lapsed");
    const count = a.packets.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(a.packets.length - count).to.be.at.most(1);

    a.keepalive();
    await waitFor(() => meters.getStatus().streaming === 1, 1000, "resumed on keepalive");

    a.session.close();
    await waitFor(() => client.getSubscribedGroups().length === 2, 2000, "extra groups dropped");
  });
});
