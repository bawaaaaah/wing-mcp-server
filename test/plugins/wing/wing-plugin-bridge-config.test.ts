// The real WingPlugin against the loopback mock console and meter simulator: a bridge change made
// through the MCP tools must be saved (so the next config save keeps it, and a restart restores it)
// and must never reconnect the console clients. `client` is private in the type system only; it is
// read here to prove the OSC client instance survives, as wing-plugin.test.ts does for its internals.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import osc from "osc";
import type { OscArgument, OscMessage, UDPPort } from "osc";
import type { ScopedConfigStore } from "../../../src/core/config-store.js";
import { EventBus } from "../../../src/core/event-bus.js";
import type { BridgeStatus } from "../../../src/plugins/wing/wing-bridge.js";
import type { WingConfig } from "../../../src/plugins/wing/wing-config.js";
import type { WingOscClient } from "../../../src/plugins/wing/wing-osc-client.js";
import { WingPlugin } from "../../../src/plugins/wing/wing-plugin.js";
import { WingMeterSimulator } from "./wing-meter-simulator.js";
import { WingMockServer } from "./wing-mock-server.js";

async function freeUdpPort(): Promise<number> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  const { port } = socket.address() as AddressInfo;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

function memoryStore(initial: unknown): ScopedConfigStore & { stored: () => WingConfig } {
  let stored = initial;
  return {
    get: () => stored,
    set: async (config: unknown) => {
      stored = config;
    },
    stored: () => stored as WingConfig,
  };
}

async function connectMcp(plugin: WingPlugin): Promise<Client> {
  const server = new McpServer({ name: "bridge-config-test", version: "0.0.0" });
  plugin.registerTools(server);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bridge-config-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met in time");
}

/** Asks the bridge for one parameter, the way an OSC app would, and returns the reply's arguments. */
async function readThroughBridge(bridgePort: number, address: string): Promise<OscArgument[]> {
  const port: UDPPort = new osc.UDPPort({ localAddress: "127.0.0.1", localPort: 0, metadata: true });
  await new Promise<void>((resolve) => {
    port.once("ready", () => resolve());
    port.open();
  });
  try {
    return await new Promise<OscArgument[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply through the bridge")), 1500);
      port.on("message", (message: OscMessage) => {
        if (message.address !== address) return;
        clearTimeout(timer);
        resolve(Array.isArray(message.args) ? (message.args as OscArgument[]) : []);
      });
      port.send({ address, args: [] }, "127.0.0.1", bridgePort);
    });
  } finally {
    port.close();
  }
}

describe("WingPlugin bridge config", () => {
  let mock: WingMockServer;
  let meters: WingMeterSimulator;
  let plugin: WingPlugin;
  let store: ReturnType<typeof memoryStore>;
  let mcp: Client;
  let bridgePort: number;

  beforeEach(async () => {
    mock = new WingMockServer();
    mock.defineLeaf("/ch/1/in/conn/grp", "s", "A");
    mock.defineLeaf("/ch/1/in/conn/in", "i", 3);
    mock.defineLeaf("/ch/1/in/conn/altgrp", "s", "OFF");
    mock.defineLeaf("/ch/1/in/conn/altin", "i", 1);
    const { oscPort } = await mock.start();
    meters = new WingMeterSimulator();
    const { tcpPort } = await meters.start();
    bridgePort = await freeUdpPort();
    store = memoryStore({
      host: "127.0.0.1",
      oscPort,
      meterTcpPort: tcpPort,
      meterUdpPort: await freeUdpPort(),
      warmCacheOnConnect: false,
      bridgeEnabled: true,
      bridgeOscPort: bridgePort,
      bridgeBindAddress: "127.0.0.1",
    });
    plugin = new WingPlugin(store, new EventBus());
    await plugin.start();
    mcp = await connectMcp(plugin);
  });

  /**
   * Stopping while the meter client is still mid-connect leaves that connection to the simulator
   * behind (it then resets, uncaught, and holds the simulator's stop() open): let it settle first.
   */
  async function settleMeters(): Promise<void> {
    await waitUntil(async () => {
      const { detail } = await plugin.getHealth();
      return !detail?.host || detail.meterStatus === "connected";
    });
  }

  afterEach(async () => {
    await settleMeters();
    await mcp.close();
    await plugin.stop();
    await meters.stop();
    await mock.stop();
  });

  const consoleClient = () => (plugin as unknown as { client: WingOscClient | null }).client;

  async function callTool(name: string, args: Record<string, unknown>): Promise<BridgeStatus> {
    const result = await mcp.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).to.not.equal(true);
    return result.structuredContent as unknown as BridgeStatus;
  }

  it("listens at start and relays an app's read to the console", async () => {
    const status = await callTool("wing_bridge_status", {});
    expect(status.enabled).to.equal(true);
    expect(status.osc).to.deep.include({ listening: true, port: bridgePort });
    const args = await readThroughBridge(bridgePort, "/ch/2/name");
    expect(args[0]?.value).to.equal("Snare");
  });

  it("saves safes without reconnecting the console, and resolves the safe channel's source", async () => {
    const before = consoleClient();
    expect(before).to.not.equal(null);

    const status = await callTool("wing_bridge_set_safes", { ch: [1], bus: [16] });
    expect(status.safes.ch).to.deep.equal([1]);
    expect(store.stored().bridgeSafes).to.deep.include({ ch: [1], bus: [16] });
    expect(consoleClient()).to.equal(before);

    await waitUntil(async () => (await callTool("wing_bridge_status", {})).safesState === "ready");
    const ready = await callTool("wing_bridge_status", {});
    expect(ready.protectedRoots).to.include.members(["/ch/1", "/io/in/A/3", "/io/in/A/4", "/bus/16"]);

    const added = await callTool("wing_bridge_set_safes", { mode: "add", dca: [2] });
    expect(added.safes).to.deep.include({ ch: [1], bus: [16], dca: [2] });
    const removed = await callTool("wing_bridge_set_safes", { mode: "remove", bus: [16] });
    expect(removed.safes).to.deep.include({ ch: [1], bus: [], dca: [2] });
    expect(consoleClient()).to.equal(before);
  });

  it("moves the listener to a new port without reconnecting, and keeps it across a config save", async () => {
    const before = consoleClient();
    const newPort = await freeUdpPort();
    const status = await callTool("wing_bridge_configure", { oscPort: newPort });
    expect(status.osc).to.deep.include({ listening: true, port: newPort });
    expect(store.stored().bridgeOscPort).to.equal(newPort);
    expect(consoleClient()).to.equal(before);

    // A later save of an unrelated field goes through the same persisted config, so it keeps the port.
    await plugin.setConfig({ ...store.stored(), showMode: true });
    expect((await callTool("wing_bridge_status", {})).osc?.port).to.equal(newPort);
    expect(consoleClient()).to.equal(before);
  });

  it("restores saved safes on the next start, and reports them in health", async () => {
    await callTool("wing_bridge_set_safes", { dca: [3] });
    await settleMeters();
    await mcp.close();
    await plugin.stop();

    // Restarted without a console (host unset), so nothing reconnects underneath the test.
    plugin = new WingPlugin(memoryStore({ ...store.stored(), host: "" }), new EventBus());
    await plugin.start();
    mcp = await connectMcp(plugin);
    expect((await callTool("wing_bridge_status", {})).safes.dca).to.deep.equal([3]);
    const health = await plugin.getHealth();
    expect(health.detail?.bridge).to.deep.include({ enabled: true, oscListening: true, safes: 1 });
  });

  it("refuses a config the bridge cannot run with, leaving the saved one alone", async () => {
    const result = await mcp.callTool({ name: "wing_bridge_configure", arguments: { oscPort: store.stored().oscPort } });
    expect(result.isError).to.equal(true);
    expect(store.stored().bridgeOscPort).to.equal(bridgePort);
  });
});
