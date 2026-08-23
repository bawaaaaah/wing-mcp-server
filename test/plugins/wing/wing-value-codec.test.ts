import { expect } from "chai";
import { buildBulkSetString, parseFlatAssignmentString, parseWingDescribeParams } from "../../../src/plugins/wing/wing-value-codec.js";

describe("buildBulkSetString", () => {
  it("leaves flat, single-level keys unchanged (backward compatible)", () => {
    expect(buildBulkSetString({ fdr: -10, mute: 1 })).to.equal("fdr=-10,mute=1");
  });

  it(
    "does NOT repeat a shared prefix on sibling keys — confirmed live that " +
      '"eq.on=1,eq.mdl=STD" literally acks NODE NOT FOUND (the console reads the second entry as a ' +
      'further descent to the nonsensical "eq.eq.mdl"); the first key keeps its full path, later ' +
      "siblings go bare",
    () => {
      expect(buildBulkSetString({ "eq.on": 1, "eq.mdl": "STD" })).to.equal("eq.on=1,mdl=STD");
    },
  );

  it("emits a leading dot to pop back to a shared ancestor before descending into a new sibling branch", () => {
    // send.1.* then send.2.* — must pop back from "send.1" to "send" before descending into "2"
    expect(buildBulkSetString({ "send.1.on": 1, "send.1.lvl": -4.3, "send.2.on": 1 })).to.equal(
      "send.1.on=1,lvl=-4.3,.2.on=1",
    );
  });

  it("emits multiple leading dots to pop back multiple levels at once", () => {
    // send.1.on/lvl establishes a 2-deep context (send, 1); a fresh root-level key pops both away
    expect(buildBulkSetString({ "send.1.on": 1, "send.1.lvl": -4.3, mute: 0 })).to.equal(
      "send.1.on=1,lvl=-4.3,..mute=0",
    );
  });

  it("round-trips through parseFlatAssignmentString for a realistic multi-section restore payload", () => {
    const assignments = {
      "eq.on": 1,
      "eq.mdl": "STD",
      "eq.1g": 0,
      "eq.1f": 200,
      "gate.on": 1,
      "gate.thr": -12,
      "send.1.on": 1,
      "send.1.lvl": -4.3,
      "send.2.on": 1,
      "send.2.lvl": -5,
    };
    const encoded = buildBulkSetString(assignments);
    expect(parseFlatAssignmentString(encoded)).to.deep.equal(assignments);
  });
});

describe("parseFlatAssignmentString", () => {
  it("keeps flat, single-segment keys exactly as before (no leading/internal dots)", () => {
    expect(parseFlatAssignmentString("name=Kick,mute=0,fdr=-6,pan=0")).to.deep.equal({
      name: "Kick",
      mute: 0,
      fdr: -6,
      pan: 0,
    });
  });

  it("expands a bare multi-segment key (0 leading dots) relative to the current (root) context", () => {
    expect(parseFlatAssignmentString("in.set.srcauto=1,altsrc=0")).to.deep.equal({
      "in.set.srcauto": 1,
      "in.set.altsrc": 0,
    });
  });

  it("pops N segments off the context for N leading dots, then descends via the remaining segments", () => {
    // in.set.* -> pop 1 -> in.* -> descend via conn.grp -> in.conn.grp; next bare key inherits in.conn.*
    const result = parseFlatAssignmentString("in.set.srcauto=1,.conn.grp=A,in=1");
    expect(result).to.deep.equal({ "in.set.srcauto": 1, "in.conn.grp": "A", "in.conn.in": 1 });
  });

  it("clamps a pop count larger than the current context depth instead of throwing", () => {
    // No prior context at all — a leading dot still just proceeds from an (already-empty) root context.
    expect(parseFlatAssignmentString(".conn.grp=A,in=1")).to.deep.equal({ "conn.grp": "A", "conn.in": 1 });
  });

  it("pops multiple segments at once for multiple leading dots", () => {
    // context: in.conn (2 segments) -> pop 2 -> root -> descend via flt.lc -> flt.lc; bare keys inherit flt.*
    const result = parseFlatAssignmentString("in.set.srcauto=1,.conn.grp=A,..flt.lc=1,lcf=151.1");
    expect(result).to.deep.equal({ "in.set.srcauto": 1, "in.conn.grp": "A", "flt.lc": 1, "flt.lcf": 151.1 });
  });

  it("strips single-quoted values and does not split on a comma inside them", () => {
    expect(parseFlatAssignmentString(".tags='#D1,#M1'")).to.deep.equal({ tags: "#D1,#M1" });
  });

  it("ignores a malformed all-dots key instead of throwing", () => {
    expect(parseFlatAssignmentString("...=1,name=Kick")).to.deep.equal({ name: "Kick" });
  });

  it(
    "reproduces a full real-hardware channel dump byte-for-byte (verified live against a WING console, " +
      "name substituted): every nested section (in.set, in.conn, flt, peq, gate, gatesc, eq, dyn, dynxo, " +
      "dynsc, preins, main.N, send.N, send.MXN, postins, tags) expands to its correct dotted path",
    () => {
      const raw =
        "in.set.srcauto=1,altsrc=0,inv=0,trim=0.0,bal=0.0,dlymode=M,dly=0.1,dlyon=0,.conn.grp=A,in=1,altgrp=CRD," +
        "altin=1,..flt.lc=1,lcf=151.1,lcs=24,hc=0,hcf=6k05,hcs=12,tf=0,mdl=TILT,tilt=0.00,.clink=0,col=12,name=TestCh," +
        "icon=113,led=1,mute=0,fdr=0.0,pan=0,wid=100,solosafe=0,mon=A,proc=EDGI,ptap=3,peq.on=0,1g=0.0,1f=100,1q=1.00," +
        "2g=0.0,2f=999,2q=1.00,3g=0.0,3f=10k0,3q=1.00,.gate.on=1,mdl=RED3,mix=100,gain=0.0,thr=-12.0,ratio=4.0,att=2.0," +
        "rel=100,auto=0,.gatesc.type=OFF,f=1k0,q=2.00,src=SELF,tap=IN,.eq.on=1,mdl=STD,mix=100,lg=0.0,lf=80.2,lq=1.00," +
        "leq=SHV,1g=0.0,1f=200.0,1q=1.00,2g=0.0,2f=601.4,2q=1.00,3g=0.0,3f=1k50,3q=1.00,4g=0.0,4f=3k99,4q=1.00,hg=0.0," +
        "hf=12k00,hq=1.00,heq=SHV,.dyn.on=1,mdl=76LA,mix=100,gain=0.0,in=-30.0,out=-27.0,att=2.0,rel=2.0,ratio=4," +
        ".dynxo.depth=6.0,type=OFF,f=1k0,q=0.40,.dynsc.type=OFF,f=1k0,q=2.00,src=SELF,tap=IN,.preins.on=1,ins=NONE," +
        ".main.1.on=0,lvl=-oo,pre=0,.2.on=1,lvl=0.0,pre=0,.3.on=1,lvl=0.0,pre=0,.4.on=1,lvl=0.0,pre=0,..send.1.on=1," +
        "lvl=-4.3,pon=0,mode=PRE,plink=0,pan=0,.2.on=1,lvl=-4.3,pon=0,mode=PRE,plink=0,pan=0,.3.on=1,lvl=0.0,pon=0," +
        "mode=PRE,plink=0,pan=0,.4.on=1,lvl=-5.0,pon=0,mode=PRE,plink=0,pan=0,.5.on=1,lvl=-1.4,pon=0,mode=PRE,plink=0," +
        "pan=0,.6.on=1,lvl=-5.0,pon=0,mode=PRE,plink=0,pan=0,.7.on=1,lvl=-5.0,pon=0,mode=PRE,plink=0,pan=0,.8.on=1," +
        "lvl=-5.0,pon=0,mode=PRE,plink=0,pan=0,.9.on=0,lvl=-10.0,pon=0,mode=PRE,plink=0,pan=0,.10.on=1,lvl=-oo,pon=0," +
        "mode=PRE,plink=0,pan=0,.11.on=0,lvl=-oo,pon=0,mode=PRE,plink=1,pan=0,.12.on=0,lvl=-oo,pon=0,mode=PRE,plink=1," +
        "pan=0,.13.on=1,lvl=-oo,pon=0,mode=GRP,plink=1,pan=0,.14.on=0,lvl=-oo,pon=0,mode=GRP,plink=1,pan=0,.15.on=0," +
        "lvl=-oo,pon=0,mode=POST,plink=1,pan=0,.16.on=0,lvl=-oo,pon=0,mode=POST,plink=1,pan=0,.MX1.on=0,lvl=-oo,pon=0," +
        "mode=PRE,plink=0,pan=0,.MX2.on=0,lvl=-oo,pon=0,mode=PRE,plink=0,pan=0,.MX3.on=0,lvl=-oo,pon=0,mode=PRE," +
        "plink=0,pan=0,.MX4.on=0,lvl=-oo,pon=0,mode=PRE,plink=0,pan=0,.MX5.on=0,lvl=-oo,pon=0,mode=PRE,plink=0,pan=0," +
        ".MX6.on=0,lvl=-oo,pon=0,mode=PRE,plink=0,pan=0,.MX7.on=0,lvl=-oo,pon=0,mode=PRE,plink=0,pan=0,.MX8.on=0," +
        "lvl=-oo,pon=0,mode=PRE,plink=0,pan=0,..tapwid=100,postins.on=0,mode=FX,ins=NONE,w=0.0,.tags='#D1,#M1',";

      const result = parseFlatAssignmentString(raw);

      // Spot-check every distinct nested section rather than asserting the full ~110-key object —
      // enough to prove the context-stack pop/descend logic is applied correctly across the whole
      // real dump, including the two double-dot pops (flt, send) and the tags quoting.
      expect(result["in.set.srcauto"]).to.equal(1);
      expect(result["in.set.dlyon"]).to.equal(0);
      expect(result["in.conn.grp"]).to.equal("A");
      expect(result["in.conn.in"]).to.equal(1);
      expect(result["flt.lc"]).to.equal(1);
      expect(result["flt.hcf"]).to.equal("6k05");
      expect(result.clink).to.equal(0);
      expect(result.name).to.equal("TestCh");
      expect(result.fdr).to.equal(0);
      expect(result["peq.on"]).to.equal(0);
      expect(result["peq.1g"]).to.equal(0);
      expect(result["peq.3f"]).to.equal("10k0");
      expect(result["gate.on"]).to.equal(1);
      expect(result["gate.thr"]).to.equal(-12);
      expect(result["gatesc.type"]).to.equal("OFF");
      expect(result["gatesc.src"]).to.equal("SELF");
      expect(result["eq.on"]).to.equal(1);
      expect(result["eq.lf"]).to.equal(80.2);
      expect(result["eq.4f"]).to.equal("3k99");
      expect(result["eq.heq"]).to.equal("SHV");
      expect(result["dyn.on"]).to.equal(1);
      expect(result["dyn.in"]).to.equal(-30);
      expect(result["dynxo.depth"]).to.equal(6);
      expect(result["dynsc.type"]).to.equal("OFF");
      expect(result["preins.on"]).to.equal(1);
      expect(result["main.1.on"]).to.equal(0);
      expect(result["main.1.lvl"]).to.equal("-oo");
      expect(result["main.2.on"]).to.equal(1);
      expect(result["main.4.pre"]).to.equal(0);
      expect(result["send.1.on"]).to.equal(1);
      expect(result["send.1.lvl"]).to.equal(-4.3);
      expect(result["send.2.mode"]).to.equal("PRE");
      expect(result["send.16.on"]).to.equal(0);
      expect(result["send.MX1.on"]).to.equal(0);
      expect(result["send.MX8.pan"]).to.equal(0);
      expect(result.tapwid).to.equal(100);
      expect(result["postins.on"]).to.equal(0);
      expect(result["postins.mode"]).to.equal("FX");
      expect(result["postins.w"]).to.equal(0);
      expect(result.tags).to.equal("#D1,#M1");
    },
  );
});

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
