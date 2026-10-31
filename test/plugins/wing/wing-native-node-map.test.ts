import { expect } from "chai";
import { decodeNativeTokens, encodeNodeId, encodeNodeIndex, encodeNodeName, type NativeNodeDef } from "../../../src/plugins/wing/wing-native-codec.js";
import { NativeNodeMap, NativePosition, NodeMapTargetError, nativeWriteVerdict, walkNodeMap } from "../../../src/plugins/wing/wing-native-node-map.js";
import { WingNativeMock, type MockNode } from "./wing-native-mock.js";

/** Answers definition requests straight from the mock's tree, counting them. */
function requesterFor(mock: WingNativeMock): { request: (target: number | "root") => Promise<NativeNodeDef[]>; asked: string[] } {
  const asked: string[] = [];
  const byId = new Map<number, MockNode>();
  const index = (node: MockNode) => {
    byId.set(node.id, node);
    node.children.forEach(index);
  };
  index(mock.root);
  return {
    asked,
    request: async (target) => {
      const node = target === "root" ? mock.root : byId.get(target);
      asked.push(target === "root" ? "/" : `/${mock.pathOf(node as MockNode)}`);
      return (node?.children ?? []).map((child) => ({
        parent: node?.id ?? 0,
        id: child.id,
        index: child.index,
        name: child.name,
        longName: child.name,
        flags: 0,
        type: child.type,
        unit: child.unit,
        readOnly: false,
      }));
    },
  };
}

describe("wing-native-node-map", () => {
  it("walks only the ancestors of the targets (complete lists) and the subtrees under **", async () => {
    const mock = new WingNativeMock();
    const map = new NativeNodeMap();
    const { request, asked } = requesterFor(mock);
    await walkNodeMap(map, request, ["/ch/2/**", "/ch/*/send/2/**"]);

    expect(asked).to.include.members(["/", "/ch", "/ch/2", "/ch/2/in", "/ch/2/in/conn", "/ch/2/send/1", "/ch/1/send", "/ch/1/send/2", "/ch/4/send/2"]);
    expect(asked, "nothing outside the targets").to.not.include.members(["/bus", "/ch/1/dyn", "/io"]);
    expect(new Set(asked).size, "no list asked twice").to.equal(asked.length);
    expect(map.pathOf(mock.idOf("ch/2/dyn/thr"))).to.equal("/ch/2/dyn/thr");
    expect(map.idOf("/ch/3/send/2/lvl")).to.equal(mock.idOf("ch/3/send/2/lvl"));
    expect(map.get(mock.idOf("ch/3/fdr")), "siblings on the way down are listed").to.not.equal(undefined);
    expect(map.isComplete(mock.idOf("ch/3/dyn")), "a subtree no pattern reaches is not walked").to.equal(false);
  });

  it("reads unnamed strips by index and named sends by name, as the console sends them", async () => {
    const mock = new WingNativeMock();
    const map = new NativeNodeMap();
    await walkNodeMap(map, requesterFor(mock).request, ["/ch/3/**"]);
    expect(map.pathOf(mock.idOf("ch/3/send/MX1/lvl"))).to.equal("/ch/3/send/MX1/lvl");
    expect(map.pathOf(mock.idOf("ch/3/main/1/on"))).to.equal("/ch/3/main/1/on");
    expect(map.idOf("/ch/3/fdr")).to.equal(mock.idOf("ch/3/fdr"));
  });

  it("fails closed when a target names a node the console does not have", async () => {
    const mock = new WingNativeMock();
    const map = new NativeNodeMap();
    let error: unknown;
    try {
      await walkNodeMap(map, requesterFor(mock).request, ["/ch/3/send/7/**"]);
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(NodeMapTargetError);
    expect((error as Error).message).to.match(/no "7" under \/ch\/3\/send/);
  });

  it("does not ask again for lists it already has", async () => {
    const mock = new WingNativeMock();
    const map = new NativeNodeMap();
    const { request, asked } = requesterFor(mock);
    await walkNodeMap(map, request, ["/bus/1/**"]);
    const first = asked.length;
    expect(await walkNodeMap(map, request, ["/bus/1/**"])).to.equal(0);
    expect(asked).to.have.lengthOf(first);
  });

  describe("NativePosition", () => {
    async function walked(): Promise<{ mock: WingNativeMock; map: NativeNodeMap }> {
      const mock = new WingNativeMock();
      const map = new NativeNodeMap();
      await walkNodeMap(map, requesterFor(mock).request, ["/ch/1/**"]);
      return { mock, map };
    }

    it("resolves root/name/index/up steps through the map and replays as an id", async () => {
      const { mock, map } = await walked();
      const position = new NativePosition(map);
      for (const token of decodeNativeTokens([0xda, ...encodeNodeName("ch"), ...encodeNodeIndex(1), ...encodeNodeName("send"), 0xdb, ...encodeNodeName("fdr")])) {
        position.apply(token);
      }
      expect(position.id).to.equal(mock.idOf("ch/1/fdr"));
      expect(position.replay()).to.deep.equal(encodeNodeId(mock.idOf("ch/1/fdr")));
    });

    it("keeps the raw steps when it cannot follow them, and says so", async () => {
      const { map } = await walked();
      const position = new NativePosition(map);
      const tokens = decodeNativeTokens([...encodeNodeId(0x12345678), ...encodeNodeIndex(3)]);
      tokens.forEach((t) => position.apply(t));
      expect(position.unresolved).to.equal(true);
      expect(position.replay()).to.deep.equal(Buffer.concat(tokens.map((t) => t.bytes)));
    });
  });

  describe("nativeWriteVerdict", () => {
    const isProtectedPath = (path: string) => path.startsWith("/ch/1/") && !path.startsWith("/ch/1/send/");

    async function verdictAt(steps: number[], opts: Partial<{ mapReady: boolean; mapStale: boolean; hasSafes: boolean; allowsUnmapped: boolean; identifying: boolean }> = {}) {
      const mock = new WingNativeMock();
      const map = new NativeNodeMap();
      await walkNodeMap(map, requesterFor(mock).request, ["/ch/1/**"]);
      const position = new NativePosition(map);
      decodeNativeTokens(steps).forEach((t) => position.apply(t));
      const policy = {
        profile: null,
        empty: opts.hasSafes === false,
        refusalFor: (path: string) => (isProtectedPath(path) ? "protected" : null),
        allowsUnmapped: opts.allowsUnmapped ?? true,
        walkPatterns: () => ["/ch/1/**"],
      };
      return {
        mock,
        verdict: nativeWriteVerdict({ map, position, policy: opts.identifying ? null : policy, mapReady: opts.mapReady ?? true, mapStale: opts.mapStale ?? false }),
      };
    }

    it("blocks a protected node and allows its sends", async () => {
      const mock = new WingNativeMock();
      expect((await verdictAt([...encodeNodeId(mock.idOf("ch/1/fdr"))])).verdict).to.deep.equal({ allow: false, reason: "protected", path: "/ch/1/fdr" });
      expect((await verdictAt([...encodeNodeId(mock.idOf("ch/1/send/2/lvl"))])).verdict.allow).to.equal(true);
    });

    it("allows an unknown id once the map is complete, blocks it while stale or not ready", async () => {
      const id = [...encodeNodeId(0x0badf00d)];
      expect((await verdictAt(id)).verdict.allow).to.equal(true);
      expect((await verdictAt(id, { mapStale: true })).verdict.allow).to.equal(false);
      expect((await verdictAt(id, { mapReady: false })).verdict.allow).to.equal(false);
    });

    it("blocks an unmapped node under an allow-list, and everything while the device is identified", async () => {
      expect((await verdictAt([...encodeNodeId(0x0badf00d)], { allowsUnmapped: false })).verdict.allow).to.equal(false);
      const mock = new WingNativeMock();
      expect((await verdictAt([...encodeNodeId(mock.idOf("ch/2/fdr"))], { identifying: true })).verdict).to.include({ allow: false, reason: "identifying the device" });
    });

    it("blocks an unresolvable position, and allows everything without safes", async () => {
      const unresolved = [...encodeNodeId(0x0badf00d), ...encodeNodeIndex(1)];
      expect((await verdictAt(unresolved)).verdict).to.include({ allow: false, reason: "position not resolvable" });
      expect((await verdictAt(unresolved, { hasSafes: false })).verdict.allow).to.equal(true);
    });
  });
});
