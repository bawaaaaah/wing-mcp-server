import { expect } from "chai";
import { applyEasing, EASING_NAMES, requireEasingName } from "../../../src/plugins/wing/wing-easing.js";
import { WingValueError } from "../../../src/plugins/wing/wing-errors.js";

describe("wing-easing", () => {
  it("every curve starts at 0 and ends at 1", () => {
    for (const name of EASING_NAMES) {
      expect(applyEasing(name, 0), name).to.be.closeTo(0, 1e-9);
      expect(applyEasing(name, 1), name).to.be.closeTo(1, 1e-9);
    }
  });

  it("clamps out-of-range progress to 0..1", () => {
    expect(applyEasing("linear", -1)).to.equal(0);
    expect(applyEasing("linear", 2)).to.equal(1);
  });

  it("linear is the identity function", () => {
    expect(applyEasing("linear", 0.5)).to.equal(0.5);
    expect(applyEasing("linear", 0.25)).to.equal(0.25);
  });

  it("ease-in curves lag behind linear before the midpoint", () => {
    for (const name of ["quad-in", "cubic-in", "sine-in", "expo-in"] as const) {
      expect(applyEasing(name, 0.5), name).to.be.lessThan(0.5);
    }
  });

  it("ease-out curves lead ahead of linear before the midpoint", () => {
    for (const name of ["quad-out", "cubic-out", "sine-out", "expo-out"] as const) {
      expect(applyEasing(name, 0.5), name).to.be.greaterThan(0.5);
    }
  });

  it("ease-in-out curves are symmetric about the midpoint and hit 0.5 at t=0.5", () => {
    for (const name of ["quad-in-out", "cubic-in-out", "sine-in-out", "expo-in-out"] as const) {
      expect(applyEasing(name, 0.5), name).to.be.closeTo(0.5, 1e-9);
      expect(applyEasing(name, 0.25), name).to.be.lessThan(0.5);
      expect(applyEasing(name, 0.75), name).to.be.greaterThan(0.5);
    }
  });

  it("requireEasingName accepts every declared name and rejects unknown ones", () => {
    for (const name of EASING_NAMES) {
      expect(() => requireEasingName(name)).to.not.throw();
    }
    expect(() => requireEasingName("bogus")).to.throw(WingValueError, /Unknown easing curve/);
  });
});
