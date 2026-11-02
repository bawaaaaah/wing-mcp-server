import { expect } from "chai";
import {
  buildClientPolicy,
  buildGlobalPolicy,
  buildSafeRules,
  normalizeBridgePath,
  type GlobalSafesOptions,
  type InsertLookup,
  type SourceLookup,
} from "../../../src/plugins/wing/wing-bridge-safes.js";
import { BridgeProfileSchema, emptyBridgeSafes, type BridgeProfile, type BridgeSafes } from "../../../src/plugins/wing/wing-config.js";

function safes(partial: Partial<BridgeSafes>): BridgeSafes {
  return { ...emptyBridgeSafes(), ...partial };
}

const noSources: SourceLookup = () => ({ main: null, alt: null });

/** A profile's policy over global safes given as a list (blacklist unless `opts.mode` says otherwise). */
function policyOf(profile: BridgeProfile, globalSafes: BridgeSafes, lookup: SourceLookup, opts: GlobalSafesOptions = {}, inserts?: InsertLookup) {
  return buildClientPolicy(profile, buildGlobalPolicy(globalSafes, lookup, opts, inserts), lookup, opts, inserts);
}

describe("wing-bridge-safes", () => {
  describe("normalizeBridgePath", () => {
    it("drops the reply-port prefix, empty segments, case, shadow $ and leading zeros", () => {
      expect(normalizeBridgePath("/%9000/CH/01//$fdr")).to.deep.equal(["ch", "1", "fdr"]);
      expect(normalizeBridgePath("/$ctl/lib/$actidx")).to.deep.equal(["ctl", "lib", "actidx"]);
      expect(normalizeBridgePath("/ch/3/send/MX02/lvl")).to.deep.equal(["ch", "3", "send", "mx2", "lvl"]);
    });
  });

  it("lets everything through when nothing is safe", () => {
    const rules = buildSafeRules(emptyBridgeSafes(), noSources);
    expect(rules.empty).to.equal(true);
    expect(rules.isProtectedPath("/ch/1/fdr")).to.equal(false);
    expect(rules.isProtectedPath("/$ctl/lib/$action")).to.equal(false);
  });

  describe("channel safe", () => {
    const rules = buildSafeRules(safes({ ch: [5] }), noSources);

    it("protects the strip, in any spelling", () => {
      for (const path of ["/ch/5/fdr", "/ch/5/mute", "/ch/5/eq/1g", "/CH/05/$fdr", "/%9000/ch/5/name", "/ch/5/in/conn/grp"]) {
        expect(rules.isProtectedPath(path), path).to.equal(true);
      }
      expect(rules.protectedBy("/ch/5/fdr")).to.equal("ch 5");
    });

    it("leaves its sends and main assigns to their destination, and other strips alone", () => {
      expect(rules.isProtectedPath("/ch/5/send/3/lvl")).to.equal(false);
      expect(rules.isProtectedPath("/ch/5/main/1/lvl")).to.equal(false);
      expect(rules.isProtectedPath("/ch/50/fdr")).to.equal(false);
      expect(rules.isProtectedPath("/ch/4/fdr")).to.equal(false);
      expect(rules.isProtectedPath("/bus/5/fdr")).to.equal(false);
    });

    it("refuses a write on a branch above it", () => {
      expect(rules.isProtectedPath("/ch")).to.equal(true);
      expect(rules.isProtectedPath("/ch/5")).to.equal(true);
    });
  });

  describe("input sources", () => {
    it("protects the patched source, its stereo partner and the alt source", () => {
      const lookup: SourceLookup = (kind, index) =>
        kind === "ch" && index === 5 ? { main: { group: "A", index: 3 }, alt: { group: "LCL", index: 8 } } : { main: null, alt: null };
      const rules = buildSafeRules(safes({ ch: [5] }), lookup);
      expect(rules.sourcesReady).to.equal(true);
      for (const path of ["/io/in/A/3/g", "/io/in/a/4/vph", "/io/in/LCL/8/name", "/io/in/LCL/7/mute"]) {
        expect(rules.isProtectedPath(path), path).to.equal(true);
      }
      expect(rules.isProtectedPath("/io/in/A/5/g")).to.equal(false);
      expect(rules.isProtectedPath("/io/in/B/3/g")).to.equal(false);
      expect(rules.protectedBy("/io/in/A/3/g")).to.contain("ch 5");
    });

    it("protects every input while a safe strip's patch is unknown", () => {
      const rules = buildSafeRules(safes({ aux: [2] }), () => undefined);
      expect(rules.sourcesReady).to.equal(false);
      expect(rules.isProtectedPath("/io/in/USB/12/g")).to.equal(true);
      expect(rules.isProtectedPath("/io/out/A/1/grp")).to.equal(false);
    });
  });

  describe("bus safe", () => {
    const rules = buildSafeRules(safes({ bus: [16] }), noSources);

    it("protects the bus and every send coming into it", () => {
      expect(rules.isProtectedPath("/bus/16/fdr")).to.equal(true);
      expect(rules.isProtectedPath("/ch/40/send/16/lvl")).to.equal(true);
      expect(rules.isProtectedPath("/aux/1/send/16/on")).to.equal(true);
      expect(rules.isProtectedPath("/bus/3/send/16/lvl")).to.equal(true);
      expect(rules.protectedBy("/ch/1/send/16/lvl")).to.equal("bus 16 (incoming send)");
    });

    it("leaves its own outgoing sends and other buses' sends alone", () => {
      expect(rules.isProtectedPath("/bus/16/send/MX1/lvl")).to.equal(false);
      expect(rules.isProtectedPath("/bus/16/main/1/lvl")).to.equal(false);
      expect(rules.isProtectedPath("/ch/1/send/15/lvl")).to.equal(false);
      expect(rules.isProtectedPath("/ch/1/fdr")).to.equal(false);
    });
  });

  it("main safe protects the main and the assigns into it, not its sends to matrices", () => {
    const rules = buildSafeRules(safes({ main: [1] }), noSources);
    expect(rules.isProtectedPath("/main/1/fdr")).to.equal(true);
    expect(rules.isProtectedPath("/ch/7/main/1/lvl")).to.equal(true);
    expect(rules.isProtectedPath("/ch/7/main/2/lvl")).to.equal(false);
    expect(rules.isProtectedPath("/main/1/send/MX1/lvl")).to.equal(false);
  });

  it("matrix safe protects the matrix and the MX sends into it", () => {
    const rules = buildSafeRules(safes({ mtx: [2] }), noSources);
    expect(rules.isProtectedPath("/mtx/2/fdr")).to.equal(true);
    expect(rules.isProtectedPath("/bus/1/send/MX2/lvl")).to.equal(true);
    expect(rules.isProtectedPath("/main/1/send/mx02/on")).to.equal(true);
    expect(rules.isProtectedPath("/bus/1/send/MX3/lvl")).to.equal(false);
    expect(rules.isProtectedPath("/bus/1/send/2/lvl")).to.equal(false);
  });

  it("DCA safe protects the DCA", () => {
    const rules = buildSafeRules(safes({ dca: [3] }), noSources);
    expect(rules.isProtectedPath("/dca/3/fdr")).to.equal(true);
    expect(rules.isProtectedPath("/dca/4/fdr")).to.equal(false);
  });

  it("protects scene recall and /cfg while anything is safe, unless global protection is off", () => {
    const on = buildSafeRules(safes({ dca: [1] }), noSources);
    expect(on.isProtectedPath("/$ctl/lib/$action")).to.equal(true);
    expect(on.isProtectedPath("/cfg/osc/port")).to.equal(true);
    expect(on.isProtectedPath("/cfg/solo/$srcsgrp"), "solo changes what the engineer hears").to.equal(true);
    expect(on.isProtectedPath("/cfg/rta/rtasrc"), "the RTA source changes no sound").to.equal(false);
    const off = buildSafeRules(safes({ dca: [1] }), noSources, { protectGlobal: false });
    expect(off.isProtectedPath("/$ctl/lib/$action")).to.equal(false);
    expect(off.isProtectedPath("/cfg/osc/port")).to.equal(false);
  });

  it("lists the protected roots for the node-map walk", () => {
    const lookup: SourceLookup = () => ({ main: { group: "A", index: 1 }, alt: null });
    const rules = buildSafeRules(safes({ ch: [1], bus: [2] }), lookup);
    expect(rules.walkTargets()).to.include.members(["/ch/1", "/io/in/A/1", "/io/in/A/2", "/bus/2", "/*/*/send/2", "/$ctl/lib", "/cfg"]);
  });

  it("spells the walk with alternatives expanded, so only reachable branches are listed", () => {
    const lookup: SourceLookup = () => ({ main: { group: "A", index: 1 }, alt: null });
    const rules = buildSafeRules(safes({ ch: [1], bus: [2] }), lookup, { protectGlobal: false });
    expect(rules.walkPatterns()).to.have.members([
      "/ch/1/**",
      "/io/in/a/1/**",
      "/io/in/a/2/**",
      "/bus/2/**",
      "/ch/*/send/2/**",
      "/aux/*/send/2/**",
      "/bus/*/send/2/**",
    ]);
  });

  describe("device profiles", () => {
    const profile = (p: Partial<BridgeProfile> & Pick<BridgeProfile, "mode">): BridgeProfile =>
      BridgeProfileSchema.parse({ id: "paul", name: "Paul", match: { ip: "192.168.20.20" }, ...p });

    it("mix scope on a bus: the mixing controls of every send into it, and the whole bus itself", () => {
      const policy = policyOf(profile({ mode: "allow", scope: "mix", allow: safes({ bus: [3] }) }), emptyBridgeSafes(), noSources);
      for (const ok of ["/ch/5/send/3/lvl", "/ch/5/send/3/on", "/aux/2/send/3/pan", "/ch/5/send/3/mode", "/ch/5/send/3/plink", "/ch/5/send/3/pon", "/bus/1/send/3/lvl", "/bus/3/fdr", "/bus/3/mute", "/bus/3/pan", "/bus/3/eq/1/g", "/bus/3/dyn/thr", "/bus/3/name"]) {
        expect(policy.refusalFor(ok), ok).to.equal(null);
      }
      for (const no of ["/bus/3/send/MX1/lvl", "/bus/3/send/4/on", "/bus/3/main/1/lvl", "/ch/5/tapwid", "/ch/5/send/4/lvl", "/ch/5/fdr", "/ch/5/eq/1/g", "/main/1/fdr", "/$ctl/lib/$action"]) {
        expect(policy.refusalFor(no), no).to.equal('not allowed for "Paul"');
      }
      expect(policy.allowsUnmapped).to.equal(false);
      expect(policy.empty).to.equal(false);
    });

    it("mix scope: the bus's inserts can be switched and their FX tweaked, but not swapped", () => {
      // FX3 is inserted in bus 3 (pre), nothing post.
      const inserts = (kind: string, index: number) => (kind === "bus" && index === 3 ? [3] : undefined);
      const policy = policyOf(profile({ mode: "allow", scope: "mix", allow: safes({ bus: [3] }) }), emptyBridgeSafes(), noSources, {}, inserts);
      expect(policy.refusalFor("/bus/3/preins/on"), "insert on/off").to.equal(null);
      expect(policy.refusalFor("/bus/3/postins/on")).to.equal(null);
      expect(policy.refusalFor("/bus/3/preins/ins"), "which FX is loaded").to.equal('not allowed for "Paul"');
      expect(policy.refusalFor("/fx/3/dcy"), "the loaded FX's parameters").to.equal(null);
      expect(policy.refusalFor("/fx/3/fxmix")).to.equal(null);
      expect(policy.refusalFor("/fx/3/mdl"), "the loaded FX's model").to.equal('not allowed for "Paul"');
      expect(policy.refusalFor("/fx/4/dcy"), "an FX not in this bus").to.equal('not allowed for "Paul"');
      expect(policy.walkPatterns()).to.include("/fx/3/**");
    });

    it("keeps every FX read-only while the bus's inserts are not known", () => {
      const policy = policyOf(profile({ mode: "allow", scope: "mix", allow: safes({ bus: [3] }) }), emptyBridgeSafes(), noSources);
      expect(policy.refusalFor("/fx/3/dcy")).to.not.equal(null);
      expect(policy.refusalFor("/bus/3/preins/on")).to.equal(null);
    });

    it("mix scope on a channel: only its fader, mute and pan — its processing feeds everyone", () => {
      const policy = policyOf(profile({ mode: "allow", scope: "mix", allow: safes({ ch: [5] }) }), emptyBridgeSafes(), noSources);
      expect(policy.refusalFor("/ch/5/fdr")).to.equal(null);
      expect(policy.refusalFor("/ch/5/eq/1/g")).to.not.equal(null);
    });

    it("full scope gives the whole strip and its incoming sends", () => {
      const policy = policyOf(profile({ mode: "allow", scope: "full", allow: safes({ bus: [3] }) }), emptyBridgeSafes(), noSources);
      expect(policy.refusalFor("/ch/5/send/3/somefuture")).to.equal(null);
      expect(policy.refusalFor("/bus/4/fdr")).to.not.equal(null);
    });

    it("applies the global safes to an allow-list device by default", () => {
      const everyBus = safes({ bus: Array.from({ length: 16 }, (_, i) => i + 1) });
      const policy = policyOf(profile({ mode: "allow", allow: safes({ bus: [3] }) }), everyBus, noSources);
      expect(policy.refusalFor("/bus/3/fdr")).to.equal("bus 3");
    });

    it("with applyGlobal off, gives an allow-list device its own bus even where every bus is safe", () => {
      // The setup it is for: all buses safe for unknown devices, each musician given theirs.
      const everyBus = safes({ bus: Array.from({ length: 16 }, (_, i) => i + 1) });
      const policy = policyOf(profile({ mode: "allow", applyGlobal: false, allow: safes({ bus: [3] }) }), everyBus, noSources);
      expect(policy.refusalFor("/bus/3/fdr")).to.equal(null);
      expect(policy.refusalFor("/ch/6/send/3/lvl")).to.equal(null);
      expect(policy.refusalFor("/bus/4/fdr")).to.equal('not allowed for "Paul"');
      expect(policy.refusalFor("/ch/6/send/4/lvl")).to.equal('not allowed for "Paul"');
      // Never freer than an unknown device outside its list: scenes and /cfg stay refused.
      expect(policy.refusalFor("/$ctl/lib/$action")).to.not.equal(null);
      expect(policy.refusalFor("/cfg/rta/rtasrc")).to.not.equal(null);
    });

    it("reads the global list as a whitelist when asked: only those strips are writable", () => {
      const global = buildGlobalPolicy(safes({ bus: [3] }), noSources, { mode: "whitelist", scope: "mix" });
      expect(global.refusalFor("/bus/3/eq/1/g")).to.equal(null);
      expect(global.refusalFor("/ch/5/send/3/lvl")).to.equal(null);
      expect(global.refusalFor("/ch/5/eq/1/g")).to.equal("not in the allowed strips");
      expect(global.refusalFor("/bus/4/fdr")).to.equal("not in the allowed strips");
      expect(global.allowsUnmapped).to.equal(false);
      // A profile's extra safes still narrow it.
      const narrowed = policyOf(profile({ mode: "safes", safes: safes({ ch: [5] }) }), safes({ bus: [3] }), noSources, { mode: "whitelist" });
      expect(narrowed.refusalFor("/ch/6/send/3/lvl")).to.equal(null);
      expect(narrowed.refusalFor("/ch/5/fdr")).to.not.equal(null);
    });

    it("adds a profile's safes to the global ones", () => {
      const policy = policyOf(profile({ mode: "safes", safes: safes({ bus: [7] }) }), safes({ ch: [1] }), noSources);
      expect(policy.refusalFor("/ch/1/fdr")).to.equal("ch 1");
      expect(policy.refusalFor("/bus/7/fdr")).to.equal("bus 7");
      expect(policy.refusalFor("/bus/8/fdr")).to.equal(null);
      expect(policy.allowsUnmapped).to.equal(true);
    });

    it("walks the allowed subtrees, so the native map can place their ids", () => {
      const policy = policyOf(profile({ mode: "allow", allow: safes({ bus: [3], mtx: [1] }) }), emptyBridgeSafes(), noSources);
      expect(policy.walkPatterns()).to.include.members(["/bus/3/**", "/ch/*/send/3/**", "/main/*/send/mx1/**"]);
    });

    it("refuses a profile that matches nothing", () => {
      expect(() => BridgeProfileSchema.parse({ id: "x", name: "X", match: {}, mode: "allow" })).to.throw(/at least one/);
    });
  });
});
