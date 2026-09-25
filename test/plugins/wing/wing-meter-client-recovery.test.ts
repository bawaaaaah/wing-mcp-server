// Three latent defects on the metering path, none of which had any coverage.
//
// Not covered here: doConnect() used to dereference `this.tcpSocket!` right after connectTcp()
// resolved, which throws an opaque TypeError if the console accepts the connection and resets it
// immediately — the exact case RECONNECT_STABLE_AFTER_MS documents. It now throws a named
// connection error instead. Reproducing that window reliably needs the "close" event to land
// between two microtasks, and a test that races is worse than none, so the fix is defensive only.

import { expect } from "chai";
import type dgram from "node:dgram";
import { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import { WingChannelDemuxer } from "../../../src/plugins/wing/wing-meter-protocol.js";
import { WingMeterSimulator } from "./wing-meter-simulator.js";

async function waitFor(condition: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

let nextUdpListenPort = 26400 + Math.floor(Math.random() * 2000);

describe("WingMeterClient recovery paths", () => {
  let simulator: WingMeterSimulator;
  let client: WingMeterClient | null = null;

  beforeEach(() => {
    simulator = new WingMeterSimulator({ keepaliveTimeoutMs: 2000, meterIntervalMs: 25 });
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
    await simulator.stop();
  });

  async function connectedClient(): Promise<WingMeterClient> {
    const { tcpPort } = await simulator.start();
    const created = new WingMeterClient({
      host: "127.0.0.1",
      tcpPort,
      udpListenPort: nextUdpListenPort++,
      keepaliveIntervalMs: 200,
    });
    // An unhandled "error" event on an EventEmitter throws; these tests provoke one on purpose.
    created.on("error", () => undefined);
    client = created;
    await created.connect();
    return created;
  }

  it("announces a fresh report id on every subscribe", async () => {
    // The id is the only thing separating a packet from the previous subscription from one that
    // belongs to the current `flattenedGroups`. Decoding is positional, so a stale packet read
    // against a new collection yields plausible levels attributed to the wrong strips.
    // handleUdpMessage() has always filtered on it — but the id never changed, so it never fired.
    const meter = await connectedClient();

    await meter.subscribe([{ type: "channel", indices: [1, 2] }]);
    await waitFor(() => simulator.currentReportId !== null);
    const first = simulator.currentReportId;

    await meter.subscribe([{ type: "channel", indices: [3, 4, 5] }]);
    await waitFor(() => simulator.currentReportId !== first);

    expect(first).to.be.a("number");
    expect(simulator.currentReportId).to.be.a("number").and.not.equal(first);
  });

  it("recovers from a UDP socket error instead of going quietly deaf", async () => {
    // bindUdpSocket() short-circuits whenever udpSocket is non-null, so a socket left dead after a
    // post-bind error was treated as valid forever: TCP up, status "connected", health HEALTHY,
    // and not one further meter frame. The error is emitted on the real socket, through the real
    // handler, exactly as Node would deliver it.
    const meter = await connectedClient();
    await meter.subscribe([{ type: "channel", indices: [1] }]);

    const statuses: string[] = [];
    meter.on("status", (status: string) => statuses.push(status));

    const socket = (meter as unknown as { udpSocket: dgram.Socket | null }).udpSocket;
    expect(socket, "the client should hold a bound UDP socket once connected").to.not.equal(null);
    socket?.emit("error", new Error("simulated ICMP storm"));

    // It must not stay silently "connected": the dead socket is dropped and recovery runs.
    await waitFor(() => statuses.includes("disconnected") || statuses.includes("reconnecting"));
    expect((meter as unknown as { udpSocket: dgram.Socket | null }).udpSocket).to.equal(null);

    // And it actually comes back, re-binding the listen port on the way.
    await waitFor(() => statuses.includes("connected"), 8000);
  });
});

describe("WingChannelDemuxer.reset", () => {
  it("drops a half-consumed escape sequence so the next stream starts clean", () => {
    const demuxer = new WingChannelDemuxer();
    const bytes: { channel: number; byte: number }[] = [];
    const collect = (channel: number, byte: number): void => {
      bytes.push({ channel, byte });
    };

    // A connection that drops mid-escape leaves the demuxer expecting the escape's second byte.
    demuxer.feed(Buffer.from([0xdf]), collect);
    expect(bytes).to.deep.equal([]);

    demuxer.reset();

    // Without the reset, this first byte of the new connection would be eaten as a channel
    // selector instead of being delivered as data.
    demuxer.feed(Buffer.from([0x41]), collect);
    expect(bytes).to.deep.equal([{ channel: 0, byte: 0x41 }]);
  });

  it("clears the selected channel as well", () => {
    const demuxer = new WingChannelDemuxer();
    const seen: number[] = [];
    // 0xdf <selector> switches channel; anything after lands on it.
    demuxer.feed(Buffer.from([0xdf, 0xd3, 0x41]), (channel) => seen.push(channel));
    expect(seen).to.have.lengthOf(1);
    const selected = seen[0] as number;
    expect(selected).to.not.equal(0);

    demuxer.reset();
    demuxer.feed(Buffer.from([0x42]), (channel) => seen.push(channel));
    expect(seen[1], "a reset stream starts back on channel 0").to.equal(0);
  });
});
