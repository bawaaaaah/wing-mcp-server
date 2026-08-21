import { expect } from "chai";
import { WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import {
  decodeRtaSourceIndex,
  encodeRtaSource,
  RTA_SOURCE_INDEX_MAX,
} from "../../../src/plugins/wing/wing-rta-source.js";

describe("wing-rta-source", () => {
  it("total index range is exactly channel+aux+bus+main+matrix (40+8+16+4+8 = 76)", () => {
    expect(RTA_SOURCE_INDEX_MAX).to.equal(76);
  });

  describe("decodeRtaSourceIndex", () => {
    it("decodes the first and last channel index", () => {
      expect(decodeRtaSourceIndex(1)).to.deep.equal({ type: "channel", index: 1 });
      expect(decodeRtaSourceIndex(40)).to.deep.equal({ type: "channel", index: 40 });
    });

    it("decodes the aux range immediately after channels", () => {
      expect(decodeRtaSourceIndex(41)).to.deep.equal({ type: "aux", index: 1 });
      expect(decodeRtaSourceIndex(48)).to.deep.equal({ type: "aux", index: 8 });
    });

    it("decodes the bus range", () => {
      expect(decodeRtaSourceIndex(49)).to.deep.equal({ type: "bus", index: 1 });
      expect(decodeRtaSourceIndex(64)).to.deep.equal({ type: "bus", index: 16 });
    });

    it("decodes the main range", () => {
      expect(decodeRtaSourceIndex(65)).to.deep.equal({ type: "main", index: 1 });
      expect(decodeRtaSourceIndex(68)).to.deep.equal({ type: "main", index: 4 });
    });

    it("decodes the matrix range, ending at the documented maximum", () => {
      expect(decodeRtaSourceIndex(69)).to.deep.equal({ type: "matrix", index: 1 });
      expect(decodeRtaSourceIndex(76)).to.deep.equal({ type: "matrix", index: 8 });
    });

    it("returns null for 0 and for anything past the documented maximum", () => {
      expect(decodeRtaSourceIndex(0)).to.equal(null);
      expect(decodeRtaSourceIndex(77)).to.equal(null);
      expect(decodeRtaSourceIndex(-1)).to.equal(null);
    });
  });

  describe("encodeRtaSource", () => {
    it("round-trips every boundary decoded above", () => {
      expect(encodeRtaSource({ type: "channel", index: 1 })).to.equal(1);
      expect(encodeRtaSource({ type: "channel", index: 40 })).to.equal(40);
      expect(encodeRtaSource({ type: "aux", index: 1 })).to.equal(41);
      expect(encodeRtaSource({ type: "aux", index: 8 })).to.equal(48);
      expect(encodeRtaSource({ type: "bus", index: 1 })).to.equal(49);
      expect(encodeRtaSource({ type: "bus", index: 16 })).to.equal(64);
      expect(encodeRtaSource({ type: "main", index: 1 })).to.equal(65);
      expect(encodeRtaSource({ type: "main", index: 4 })).to.equal(68);
      expect(encodeRtaSource({ type: "matrix", index: 1 })).to.equal(69);
      expect(encodeRtaSource({ type: "matrix", index: 8 })).to.equal(76);
    });

    it("throws WingValueError for an out-of-range index within a valid type", () => {
      expect(() => encodeRtaSource({ type: "main", index: 5 })).to.throw(WingValueError);
      expect(() => encodeRtaSource({ type: "channel", index: 0 })).to.throw(WingValueError);
    });
  });
});
