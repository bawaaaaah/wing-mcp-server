import { expect } from "chai";
import {
  IDENTITY_CACHE_LIMIT,
  LruMap,
  MacResolver,
  matchProfile,
  normalizeMac,
  parseArpOutput,
  parseDeviceModel,
} from "../../../src/plugins/wing/wing-bridge-identity.js";
import { WingBridge } from "../../../src/plugins/wing/wing-bridge.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import { BridgeProfileSchema, type BridgeProfile } from "../../../src/plugins/wing/wing-config.js";

const profile = (id: string, match: BridgeProfile["match"]): BridgeProfile => BridgeProfileSchema.parse({ id, name: id, match, mode: "allow" });

describe("wing-bridge-identity", () => {
  it("reads the model WING-Q's WebView sends", () => {
    // Captured from WING-Q on a Galaxy Tab S8.
    const ua =
      "Mozilla/5.0 (Linux; Android 16; SM-X700 Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.47 Safari/537.36";
    expect(parseDeviceModel(ua)).to.equal("SM-X700");
    expect(parseDeviceModel("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).to.equal("iPad");
    expect(parseDeviceModel(undefined)).to.equal(null);
  });

  it("normalises MAC addresses and reads them from arp output on macOS and Linux", () => {
    expect(normalizeMac("A:b:C:1:2:3")).to.equal("0a:0b:0c:01:02:03");
    expect(normalizeMac("0A-0B-0C-01-02-03")).to.equal("0a:0b:0c:01:02:03");
    expect(normalizeMac("nope")).to.equal(null);
    expect(parseArpOutput("? (192.168.20.20) at 2a:f:3c:4d:5e:6f on en0 ifscope [ethernet]")).to.equal("2a:0f:3c:4d:5e:6f");
    expect(parseArpOutput("Address  HWtype  HWaddress  Flags Mask  Iface\n192.168.20.20  ether  2a:0f:3c:4d:5e:6f  C  eth0")).to.equal("2a:0f:3c:4d:5e:6f");
    expect(parseArpOutput("? (192.168.20.20) at (incomplete) on en0")).to.equal(null);
  });

  it("caches lookups and never throws", async () => {
    let calls = 0;
    const resolver = new MacResolver(async () => {
      calls += 1;
      return "? (10.0.0.2) at 1:2:3:4:5:6 on en0";
    });
    expect(await resolver.lookup("10.0.0.2")).to.equal("01:02:03:04:05:06");
    expect(await resolver.lookup("10.0.0.2")).to.equal("01:02:03:04:05:06");
    expect(calls).to.equal(1);
    const failing = new MacResolver(async () => {
      throw new Error("no arp");
    });
    expect(await failing.lookup("10.0.0.3")).to.equal(null);
  });

  it("caps the MAC cache and runs one arp per IP however many ask at once", async () => {
    let calls = 0;
    const resolver = new MacResolver(async () => {
      calls += 1;
      return "? (10.0.0.2) at 1:2:3:4:5:6 on en0";
    }, 4);
    const same = await Promise.all([1, 2, 3].map(() => resolver.lookup("10.0.0.2")));
    expect(same).to.deep.equal(["01:02:03:04:05:06", "01:02:03:04:05:06", "01:02:03:04:05:06"]);
    expect(calls).to.equal(1);
    for (let n = 1; n <= 20; n += 1) await resolver.lookup(`10.0.1.${n}`);
    expect(resolver.cacheSize).to.equal(4);
  });

  it("LruMap keeps the most recently used entries within its limit", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1).set("b", 2);
    expect(lru.get("a")).to.equal(1); // "a" is now the most recent
    lru.set("c", 3);
    expect(lru.has("b")).to.equal(false);
    expect(lru.get("a")).to.equal(1);
    expect(lru.get("c")).to.equal(3);
    lru.set("c", 4).set("d", 5);
    expect(lru.size).to.equal(2);
    expect(lru.has("a")).to.equal(false);
    expect(() => new LruMap(0)).to.throw(RangeError);
  });

  it("WingBridge keeps a bounded identity cache however many user agents a host sends", async () => {
    const bridge = new WingBridge(new WingStateCache());
    const internals = bridge as unknown as {
      macResolver: MacResolver;
      identities: LruMap<string, unknown>;
      identify(client: { address: string; userAgent?: string }): unknown;
    };
    let arpCalls = 0;
    internals.macResolver = new MacResolver(async () => {
      arpCalls += 1;
      return "";
    });
    for (let n = 0; n < IDENTITY_CACHE_LIMIT + 100; n += 1) internals.identify({ address: "10.0.0.7", userAgent: `flood ${n}` });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(internals.identities.size).to.equal(IDENTITY_CACHE_LIMIT);
    expect(arpCalls).to.equal(1);
    await bridge.close();
  });

  it("prefers the most specific matching profile; one with no criterion is everyone's default", () => {
    const profiles = [profile("everyone", {}), profile("tabs", { model: "SM-X700" }), profile("paul", { model: "SM-X700", ip: "10.0.0.9" })];
    expect(matchProfile(profiles, { ip: "10.0.0.9", mac: null, model: "SM-X700" })?.id).to.equal("paul");
    expect(matchProfile(profiles, { ip: "10.0.0.5", mac: null, model: "SM-X700" })?.id).to.equal("tabs");
    expect(matchProfile(profiles, { ip: "10.0.0.5", mac: null, model: null })?.id).to.equal("everyone");
    expect(matchProfile(profiles.slice(1), { ip: "10.0.0.5", mac: null, model: null })).to.equal(null);
  });

  it("matches a profile on every criterion it gives, and never on one the client lacks", () => {
    const profiles = [profile("by-mac", { mac: "01:02:03:04:05:06" }), profile("by-model-ip", { model: "sm-x700", ip: "10.0.0.9" }), profile("by-ip", { ip: "10.0.0.9" })];
    expect(matchProfile(profiles, { ip: "10.0.0.1", mac: "01:02:03:04:05:06", model: null })?.id).to.equal("by-mac");
    expect(matchProfile(profiles, { ip: "10.0.0.9", mac: null, model: "SM-X700" })?.id).to.equal("by-model-ip");
    expect(matchProfile(profiles, { ip: "10.0.0.9", mac: null, model: null })?.id).to.equal("by-ip");
    expect(matchProfile(profiles, { ip: "10.0.0.7", mac: null, model: "SM-X700" })).to.equal(null);
  });
});
