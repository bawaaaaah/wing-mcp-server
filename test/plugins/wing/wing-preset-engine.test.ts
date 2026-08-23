import { expect } from "chai";
import {
  classifyRawKey,
  filterRawDumpForCapture,
  resolveLoadTargets,
} from "../../../src/plugins/wing/wing-preset-engine.js";
import type { PresetSlot } from "../../../src/plugins/wing/wing-preset-store.js";

function fakeSlot(sourceIndex: number): PresetSlot {
  return {
    sourceIndex,
    raw: {},
    corrected: {
      tags: "",
      inConnGrp: null,
      inConnIn: null,
      inSetTrim: null,
      inSetSrcauto: null,
      ownName: "",
      effectiveName: "",
    },
    preampGain: null,
  };
}

describe("classifyRawKey", () => {
  it("classifies pan/wid as the pan section", () => {
    expect(classifyRawKey("pan")).to.equal("pan");
    expect(classifyRawKey("wid")).to.equal("pan");
  });

  it("classifies fdr as fader and mute as mute", () => {
    expect(classifyRawKey("fdr")).to.equal("fader");
    expect(classifyRawKey("mute")).to.equal("mute");
  });

  it("classifies eq.*, flt.*, and peq.* as the eq section", () => {
    expect(classifyRawKey("eq.on")).to.equal("eq");
    expect(classifyRawKey("eq.1g")).to.equal("eq");
    expect(classifyRawKey("flt.on")).to.equal("eq");
    expect(classifyRawKey("peq.on")).to.equal("eq");
  });

  it("classifies gate.* and dyn.* as their own sections", () => {
    expect(classifyRawKey("gate.thr")).to.equal("gate");
    expect(classifyRawKey("dyn.ratio")).to.equal("dyn");
  });

  it("classifies send.* and main.* as sends", () => {
    expect(classifyRawKey("send.3.lvl")).to.equal("sends");
    expect(classifyRawKey("main.1.on")).to.equal("sends");
  });

  it("falls back to uncategorized for cosmetic/unknown fields", () => {
    expect(classifyRawKey("col")).to.equal("uncategorized");
    expect(classifyRawKey("icon")).to.equal("uncategorized");
    expect(classifyRawKey("led")).to.equal("uncategorized");
    expect(classifyRawKey("clink")).to.equal("uncategorized");
    expect(classifyRawKey("mon")).to.equal("uncategorized");
    expect(classifyRawKey("something.new")).to.equal("uncategorized");
  });
});

describe("filterRawDumpForCapture", () => {
  it("strips read-only $-shadow mirrors", () => {
    const out = filterRawDumpForCapture({ fdr: -6, "$fdr": -6, "eq.$on": 1 });
    expect(out).to.deep.equal({ fdr: -6 });
  });

  it("strips tags/.tags, name, and anything under in.*", () => {
    const out = filterRawDumpForCapture({
      fdr: -6,
      tags: "#D3",
      ".tags": "#D3",
      name: "Kick",
      "in.conn.grp": "A",
      "in.set.trim": 2,
    });
    expect(out).to.deep.equal({ fdr: -6 });
  });

  it("keeps every other key untouched", () => {
    const dump = { fdr: -6, mute: 0, pan: 0, "eq.on": 1, "eq.1g": 3.2, "send.3.lvl": -10, "main.1.on": 1 };
    expect(filterRawDumpForCapture(dump)).to.deep.equal(dump);
  });

  it("naturally reduces to a mute group's tiny field set (mute/name only, nothing to strip)", () => {
    // A real mutegroup dump() never contains fdr/eq/pan/etc at all — filterRawDumpForCapture doesn't
    // need to know that; it just passes through whatever a type's dump() actually returned.
    expect(filterRawDumpForCapture({ mute: 0 })).to.deep.equal({ mute: 0 });
  });
});

describe("resolveLoadTargets", () => {
  it("defaults to the original source indices when nothing is given", () => {
    const slots = [fakeSlot(17), fakeSlot(18)];
    expect(resolveLoadTargets("channel", slots, {})).to.deep.equal([17, 18]);
  });

  it("shifts a whole group by an offset when targetIndex is given (the Drums 17-24 -> 9 example)", () => {
    const slots = Array.from({ length: 8 }, (_, i) => fakeSlot(17 + i));
    expect(resolveLoadTargets("channel", slots, { targetIndex: 9 })).to.deep.equal([9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("resolves a single-strip preset's targetIndex directly", () => {
    const slots = [fakeSlot(1)];
    expect(resolveLoadTargets("channel", slots, { targetIndex: 3 })).to.deep.equal([3]);
  });

  it("uses an explicit targetIndices mapping when given", () => {
    const slots = [fakeSlot(17), fakeSlot(18)];
    expect(resolveLoadTargets("channel", slots, { targetIndices: [5, 9] })).to.deep.equal([5, 9]);
  });

  it("rejects a targetIndices list whose length doesn't match the slot count", () => {
    const slots = [fakeSlot(17), fakeSlot(18)];
    expect(() => resolveLoadTargets("channel", slots, { targetIndices: [5] })).to.throw(/entries but the preset has/);
  });

  it("rejects an out-of-range resolved target channel", () => {
    const slots = [fakeSlot(38), fakeSlot(39), fakeSlot(40)];
    expect(() => resolveLoadTargets("channel", slots, { targetIndex: 39 })).to.throw(/out of range/);
  });

  it("rejects duplicate resolved target indices", () => {
    const slots = [fakeSlot(1), fakeSlot(2)];
    expect(() => resolveLoadTargets("channel", slots, { targetIndices: [5, 5] })).to.throw(/duplicates/);
  });

  it("enforces the type-specific count, not the channel count (mutegroup only goes up to 8)", () => {
    const slots = [fakeSlot(1)];
    expect(() => resolveLoadTargets("mutegroup", slots, { targetIndex: 9 })).to.throw(/out of range \(1\.\.8\)/);
    expect(resolveLoadTargets("mutegroup", slots, { targetIndex: 8 })).to.deep.equal([8]);
  });

  it("enforces the DCA count (1..16)", () => {
    const slots = [fakeSlot(1)];
    expect(() => resolveLoadTargets("dca", slots, { targetIndex: 17 })).to.throw(/out of range \(1\.\.16\)/);
  });
});
