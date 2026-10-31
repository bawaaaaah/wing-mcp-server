import { expect } from "chai";
import osc from "osc";
import type { OscArgument, OscMessage, UDPPort } from "osc";
import { WingBridgeOsc, classifyOscRequest, splitReplyPortPrefix, type BridgeBlockedWrite } from "../../../src/plugins/wing/wing-bridge-osc.js";
import { buildSafeRules, type SafeRules } from "../../../src/plugins/wing/wing-bridge-safes.js";
import { emptyBridgeSafes } from "../../../src/plugins/wing/wing-config.js";
import { WingOscClient, type WingSubscriptionHandle } from "../../../src/plugins/wing/wing-osc-client.js";
import { WingMockServer } from "./wing-mock-server.js";

interface Received {
  address: string;
  args: OscArgument[];
  port: number;
}

/** A stand-in OSC app: one UDP socket that records everything it receives. */
class TestApp {
  readonly received: Received[] = [];
  private port: UDPPort | null = null;

  async open(): Promise<number> {
    const port = new osc.UDPPort({ localAddress: "127.0.0.1", localPort: 0, metadata: true });
    await new Promise<void>((resolve, reject) => {
      port.once("ready", () => resolve());
      port.once("error", reject);
      port.open();
    });
    port.on("message", (message: OscMessage) => {
      const args = Array.isArray(message.args) ? (message.args as OscArgument[]) : [];
      this.received.push({ address: message.address, args, port: this.localPort });
    });
    this.port = port;
    return this.localPort;
  }

  get localPort(): number {
    return this.port?.socket?.address().port ?? 0;
  }

  send(bridgePort: number, address: string, args: OscArgument[] = []): void {
    this.port?.send({ address, args }, "127.0.0.1", bridgePort);
  }

  async waitFor(predicate: (msg: Received) => boolean, timeoutMs = 1500): Promise<Received> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out; received: ${JSON.stringify(this.received.map((r) => r.address))}`);
  }

  close(): void {
    this.port?.close();
    this.port = null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("classifyOscRequest", () => {
  it("sorts reads, subscriptions, plain sets and bulk-sets", () => {
    expect(classifyOscRequest("/*s", [])).to.deep.equal({ kind: "subscribe", mode: "/*s" });
    expect(classifyOscRequest("/*b", [])).to.deep.equal({ kind: "ignore" });
    expect(classifyOscRequest("/ch/1/fdr", [])).to.deep.equal({ kind: "read" });
    expect(classifyOscRequest("/ch/1", [{ type: "s", value: "*" }])).to.deep.equal({ kind: "read" });
    expect(classifyOscRequest("/ch/1/mute", [{ type: "i", value: -1 }])).to.deep.include({ kind: "write", paths: ["/ch/1/mute"], bulk: false });
    expect(classifyOscRequest("/ch/1/name", [{ type: "s", value: "Kick" }])).to.deep.include({ kind: "write", paths: ["/ch/1/name"] });
    expect(classifyOscRequest("/ch/1", [{ type: "s", value: "fdr=0,eq.on=1,tags='#D1,#M1'" }])).to.deep.equal({
      kind: "write",
      paths: ["/ch/1/fdr", "/ch/1/eq/on", "/ch/1/tags"],
      bulk: true,
      unresolved: false,
    });
    expect(classifyOscRequest("/ch/1/eq", [{ type: "s", value: "..fdr=0" }])).to.deep.include({ unresolved: true });
    expect(classifyOscRequest("/#1234abcd", [{ type: "f", value: 0 }])).to.deep.include({ kind: "write", unresolved: true });
  });

  it("splits the /%port/ reply prefix", () => {
    expect(splitReplyPortPrefix("/%9000/ch/1/fdr")).to.deep.equal({ replyPort: 9000, address: "/ch/1/fdr" });
    expect(splitReplyPortPrefix("/ch/1/fdr")).to.deep.equal({ replyPort: null, address: "/ch/1/fdr" });
  });
});

describe("WingBridgeOsc (against the mock console)", () => {
  let mock: WingMockServer;
  let client: WingOscClient;
  let subscription: WingSubscriptionHandle;
  let bridge: WingBridgeOsc;
  let rules: SafeRules;
  let blocked: BridgeBlockedWrite[];
  let appA: TestApp;
  let appB: TestApp;

  beforeEach(async () => {
    mock = new WingMockServer({ applyPlainSets: true, subscriptionInactivityTimeoutMs: 2_000 });
    const { oscPort } = await mock.start();
    mock.defineLeaf("/ch/1/send/1/lvl", "f", -10);

    // The plugin's own client, holding the console's one subscription.
    client = new WingOscClient({ host: "127.0.0.1", port: oscPort, subscriptionMode: "/*s", subscriptionRenewalIntervalMs: 500 });
    await client.connect();
    subscription = client.subscribe();

    rules = buildSafeRules(emptyBridgeSafes(), () => undefined);
    blocked = [];
    bridge = new WingBridgeOsc({
      port: 0,
      bindAddress: "127.0.0.1",
      consoleHost: "127.0.0.1",
      consolePort: oscPort,
      getRules: () => rules,
      onBlocked: (b) => blocked.push(b),
      snapBackDelayMs: 20,
    });
    await bridge.start();
    client.on("push", (msg: { address: string; args: OscArgument[] }) => bridge.handleConsolePush(msg.address, msg.args));

    appA = new TestApp();
    appB = new TestApp();
    await appA.open();
    await appB.open();
  });

  afterEach(async () => {
    appA.close();
    appB.close();
    await bridge.close();
    subscription.close();
    await client.close();
    await mock.stop();
  });

  it("serves two subscribed apps while the console sees one subscriber", async () => {
    appA.send(bridge.port, "/*s");
    appB.send(bridge.port, "/*S");
    await sleep(100);
    expect(mock.subscriberCount()).to.equal(1);

    mock.setParam("/ch/1/fdr", -12);
    const full = await appA.waitFor((m) => m.address === "/ch/1/$fdr");
    const compact = await appB.waitFor((m) => m.address === "/ch/1/$fdr");
    expect(full.args.map((a) => a.type)).to.deep.equal(["s", "f", "f"]);
    expect(full.args[2]?.value).to.be.closeTo(-12, 1e-6);
    expect(compact.args).to.have.length(1);
    expect(compact.args[0]?.value).to.be.closeTo(-12, 1e-6);
    expect(bridge.getClients().map((c) => c.subscription).sort()).to.deep.equal(["/*S", "/*s"]);
  });

  it("routes each reply back to the app that asked", async () => {
    appA.send(bridge.port, "/ch/2/name");
    appB.send(bridge.port, "/ch/3/name");
    const a = await appA.waitFor((m) => m.address === "/ch/2/name");
    const b = await appB.waitFor((m) => m.address === "/ch/3/name");
    expect(a.args[0]?.value).to.equal("Snare");
    expect(b.args[0]?.value).to.equal("Bass");
    await sleep(50);
    expect(appA.received.some((m) => m.address === "/ch/3/name")).to.equal(false);
    expect(appB.received.some((m) => m.address === "/ch/2/name")).to.equal(false);
  });

  it("sends the reply to the /%port/ given", async () => {
    appA.send(bridge.port, `/%${appB.localPort}/ch/2/name`);
    const reply = await appB.waitFor((m) => m.address === "/ch/2/name");
    expect(reply.args[0]?.value).to.equal("Snare");
    expect(appA.received).to.have.length(0);
  });

  it("forwards writes to strips that are not safe", async () => {
    rules = buildSafeRules({ ...emptyBridgeSafes(), ch: [1] }, () => ({ main: null, alt: null }));
    appA.send(bridge.port, "/ch/3/fdr", [{ type: "f", value: -3 }]);
    appA.send(bridge.port, "/ch/1", [{ type: "s", value: "send.1.lvl=-20" }]);
    const ack = await appA.waitFor((m) => m.address === "/*");
    expect(ack.args[0]?.value).to.equal("OK");
    expect(mock.getParam("/ch/3/fdr")).to.equal(-3);
    expect(mock.getParam("/ch/1/send/1/lvl")).to.equal(-20);
    expect(blocked).to.have.length(0);
  });

  it("refuses a safe strip's bulk-set with PROTECTED, then snaps the app back", async () => {
    rules = buildSafeRules({ ...emptyBridgeSafes(), ch: [1] }, () => ({ main: null, alt: null }));
    appA.send(bridge.port, "/*s");
    await sleep(50);
    appA.send(bridge.port, "/ch/1", [{ type: "s", value: "fdr=0" }]);

    const ack = await appA.waitFor((m) => m.address === "/*");
    expect(ack.args[0]?.value).to.equal("PROTECTED");
    const readBack = await appA.waitFor((m) => m.address === "/ch/1/fdr");
    expect(readBack.args[2]?.value).to.equal(-6);
    const push = await appA.waitFor((m) => m.address === "/ch/1/$fdr");
    expect(push.args[2]?.value).to.equal(-6);

    expect(mock.getParam("/ch/1/fdr")).to.equal(-6);
    expect(blocked).to.have.length(1);
    expect(blocked[0]).to.deep.include({ transport: "osc", path: "/ch/1/fdr", reason: "ch 1" });
  });

  it("refuses a plain set or toggle on a safe strip without touching the console", async () => {
    rules = buildSafeRules({ ...emptyBridgeSafes(), ch: [1] }, () => ({ main: null, alt: null }));
    appA.send(bridge.port, "/ch/1/mute", [{ type: "i", value: -1 }]);
    const readBack = await appA.waitFor((m) => m.address === "/ch/1/mute");
    expect(readBack.args[2]?.value).to.equal(0);
    expect(mock.getParam("/ch/1/mute")).to.equal(0);
    expect(bridge.getStats().blocked).to.equal(1);
  });

  it("refuses node-id writes while anything is safe", async () => {
    rules = buildSafeRules({ ...emptyBridgeSafes(), dca: [1] }, () => ({ main: null, alt: null }));
    appA.send(bridge.port, "/#12345678", [{ type: "f", value: 0 }]);
    await sleep(50);
    expect(blocked).to.have.length(1);
    expect(blocked[0]?.reason).to.match(/not resolvable/);
  });
});
