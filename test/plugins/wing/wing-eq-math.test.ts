import { expect } from "chai";
import {
  cutResponseDb,
  fitNativeEq,
  interpolateCurveDb,
  ISO_THIRD_OCTAVE_EXACT_HZ,
  ISO_THIRD_OCTAVE_NOMINAL_HZ,
  nativeEqResponseDb,
  peakingResponseDb,
  qFromBandwidthOctaves,
  shelfResponseDb,
  RTA_BAND_COUNT,
  RtaAverager,
  rtaBandCenterHz,
  rtaToThirdOctaves,
  smoothBands,
} from "../../../src/plugins/wing/wing-eq-math.js";

describe("wing-eq-math", () => {
  it("maps the 120 RTA bands as 1/12 octaves starting at 20 Hz", () => {
    expect(rtaBandCenterHz(0)).to.be.closeTo(20.6, 0.1);
    expect(rtaBandCenterHz(119)).to.be.closeTo(19897, 1);
    expect(rtaBandCenterHz(12) / rtaBandCenterHz(0)).to.be.closeTo(2, 1e-9);
  });

  it("has 31 ISO third-octave bands with 1 kHz at index 17", () => {
    expect(ISO_THIRD_OCTAVE_NOMINAL_HZ).to.have.length(31);
    expect(ISO_THIRD_OCTAVE_EXACT_HZ[17]).to.equal(1000);
    expect(ISO_THIRD_OCTAVE_EXACT_HZ[0]).to.be.closeTo(19.7, 0.1);
  });

  it("aggregates a flat RTA spectrum into flat third octaves at the same level", () => {
    const thirds = rtaToThirdOctaves(new Array(RTA_BAND_COUNT).fill(-40));
    for (let i = 1; i < 30; i++) expect(thirds[i]).to.be.closeTo(-40, 1e-9);
  });

  it("puts a single-band peak into the third octave containing its frequency", () => {
    const bands = new Array(RTA_BAND_COUNT).fill(-100);
    const oneKhz = bands.findIndex((_, i) => rtaBandCenterHz(i) > 1000);
    bands[oneKhz] = -10;
    const thirds = rtaToThirdOctaves(bands);
    const loudest = thirds.indexOf(Math.max(...thirds.filter(Number.isFinite)));
    expect(ISO_THIRD_OCTAVE_NOMINAL_HZ[loudest]).to.equal(1000);
  });

  it("power-averages RTA frames", () => {
    const averager = new RtaAverager();
    averager.add(new Array(RTA_BAND_COUNT).fill(-20));
    averager.add(new Array(RTA_BAND_COUNT).fill(-20));
    averager.add([1, 2, 3]);
    expect(averager.count).to.equal(2);
    expect(averager.averageDb()[50]).to.be.closeTo(-20, 1e-9);

    const mixed = new RtaAverager();
    mixed.add(new Array(RTA_BAND_COUNT).fill(0));
    mixed.add(new Array(RTA_BAND_COUNT).fill(-200));
    expect(mixed.averageDb()[0]).to.be.closeTo(-3.01, 0.01);
  });

  it("interpolates a target curve in log frequency and holds the ends", () => {
    const curve = [
      { hz: 100, db: 6 },
      { hz: 1000, db: 0 },
    ];
    expect(interpolateCurveDb(curve, 50)).to.equal(6);
    expect(interpolateCurveDb(curve, 5000)).to.equal(0);
    expect(interpolateCurveDb(curve, Math.sqrt(100 * 1000))).to.be.closeTo(3, 1e-9);
    expect(interpolateCurveDb([], 440)).to.equal(0);
  });

  it("smooths neighbouring bands and skips NaN neighbours", () => {
    expect(smoothBands([0, 4, 0])).to.deep.equal([4 / 3, 2, 4 / 3]);
    const withGap = smoothBands([NaN, 4, 0]);
    expect(withGap[0]).to.be.NaN;
    expect(withGap[1]).to.be.closeTo((4 * 0.5 + 0 * 0.25) / 0.75, 1e-9);
  });

  it("models an RBJ peaking band: full gain at the center, ~0 far away", () => {
    expect(peakingResponseDb(1000, 1000, -6, 2)).to.be.closeTo(-6, 0.01);
    expect(peakingResponseDb(50, 1000, -6, 2)).to.be.closeTo(0, 0.05);
    expect(peakingResponseDb(1000, 1000, 0, 2)).to.equal(0);
  });

  it("converts bandwidth to Q (1 octave = sqrt 2)", () => {
    expect(qFromBandwidthOctaves(1)).to.be.closeTo(Math.SQRT2, 1e-9);
    expect(qFromBandwidthOctaves(1 / 3)).to.be.closeTo(4.32, 0.01);
  });

  it("models shelves reaching half their gain at the corner, as measured on the WING", () => {
    expect(shelfResponseDb(200, "low", 200, 6, 1)).to.be.closeTo(3, 0.2);
    expect(shelfResponseDb(40, "low", 200, 6, 1)).to.be.closeTo(6, 0.3);
    expect(shelfResponseDb(4000, "low", 200, 6, 1)).to.be.closeTo(0, 0.1);
    expect(shelfResponseDb(4000, "high", 4000, -6, 1)).to.be.closeTo(-3, 0.2);
    expect(shelfResponseDb(15000, "high", 4000, -6, 1)).to.be.closeTo(-6, 0.5);
  });

  it("models cut slopes (BW12 -3 dB at the corner and 12 dB/oct; LR24 and CUT twice as steep)", () => {
    expect(cutResponseDb(100, "low", 100, "BW12")).to.be.closeTo(-3, 0.1);
    expect(cutResponseDb(50, "low", 100, "BW12")).to.be.closeTo(-12.3, 0.2);
    expect(cutResponseDb(100, "low", 100, "LR24")).to.be.closeTo(-6, 0.1);
    expect(cutResponseDb(50, "low", 100, "CUT")).to.be.closeTo(cutResponseDb(50, "low", 100, "LR24"), 1e-9);
    expect(cutResponseDb(1000, "low", 100, "LR24")).to.be.closeTo(0, 0.01);
    expect(cutResponseDb(16000, "high", 8000, "BW12")).to.be.closeTo(-12.3, 0.2);
  });

  const LIMITS = { gMin: -15, gMax: 15, qMin: 0.44, qMax: 10, fMin: 20, fMax: 20000, minGainDb: 0.5 };

  it("fits bells whose Q follows the width of a known bump and dip", () => {
    const truth = { bells: [{ f: 250, g: -6, q: 1.4 }, { f: 4000, g: 3, q: 4 }], lowShelf: null, highShelf: null };
    const desired = ISO_THIRD_OCTAVE_EXACT_HZ.map((hz) => nativeEqResponseDb(truth, hz));
    const fitted = fitNativeEq(ISO_THIRD_OCTAVE_EXACT_HZ, desired, { ...LIMITS, bellCount: 6, lowBand: false, highBand: false });
    const wide = fitted.bells.find((b) => Math.abs(b.f - 250) < 30)!;
    const narrow = fitted.bells.find((b) => Math.abs(b.f - 4000) < 400)!;
    expect(wide.g).to.be.closeTo(-6, 1);
    expect(narrow.q).to.be.greaterThan(wide.q);
    const residual = ISO_THIRD_OCTAVE_EXACT_HZ.map((hz, i) => desired[i] - nativeEqResponseDb(fitted, hz));
    expect(Math.max(...residual.map(Math.abs))).to.be.lessThan(1.5);
  });

  it("prefers shelves for a broad low/high tilt when they are available", () => {
    const truth = { bells: [], lowShelf: { f: 150, g: 5, q: 0.7 }, highShelf: { f: 6000, g: -4, q: 0.7 } };
    const desired = ISO_THIRD_OCTAVE_EXACT_HZ.map((hz) => nativeEqResponseDb(truth, hz));
    const fitted = fitNativeEq(ISO_THIRD_OCTAVE_EXACT_HZ, desired, { ...LIMITS, bellCount: 6, lowBand: true, highBand: true });
    expect(fitted.lowShelf?.g).to.be.greaterThan(3);
    expect(fitted.highShelf?.g).to.be.lessThan(-2);
    const residual = ISO_THIRD_OCTAVE_EXACT_HZ.map((hz, i) => desired[i] - nativeEqResponseDb(fitted, hz));
    expect(Math.max(...residual.map(Math.abs))).to.be.lessThan(1);
  });

  it("uses L and H as bells when they are free, for up to 8 bells — and only 6 when both are cuts", () => {
    const centers = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
    const truth = { bells: centers.map((f, i) => ({ f, g: i % 2 === 0 ? 4 : -4, q: 4.3 })), lowShelf: null, highShelf: null };
    const desired = ISO_THIRD_OCTAVE_EXACT_HZ.map((hz) => nativeEqResponseDb(truth, hz));
    const free = fitNativeEq(ISO_THIRD_OCTAVE_EXACT_HZ, desired, { ...LIMITS, bellCount: 6, lowBand: true, highBand: true });
    expect(free.bells).to.have.length(8);
    expect(free.lowShelf).to.equal(null);
    expect(free.highShelf).to.equal(null);
    const cut = fitNativeEq(ISO_THIRD_OCTAVE_EXACT_HZ, desired, { ...LIMITS, bellCount: 6, lowBand: false, highBand: false });
    expect(cut.bells).to.have.length(6);
  });

  it("ignores NaN (don't care) bands and places nothing below minGainDb", () => {
    const desired = ISO_THIRD_OCTAVE_EXACT_HZ.map((_, i) => (i < 8 ? NaN : 0.2));
    desired[3] = NaN;
    expect(fitNativeEq(ISO_THIRD_OCTAVE_EXACT_HZ, desired, { ...LIMITS, bellCount: 6, lowBand: true, highBand: true })).to.deep.equal({
      bells: [],
      lowShelf: null,
      highShelf: null,
    });
  });
});
