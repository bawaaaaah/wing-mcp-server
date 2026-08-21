import { expect } from "chai";
import { parseWingDescribeParams } from "../../../src/plugins/wing/wing-value-codec.js";

describe("parseWingDescribeParams", () => {
  it("parses int/lin/log/list/string/fader lines observed on real hardware", () => {
    const lines = [
      "on             int [0 .. 1]",
      "mdl            list [STD, SOUL, E88, E84, F110, PULSAR, MACH4]",
      "lg             lin [-15.0 .. +15.0 dB], 301 steps",
      "lf             log [20.0 .. 20k00 Hz], 961 steps",
      "name           string [16]",
      "fdr            fader [-oo .. 10.0 dB], 1024 steps",
    ];

    const params = parseWingDescribeParams(lines);
    expect(params).to.have.length(6);

    expect(params[0]).to.deep.equal({ key: "on", kind: "int", min: 0, max: 1, unit: undefined, steps: undefined });

    expect(params[1].kind).to.equal("list");
    expect(params[1].options).to.deep.equal(["STD", "SOUL", "E88", "E84", "F110", "PULSAR", "MACH4"]);

    expect(params[2]).to.deep.equal({ key: "lg", kind: "lin", min: -15, max: 15, unit: "dB", steps: 301 });

    // "20k00" -> 20000 Hz — WING's shorthand for large frequency bounds.
    expect(params[3]).to.deep.equal({ key: "lf", kind: "log", min: 20, max: 20000, unit: "Hz", steps: 961 });

    expect(params[4]).to.deep.equal({ key: "name", kind: "string", maxLength: 16 });

    // "-oo" has no numeric value on the wire; a fader's lower bound defaults to -144 instead.
    expect(params[5]).to.deep.equal({ key: "fdr", kind: "fader", min: -144, max: 10, unit: "dB", steps: 1024 });
  });

  it("parses the '7k0' single-digit-fraction shorthand", () => {
    const params = parseWingDescribeParams(["hc             log [500 .. 7k0 Hz], 51 steps"]);
    expect(params[0].max).to.equal(7000);
  });

  it("drops lines that don't match the expected shape", () => {
    const params = parseWingDescribeParams(["", "   ", "not a valid describe line at all"]);
    expect(params).to.have.length(0);
  });

  it("trims list options with irregular spacing", () => {
    const params = parseWingDescribeParams(["ratio          list [1.5, 2.0, 3.0, 4.0, 5.0,  10]"]);
    expect(params[0].options).to.deep.equal(["1.5", "2.0", "3.0", "4.0", "5.0", "10"]);
  });

  it("parses a '$'-prefixed key with multi-word list options, as seen describing /$ctl/lib", () => {
    // This is the real mechanism scene enumeration relies on: describing the *leaf* "$scenes"
    // never replies on real hardware, but describing its *parent branch* does, and this exact line
    // shape is how the full scene list (in order, matching $actidx) is recovered from that reply.
    const lines = [
      "$scenes        list [entree-epoux, AMI REPET, AMI INSTALL, AMI]",
      "$actidx        int [0 .. 4]",
      "$action        list [IDLE, GOPREV, GONEXT, GO, PREV, NEXT, GOTAG]",
    ];
    const params = parseWingDescribeParams(lines);
    expect(params[0].key).to.equal("$scenes");
    expect(params[0].options).to.deep.equal(["entree-epoux", "AMI REPET", "AMI INSTALL", "AMI"]);
    expect(params[1]).to.deep.equal({ key: "$actidx", kind: "int", min: 0, max: 4, unit: undefined, steps: undefined });
  });
});
