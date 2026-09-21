// Covers the late-reply race in WingOscClient's request queue: a request that times out is
// rejected and its successor promoted immediately, but the console's reply may have been merely
// slow rather than lost. Correlation is by OSC address alone, so that late reply would otherwise
// satisfy the *next* request's matcher. bulkSet is the acute case — its matcher is the catch-all
// "/*" ack, so any late ack matches any pending bulk-set.
//
// WingMockServer always answers immediately, which is exactly what these tests must not do, so
// they drive a scriptable stand-in that replies only when told to.

import { expect } from "chai";
import osc from "osc";
import type { OscArgument, OscMessage, OscRemoteInfo, UDPPort } from "osc";
import { WingTimeoutError } from "../../../src/plugins/wing/wing-errors.js";
import { WingOscClient } from "../../../src/plugins/wing/wing-osc-client.js";

/** Records what the client sends and replies only on demand. */
class ScriptableConsole {
  private port: UDPPort | null = null;
  private lastFrom: { address: string; port: number } | null = null;
  readonly received: string[] = [];

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const port = new osc.UDPPort({ localAddress: "127.0.0.1", localPort: 0, metadata: true });
      port.once("ready", () => {
        this.port = port;
        port.on("message", (message: OscMessage, _timeTag: unknown, info: OscRemoteInfo) => {
          this.lastFrom = { address: info.address, port: info.port };
          this.received.push(message.address);
        });
        port.on("error", () => undefined);
        resolve(port.socket?.address().port ?? 0);
      });
      port.once("error", reject);
      port.open();
    });
  }

  reply(address: string, args: OscArgument[]): void {
    if (!this.port || !this.lastFrom) {
      throw new Error("ScriptableConsole has not received anything to reply to yet");
    }
    this.port.send({ address, args }, this.lastFrom.address, this.lastFrom.port);
  }

  ackBulkSet(status: string): void {
    this.reply("/*", [{ type: "s", value: status }]);
  }

  stop(): void {
    this.port?.close();
    this.port = null;
  }
}

/** Polls instead of sleeping a fixed amount, so the assertion never depends on a guessed delay. */
async function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

describe("WingOscClient late replies (a reply that arrives after its request timed out)", () => {
  const REQUEST_TIMEOUT_MS = 120;
  let fakeConsole: ScriptableConsole;
  let client: WingOscClient;

  beforeEach(async () => {
    fakeConsole = new ScriptableConsole();
    const port = await fakeConsole.start();
    client = new WingOscClient({ host: "127.0.0.1", port, requestTimeoutMs: REQUEST_TIMEOUT_MS });
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    fakeConsole.stop();
  });

  it("does not let a timed-out bulkSet's late ack resolve the next bulkSet", async () => {
    // First write: the console never answers in time, so it must reject.
    const first = client.bulkSet("/ch/1", { fdr: -10 });
    await waitFor(() => fakeConsole.received.length === 1);
    expect(await expectRejection(first)).to.be.instanceOf(WingTimeoutError);

    // Second write, now at the head of the queue.
    const second = client.bulkSet("/ch/2", { fdr: -20 });
    await waitFor(() => fakeConsole.received.length === 2);

    // The first write's ack finally shows up. Matching by address alone, it fits the second
    // write's "/*" matcher perfectly — this is the packet that used to resolve the wrong request.
    fakeConsole.ackBulkSet("NODE NOT FOUND");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Only now does the second write's own ack arrive.
    fakeConsole.ackBulkSet("OK");

    expect(await second).to.deep.equal({ status: "OK", ok: true, raw: "OK" });
  });

  it("still resolves a get() from the first reply after an earlier get() on the same path timed out", async () => {
    // Reads deliberately opt out of the swallowing above: a GET reply is the parameter's current
    // value whoever asked for it, so treating the first reply after a timeout as stale would break
    // the first read after a console restart for no gain. This pins that asymmetry.
    const first = client.get("/ch/1/fdr");
    await waitFor(() => fakeConsole.received.length === 1);
    expect(await expectRejection(first)).to.be.instanceOf(WingTimeoutError);

    const second = client.get("/ch/1/fdr");
    await waitFor(() => fakeConsole.received.length === 2);

    // A ",sff" leaf is (display, normalized raw, actual value) — parseOscGetReply, wing-value-codec.ts.
    fakeConsole.reply("/ch/1/fdr", [
      { type: "s", value: "-6.0 dB" },
      { type: "f", value: 0.5 },
      { type: "f", value: -6 },
    ]);

    const result = await second;
    if (result.kind !== "leaf") throw new Error("expected a leaf result");
    expect(result.value).to.equal(-6);
  });

  it("swallows only one late reply per timed-out request", async () => {
    const first = client.bulkSet("/ch/1", { fdr: -10 });
    await waitFor(() => fakeConsole.received.length === 1);
    await expectRejection(first);

    const second = client.bulkSet("/ch/2", { fdr: -20 });
    await waitFor(() => fakeConsole.received.length === 2);

    // One abandoned request means exactly one ack is swallowed; the next one is the live
    // request's own and must resolve it.
    fakeConsole.ackBulkSet("NODE NOT FOUND");
    await new Promise((resolve) => setTimeout(resolve, 20));
    fakeConsole.ackBulkSet("VALUE ERROR");

    const result = await second;
    expect(result.status).to.equal("VALUE ERROR");
    expect(result.ok).to.equal(false);
  });

  it("stops swallowing once the grace period has passed", async () => {
    const first = client.bulkSet("/ch/1", { fdr: -10 });
    await waitFor(() => fakeConsole.received.length === 1);
    await expectRejection(first);

    // The grace period is 2x requestTimeoutMs; wait it out so the abandoned entry expires.
    await new Promise((resolve) => setTimeout(resolve, REQUEST_TIMEOUT_MS * 2 + 60));

    const second = client.bulkSet("/ch/2", { fdr: -20 });
    await waitFor(() => fakeConsole.received.length === 2);
    fakeConsole.ackBulkSet("OK");

    expect(await second).to.deep.equal({ status: "OK", ok: true, raw: "OK" });
  });
});
