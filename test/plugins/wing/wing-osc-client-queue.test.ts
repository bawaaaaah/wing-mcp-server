// WingOscClient arms a request's timeout in activateHead(), i.e. when the entry reaches the head
// of the FIFO queue — not when it is enqueued. So a queued request had no deadline of its own at
// all: behind a full queue against an unresponsive console, an entry could wait
// maxQueueLength * requestTimeoutMs before its own clock even started. These tests pin the
// separate queue-wait deadline that bounds it.

import { expect } from "chai";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { WingTimeoutError } from "../../../src/plugins/wing/wing-errors.js";
import { WingOscClient } from "../../../src/plugins/wing/wing-osc-client.js";

/** Binds a UDP socket, immediately closes it, and returns the (now-free, nobody-listening) port. */
async function getClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = dgram.createSocket("udp4");
    probe.once("error", reject);
    probe.bind(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function settle(promise: Promise<unknown>): Promise<{ ok: boolean; error?: unknown; ms: number }> {
  const start = Date.now();
  try {
    await promise;
    return { ok: true, ms: Date.now() - start };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - start };
  }
}

describe("WingOscClient queue-wait deadline (nothing ever answers)", () => {
  const REQUEST_TIMEOUT_MS = 400;
  const MAX_QUEUE_WAIT_MS = 100;
  let client: WingOscClient;

  beforeEach(async () => {
    client = new WingOscClient({
      host: "127.0.0.1",
      port: await getClosedPort(),
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxQueueWaitMs: MAX_QUEUE_WAIT_MS,
    });
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
  });

  it("rejects a queued request that never gets sent, well before the head's own timeout", async () => {
    // The first request occupies the head for REQUEST_TIMEOUT_MS; the second only ever waits.
    const head = settle(client.get("/ch/1/fdr"));
    const queued = settle(client.get("/ch/2/fdr"));

    const queuedResult = await queued;
    expect(queuedResult.ok).to.equal(false);
    expect(queuedResult.error).to.be.instanceOf(WingTimeoutError);
    expect((queuedResult.error as Error).message).to.include("in the queue without being sent");
    // It must give up on its own schedule, not inherit the head's.
    expect(queuedResult.ms).to.be.lessThan(REQUEST_TIMEOUT_MS);

    const headResult = await head;
    expect(headResult.ok).to.equal(false);
    expect(headResult.error).to.be.instanceOf(WingTimeoutError);
    expect((headResult.error as Error).message).to.include("timed out after");
  });

  it("does not apply the queue deadline to a request that goes straight to the head", async () => {
    // Nothing is ahead of it, so it is sent immediately and gets the full request timeout — the
    // queue deadline, shorter here, must not cut it short.
    const result = await settle(client.get("/ch/1/fdr"));
    expect(result.ok).to.equal(false);
    expect((result.error as Error).message).to.include("timed out after");
    expect(result.ms).to.be.at.least(REQUEST_TIMEOUT_MS - 50);
  });

  it("still serves a request that reaches the head within the queue deadline", async () => {
    const forgiving = new WingOscClient({
      host: "127.0.0.1",
      port: await getClosedPort(),
      requestTimeoutMs: 80,
      maxQueueWaitMs: 5000,
    });
    await forgiving.connect();
    try {
      // Both fail on their own request timeout, not on the queue deadline: the second one waits
      // ~80ms for the first, comfortably inside its 5s queue budget.
      const results = await Promise.all([settle(forgiving.get("/ch/1/fdr")), settle(forgiving.get("/ch/2/fdr"))]);
      for (const result of results) {
        expect(result.ok).to.equal(false);
        expect((result.error as Error).message).to.include("timed out after");
      }
    } finally {
      await forgiving.close();
    }
  });
});
