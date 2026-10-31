import { expect } from "chai";
import { WingBridge, type BridgeSettings } from "../../../src/plugins/wing/wing-bridge.js";
import { emptyBridgeSafes } from "../../../src/plugins/wing/wing-config.js";
import { discoverWingConsoles } from "../../../src/plugins/wing/wing-discovery.js";
import { encodeFloat, encodeNodeId } from "../../../src/plugins/wing/wing-native-codec.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import { WingMockServer } from "./wing-mock-server.js";
import { NativeTestClient, WingNativeMock } from "./wing-native-mock.js";

async function waitFor(condition: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: ${what} not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("WingBridge with the native proxy and discovery on", () => {
  let native: WingNativeMock;
  let oscMock: WingMockServer;
  let bridge: WingBridge;
  let settings: BridgeSettings;
  const tablets: NativeTestClient[] = [];

  beforeEach(async () => {
    native = new WingNativeMock();
    const { port: nativePort } = await native.start();
    oscMock = new WingMockServer();
    const { oscPort, discoveryPort } = await oscMock.start();
    bridge = new WingBridge(new WingStateCache());
    settings = {
      enabled: true,
      osc: false,
      native: true,
      oscPort: 0,
      nativePort: 0,
      discovery: true,
      bindAddress: "127.0.0.1",
      name: "",
      advertiseHost: "127.0.0.1",
      serialMode: "derived",
      protectGlobal: false,
      safes: { ...emptyBridgeSafes(), ch: [1] },
      consoleHost: "127.0.0.1",
      consoleOscPort: oscPort,
      consoleNativePort: nativePort,
      consoleDiscoveryPort: discoveryPort,
    };
    await bridge.configure(settings);
  });

  afterEach(async () => {
    for (const t of tablets.splice(0)) t.close();
    await bridge.close();
    await native.stop();
    await oscMock.stop();
  });

  async function tablet(): Promise<NativeTestClient> {
    const port = bridge.getStatus().native.proxy?.listenPort;
    if (!port) throw new Error("native proxy not listening");
    const t = await new NativeTestClient().connect(port);
    tablets.push(t);
    return t;
  }

  it("answers discovery as the console under its own name and serial, and knows its own reply", async () => {
    await waitFor(() => bridge.getStatus().discovery.responder?.advertised !== null, 3000, "console identity read");
    const port = bridge.getStatus().discovery.responder?.port;
    const found = await discoverWingConsoles({ broadcastAddress: "127.0.0.1", port, timeoutMs: 500 });
    expect(found).to.deep.equal([{ ip: "127.0.0.1", name: "MockWing-BR", model: "ngc-full", serial: "MOCK-SN-0001-BR", firmware: "3.1.0" }]);
    expect(bridge.isOwnDiscoveryReply(found[0])).to.equal(true);
    expect(bridge.isOwnDiscoveryReply({ ...found[0], name: "MockWing", serial: "MOCK-SN-0001" })).to.equal(false);
  });

  it("refuses a native write to a safe channel and logs it with the OSC blocks", async () => {
    const t = await tablet();
    await waitFor(() => bridge.getStatus().native.proxy?.map.state === "ready", 3000, "safe map ready");
    t.send(encodeNodeId(native.idOf("ch/1/fdr")), encodeFloat(0));
    t.send(encodeNodeId(native.idOf("bus/1/fdr")), encodeFloat(-6));
    await waitFor(() => native.get("bus/1/fdr") === -6, 2000, "unprotected write applied");
    await waitFor(() => bridge.getStatus().recentBlocks.length === 1, 2000, "block logged");

    const status = bridge.getStatus();
    expect(native.get("ch/1/fdr")).to.equal(-144);
    expect(status.recentBlocks[0]).to.include({ transport: "native", path: "/ch/1/fdr" });
    expect(status.clients.map((c) => c.transport)).to.deep.equal(["native"]);
  });

  it("re-maps when the safes change, then protects the new strip", async () => {
    const t = await tablet();
    await waitFor(() => bridge.getStatus().native.proxy?.map.state === "ready");
    await bridge.configure({ ...settings, safes: { ...emptyBridgeSafes(), bus: [2] } });
    await waitFor(() => bridge.getStatus().native.proxy?.map.state === "ready" && !bridge.getStatus().native.proxy?.map.stale, 3000, "re-mapped");
    t.send(encodeNodeId(native.idOf("bus/2/fdr")), encodeFloat(-6));
    t.send(encodeNodeId(native.idOf("ch/3/send/2/lvl")), encodeFloat(-6));
    t.send(encodeNodeId(native.idOf("ch/1/fdr")), encodeFloat(-6));
    await waitFor(() => native.get("ch/1/fdr") === -6, 2000, "channel 1 no longer safe");
    await waitFor(() => bridge.getStatus().recentBlocks.length === 2, 2000, "bus and its incoming send blocked");
    expect(native.get("bus/2/fdr")).to.equal(0);
    expect(native.get("ch/3/send/2/lvl")).to.equal(-144);
  });

  it("stops listening when turned off", async () => {
    await bridge.configure({ ...settings, enabled: false });
    expect(bridge.getStatus().native.proxy).to.equal(null);
    expect(bridge.getStatus().discovery.responder).to.equal(null);
  });
});
