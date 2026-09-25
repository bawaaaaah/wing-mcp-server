import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { registerAutoEqTools } from "../../../src/plugins/wing/tools/auto-eq.js";
import { resolveGeqBandKeys, runAutoEqBalance, undoAutoEqBalance, type AutoEqBalanceOptions } from "../../../src/plugins/wing/wing-auto-eq.js";
import {
  cutResponseDb,
  isCutSlope,
  ISO_THIRD_OCTAVE_EXACT_HZ,
  ISO_THIRD_OCTAVE_NOMINAL_HZ,
  nativeEqResponseDb,
  RTA_BAND_COUNT,
  rtaBandCenterHz,
  type PeqBand,
} from "../../../src/plugins/wing/wing-eq-math.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";
import { WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import { WingMicCalibrationStore } from "../../../src/plugins/wing/wing-mic-calibration-store.js";
import { parseWingDescribeNumber, parseWingDescribeParams } from "../../../src/plugins/wing/wing-value-codec.js";

type Value = number | string;

const MIC = 30;
// Band keys as reported by a real WING GEQ (describe /fx/10, 2026-09-16), including the TRIM decoy.
const GEQ_KEYS = [
  "20", "25", "31", "40", "50", "63", "80", "100", "125", "160", "200", "250", "315", "400", "500", "630", "800",
  "1k", "1k25", "1k6", "2k", "2k5", "3k15", "4k", "5k", "6k3", "8k", "10k", "12k5", "16k", "20k",
];
const GEQ_DESCRIBE = [
  "mdl list [NONE, EXT, GEQ, PIA]",
  "fxmix lin [0 .. 100 %], 101 steps",
  "$esrc r/o int [0 .. 448]",
  "type list [STD, TRU]",
  ...GEQ_KEYS.map((k) => `${k} lin [-15.00 .. 15.00 dB], 121 steps`),
  "TRIM lin [-15.00 .. 15.00 dB], 121 steps",
];
// Shape of a real bus/main/matrix 8-band EQ describe (verified on hardware): L, bands 1-6, H, tilt.
const STRIP_EQ_DESCRIBE = [
  "on int [0 .. 1]",
  "lg lin [-15.0 .. +15.0 dB], 301 steps",
  "lf log [20.0 .. 20k00 Hz], 961 steps",
  "lq log [0.44 .. 10.00], 181 steps",
  "leq list [PEQ, SHV, CUT, BW6, BW12, BS12, LR12, BW18, BW24, BS24, LR24, BW48, LR48]",
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [
    `${n}g lin [-15.0 .. +15.0 dB], 301 steps`,
    `${n}f log [20.0 .. 20k00 Hz], 961 steps`,
    `${n}q log [0.44 .. 10.00], 181 steps`,
  ]),
  "hg lin [-15.0 .. +15.0 dB], 301 steps",
  "hf log [20.0 .. 20k00 Hz], 961 steps",
  "hq log [0.44 .. 10.00], 181 steps",
  "heq list [PEQ, SHV, CUT, BW6, BW12, BS12, LR12, BW18, BW24, BS24, LR24, BW48, LR48]",
  "tilt lin [-6.00 .. +6.00 dB], 49 steps",
];

const bump = (hz: number, centerHz: number, db: number, sigmaOct: number) => db * Math.exp(-(Math.log2(hz / centerHz) ** 2) / (2 * sigmaOct ** 2));

function nearestIsoBand(hz: number): number {
  let best = 0;
  ISO_THIRD_OCTAVE_EXACT_HZ.forEach((center, k) => {
    if (Math.abs(Math.log(hz / center)) < Math.abs(Math.log(hz / ISO_THIRD_OCTAVE_EXACT_HZ[best]))) best = k;
  });
  return best;
}

interface FakeConsoleOptions {
  room: (hz: number) => number;
  /** Which strip (node path) drives the speaker the mic hears at this frequency (e.g. FOH/SUB crossover). */
  stripFor?: (hz: number) => string;
  refLevelDb?: number;
  micOffsetDb?: number;
  /** The measurement mic's own frequency response, added to what it reads. */
  micResponse?: (hz: number) => number;
}

/**
 * A stateful fake WING: every bulkSet lands in `values`, and the RTA stream is synthesised from that
 * state — the matrix input shows the (slightly coloured) pink noise, the mic shows noise + room +
 * whatever GEQ/parametric EQ is currently active on the matrix feeding that frequency.
 */
function createFakeConsole(opts: FakeConsoleOptions) {
  const values = new Map<string, Value>();
  const describes = new Map<string, string[]>();
  const writes: { baseNode: string; assignments: Record<string, Value> }[] = [];

  values.set("/cfg/rta/rtasrc", 7);
  values.set("/cfg/rta/rtatap", "POST");
  values.set("/cfg/rta/rtadet", "PEAK");
  values.set("/cfg/rta/rtadecay", "MED");
  values.set("/cfg/rta/rtaauto", 1);
  values.set(`/ch/${MIC}/mute`, 1);
  values.set(`/ch/${MIC}/fdr`, -144);
  for (let n = 1; n <= 16; n++) values.set(`/fx/${n}/mdl`, "NONE");
  const strips = [
    ...Array.from({ length: 16 }, (_, i) => `/bus/${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `/main/${i + 1}`),
    ...Array.from({ length: 8 }, (_, i) => `/mtx/${i + 1}`),
  ];
  for (const strip of strips) {
    values.set(`${strip}/preins/on`, 0);
    values.set(`${strip}/preins/ins`, "NONE");
    values.set(`${strip}/postins/on`, 0);
    values.set(`${strip}/postins/ins`, "NONE");
    values.set(`${strip}/postins/mode`, "FX");
    values.set(`${strip}/postins/w`, 0);
    values.set(`${strip}/eq/on`, 0);
    values.set(`${strip}/eq/tilt`, 0);
    for (let b = 1; b <= 6; b++) {
      values.set(`${strip}/eq/${b}g`, "0.0");
      // Real dumps format kHz values as "1k50" and gains with an explicit sign.
      values.set(`${strip}/eq/${b}f`, ["129.9", "299.2", "699.5", "1k50", "2k99", "6k01"][b - 1]);
      values.set(`${strip}/eq/${b}q`, 1);
    }
    values.set(`${strip}/eq/lg`, "0.0");
    values.set(`${strip}/eq/lf`, "60.1");
    values.set(`${strip}/eq/lq`, 1);
    values.set(`${strip}/eq/leq`, "SHV");
    values.set(`${strip}/eq/hg`, "0.0");
    values.set(`${strip}/eq/hf`, "12k00");
    values.set(`${strip}/eq/hq`, 1);
    values.set(`${strip}/eq/heq`, "SHV");
    describes.set(`${strip}/eq`, STRIP_EQ_DESCRIBE);
  }

  const loadGeq = (slot: number) => {
    values.set(`/fx/${slot}/mdl`, "GEQ");
    describes.set(`/fx/${slot}`, GEQ_DESCRIBE);
    values.set(`/fx/${slot}/TRIM`, 0);
    for (const key of GEQ_KEYS) {
      if (!values.has(`/fx/${slot}/${key}`)) values.set(`/fx/${slot}/${key}`, 0);
    }
  };

  const eqEffectDb = (strip: string, hz: number): number => {
    let total = 0;
    for (const slot of ["preins", "postins"]) {
      const fx = /^FX(\d+)$/.exec(String(values.get(`${strip}/${slot}/ins`)));
      if (fx && Number(values.get(`${strip}/${slot}/on`)) === 1 && values.get(`/fx/${fx[1]}/mdl`) === "GEQ") {
        total += Number(values.get(`/fx/${fx[1]}/${GEQ_KEYS[nearestIsoBand(hz)]}`) ?? 0);
      }
    }
    if (Number(values.get(`${strip}/eq/on`)) === 1) {
      const band = (prefix: string): PeqBand => ({
        f: parseWingDescribeNumber(String(values.get(`${strip}/eq/${prefix}f`)))!,
        g: parseWingDescribeNumber(String(values.get(`${strip}/eq/${prefix}g`)))!,
        q: parseWingDescribeNumber(String(values.get(`${strip}/eq/${prefix}q`)))!,
      });
      const shape = { bells: [1, 2, 3, 4, 5, 6].map((b) => band(String(b))), lowShelf: null as PeqBand | null, highShelf: null as PeqBand | null };
      for (const [side, prefix] of [["low", "l"], ["high", "h"]] as const) {
        const type = String(values.get(`${strip}/eq/${prefix}eq`));
        if (type === "SHV") shape[side === "low" ? "lowShelf" : "highShelf"] = band(prefix);
        else if (type === "PEQ") shape.bells.push(band(prefix));
        else if (isCutSlope(type)) total += cutResponseDb(hz, side, band(prefix).f, type);
      }
      total += nativeEqResponseDb(shape, hz);
    }
    return total;
  };

  const stripFor = opts.stripFor ?? ((hz: number) => (hz >= 89 ? "/mtx/1" : "/mtx/2"));
  const noiseColour = (hz: number) => (hz < 60 ? -4 : 0);
  const spectrum = (): number[] => {
    const raw = Number(values.get("/cfg/rta/rtasrc"));
    const refLevel = opts.refLevelDb ?? -30;
    return Array.from({ length: RTA_BAND_COUNT }, (_, i) => {
      const hz = rtaBandCenterHz(i);
      // rtasrc 49..76 = bus/main/matrix inputs, all fed the same pink noise here.
      if (raw > 48) return refLevel + noiseColour(hz);
      if (raw === MIC) return refLevel + noiseColour(hz) + opts.room(hz) + eqEffectDb(stripFor(hz), hz) + (opts.micOffsetDb ?? -25) + (opts.micResponse?.(hz) ?? 0);
      return -144;
    });
  };

  const client = {
    async get(path: string) {
      const v = values.get(path);
      return v === undefined
        ? { path, kind: "branch", children: [] }
        : { path, kind: "leaf", valueKind: typeof v === "string" ? "string" : "float", value: v };
    },
    async dump(path: string) {
      const out: Record<string, Value> = {};
      for (const [key, v] of values) {
        if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")) out[key.slice(path.length + 1)] = v;
      }
      return out;
    },
    async describe(path: string) {
      const lines = describes.get(path) ?? [];
      return { path, raw: lines.join("~"), lines };
    },
    async bulkSet(baseNode: string, assignments: Record<string, Value>) {
      writes.push({ baseNode, assignments });
      for (const [k, v] of Object.entries(assignments)) values.set(`${baseNode}/${k}`, v);
      const fx = /^\/fx\/(\d+)$/.exec(baseNode);
      if (fx && assignments.mdl !== undefined) {
        if (assignments.mdl === "GEQ") loadGeq(Number(fx[1]));
        else describes.delete(baseNode);
      }
      return { status: "OK", ok: true, raw: "OK" };
    },
  };

  const meterClient = new EventEmitter();
  const timer = setInterval(() => meterClient.emit("snapshot", { frames: [{ type: "rta", bands_dB: spectrum() }] }), 5);
  const ctx = { client, meterClient } as unknown as WingPluginContext;
  const eqWrites = () => writes.filter((w) => w.baseNode !== "/cfg/rta");
  return { ctx, values, writes, eqWrites, loadGeq, stop: () => clearInterval(timer) };
}

const FAST = { sampleMs: 60, settleMs: 10 };
const FOH_SUB: AutoEqBalanceOptions["zones"] = [
  { type: "matrix", index: 1, fromHz: 100, toHz: 20000 },
  { type: "matrix", index: 2, fromHz: 20, toHz: 100 },
];
const maxAbs = (values: (number | null)[]) => Math.max(...values.filter((v): v is number => v !== null).map(Math.abs));

describe("wing auto EQ balance", () => {
  let fake: ReturnType<typeof createFakeConsole> | null = null;
  afterEach(() => {
    fake?.stop();
    fake = null;
  });

  it("resolves the real GEQ band keys by the frequency in their names, ignoring TRIM", () => {
    const resolved = resolveGeqBandKeys(parseWingDescribeParams(GEQ_DESCRIBE));
    expect(resolved).to.deep.equal({ keys: GEQ_KEYS, min: -15, max: 15 });
    expect(resolveGeqBandKeys(parseWingDescribeParams(GEQ_DESCRIBE.filter((l) => !l.startsWith("1k25 "))))).to.equal(null);
  });

  it("refuses to undo when no run has changed anything", async () => {
    fake = createFakeConsole({ room: () => 0 });
    try {
      await undoAutoEqBalance(fake.ctx);
      expect.fail("expected undo to reject");
    } catch (err) {
      expect(err).to.be.instanceOf(WingValueError);
      expect((err as Error).message).to.match(/Nothing to undo/);
    }
  });

  it("corrects FOH on an existing GEQ and SUB on a newly installed one, then undo restores everything", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 250, 6, 0.6) + bump(hz, 3000, -3, 0.5) + bump(hz, 50, 4, 0.5) });
    fake.loadGeq(3);
    fake.values.set("/mtx/1/preins/ins", "FX3");
    fake.values.set("/mtx/1/preins/on", 1);
    fake.values.set("/fx/1/mdl", "HALL");
    const before = new Map(fake.values);

    const result = await runAutoEqBalance(fake.ctx, { micChannel: MIC, zones: FOH_SUB, maxBoostDb: 6, iterations: 4, ...FAST });

    expect(maxAbs(result.before)).to.be.greaterThan(4);
    expect(result.stopReason).to.equal("converged");
    expect(result.residualMaxDb).to.be.at.most(1.5);
    expect(result.reference).to.include({ type: "matrix", index: 1 });

    const [foh, sub] = result.zones;
    expect(foh).to.include({ eqKind: "geq", fxSlot: 3 });
    expect(foh.insert).to.deep.equal({ slot: "pre", installed: false, turnedOn: false });
    expect(foh.geqBands!.every((b) => b.hz >= 100)).to.equal(true);
    expect(sub).to.include({ eqKind: "geq", fxSlot: 2 });
    expect(sub.insert).to.deep.equal({ slot: "pre", installed: true, turnedOn: true });
    expect(sub.geqBands!.every((b) => b.hz < 100)).to.equal(true);

    expect(fake.values.get("/fx/2/mdl")).to.equal("GEQ");
    expect(fake.values.get("/mtx/2/preins/ins")).to.equal("FX2");
    expect(Number(fake.values.get("/fx/3/250"))).to.be.lessThan(-3);
    const bandHz = (key: string) => ISO_THIRD_OCTAVE_NOMINAL_HZ[GEQ_KEYS.indexOf(key)];
    for (const w of fake.writes.filter((x) => x.baseNode === "/fx/3")) {
      for (const k of Object.keys(w.assignments)) expect(bandHz(k)).to.be.at.least(100);
    }
    for (const w of fake.writes.filter((x) => x.baseNode === "/fx/2" && x.assignments.mdl === undefined)) {
      for (const k of Object.keys(w.assignments)) expect(bandHz(k)).to.be.below(100);
    }
    expect(fake.values.get("/cfg/rta/rtasrc")).to.equal(7);
    expect(fake.values.get("/cfg/rta/rtatap")).to.equal("POST");
    expect(fake.writes).to.deep.include({ baseNode: "/cfg/rta", assignments: { rtadet: "RMS", rtadecay: "FAST", rtaauto: 0 } });
    expect([fake.values.get("/cfg/rta/rtadet"), fake.values.get("/cfg/rta/rtadecay"), fake.values.get("/cfg/rta/rtaauto")]).to.deep.equal(["PEAK", "MED", 1]);

    const undo = await undoAutoEqBalance(fake.ctx);
    expect(undo.restoredWrites).to.be.greaterThan(2);
    for (const [key, value] of before) expect(fake.values.get(key), key).to.equal(value);
  });

  it("tunes a wedge on a bus: reference on the bus input, GEQ installed on the bus insert, undo restores it", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 400, 5, 0.5) + bump(hz, 2500, 4, 0.4), stripFor: () => "/bus/3" });
    const before = new Map(fake.values);

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "bus", index: 3, fromHz: 20, toHz: 20000 }],
      maxCutDb: -12,
      iterations: 3,
      ...FAST,
    });

    expect(fake.writes).to.deep.include({ baseNode: "/cfg/rta", assignments: { rtasrc: 51, rtatap: "IN" } });
    expect(result.reference).to.include({ type: "bus", index: 3 });
    expect(result.zones[0]).to.include({ type: "bus", index: 3, eqKind: "geq", fxSlot: 1 });
    expect(fake.values.get("/bus/3/preins/ins")).to.equal("FX1");
    expect(result.stopReason).to.equal("converged");
    expect(fake.eqWrites().some((w) => w.baseNode.startsWith("/mtx/"))).to.equal(false);

    await undoAutoEqBalance(fake.ctx);
    for (const [key, value] of before) expect(fake.values.get(key), key).to.equal(value);
  });

  it("corrects a main on its native EQ in peq mode", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 200, -5, 0.6) + bump(hz, 5000, 4, 0.6), stripFor: () => "/main/1" });

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "main", index: 1, fromHz: 20, toHz: 20000, eq: "peq" }],
      maxBoostDb: 6,
      iterations: 3,
      ...FAST,
    });

    expect(fake.writes).to.deep.include({ baseNode: "/cfg/rta", assignments: { rtasrc: 65, rtatap: "IN" } });
    expect(result.zones[0]).to.include({ type: "main", index: 1, eqKind: "peq" });
    expect(result.residualMaxDb).to.be.lessThan(maxAbs(result.before) / 2);
    expect(fake.eqWrites().every((w) => w.baseNode === "/main/1/eq")).to.equal(true);
  });

  it("fits shelves on the native EQ low/high bands for a broad tilt", async () => {
    fake = createFakeConsole({
      room: (hz) => 5 / (1 + (hz / 150) ** 2) - 4 / (1 + (6000 / hz) ** 2),
      stripFor: () => "/mtx/1",
    });

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000, eq: "peq" }],
      maxBoostDb: 6,
      iterations: 3,
      ...FAST,
    });

    const eq = result.zones[0].peq!.new;
    expect(eq.low.type).to.equal("SHV");
    expect(eq.low.g).to.be.lessThan(-1);
    expect(eq.high.type).to.equal("SHV");
    expect(eq.high.g).to.be.greaterThan(1);
    // 20/25 Hz are outside the analysed range: no bell may be spent reproducing the shelf down there.
    expect(eq.bands.every((b) => b.g === 0 || b.f >= 30), JSON.stringify(eq.bands)).to.equal(true);
    expect(result.stopReason).to.equal("converged");
  });

  it("turns free L/H bands into extra bells when the response needs more than 6", async () => {
    const centers = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
    fake = createFakeConsole({
      room: (hz) => centers.reduce((sum, f, i) => sum + bump(hz, f, i % 2 === 0 ? 4 : -4, 0.15), 0),
      stripFor: () => "/mtx/1",
    });

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000, eq: "peq" }],
      maxBoostDb: 6,
      iterations: 1,
      ...FAST,
    });

    const eq = result.zones[0].peq!.new;
    expect(eq.bands.every((b) => b.g !== 0)).to.equal(true);
    expect([eq.low.type, eq.high.type]).to.deep.equal(["PEQ", "PEQ"]);
    const layout = [eq.low.f, ...eq.bands.map((b) => b.f), eq.high.f];
    expect(layout).to.deep.equal([...layout].sort((a, b) => a - b));
    expect(fake.values.get("/mtx/1/eq/leq")).to.equal("PEQ");
    expect(fake.values.get("/mtx/1/eq/heq")).to.equal("PEQ");
  });

  it("writes a wedge's requested low cut and leaves the bands it attenuates uncorrected", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 50, 8, 0.4) + bump(hz, 1000, 5, 0.5), stripFor: () => "/bus/3" });

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "bus", index: 3, fromHz: 20, toHz: 20000, eq: "peq", lowCut: { hz: 100, slope: "LR24" } }],
      iterations: 3,
      ...FAST,
    });

    expect(fake.writes).to.deep.include({ baseNode: "/bus/3/eq", assignments: { lf: 100, leq: "LR24" } });
    expect(result.zones[0].cuts).to.deep.equal({ low: { hz: 100, slope: "LR24" }, high: null });
    const idx = (hz: number) => ISO_THIRD_OCTAVE_NOMINAL_HZ.indexOf(hz);
    expect(result.before[idx(50)]).to.equal(null);
    expect(result.before[idx(125)]).to.equal(null);
    expect(result.before[idx(1000)]).to.be.greaterThan(2);
    const eq = result.zones[0].peq!.new;
    expect(eq.low).to.include({ type: "LR24", f: 100 });
    expect(eq.bands.every((b) => b.g === 0 || b.f > 150)).to.equal(true);
    expect(result.stopReason).to.equal("converged");
  });

  it("keeps a cut already set on the console and never rewrites it", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 2000, 5, 0.5), stripFor: () => "/mtx/1" });
    fake.values.set("/mtx/1/eq/on", 1);
    fake.values.set("/mtx/1/eq/lf", 80);
    fake.values.set("/mtx/1/eq/leq", "BW12");

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000, eq: "peq" }],
      iterations: 3,
      ...FAST,
    });

    expect(result.zones[0].cuts.low).to.deep.equal({ hz: 80, slope: "BW12" });
    expect(fake.values.get("/mtx/1/eq/leq")).to.equal("BW12");
    expect(fake.values.get("/mtx/1/eq/lf")).to.equal(80);
    expect(fake.eqWrites().some((w) => "leq" in w.assignments || "lf" in w.assignments)).to.equal(false);
  });

  it("refuses a main linked to main 1", async () => {
    fake = createFakeConsole({ room: () => 0 });
    fake.values.set("/cfg/mainlink", "2-4");
    try {
      await runAutoEqBalance(fake.ctx, { micChannel: MIC, zones: [{ type: "main", index: 3, fromHz: 20, toHz: 20000 }], ...FAST });
      expect.fail("expected a rejection");
    } catch (err) {
      expect((err as Error).message).to.match(/main 3 is linked to main 1/);
    }
    expect(fake.writes).to.deep.equal([]);
  });

  it("falls back to the matrix's native 8-band EQ when both inserts are taken", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 250, 6, 0.7) + bump(hz, 3000, -3, 0.6), stripFor: () => "/mtx/1" });
    fake.values.set("/fx/1/mdl", "HALL");
    fake.values.set("/mtx/1/preins/ins", "FX1");
    fake.values.set("/fx/4/mdl", "DLY");
    fake.values.set("/mtx/1/postins/ins", "FX4");

    const before = new Map(fake.values);
    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000 }],
      maxBoostDb: 6,
      iterations: 3,
      ...FAST,
    });

    const zone = result.zones[0];
    expect(zone.eqKind).to.equal("peq");
    expect(zone.fallbackReason).to.match(/no GEQ is inserted on it, and both its insert points/);
    expect(zone.nativeEqTurnedOn).to.equal(true);
    expect(fake.values.get("/mtx/1/eq/on")).to.equal(1);
    expect(result.residualMaxDb).to.be.lessThan(maxAbs(result.before) / 2);
    expect(fake.eqWrites().every((w) => w.baseNode === "/mtx/1/eq")).to.equal(true);
    expect(zone.peq!.old.bands.map((b) => b.f)).to.deep.equal([129.9, 299.2, 699.5, 1500, 2990, 6010]);
    expect(zone.peq!.old.high).to.deep.equal({ type: "SHV", f: 12000, g: 0, q: 1 });
    for (const w of fake.eqWrites()) {
      for (const v of Object.values(w.assignments)) expect(Number.isFinite(Number(v)), JSON.stringify(w)).to.equal(true);
    }

    await undoAutoEqBalance(fake.ctx);
    for (const [key, value] of before) {
      if (key.startsWith("/mtx/1/eq/")) expect(parseWingDescribeNumber(String(fake.values.get(key))), key).to.equal(parseWingDescribeNumber(String(value)));
    }
  });

  it("previews without writing anything but the RTA source", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 1000, 5, 0.6) });
    fake.loadGeq(3);
    fake.values.set("/mtx/1/preins/ins", "FX3");
    fake.values.set("/mtx/1/preins/on", 1);

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "matrix", index: 1, fromHz: 100, toHz: 20000 }],
      apply: false,
      ...FAST,
    });

    expect(result.applied).to.equal(false);
    expect(result.stopReason).to.equal("preview");
    expect(result.iterations).to.equal(0);
    expect(result.after).to.deep.equal(result.before);
    const oneK = result.zones[0].geqBands!.find((b) => b.hz === 1000)!;
    expect(oneK.old).to.equal(0);
    expect(oneK.new).to.be.lessThan(-2);
    expect(fake.eqWrites()).to.deep.equal([]);
    expect(fake.values.get("/cfg/rta/rtasrc")).to.equal(7);
  });

  it("keeps every GEQ gain inside the boost/cut limits and flags the clamped bands", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 500, 14, 0.4) + bump(hz, 4000, -14, 0.4), stripFor: () => "/mtx/1" });
    fake.loadGeq(5);
    fake.values.set("/mtx/1/postins/ins", "FX5");
    fake.values.set("/mtx/1/postins/on", 0);

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000, eq: "geq" }],
      iterations: 3,
      ...FAST,
    });

    const bands = result.zones[0].geqBands!;
    expect(result.zones[0].insert).to.deep.equal({ slot: "post", installed: false, turnedOn: true });
    expect(bands.every((b) => b.new >= -9 && b.new <= 3)).to.equal(true);
    expect(bands.some((b) => b.clamped && b.new === 3)).to.equal(true);
    expect(bands.some((b) => b.clamped && b.new === -9)).to.equal(true);
    expect(result.stopReason).to.not.equal("converged");
  });

  it("refuses an unmuted mic channel with its fader up before touching the console", async () => {
    fake = createFakeConsole({ room: () => 0 });
    fake.values.set(`/ch/${MIC}/mute`, 0);
    fake.values.set(`/ch/${MIC}/fdr`, -10);
    try {
      await runAutoEqBalance(fake.ctx, { micChannel: MIC, zones: FOH_SUB, ...FAST });
      expect.fail("expected a rejection");
    } catch (err) {
      expect(err).to.be.instanceOf(WingValueError);
      expect((err as Error).message).to.match(/mute it first/);
    }
    expect(fake.writes).to.deep.equal([]);
  });

  it("refuses to change anything without pink noise, and still restores the RTA source", async () => {
    fake = createFakeConsole({ room: () => 0, refLevelDb: -120 });
    try {
      await runAutoEqBalance(fake.ctx, { micChannel: MIC, zones: FOH_SUB, ...FAST });
      expect.fail("expected a rejection");
    } catch (err) {
      expect((err as Error).message).to.match(/No signal on matrix 1's input/);
    }
    expect(fake.eqWrites()).to.deep.equal([]);
    expect(fake.values.get("/cfg/rta/rtasrc")).to.equal(7);
    expect(fake.values.get("/cfg/rta/rtatap")).to.equal("POST");
    expect(fake.values.get("/cfg/rta/rtadet")).to.equal("PEAK");
    expect(fake.values.get("/cfg/rta/rtaauto")).to.equal(1);
  });

  it('fails in eq: "geq" mode instead of falling back — before measuring, even without pink noise', async () => {
    fake = createFakeConsole({ room: () => 0, refLevelDb: -120 });
    fake.values.set("/mtx/1/preins/ins", "FX1");
    fake.values.set("/fx/1/mdl", "HALL");
    fake.values.set("/mtx/1/postins/ins", "FX4");
    fake.values.set("/fx/4/mdl", "DLY");
    try {
      await runAutoEqBalance(fake.ctx, { micChannel: MIC, zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000, eq: "geq" }], ...FAST });
      expect.fail("expected a rejection");
    } catch (err) {
      expect((err as Error).message).to.match(/matrix 1: no GEQ is inserted on it, and both its insert points/);
    }
    expect(fake.writes).to.deep.equal([]);
  });

  it('"geq" mode never borrows a GEQ inserted on another strip', async () => {
    fake = createFakeConsole({ room: () => 0 });
    for (let n = 1; n <= 16; n++) fake.values.set(`/fx/${n}/mdl`, "HALL");
    fake.loadGeq(7);
    fake.values.set("/bus/5/preins/ins", "FX7");
    fake.values.set("/bus/5/preins/on", 1);
    fake.values.set("/fx/7/$a_chn", 53);

    for (const zone of [
      { type: "matrix" as const, index: 1, fromHz: 20, toHz: 20000, eq: "geq" as const },
      { type: "matrix" as const, index: 1, fromHz: 20, toHz: 20000, eq: "geq" as const, fxSlot: 7 },
    ]) {
      try {
        await runAutoEqBalance(fake.ctx, { micChannel: MIC, zones: [zone], ...FAST });
        expect.fail("expected a rejection");
      } catch (err) {
        expect((err as Error).message).to.match(zone.fxSlot ? /matrix 1: FX7 is already in use/ : /matrix 1: no GEQ is inserted on it, and there is no empty FX slot/);
      }
    }
    expect(fake.writes).to.deep.equal([]);
  });

  it("uses the GEQ inserted on the target strip (here its post-insert), not one inserted elsewhere", async () => {
    fake = createFakeConsole({ room: (hz) => bump(hz, 800, 5, 0.5), stripFor: () => "/mtx/1" });
    fake.values.set("/fx/1/mdl", "HALL");
    fake.values.set("/mtx/1/preins/ins", "FX1");
    fake.values.set("/mtx/1/preins/on", 1);
    fake.loadGeq(6);
    fake.values.set("/mtx/1/postins/ins", "FX6");
    fake.values.set("/mtx/1/postins/on", 1);
    fake.loadGeq(2);
    fake.values.set("/bus/3/preins/ins", "FX2");
    fake.values.set("/bus/3/preins/on", 1);

    const result = await runAutoEqBalance(fake.ctx, {
      micChannel: MIC,
      zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000, eq: "geq" }],
      ...FAST,
    });

    expect(result.zones[0]).to.include({ eqKind: "geq", fxSlot: 6 });
    expect(result.zones[0].insert).to.deep.equal({ slot: "post", installed: false, turnedOn: false });
    expect(fake.eqWrites().every((w) => w.baseNode === "/fx/6")).to.equal(true);
    expect(fake.eqWrites().length).to.be.greaterThan(0);
  });

  describe("mic calibration", () => {
    // A mic that reads 4 dB low in the top octaves, like a cheap measurement mic without its calibration.
    const micResponse = (hz: number) => -4 / (1 + (8000 / hz) ** 4);
    const micCurve = Array.from({ length: 61 }, (_, i) => 20 * 2 ** (i / 6)).map((hz) => ({ hz, db: micResponse(hz) }));
    const zones: AutoEqBalanceOptions["zones"] = [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000, eq: "geq" }];
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "wing-mcp-test-auto-eq-mics-"));
      fake = createFakeConsole({ room: () => 0, micResponse, stripFor: () => "/mtx/1" });
      fake.loadGeq(3);
      fake.values.set("/mtx/1/preins/ins", "FX3");
      fake.values.set("/mtx/1/preins/on", 1);
      fake.ctx.micCalibrationStore = new WingMicCalibrationStore({ dir });
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("without calibration, the mic's own high-frequency loss is 'corrected' into the system", async () => {
      const result = await runAutoEqBalance(fake!.ctx, { micChannel: MIC, zones, apply: false, ...FAST });
      expect(result.micCalibration).to.equal(null);
      expect(result.zones[0].geqBands!.find((b) => b.hz === 12500)!.new).to.be.at.least(1.5);
    });

    it("subtracts a saved mic's curve from the mic readings, so a flat system stays flat", async () => {
      await fake!.ctx.micCalibrationStore.save({ name: "ECM8000", curves: { deg0: { sourceFiles: ["x.rtf"], points: micCurve }, deg90: null } });

      const result = await runAutoEqBalance(fake!.ctx, { micChannel: MIC, zones, micCalibration: { name: "ecm8000" }, ...FAST });

      expect(result.micCalibration).to.deep.equal({ name: "ECM8000", orientation: 0, pointCount: 61, minHz: 20, maxHz: micCurve[60].hz });
      expect(maxAbs(result.before)).to.be.below(0.5);
      expect(result.stopReason).to.equal("converged");
      expect(fake!.eqWrites()).to.deep.equal([]);
    });

    it("accepts a one-off curve without saving a mic", async () => {
      const result = await runAutoEqBalance(fake!.ctx, { micChannel: MIC, zones, micCalibrationCurve: micCurve, apply: false, ...FAST });
      expect(result.micCalibration).to.include({ name: null, orientation: null, pointCount: 61 });
      expect(maxAbs(result.before)).to.be.below(0.5);
    });

    it("refuses an unknown mic, a missing orientation, or both kinds of calibration — before touching the console", async () => {
      await fake!.ctx.micCalibrationStore.save({ name: "ECM8000", curves: { deg0: { sourceFiles: [], points: micCurve }, deg90: null } });
      const attempts: [Partial<AutoEqBalanceOptions>, RegExp][] = [
        [{ micCalibration: { name: "UMIK-1" } }, /No saved mic named "UMIK-1" \(saved: ECM8000\)\. Nothing was changed/],
        [{ micCalibration: { name: "ECM8000", orientation: 90 } }, /Mic "ECM8000" has no 90° calibration curve \(only 0°\)/],
        [{ micCalibration: { name: "ECM8000" }, micCalibrationCurve: micCurve }, /not both/],
      ];
      for (const [extra, message] of attempts) {
        try {
          await runAutoEqBalance(fake!.ctx, { micChannel: MIC, zones, ...extra, ...FAST });
          expect.fail("expected a rejection");
        } catch (err) {
          expect(err).to.be.instanceOf(WingValueError);
          expect((err as Error).message).to.match(message);
        }
      }
      expect(fake!.writes).to.deep.equal([]);
    });
  });

  it("rejects overlapping zones and a second concurrent run", async () => {
    fake = createFakeConsole({ room: () => 0 });
    try {
      await runAutoEqBalance(fake.ctx, {
        micChannel: MIC,
        zones: [
          { type: "matrix", index: 1, fromHz: 80, toHz: 20000 },
          { type: "matrix", index: 2, fromHz: 20, toHz: 120 },
        ],
      });
      expect.fail("expected a rejection");
    } catch (err) {
      expect((err as Error).message).to.match(/Zones overlap/);
    }

    const first = runAutoEqBalance(fake.ctx, { micChannel: MIC, zones: FOH_SUB, apply: false, ...FAST });
    try {
      await runAutoEqBalance(fake.ctx, { micChannel: MIC, zones: FOH_SUB, apply: false, ...FAST });
      expect.fail("expected a rejection");
    } catch (err) {
      expect((err as Error).message).to.match(/already in progress/);
    }
    await first;
  });

  it("exposes the engine through the wing_auto_eq_balance MCP tool", async () => {
    fake = createFakeConsole({ room: () => 0 });
    const server = new McpServer({ name: "auto-eq-test", version: "0.0.0" });
    registerAutoEqTools(server, fake.ctx);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "auto-eq-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "wing_auto_eq_balance",
        arguments: {
          micChannel: MIC,
          zones: [
            { type: "bus", index: 3, fromHz: 100, toHz: 20000 },
            { type: "bus", index: 3, fromHz: 20, toHz: 100 },
          ],
        },
      });
      expect(result.isError).to.equal(true);
      expect((result.content as { text: string }[])[0].text).to.match(/more than one zone/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
