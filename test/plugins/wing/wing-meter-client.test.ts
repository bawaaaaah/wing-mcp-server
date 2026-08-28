import { expect } from "chai";
import { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import { WingMeterSimulator } from "./wing-meter-simulator.js";
import type { MeterSnapshot } from "../../../src/plugins/wing/wing-meter-types.js";

/** Polls `condition` until it's true or `timeoutMs` elapses (then throws) — no raw sleeps in assertions. */
async function waitFor(condition: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Spread test UDP listen ports out to avoid collisions between the tests in this file (each test
// picks its own fixed-but-unique port rather than relying on the ephemeral port 0, since the real
// WingMeterClient announces the *configured* udpListenPort to the console, not whatever the OS
// happens to assign).
let nextUdpListenPort = 25170 + Math.floor(Math.random() * 3000);
function allocateUdpListenPort(): number {
  return nextUdpListenPort++;
}

describe("WingMeterClient (real WingMeterClient vs real WingMeterSimulator, loopback)", () => {
  let simulator: WingMeterSimulator;
  let client: WingMeterClient | null = null;
  let tcpPort: number;

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
    await simulator.stop();
  });

  function makeClient(opts?: { keepaliveIntervalMs?: number }): WingMeterClient {
    const c = new WingMeterClient({
      host: "127.0.0.1",
      tcpPort,
      udpListenPort: allocateUdpListenPort(),
      keepaliveIntervalMs: opts?.keepaliveIntervalMs ?? 100,
    });
    // Errors are expected transiently around teardown (destroyed sockets) — never let them crash
    // the test process via Node's default "unhandled 'error' event" behavior.
    c.on("error", () => {
      /* swallowed in tests */
    });
    client = c;
    return c;
  }

  it("connect() + subscribe() eventually emits a snapshot whose frames match the requested groups", async () => {
    simulator = new WingMeterSimulator({ keepaliveTimeoutMs: 5000 });
    ({ tcpPort } = await simulator.start());

    const c = makeClient();
    const snapshots: MeterSnapshot[] = [];
    c.on("snapshot", (snapshot: MeterSnapshot) => snapshots.push(snapshot));

    await c.connect();
    await c.subscribe([
      { type: "channel", indices: [1, 2] },
      { type: "dca", indices: [3] },
    ]);

    await waitFor(() => snapshots.length > 0);

    const snapshot = snapshots[0];
    expect(snapshot.frames).to.have.length(3);

    expect(snapshot.frames[0].type).to.equal("channel");
    expect(snapshot.frames[1].type).to.equal("channel");
    expect(snapshot.frames[2].type).to.equal("dca");

    const [channelFrame1, channelFrame2, dcaFrame] = snapshot.frames;
    if (channelFrame1.type === "channel" && channelFrame2.type === "channel") {
      expect(channelFrame1.index).to.equal(1);
      expect(channelFrame2.index).to.equal(2);
      expect(channelFrame1.inputL_dB).to.be.a("number");
      expect(channelFrame1.gateGain_dB).to.be.a("number");
    } else {
      throw new Error("expected the first two frames to be channel frames");
    }
    if (dcaFrame.type === "dca") {
      expect(dcaFrame.index).to.equal(3);
      expect(dcaFrame.preFaderL_dB).to.be.a("number");
      expect(dcaFrame.postFaderR_dB).to.be.a("number");
    } else {
      throw new Error("expected the third frame to be a dca frame");
    }
  });

  it("emits a raw event with the exact UDP bytes received, for wing-osc-mirror.ts to tap", async () => {
    simulator = new WingMeterSimulator({ keepaliveTimeoutMs: 5000 });
    ({ tcpPort } = await simulator.start());

    const c = makeClient();
    const rawPackets: Buffer[] = [];
    c.on("raw", (buf: Buffer) => rawPackets.push(buf));
    const snapshots: MeterSnapshot[] = [];
    c.on("snapshot", (snapshot: MeterSnapshot) => snapshots.push(snapshot));

    await c.connect();
    await c.subscribe([{ type: "channel", indices: [1] }]);

    await waitFor(() => snapshots.length > 0);
    expect(rawPackets.length).to.be.greaterThan(0);
    expect(Buffer.isBuffer(rawPackets[0])).to.equal(true);
  });

  it("keepalive renewal keeps snapshots flowing past the simulator's short keepalive-timeout window", async () => {
    simulator = new WingMeterSimulator({ keepaliveTimeoutMs: 250, meterIntervalMs: 30 });
    ({ tcpPort } = await simulator.start());

    const c = makeClient({ keepaliveIntervalMs: 80 });
    let snapshotCount = 0;
    c.on("snapshot", () => {
      snapshotCount += 1;
    });

    await c.connect();
    await c.subscribe([{ type: "bus", indices: [1] }]);

    await waitFor(() => snapshotCount > 0);
    const countAfterFirstSnapshot = snapshotCount;

    // Wait well past the simulator's 250ms keepalive-timeout window. If the client's periodic
    // keepalive (every 80ms) weren't renewing the subscription, the simulator would stop the UDP
    // stream and this count would stall.
    await sleep(900);

    expect(simulator.receivedKeepalives).to.be.greaterThan(1);
    expect(snapshotCount).to.be.greaterThan(countAfterFirstSnapshot);
  });

  it("automatically reconnects and resubscribes after the console drops the TCP connection", async () => {
    simulator = new WingMeterSimulator({ keepaliveTimeoutMs: 5000, meterIntervalMs: 30 });
    ({ tcpPort } = await simulator.start());

    const c = makeClient();
    const statuses: string[] = [];
    c.on("status", (status: string) => statuses.push(status));
    let snapshotCount = 0;
    c.on("snapshot", () => {
      snapshotCount += 1;
    });

    await c.connect();
    await c.subscribe([{ type: "bus", indices: [1] }]);
    await waitFor(() => snapshotCount > 0);

    // Simulate the console dropping the connection (reboot, network blip, cable pull, ...) —
    // nothing in this test tells the client to reconnect; that has to happen entirely on its own.
    simulator.forceDisconnect();
    await waitFor(() => statuses.includes("disconnected"));

    const countAtDrop = snapshotCount;
    await sleep(200);
    expect(snapshotCount).to.equal(countAtDrop); // proves the stream genuinely stopped, not a fluke

    await waitFor(() => statuses.includes("reconnecting"), 5000);
    await waitFor(() => snapshotCount > countAtDrop, 8000); // reconnect + full re-handshake + resubscribe

    expect(statuses[0]).to.equal("connected");
    expect(statuses[statuses.length - 1]).to.equal("connected");
    expect(statuses).to.include("disconnected");
    expect(statuses).to.include("reconnecting");
  });

  it("disconnect() resolves promptly even when called during the disconnected/reconnecting window after an unexpected drop", async () => {
    simulator = new WingMeterSimulator({ keepaliveTimeoutMs: 5000, meterIntervalMs: 30 });
    ({ tcpPort } = await simulator.start());

    const c = makeClient();
    const statuses: string[] = [];
    c.on("status", (status: string) => statuses.push(status));
    let snapshotCount = 0;
    c.on("snapshot", () => {
      snapshotCount += 1;
    });

    await c.connect();
    await c.subscribe([{ type: "bus", indices: [1] }]);
    await waitFor(() => snapshotCount > 0);

    // Regression test: an unexpected disconnect used to leave `tcpSocket` pointing at the
    // already-closed socket (handleTcpClosed never cleared it), so calling disconnect() during the
    // "disconnected"/reconnecting window would await a "close" event that Node never re-emits for an
    // already-destroyed socket — hanging forever.
    simulator.forceDisconnect();
    await waitFor(() => statuses.includes("disconnected"));

    const timedOut = await Promise.race([c.disconnect().then(() => false), sleep(2000).then(() => true)]);
    expect(timedOut, "disconnect() hung instead of resolving").to.equal(false);
    client = null; // already disconnected — afterEach shouldn't disconnect it again
  });

  it("disconnect() stops further snapshot events cleanly", async () => {
    simulator = new WingMeterSimulator({ keepaliveTimeoutMs: 5000, meterIntervalMs: 30 });
    ({ tcpPort } = await simulator.start());

    const c = makeClient();
    let snapshotCount = 0;
    c.on("snapshot", () => {
      snapshotCount += 1;
    });

    await c.connect();
    await c.subscribe([{ type: "main", indices: [1] }]);
    await waitFor(() => snapshotCount > 0);

    await c.disconnect();
    client = null; // already disconnected — afterEach shouldn't disconnect it again
    const countAtDisconnect = snapshotCount;

    await sleep(400);
    expect(snapshotCount).to.equal(countAtDisconnect);
  });
});
