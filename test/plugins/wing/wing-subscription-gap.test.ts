// A `/*S` subscription is kept alive by re-sending the same command on a timer, so a missed
// renewal repairs itself on the next tick. The *state* does not: every change pushed while the
// console-side subscription was dead is lost, nothing ever overwrites it (a name is only re-pushed
// on an actual rename), and the heartbeat keeps health reporting green throughout. Node coalesces
// the ticks an interval misses, so a stall longer than the console's inactivity timeout is enough
// — and none of this had any coverage.

import { expect } from "chai";
import { WingOscClient, type WingSubscriptionGap } from "../../../src/plugins/wing/wing-osc-client.js";
import { WingMockServer } from "./wing-mock-server.js";

async function waitFor(condition: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Blocks the event loop for real, which is the whole point: a fake timer would move the clock
 * without ever making `setInterval` coalesce, and coalescing is the mechanism under test.
 */
function stallEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* deliberately busy */
  }
}

describe("WingOscClient subscription renewal gaps", () => {
  let mockServer: WingMockServer;
  let client: WingOscClient;

  beforeEach(async () => {
    mockServer = new WingMockServer({ subscriptionInactivityTimeoutMs: 5000 });
    const { oscPort } = await mockServer.start();
    client = new WingOscClient({
      host: "127.0.0.1",
      port: oscPort,
      requestTimeoutMs: 500,
      subscriptionRenewalIntervalMs: 40,
      // Scaled down from the console's real 10s, the same way the mock's own window is.
      subscriptionInactivityTimeoutMs: 120,
    });
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await mockServer.stop();
  });

  it("reports a gap when renewals fall further apart than the console tolerates", async () => {
    const gaps: WingSubscriptionGap[] = [];
    const handle = client.subscribe("/*S");
    handle.on("renewal-gap", (gap) => gaps.push(gap));

    try {
      // Long enough that the 40ms interval cannot have kept up: Node collapses the missed ticks
      // into one, which is exactly how a real stall kills the console-side subscription silently.
      stallEventLoop(300);
      await waitFor(() => gaps.length > 0);

      const [gap] = gaps;
      expect(gap?.gapMs).to.be.greaterThan(120);
      expect(gap?.inactivityTimeoutMs).to.equal(120);
    } finally {
      handle.close();
    }
  });

  it("stays quiet while renewals keep up", async () => {
    const gaps: WingSubscriptionGap[] = [];
    const handle = client.subscribe("/*S");
    handle.on("renewal-gap", (gap) => gaps.push(gap));

    try {
      // Several renewal intervals of ordinary, unblocked operation.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(gaps, "a healthy subscription must not report gaps").to.deep.equal([]);
    } finally {
      handle.close();
    }
  });

  it("stops reporting once the handle is closed", async () => {
    const gaps: WingSubscriptionGap[] = [];
    const handle = client.subscribe("/*S");
    handle.on("renewal-gap", (gap) => gaps.push(gap));
    handle.close();

    stallEventLoop(300);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gaps).to.deep.equal([]);
  });
});
