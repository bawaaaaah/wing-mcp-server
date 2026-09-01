import { expect } from "chai";
import {
  gainReductionFullScaleDb,
  gainReductionScaleCorrection,
  isBidirectionalDynModel,
  resolveCompressionControl,
  type DynSlotSettings,
} from "../../../src/plugins/wing/wing-dynamics-models.js";

describe("wing-dynamics-models", () => {
  describe("isBidirectionalDynModel", () => {
    it("is true for Dynamic EQ models (mdl starting with DEQ)", () => {
      expect(isBidirectionalDynModel("DEQ")).to.equal(true);
      expect(isBidirectionalDynModel("DEQ2")).to.equal(true);
      expect(isBidirectionalDynModel("deq2")).to.equal(true);
    });

    it("is false for every cut-only model verified against real hardware", () => {
      for (const mdl of ["GATE", "CMB", "76LA", "SBUS", "NSTR", "COMP"]) {
        expect(isBidirectionalDynModel(mdl)).to.equal(false);
      }
    });

    it("is false for undefined (no model info available)", () => {
      expect(isBidirectionalDynModel(undefined)).to.equal(false);
    });
  });

  describe("gainReductionFullScaleDb / gainReductionScaleCorrection", () => {
    it('reads the "GATE" model\'s own live `range` setting instead of a hardcoded 60', () => {
      expect(gainReductionFullScaleDb({ mdl: "GATE", range: 30 })).to.equal(30);
      expect(gainReductionScaleCorrection({ mdl: "GATE", range: 30 })).to.equal(1.5);
      // range turned all the way up (its describe()'d max) still works, no longer hardcoded but
      // arriving at the same number the protocol doc calls out ("Standard Wing gate is 60 dB").
      expect(gainReductionFullScaleDb({ mdl: "GATE", range: 60 })).to.equal(60);
      expect(gainReductionScaleCorrection({ mdl: "GATE", range: 60 })).to.equal(3);
    });

    it('falls back to 60dB for the "GATE" model if `range` is ever missing from the settings', () => {
      expect(gainReductionFullScaleDb({ mdl: "GATE" })).to.equal(60);
      expect(gainReductionScaleCorrection({ mdl: "GATE" })).to.equal(3);
    });

    it("uses the documented DEFAULT 20dB range (correction 1) for every other model, even ones with their own range-like knob (e.g. CMB's depth)", () => {
      const settingsToCheck: DynSlotSettings[] = [
        { mdl: "COMP" },
        { mdl: "CMB", depth: 20 },
        { mdl: "SBUS" },
        { mdl: "GATED", range: 60 },
      ];
      for (const settings of settingsToCheck) {
        expect(gainReductionFullScaleDb(settings)).to.equal(20);
        expect(gainReductionScaleCorrection(settings)).to.equal(1);
      }
    });

    it("flips the SIGN (not the magnitude) for the models whose meter reports reduction inverted", () => {
      // Verified live: 76LA/L100/RIDE read a clean monotonic 0 -> +full-scale that DEEPENS with
      // compression; DEQ/DEQ2 read a band CUT as positive and a BOOST as negative — all opposite the
      // usual "reduction is negative" convention. Magnitude (full-scale) is untouched.
      for (const mdl of ["76LA", "L100", "RIDE", "DEQ", "DEQ2", "deq2"]) {
        expect(gainReductionFullScaleDb({ mdl })).to.equal(20);
        expect(gainReductionScaleCorrection({ mdl })).to.equal(-1);
      }
    });

    it("is case-insensitive on the model name", () => {
      expect(gainReductionScaleCorrection({ mdl: "gate", range: 60 })).to.equal(3);
    });

    it("returns the 20dB default for undefined settings or a settings object with no mdl", () => {
      expect(gainReductionFullScaleDb(undefined)).to.equal(20);
      expect(gainReductionScaleCorrection(undefined)).to.equal(1);
      expect(gainReductionScaleCorrection({ on: 1 })).to.equal(1);
    });
  });

  describe("resolveCompressionControl", () => {
    it('resolves a plain threshold model to "thr" with compressor polarity', () => {
      expect(resolveCompressionControl(["on", "thr", "gain"])).to.deep.equal({
        kind: "threshold",
        key: "thr",
        initialPolarity: 1,
      });
    });

    it('resolves a split comp/limiter model (no "thr") to "cthr" with compressor polarity', () => {
      expect(resolveCompressionControl(["on", "cthr", "lthr", "gain", "ratio"])).to.deep.equal({
        kind: "threshold",
        key: "cthr",
        initialPolarity: 1,
      });
    });

    it('resolves an 1176-style model to "in" with inverted (input-drive) polarity', () => {
      expect(resolveCompressionControl(["on", "in", "out", "gain", "ratio"])).to.deep.equal({
        kind: "input-gain",
        key: "in",
        initialPolarity: -1,
      });
    });

    it('resolves an LA-2A-style model to "peak" (its Peak Reduction knob), not the inert "ingain" make-up trim', () => {
      expect(resolveCompressionControl(["on", "ingain", "peak", "mode"])).to.deep.equal({
        kind: "input-gain",
        key: "peak",
        initialPolarity: -1,
      });
    });

    it('resolves a Dual Dynamic EQ (no plain "thr") to band 1\'s "1-thr" as a threshold', () => {
      expect(resolveCompressionControl(["on", "1-thr", "2-thr", "1-g", "1-ratio"])).to.deep.equal({
        kind: "threshold",
        key: "1-thr",
        initialPolarity: 1,
      });
    });

    it('resolves a one-knob compressor to its unitless amount knob ("gr" ONEC / "comp" LMT) with inverted polarity', () => {
      expect(resolveCompressionControl(["on", "gr", "dag", "gain"])).to.deep.equal({
        kind: "input-gain",
        key: "gr",
        initialPolarity: -1,
      });
      expect(resolveCompressionControl(["on", "comp", "con", "gain"])).to.deep.equal({
        kind: "input-gain",
        key: "comp",
        initialPolarity: -1,
      });
    });

    it("prefers a threshold key over any drive/amount key, and orders within each group", () => {
      expect(resolveCompressionControl(["thr", "cthr"])?.key).to.equal("thr");
      expect(resolveCompressionControl(["thr", "1-thr"])?.key).to.equal("thr");
      expect(resolveCompressionControl(["cthr", "1-thr"])?.key).to.equal("cthr");
      expect(resolveCompressionControl(["thr", "ingain"])?.key).to.equal("thr"); // e.g. CMB
      expect(resolveCompressionControl(["cthr", "in"])?.key).to.equal("cthr");
      // Drive/amount group: peak > gr > comp > in > ingain. `ingain` is dead last — on LA/L100 it's
      // just make-up trim, so a model that also exposes a real amount knob must pick that instead.
      expect(resolveCompressionControl(["ingain", "peak"])?.key).to.equal("peak"); // LA-2A
      expect(resolveCompressionControl(["ingain", "gr"])?.key).to.equal("gr"); // L100 has both
      expect(resolveCompressionControl(["in", "ingain"])?.key).to.equal("in"); // NSTR-ish
      expect(resolveCompressionControl(["gr", "comp"])?.key).to.equal("gr");
      expect(resolveCompressionControl(["peak", "gr", "comp", "in"])?.key).to.equal("peak");
    });

    it("returns null for a model that exposes no threshold or drive/amount control (DS902/WAVE/WARM)", () => {
      expect(resolveCompressionControl(["on", "f", "range", "mode"])).to.equal(null); // DS902 de-esser
      expect(resolveCompressionControl(["on", "att", "sust", "g"])).to.equal(null); // WAVE transient designer
      expect(resolveCompressionControl(["on", "mix", "gain"])).to.equal(null);
      expect(resolveCompressionControl([])).to.equal(null);
    });
  });
});
