import { expect } from "chai";
import { MacResolver, matchProfile, normalizeMac, parseArpOutput, parseDeviceModel } from "../../../src/plugins/wing/wing-bridge-identity.js";
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

  it("matches a profile on every criterion it gives, and never on one the client lacks", () => {
    const profiles = [profile("by-mac", { mac: "01:02:03:04:05:06" }), profile("by-model-ip", { model: "sm-x700", ip: "10.0.0.9" }), profile("by-ip", { ip: "10.0.0.9" })];
    expect(matchProfile(profiles, { ip: "10.0.0.1", mac: "01:02:03:04:05:06", model: null })?.id).to.equal("by-mac");
    expect(matchProfile(profiles, { ip: "10.0.0.9", mac: null, model: "SM-X700" })?.id).to.equal("by-model-ip");
    expect(matchProfile(profiles, { ip: "10.0.0.9", mac: null, model: null })?.id).to.equal("by-ip");
    expect(matchProfile(profiles, { ip: "10.0.0.7", mac: null, model: "SM-X700" })).to.equal(null);
  });
});
