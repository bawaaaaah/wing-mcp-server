import { expect } from "chai";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { WingTimeoutError } from "../../../src/plugins/wing/wing-errors.js";
import {
  WingOscClient,
  type WingBranchResult,
  type WingParamChange,
} from "../../../src/plugins/wing/wing-osc-client.js";
import { WingMockServer } from "./wing-mock-server.js";

/** Polls `condition` instead of sleeping a fixed amount, for asserting async event arrival. */
async function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

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

describe("WingOscClient (against a real WingMockServer over loopback UDP)", () => {
  let mockServer: WingMockServer;
  let client: WingOscClient;

  beforeEach(async () => {
    // A short inactivity timeout lets the subscription-renewal test prove
    // the client's renewal loop (not just luck/slack) keeps the
    // subscription alive, without the test itself waiting anywhere close to
    // the real console's 10s window.
    mockServer = new WingMockServer({ subscriptionInactivityTimeoutMs: 300 });
    const { oscPort } = await mockServer.start();

    client = new WingOscClient({
      host: "127.0.0.1",
      port: oscPort,
      requestTimeoutMs: 500,
      subscriptionRenewalIntervalMs: 100,
    });
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await mockServer.stop();
  });

  describe("get()", () => {
    it("returns a parsed float leaf value", async () => {
      const result = await client.get("/ch/1/fdr");
      expect(result.kind).to.equal("leaf");
      if (result.kind !== "leaf") throw new Error("expected a leaf result");
      expect(result.valueKind).to.equal("float");
      expect(result.value).to.equal(-6);
    });

    it("returns a parsed int leaf value", async () => {
      const result = await client.get("/ch/1/mute");
      expect(result.kind).to.equal("leaf");
      if (result.kind !== "leaf") throw new Error("expected a leaf result");
      expect(result.valueKind).to.equal("int");
      expect(result.value).to.equal(0);
    });

    it("returns a branch listing for a non-leaf node", async () => {
      const result = await client.get("/");
      expect(result.kind).to.equal("branch");
      const branch = result as WingBranchResult;
      expect(branch.children).to.include.members(["ch", "bus", "dca", "mgrp"]);
    });

    it("times out when the address does not resolve to any node (no reply at all)", async () => {
      let error: unknown;
      try {
        await client.get("/does/not/exist");
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(WingTimeoutError);
    });
  });

  describe("dump()", () => {
    it("returns a flat, best-effort-coerced object for a channel subtree", async () => {
      const result = await client.dump("/ch/1");
      expect(result).to.deep.equal({ name: "Kick", mute: 0, fdr: -6, pan: 0 });
    });
  });

  describe("bulkSet()", () => {
    it("applies the assignments and acks OK", async () => {
      const result = await client.bulkSet("/ch/1", { fdr: -10, mute: 1 });
      expect(result).to.deep.equal({ status: "OK", ok: true, raw: "OK" });
      expect(mockServer.getParam("/ch/1/fdr")).to.equal(-10);
      expect(mockServer.getParam("/ch/1/mute")).to.equal(1);
    });

    it("acks NODE NOT FOUND for an assignment key that doesn't resolve", async () => {
      const result = await client.bulkSet("/ch/1", { doesNotExist: 1 });
      expect(result.ok).to.equal(false);
      expect(result.status).to.equal("NODE NOT FOUND");
    });

    it("acks VALUE ERROR for a non-numeric value on a numeric leaf", async () => {
      const result = await client.bulkSet("/ch/1", { fdr: "not-a-number" });
      expect(result.ok).to.equal(false);
      expect(result.status).to.equal("VALUE ERROR");
    });
  });

  describe("subscribe()", () => {
    it("keeps the subscription alive across the mock's short inactivity timeout via periodic renewal", async () => {
      const changes: WingParamChange[] = [];
      const handle = client.subscribe("/*S");
      handle.on("change", (change) => changes.push(change));

      try {
        // The subscribe request is itself a fire-and-forget UDP datagram, so
        // it may not have reached (and been registered by) the mock yet the
        // instant subscribe() returns. Re-asserting the value on every poll
        // (rather than once up front) makes this deterministic without
        // depending on a guessed "long enough" delay.
        await waitFor(() => {
          mockServer.setParam("/ch/1/fdr", -20);
          return changes.some((c) => c.path === "/ch/1/fdr" && c.value === -20);
        });

        // Nothing but the client's own renewal loop (subscriptionRenewalIntervalMs: 100)
        // keeps this alive across the mock's 300ms inactivity window.
        await new Promise((resolve) => setTimeout(resolve, 700));

        changes.length = 0;
        await waitFor(() => {
          mockServer.setParam("/ch/1/fdr", -21);
          return changes.some((c) => c.path === "/ch/1/fdr" && c.value === -21);
        });
      } finally {
        handle.close();
      }
    });

    it("canonicalizes pushes delivered on the parameter's $-shadow address back to the plain path", async () => {
      // Real hardware only ever pushes changes on the shadow ("$"-prefixed) address, even for a
      // plain write — the client normalizes `path` back to its plain form so callers that key
      // state by the plain path (the state cache, the dashboard's live-merge) don't need to know
      // about the shadow addressing scheme; `shadow` still flags how it was actually delivered.
      const changes: WingParamChange[] = [];
      const handle = client.subscribe("/*S");
      handle.on("change", (change) => changes.push(change));

      try {
        await waitFor(() => {
          mockServer.setParam("/ch/1/mute", 1);
          return changes.some((c) => c.path === "/ch/1/mute" && c.shadow);
        });
      } finally {
        handle.close();
      }
    });

    it("delivers exactly one change per write, on the shadow address only — never a redundant plain-address push", async () => {
      // Regression test for the mock itself: it used to push every change on BOTH the plain and
      // shadow address, unlike real hardware (which only ever pushes the shadow one, per this
      // describe block's other tests) — that redundant plain push meant a broken
      // canonicalizeShadowAddress/isShadowAddress here would still "work by accident", since the
      // plain push needs no canonicalization to land under the right key. Asserting exactly one
      // change (not two) makes that class of bug visible again.
      const changes: WingParamChange[] = [];
      const handle = client.subscribe("/*S");
      handle.on("change", (change) => changes.push(change));

      try {
        // Prime the subscription first (retrying setParam inside waitFor's condition, same pattern
        // as this describe block's other tests, handles the race where the subscribe registration
        // hasn't reached the mock yet) before the single write this test needs to land exactly once.
        await waitFor(() => {
          mockServer.setParam("/ch/1/mute", 1);
          return changes.some((c) => c.path === "/ch/1/mute" && c.value === 1);
        });
        changes.length = 0;

        mockServer.setParam("/ch/1/mute", 0);
        await waitFor(() => changes.some((c) => c.path === "/ch/1/mute" && c.value === 0));
        // Give any (incorrect) second push a moment to arrive too before counting.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const matches = changes.filter((c) => c.path === "/ch/1/mute" && c.value === 0);
        expect(matches).to.have.length(1);
        expect(matches[0].shadow).to.equal(true);
      } finally {
        handle.close();
      }
    });

    it("does not canonicalize a permanent $-only address that has no plain sibling", async () => {
      // Regression test: "/$ctl/lib/$actidx" (and its siblings — see PERMANENT_SHADOW_ONLY_ADDRESSES
      // in wing-osc-client.ts) has "$" as part of its only, permanent name. Treating it as an
      // ordinary shadow-of-a-plain-sibling used to strip the "$" into the nonexistent path
      // "/$ctl/lib/actidx" and mark it `shadow: true`, corrupting the cache key for real hardware
      // pushes on this exact address (e.g. on a scene recall).
      const changes: WingParamChange[] = [];
      const handle = client.subscribe("/*S");
      handle.on("change", (change) => changes.push(change));

      try {
        await waitFor(() => {
          mockServer.setParam("/$ctl/lib/$actidx", 5);
          return changes.some((c) => c.path === "/$ctl/lib/$actidx");
        });
        const match = changes.find((c) => c.path === "/$ctl/lib/$actidx");
        expect(match?.shadow).to.equal(false);
        expect(changes.some((c) => c.path === "/$ctl/lib/actidx")).to.equal(false);
      } finally {
        handle.close();
      }
    });
  });

  /**
   * There is no TCP-style "connection" to lose on the OSC control plane (UDP:2223) — the local
   * socket opened by connect() stays bound regardless of whether the console is reachable, so
   * there is deliberately no reconnect/backoff logic here (unlike WingMeterClient's TCP metering
   * connection, see wing-meter-client.ts). This test proves that design actually holds up: the same
   * client instance, with nothing reconnect-flavored ever called on it, recovers on its own once
   * the console reappears at the same address — purely because UDP never required "reconnecting"
   * in the first place.
   */
  describe("resilience across a console restart", () => {
    it("recovers automatically once the console comes back at the same address, without any reconnect call", async () => {
      const fixedPort = await getClosedPort();
      let mock = new WingMockServer({ port: fixedPort });
      await mock.start();

      const resilientClient = new WingOscClient({ host: "127.0.0.1", port: fixedPort, requestTimeoutMs: 300 });
      await resilientClient.connect();

      try {
        const before = await resilientClient.get("/ch/1/fdr");
        expect(before.kind).to.equal("leaf");

        // Simulate the console going away: reboot, cable pull, power cycle.
        await mock.stop();
        let timedOut = false;
        try {
          await resilientClient.get("/ch/1/fdr");
        } catch (err) {
          timedOut = err instanceof WingTimeoutError;
        }
        expect(timedOut).to.equal(true);

        // Simulate the console coming back at the same IP:port. Nothing below calls connect(),
        // reconnect(), or anything else on resilientClient — it's the exact same instance/socket.
        mock = new WingMockServer({ port: fixedPort });
        await mock.start();

        const after = await resilientClient.get("/ch/1/fdr");
        expect(after.kind).to.equal("leaf");
      } finally {
        await resilientClient.close();
        await mock.stop();
      }
    });
  });

  describe("raw event", () => {
    it("fires for a GET reply, verbatim (address + args), for wing-osc-mirror.ts to tap", async () => {
      const raws: { address: string; args: { type: string; value: unknown }[] }[] = [];
      client.on("raw", (msg: (typeof raws)[number]) => raws.push(msg));

      await client.get("/ch/1/fdr");

      expect(raws).to.have.length(1);
      expect(raws[0].address).to.equal("/ch/1/fdr");
    });

    it("fires for an unsolicited subscription push, not just request/reply traffic", async () => {
      const raws: { address: string }[] = [];
      client.on("raw", (msg: { address: string }) => raws.push(msg));
      const handle = client.subscribe("/*S");

      try {
        await waitFor(() => {
          mockServer.setParam("/ch/1/fdr", -15);
          return raws.some((m) => m.address === "/ch/1/fdr" || m.address === "/ch/1/$fdr");
        });
      } finally {
        handle.close();
      }
    });
  });

  describe("timeout behavior against an unreachable console", () => {
    it("rejects with WingTimeoutError when pointed at a closed UDP port", async () => {
      const closedPort = await getClosedPort();
      const deadClient = new WingOscClient({
        host: "127.0.0.1",
        port: closedPort,
        requestTimeoutMs: 300,
      });
      await deadClient.connect();

      try {
        let error: unknown;
        try {
          await deadClient.get("/ch/1/fdr");
        } catch (err) {
          error = err;
        }
        expect(error).to.be.instanceOf(WingTimeoutError);
      } finally {
        await deadClient.close();
      }
    });
  });
});
