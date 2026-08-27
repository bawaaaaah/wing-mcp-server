import { expect } from "chai";
import {
  gainReductionFullScaleDb,
  gainReductionScaleCorrection,
  isBidirectionalDynModel,
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
        { mdl: "76LA" },
        { mdl: "DEQ2" },
        { mdl: "GATED", range: 60 },
      ];
      for (const settings of settingsToCheck) {
        expect(gainReductionFullScaleDb(settings)).to.equal(20);
        expect(gainReductionScaleCorrection(settings)).to.equal(1);
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
});
