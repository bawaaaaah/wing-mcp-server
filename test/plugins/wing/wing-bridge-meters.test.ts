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

  it("keeps several subscriptions of one tablet apart, one per report id (strips and RTA)", async () => {
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    sockets.push(socket);
    const byId = new Map<number, number[]>();
    socket.on("message", (msg: Buffer) => {
      const id = msg.readUInt32BE(0);
      byId.set(id, [...(byId.get(id) ?? []), msg.length]);
    });
    const session = meters.createSession({ address: "127.0.0.1", port: 50001 });
    const feed = (bytes: Buffer) => bytes.forEach((b) => session.feedByte(b));
    feed(encodeUdpPortAnnouncement(socket.address().port));
    feed(encodeReportId(1));
    feed(encodeMeterCollection([{ type: "channel", indices: [1] }]));
    feed(encodeReportId(2));
    feed(encodeMeterCollection([{ type: "rta" }]));
    // Renewed in turn, as an app does: neither replaces the other.
    const renew = setInterval(() => {
      feed(encodeReportId(1));
      feed(encodeReportId(2));
    }, 100);
    try {
      await waitFor(() => (byId.get(1)?.length ?? 0) > 3 && (byId.get(2)?.length ?? 0) > 3, 3000, "both subscriptions stream");
      expect(new Set(byId.get(1))).to.deep.equal(new Set([4 + 8 * 2]));
      expect(new Set(byId.get(2))).to.deep.equal(new Set([4 + 120 * 2]));
    } finally {
      clearInterval(renew);
    }
  });

  it("cuts the RTA right after sources sized by their I/O group (WING Edit's RTA view)", async () => {
    client.setIoSizes({ source: [24, 8, 48], output: [] });
    const frames: Buffer[] = [];
    client.on("frame", (frame: { packet: Buffer; layout: ReadonlyMap<string, { offset: number }> }) => {
      const rta = frame.layout.get("rta");
      if (rta) frames.push(frame.packet.subarray(4 + rta.offset * 2, 4 + (rta.offset + 120) * 2));
    });
    // As WING Edit asks: strips, sources, then the RTA last.
    const a = await tablet(meters, 30, [{ type: "channel", indices: [1] }, { type: "source", indices: [1, 3] }, { type: "rta" }]);
    sockets.push(a.socket);
    await waitFor(() => a.packets.length > 2 && frames.length > 2, 3000, "packets with the RTA");
    const packet = a.packets[a.packets.length - 1];
    expect(packet.length).to.equal(4 + (8 + 24 + 48 + 120) * 2);
    const rtaInTablet = packet.subarray(4 + (8 + 24 + 48) * 2).toString("hex");
    expect(frames.map((f) => f.toString("hex"))).to.include(rtaInTablet);
  });

  it("sends nothing for a subscription it cannot size yet, rather than a shifted packet", async () => {
    const a = await tablet(meters, 31, [{ type: "source", indices: [1] }, { type: "rta" }]);
    sockets.push(a.socket);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.packets).to.deep.equal([]);
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
