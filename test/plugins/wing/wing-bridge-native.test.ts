import { expect } from "chai";
import {
  encodeFloat,
  encodeInt,
  encodeNodeId,
  encodeNodeIndex,
  encodeNodeName,
  TOKEN_DATA_REQUEST,
  TOKEN_DEF_REQUEST,
  TOKEN_ROOT,
} from "../../../src/plugins/wing/wing-native-codec.js";
import { WingNativeProxy, type NativeSafety } from "../../../src/plugins/wing/wing-bridge-native.js";
import { NativeTestClient, WingNativeMock } from "./wing-native-mock.js";

async function waitFor(condition: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: ${what} not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Channel 1 protected, its sends excepted — the "sends belong to the bus" rule, in miniature. */
function channelOneSafe(enabled = true): NativeSafety & { enabled: boolean } {
  const isProtected = (path: string) => path.toLowerCase().startsWith("/ch/1/") && !/^\/ch\/1\/(send|main)\//i.test(path);
  const safety = {
    enabled,
    hasSafes: () => safety.enabled,
    policyFor: () => ({
      profile: null,
      empty: !safety.enabled,
      refusalFor: (path: string) => (safety.enabled && isProtected(path) ? "protected" : null),
      allowsUnmapped: true,
      walkPatterns: () => (safety.enabled ? ["/ch/1/**"] : []),
    }),
    walkTargets: () => (safety.enabled ? ["/ch/1/**"] : []),
  };
  return safety;
}

describe("WingNativeProxy (tablets multiplexed onto one console connection)", () => {
  let mock: WingNativeMock;
  let proxy: WingNativeProxy;
  const clients: NativeTestClient[] = [];

  async function setup(safety: NativeSafety = channelOneSafe(false), mockOpts: ConstructorParameters<typeof WingNativeMock>[0] = {}) {
    mock = new WingNativeMock(mockOpts);
    const { port } = await mock.start();
    proxy = new WingNativeProxy({
      consoleHost: () => "127.0.0.1",
      consolePort: () => port,
      listenPort: 0,
      bindAddress: "127.0.0.1",
      safety,
      timing: { readbackDelayMs: 20, snapbackDelayMs: 20, upstreamLingerMs: 50 },
    });
    await proxy.start();
  }

  /** Resolves once the bridge has taken the tablet on (a silent raw client is recognised after a moment). */
  async function tablet(transport: "tcp" | "websocket" = "tcp"): Promise<NativeTestClient> {
    const before = proxy.getStatus().sessions.length;
    const c = transport === "tcp" ? await new NativeTestClient().connect(proxy.port) : await new NativeTestClient().connectWebSocket(proxy.port);
    clients.push(c);
    await waitFor(() => proxy.getStatus().sessions.length > before, 2000, "tablet registered");
    return c;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await proxy?.stop();
    await mock?.stop();
  });

  it("serves three tablets over a single console connection", async () => {
    await setup();
    const tablets = [await tablet(), await tablet(), await tablet()];
    const fdr = mock.idOf("ch/2/fdr");
    for (const t of tablets) t.send(encodeNodeId(fdr), [TOKEN_DATA_REQUEST]);
    await waitFor(() => tablets.every((t) => t.count("end") === 1), 3000, "every tablet's request answered");
    expect(mock.connectionsAccepted).to.equal(1);
    expect(proxy.getStatus().sessions).to.have.lengthOf(3);
  });

  it("serves WING-Q's WebSocket and raw TCP tablets side by side on one console connection", async () => {
    await setup(channelOneSafe());
    const raw = await tablet();
    const ws = await tablet("websocket");
    await waitFor(() => proxy.getStatus().map.state === "ready");
    const mute = mock.idOf("ch/2/mute");
    ws.send(encodeNodeId(mute), encodeInt(1));
    await waitFor(() => raw.valuesFor(mute).includes(1), 1000, "raw tablet hears the WebSocket tablet's write");
    expect(mock.get("ch/2/mute")).to.equal(1);
    ws.send(encodeNodeId(mock.idOf("ch/1/fdr")), encodeFloat(0));
    await waitFor(() => ws.valuesFor(mock.idOf("ch/1/fdr")).length > 0, 1000, "snap-back over the WebSocket");
    expect(mock.get("ch/1/fdr")).to.equal(-144);
    expect(mock.connectionsAccepted).to.equal(1);
    expect(proxy.getStatus().sessions.map((s) => s.transport).sort()).to.deep.equal(["tcp", "websocket"]);
  });

  it("passes on a write sent before the console connection is open", async () => {
    await setup();
    const a = await tablet();
    a.send(encodeNodeId(mock.idOf("ch/4/mute")), encodeInt(1));
    await waitFor(() => mock.get("ch/4/mute") === 1, 2000, "early write applied");
  });

  it("returns definition listings and request ends to the tablet that asked only", async () => {
    await setup();
    const a = await tablet();
    const b = await tablet();
    a.send([TOKEN_ROOT], encodeNodeName("bus"), [TOKEN_DEF_REQUEST]);
    await waitFor(() => a.count("end") === 1);
    await sleep(50);
    expect(a.tokens.filter((t) => t.kind === "def")).to.have.lengthOf(2);
    expect(b.count("def") + b.count("end")).to.equal(0);
  });

  it("keeps each tablet's position its own on the shared connection", async () => {
    await setup();
    const a = await tablet();
    const b = await tablet();
    // A walks to /ch/1/fdr step by step; B jumps elsewhere by id in between; then A writes.
    a.send([TOKEN_ROOT], encodeNodeName("ch"), encodeNodeIndex(1), encodeNodeName("fdr"));
    await sleep(20);
    b.send(encodeNodeId(mock.idOf("ch/2/fdr")), encodeFloat(-20));
    await sleep(20);
    a.send(encodeFloat(-7));
    await waitFor(() => mock.get("ch/1/fdr") === -7, 2000, "A's write lands on /ch/1/fdr");
    expect(mock.get("ch/2/fdr")).to.equal(-20);
  });

  it("tells the other tablets about a write at once, and everyone hears desk changes", async () => {
    await setup();
    const a = await tablet();
    const b = await tablet();
    const mute = mock.idOf("ch/3/mute");
    a.send(encodeNodeId(mute), encodeInt(1));
    await waitFor(() => b.valuesFor(mute).includes(1), 1000, "B hears A's write");
    expect(mock.get("ch/3/mute")).to.equal(1);

    mock.setFromDesk("ch/3/mute", 0);
    await waitFor(() => a.valuesFor(mute).at(-1) === 0 && b.valuesFor(mute).at(-1) === 0, 1000, "both hear the desk");
  });

  describe("with channel 1 safe", () => {
    it("refuses a protected write, leaves the console untouched and snaps the tablet back", async () => {
      await setup(channelOneSafe());
      const a = await tablet();
      await waitFor(() => proxy.getStatus().map.state === "ready", 3000, "safe map ready");
      const fdr = mock.idOf("ch/1/fdr");
      a.send(encodeNodeId(fdr), encodeFloat(0));
      await waitFor(() => a.valuesFor(fdr).length > 0, 1000, "snap-back value");
      expect(a.valuesFor(fdr)).to.deep.equal([-144]);
      expect(mock.writes).to.deep.equal([]);
      expect(proxy.blocked[0]).to.include({ path: "/ch/1/fdr", reason: "protected" });
    });

    it("lets the channel's sends, other strips and unmapped nodes through", async () => {
      await setup(channelOneSafe());
      const a = await tablet();
      await waitFor(() => proxy.getStatus().map.state === "ready");
      a.send(encodeNodeId(mock.idOf("ch/1/send/2/lvl")), encodeFloat(-3));
      a.send(encodeNodeId(mock.idOf("bus/1/fdr")), encodeFloat(-5));
      await waitFor(() => mock.writes.length === 2, 1000, "both writes applied");
      expect(mock.get("ch/1/send/2/lvl")).to.equal(-3);
      expect(mock.get("bus/1/fdr")).to.equal(-5);
    });

    it("blocks a relative step it cannot follow", async () => {
      await setup(channelOneSafe());
      const a = await tablet();
      await waitFor(() => proxy.getStatus().map.state === "ready");
      // /bus was listed on the way to /ch? No: only root and /ch are. Stepping inside /bus is unresolvable.
      a.send([TOKEN_ROOT], encodeNodeName("bus"), encodeNodeIndex(1), encodeNodeName("fdr"), encodeFloat(-1));
      await waitFor(() => proxy.blocked.length === 1, 1000, "blocked");
      expect(proxy.blocked[0].reason).to.equal("position not resolvable");
      expect(mock.get("bus/1/fdr")).to.equal(0);
    });

    it("re-maps a subtree whose ids changed before allowing writes under it again", async () => {
      await setup(channelOneSafe());
      const a = await tablet();
      await waitFor(() => proxy.getStatus().map.state === "ready");
      mock.renumberSubtree("ch/1/dyn");
      proxy.forgetSubtree("/ch/1/dyn");
      await waitFor(() => proxy.getStatus().map.state === "ready" && !proxy.getStatus().map.stale, 3000, "re-mapped");
      a.send(encodeNodeId(mock.idOf("ch/1/dyn/thr")), encodeFloat(-30));
      await waitFor(() => proxy.blocked.length === 1, 1000, "blocked under the new id");
      expect(proxy.blocked[0].path).to.equal("/ch/1/dyn/thr");
      expect(mock.get("ch/1/dyn/thr")).to.equal(-20);
    });
  });

  it("drops the tablets when the console connection goes, so they resync on reconnect", async () => {
    await setup();
    const a = await tablet();
    a.send(encodeNodeId(mock.idOf("ch/1/fdr")), [TOKEN_DATA_REQUEST]);
    await waitFor(() => a.count("end") === 1);
    mock.dropConnections();
    await waitFor(() => a.closed, 2000, "tablet disconnected");
  });

  it("closes a tablet whose stream stops parsing", async () => {
    await setup();
    const a = await tablet();
    a.send([0xe5]);
    await waitFor(() => a.closed, 1000, "closed");
    expect(proxy.getStatus().lastError).to.match(/unknown token/);
  });
});
