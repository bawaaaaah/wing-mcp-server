import { WingUnavailableError, WingValueError } from "./wing-errors.js";
import { abortableDelay, throwIfAborted, type ProgressReporter } from "./long-running.js";
import {
  cutResponseDb,
  fitNativeEq,
  interpolateCurveDb,
  isCutSlope,
  ISO_THIRD_OCTAVE_EXACT_HZ,
  ISO_THIRD_OCTAVE_NOMINAL_HZ,
  nativeEqResponseDb,
  RtaAverager,
  rtaToThirdOctaves,
  smoothBands,
  type CurvePoint,
  type CutSlope,
  type NativeEqShape,
  type PeqBand,
  type ShelfSide,
} from "./wing-eq-math.js";
import { getInsertStatus, type InsertSlot } from "./wing-insert.js";
import { calibrationRtaOffsetsDb, validateCalibrationPoints } from "./wing-mic-calibration.js";
import { curveKey, MIC_ORIENTATIONS, type MicOrientation } from "./wing-mic-calibration-store.js";
import { channelPath, FX_COUNT, fxPath, resolveStripPath } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";
import { setRtaSource, type RtaSource } from "./wing-rta-source.js";
import { parseWingDescribeNumber, parseWingDescribeParams, type WingDescribeParam } from "./wing-value-codec.js";

/**
 * Auto-EQ balance: pink noise is played through the system, a measurement mic sits on a channel, and
 * the console's single RTA is pointed first at a zone strip's input (the electrical noise — the
 * reference) and then at the mic. Their difference is the speaker+room transfer function, so the
 * noise source's own colour and the RTA's weighting cancel out. Each zone (a matrix, bus or main
 * feeding FOH, SUB, fills, wedges...) receives the part of the correction inside its own frequency
 * range, written to a 31-band GEQ insert when one exists or can be installed, else fitted onto the
 * strip's 8-band native EQ (L, 1-6, H — L/H as shelf, bell or cut). Optional low/high cuts go on L/H.
 * A measurement-mic calibration (a saved mic or a one-off curve) is subtracted from the mic readings.
 */

export const AUTO_EQ_STRIP_TYPES = ["bus", "main", "matrix"] as const;
export type AutoEqStripType = (typeof AUTO_EQ_STRIP_TYPES)[number];
export type AutoEqKind = "auto" | "geq" | "peq";
export type AutoEqStopReason = "converged" | "limits-reached" | "max-iterations" | "preview";

export interface AutoEqCut {
  hz: number;
  slope: CutSlope;
}

export interface AutoEqZone {
  type: AutoEqStripType;
  index: number;
  /** Inclusive lower bound, compared against the ISO nominal band label. */
  fromHz: number;
  /** Exclusive upper bound. */
  toHz: number;
  eq?: AutoEqKind;
  fxSlot?: number;
  /** Written to the strip's native low band (e.g. a wedge's LR24 at 100 Hz); bands it cuts are left uncorrected. */
  lowCut?: AutoEqCut;
  highCut?: AutoEqCut;
}

export interface AutoEqBalanceOptions {
  micChannel: number;
  zones: AutoEqZone[];
  targetCurve?: CurvePoint[];
  maxBoostDb?: number;
  maxCutDb?: number;
  iterations?: number;
  sampleMs?: number;
  settleMs?: number;
  apply?: boolean;
  /** Cancels the run between rounds and during each capture — see long-running.ts. */
  signal?: AbortSignal;
  /** Called once per measure-then-correct round. */
  onProgress?: ProgressReporter;
  /** A saved mic (wing_mic_calibration_save): its curve is subtracted from what the mic measures. */
  micCalibration?: { name: string; orientation?: MicOrientation };
  /** A one-off mic calibration curve ({hz, db} = the mic's own deviation), instead of a saved mic. */
  micCalibrationCurve?: CurvePoint[];
}

/** The mic calibration applied to the mic readings (name/orientation null for a one-off curve). */
export interface AutoEqMicCalibrationInfo {
  name: string | null;
  orientation: MicOrientation | null;
  pointCount: number;
  minHz: number;
  maxHz: number;
}

export interface AutoEqGeqBandChange {
  hz: number;
  old: number;
  new: number;
  clamped: boolean;
}

/** A native EQ low/high band: `type` is the console's leq/heq value (PEQ, SHV, or a cut slope). */
export interface AutoEqNativeSide {
  type: string;
  f: number;
  g: number;
  q: number;
}

export interface AutoEqNativeEq {
  bands: PeqBand[];
  low: AutoEqNativeSide;
  high: AutoEqNativeSide;
}

export interface AutoEqZoneResult {
  type: AutoEqStripType;
  index: number;
  fromHz: number;
  toHz: number;
  eqKind: "geq" | "peq";
  fallbackReason?: string;
  fxSlot?: number;
  insert?: { slot: InsertSlot; installed: boolean; turnedOn: boolean };
  geqBands?: AutoEqGeqBandChange[];
  peq?: { old: AutoEqNativeEq; new: AutoEqNativeEq };
  /** Cuts in effect on the strip's native EQ (requested, or already set on the console). */
  cuts: { low: AutoEqCut | null; high: AutoEqCut | null };
  nativeEqTurnedOn: boolean;
}

export interface AutoEqBalanceResult {
  micChannel: number;
  applied: boolean;
  frequenciesHz: number[];
  target: number[];
  /** Normalised mic-minus-reference response per third octave (null = not measured / outside the zones). */
  before: Array<number | null>;
  after: Array<number | null>;
  reference: { type: AutoEqStripType; index: number; sampleCount: number; sampleMs: number };
  zones: AutoEqZoneResult[];
  iterations: number;
  stopReason: AutoEqStopReason;
  residualMaxDb: number;
  residualRmsDb: number;
  micCalibration: AutoEqMicCalibrationInfo | null;
}

const DEFAULT_SAMPLE_MS = 4000;
/** The console's RTA has its own decay — give it this long after a source switch or an EQ write. */
/** Names this operation in cancellation messages and progress updates. */
const AUTO_EQ_LABEL = "Auto-EQ";

const DEFAULT_SETTLE_MS = 1000;
/**
 * Verified on hardware: the console's default PEAK detector with auto gain makes pink-noise readings
 * swing by several dB and lifts silence to plausible levels; RMS with fast decay and no auto gain reads
 * the same noise within ~0.2 dB. These are shared console display settings, restored after the run.
 */
const RTA_MEASURE_SETTINGS = { rtadet: "RMS", rtadecay: "FAST", rtaauto: 0 } as const;
const RTA_RESTORED_KEYS = ["rtasrc", "rtatap", ...Object.keys(RTA_MEASURE_SETTINGS)];
const DEFAULT_ITERATIONS = 2;
export const AUTO_EQ_MAX_ITERATIONS = 5;
const DEFAULT_MAX_BOOST_DB = 3;
const DEFAULT_MAX_CUT_DB = -9;
/** Damping, same reasoning as auto-compress: a full 1:1 correction tends to overshoot. */
const STEP_FACTOR = 0.7;
const CONVERGED_MAX_DB = 1.5;
/** A round whose largest band move is below this changed nothing worth re-measuring. */
const MIN_EFFECTIVE_STEP_DB = 0.3;
const ANALYSIS_MIN_HZ = 31.5;
const ANALYSIS_MAX_HZ = 16000;
const NO_SIGNAL_FLOOR_DB = -80;
const BAND_FLOOR_DB = -90;
const MIC_MAX_OPEN_FADER_DB = -60;
const GEQ_MODEL = "GEQ";
const EMPTY_FX_MODEL = "NONE";
const PEQ_BAND_COUNT = 6;
const GEQ_BAND_COUNT = ISO_THIRD_OCTAVE_NOMINAL_HZ.length;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Dumped values come back formatted — frequencies >= 1 kHz as "1k50", gains as "+6.0". */
const dumpedNumber = (value: string | number | undefined, fallback: number) =>
  (value === undefined ? null : parseWingDescribeNumber(String(value))) ?? fallback;
const round1 = (v: number) => Number(v.toFixed(1));

interface RestoreWrite {
  baseNode: string;
  assignments: Record<string, number | string>;
}

type WriteFn = (baseNode: string, assignments: Record<string, number | string>, restore: Record<string, number | string>) => Promise<void>;

let running = false;
const zoneLabel = (z: AutoEqZone) => `${z.type} ${z.index}`;
const stripPath = (z: AutoEqZone, suffix: string) => resolveStripPath(z.type, z.index, suffix);
let lastUndoLog: RestoreWrite[] | null = null;

/** "20" -> 20, "31" -> 31, "1k25" -> 1250, "20k" -> 20000; null for anything else (e.g. "TRIM"). */
function geqKeyHz(key: string): number | null {
  const m = /^(\d+)(?:k(\d*))?$/.exec(key);
  if (!m) return null;
  return m[0].includes("k") ? Number(`${m[1]}.${m[2] || "0"}`) * 1000 : Number(m[1]);
}

/**
 * The 31 GEQ gain keys in ISO band order. Verified on hardware: the GEQ names its bands by frequency
 * ("20", "25", "31", ..., "1k", "1k25", ..., "20k") next to a same-range "TRIM", so bands are matched by
 * the frequency in their name rather than by position. Null if any band is missing.
 */
export function resolveGeqBandKeys(params: readonly WingDescribeParam[]): { keys: string[]; min: number; max: number } | null {
  const bands = params.flatMap((p) => {
    const hz = geqKeyHz(p.key);
    return hz !== null && p.kind === "lin" && p.min !== undefined && p.max !== undefined ? [{ key: p.key, hz, min: p.min, max: p.max }] : [];
  });
  const keys: string[] = [];
  for (const nominal of ISO_THIRD_OCTAVE_NOMINAL_HZ) {
    const match = bands.find((b) => Math.abs(Math.log2(b.hz / nominal)) < 1 / 12);
    if (!match) return null;
    keys.push(match.key);
  }
  const first = bands.find((b) => b.key === keys[0])!;
  return { keys, min: first.min, max: first.max };
}

function validate(opts: AutoEqBalanceOptions): void {
  channelPath(opts.micChannel);
  if (!Array.isArray(opts.zones) || opts.zones.length === 0) {
    throw new WingValueError("Pass at least one zone ({ type, index, fromHz, toHz }).");
  }
  const seen = new Set<string>();
  for (const z of opts.zones) {
    if (!AUTO_EQ_STRIP_TYPES.includes(z.type)) {
      throw new WingValueError(`Zone type must be one of ${AUTO_EQ_STRIP_TYPES.join(", ")} (got ${String(z.type)}).`);
    }
    resolveStripPath(z.type, z.index);
    if (seen.has(zoneLabel(z))) throw new WingValueError(`${zoneLabel(z)} appears in more than one zone.`);
    seen.add(zoneLabel(z));
    if (!(Number.isFinite(z.fromHz) && Number.isFinite(z.toHz) && z.fromHz >= 20 && z.toHz <= 20000 && z.fromHz < z.toHz)) {
      throw new WingValueError(`Zone for ${zoneLabel(z)} needs 20 <= fromHz < toHz <= 20000 (got ${z.fromHz}..${z.toHz}).`);
    }
    if (z.fxSlot !== undefined) fxPath(z.fxSlot);
    for (const [side, cut] of [["lowCut", z.lowCut], ["highCut", z.highCut]] as const) {
      if (cut && !(Number.isFinite(cut.hz) && cut.hz >= 20 && cut.hz <= 20000 && isCutSlope(cut.slope))) {
        throw new WingValueError(`${zoneLabel(z)} ${side} needs 20 <= hz <= 20000 and a slope (got ${JSON.stringify(cut)}).`);
      }
    }
    if (z.lowCut && z.highCut && z.lowCut.hz >= z.highCut.hz) {
      throw new WingValueError(`${zoneLabel(z)}: lowCut (${z.lowCut.hz} Hz) must be below highCut (${z.highCut.hz} Hz).`);
    }
  }
  const sorted = [...opts.zones].sort((a, b) => a.fromHz - b.fromHz);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].fromHz < sorted[i - 1].toHz) {
      throw new WingValueError(
        `Zones overlap: ${zoneLabel(sorted[i - 1])} (${sorted[i - 1].fromHz}-${sorted[i - 1].toHz} Hz) and ` +
          `${zoneLabel(sorted[i])} (${sorted[i].fromHz}-${sorted[i].toHz} Hz).`,
      );
    }
  }
  if (opts.maxBoostDb !== undefined && !(opts.maxBoostDb >= 0)) throw new WingValueError("maxBoostDb must be >= 0.");
  if (opts.maxCutDb !== undefined && !(opts.maxCutDb <= 0)) throw new WingValueError("maxCutDb must be <= 0.");
  if (
    opts.iterations !== undefined &&
    !(Number.isInteger(opts.iterations) && opts.iterations >= 1 && opts.iterations <= AUTO_EQ_MAX_ITERATIONS)
  ) {
    throw new WingValueError(`iterations must be an integer between 1 and ${AUTO_EQ_MAX_ITERATIONS}.`);
  }
  for (const p of opts.targetCurve ?? []) {
    if (!(Number.isFinite(p.hz) && p.hz > 0 && Number.isFinite(p.db))) {
      throw new WingValueError(`Invalid target curve point ${JSON.stringify(p)} — expected { hz > 0, db }.`);
    }
  }
  if (opts.micCalibration && opts.micCalibrationCurve) {
    throw new WingValueError("Pass either micCalibration (a saved mic) or micCalibrationCurve (a one-off curve), not both.");
  }
  const orientation = opts.micCalibration?.orientation;
  if (orientation !== undefined && !MIC_ORIENTATIONS.includes(orientation)) {
    throw new WingValueError(`micCalibration.orientation must be 0 or 90 (got ${String(orientation)}).`);
  }
  if (opts.micCalibrationCurve) validateCalibrationPoints(opts.micCalibrationCurve, "micCalibrationCurve");
}

/** Loads the requested mic calibration as per-RTA-band offsets — before anything is measured or written. */
async function resolveMicCalibration(
  ctx: WingPluginContext,
  opts: AutoEqBalanceOptions,
): Promise<{ info: AutoEqMicCalibrationInfo; offsets: number[] } | null> {
  const describe = (points: CurvePoint[], name: string | null, orientation: MicOrientation | null) => ({
    info: { name, orientation, pointCount: points.length, minHz: points[0].hz, maxHz: points[points.length - 1].hz },
    offsets: calibrationRtaOffsetsDb(points),
  });
  if (opts.micCalibrationCurve) {
    return describe(validateCalibrationPoints(opts.micCalibrationCurve, "micCalibrationCurve"), null, null);
  }
  if (!opts.micCalibration) return null;
  const { name } = opts.micCalibration;
  const file = await ctx.micCalibrationStore.get(name);
  if (!file) {
    const known = (await ctx.micCalibrationStore.list()).map((m) => m.name);
    throw new WingValueError(
      `No saved mic named "${name}" (${known.length ? `saved: ${known.join(", ")}` : "none saved yet"}). Nothing was changed.`,
    );
  }
  const orientation = opts.micCalibration.orientation ?? (file.curves.deg0 ? 0 : 90);
  const curve = file.curves[curveKey(orientation)];
  if (!curve) {
    throw new WingValueError(
      `Mic "${file.name}" has no ${orientation}° calibration curve (only ${orientation === 0 ? 90 : 0}°). Nothing was changed.`,
    );
  }
  return describe(curve.points, file.name, orientation);
}

interface NativeEqState {
  path: string;
  wasOn: boolean;
  turnedOn: boolean;
  limits: { gMin: number; gMax: number; qMin: number; qMax: number; fMin: number; fMax: number };
  original: AutoEqNativeEq;
  current: AutoEqNativeEq;
}

interface ZoneCommon {
  zone: AutoEqZone;
  /** Third-octave indices this zone corrects: inside its range and not attenuated by a cut. */
  bandIdx: number[];
  native: NativeEqState;
  cuts: { low: AutoEqCut | null; high: AutoEqCut | null };
}

interface GeqTarget extends ZoneCommon {
  kind: "geq";
  fxSlot: number;
  /** null only in preview when the GEQ would still have to be installed. */
  keys: string[] | null;
  min: number;
  max: number;
  /** Whether the GEQ was in the signal path when the mic was measured. */
  active: boolean;
  originalGains: number[];
  gains: number[];
  clamped: Set<number>;
  insert: { slot: InsertSlot; installed: boolean; turnedOn: boolean };
}

interface PeqTarget extends ZoneCommon {
  kind: "peq";
  fallbackReason?: string;
}

type ZoneTarget = GeqTarget | PeqTarget;

export async function runAutoEqBalance(ctx: WingPluginContext, opts: AutoEqBalanceOptions): Promise<AutoEqBalanceResult> {
  validate(opts);
  if (running) throw new WingValueError("An auto-EQ balance run is already in progress — the console has a single RTA.");
  running = true;
  try {
    return await run(ctx, opts);
  } finally {
    running = false;
  }
}

async function run(ctx: WingPluginContext, opts: AutoEqBalanceOptions): Promise<AutoEqBalanceResult> {
  const apply = opts.apply ?? true;
  const sampleMs = opts.sampleMs ?? DEFAULT_SAMPLE_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const maxIterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const maxBoost = opts.maxBoostDb ?? DEFAULT_MAX_BOOST_DB;
  const maxCut = opts.maxCutDb ?? DEFAULT_MAX_CUT_DB;
  const target = ISO_THIRD_OCTAVE_NOMINAL_HZ.map((hz) => round1(interpolateCurveDb(opts.targetCurve ?? [], hz)));
  const micCalibration = await resolveMicCalibration(ctx, opts);

  const [micMute, micFader] = await Promise.all([
    ctx.client.get(channelPath(opts.micChannel, "mute")),
    ctx.client.get(channelPath(opts.micChannel, "fdr")),
  ]);
  const muted = micMute.kind === "leaf" && Number(micMute.value) === 1;
  const faderDb = micFader.kind === "leaf" ? Number(micFader.value) : NaN;
  if (!muted && !(faderDb <= MIC_MAX_OPEN_FADER_DB)) {
    throw new WingValueError(
      `Mic channel ${opts.micChannel} is unmuted with its fader up (${Number.isFinite(faderDb) ? faderDb.toFixed(1) : "?"} dB) — ` +
        `mute it first to avoid feedback (the RTA taps its input, so the measurement is unaffected). Nothing was changed.`,
    );
  }

  const mainZones = opts.zones.filter((z) => z.type === "main");
  if (mainZones.length > 0) {
    const link = await getLeafString(ctx, "/cfg/mainlink");
    const range = /^2(?:-(\d))?$/.exec(link ?? "");
    const lastLinked = range ? Number(range[1] ?? 2) : 1;
    const linked = mainZones.find((z) => z.index >= 2 && z.index <= lastLinked);
    if (linked) {
      throw new WingValueError(
        `main ${linked.index} is linked to main 1 (/cfg/mainlink = ${link}) — verified on hardware, its level follows main 1, ` +
          `so a correction measured and written there isn't independent. Use main 1, or unlink the mains. Nothing was changed.`,
      );
    }
  }

  const undoLog: RestoreWrite[] = [];
  const write: WriteFn = async (baseNode, assignments, restore) => {
    const ack = await ctx.client.bulkSet(baseNode, assignments);
    if (!ack.ok) {
      throw new WingValueError(`Console rejected ${JSON.stringify(assignments)} on ${baseNode} (${ack.status}).`);
    }
    undoLog.push({ baseNode, assignments: restore });
    lastUndoLog = undoLog;
  };

  const inAnalysisRange = (i: number) =>
    ISO_THIRD_OCTAVE_NOMINAL_HZ[i] >= ANALYSIS_MIN_HZ && ISO_THIRD_OCTAVE_NOMINAL_HZ[i] <= ANALYSIS_MAX_HZ;

  /** `offsetsDb`: per-RTA-band values subtracted from the reading (the mic's calibration). */
  const capture = async (source: RtaSource, label: string, offsetsDb?: readonly number[]) => {
    await setRtaSource(ctx, source, "IN");
    await abortableDelay(settleMs, opts.signal, AUTO_EQ_LABEL);
    const averager = new RtaAverager();
    const onSnapshot = (snapshot: { frames: Array<Record<string, unknown>> }) => {
      for (const frame of snapshot.frames) {
        if (frame.type === "rta" && Array.isArray(frame.bands_dB)) averager.add(frame.bands_dB as number[]);
      }
    };
    // Captured once: ctx.meterClient is a live getter that can re-resolve to a new instance across the await.
    const meterClient = ctx.meterClient;
    meterClient.on("snapshot", onSnapshot);
    try {
      await abortableDelay(sampleMs, opts.signal, AUTO_EQ_LABEL);
    } finally {
      // In a finally because the delay rejects on cancellation — otherwise this listener would
      // stay attached to the meter client for the life of the process.
      meterClient.off("snapshot", onSnapshot);
    }
    if (averager.count === 0) {
      throw new WingUnavailableError(`No RTA data was received while measuring ${label} — is the meter client connected?`);
    }
    const averaged = averager.averageDb();
    const thirds = rtaToThirdOctaves(offsetsDb ? averaged.map((db, i) => db - offsetsDb[i]) : averaged);
    const loudest = Math.max(-Infinity, ...thirds.filter((v, i) => Number.isFinite(v) && inAnalysisRange(i)));
    if (!(loudest > NO_SIGNAL_FLOOR_DB)) {
      throw new WingValueError(
        `No signal on ${label} (loudest band ${Number.isFinite(loudest) ? loudest.toFixed(1) : "-inf"} dB) — start the pink ` +
          `noise through the system first.`,
      );
    }
    return { thirds, count: averager.count };
  };

  // Dry run (apply=false never writes): an unavailable GEQ in "geq" mode fails here, before touching the
  // RTA or spending seconds measuring — and can't be masked by a missing-pink-noise error.
  const dryRunClaimedFx = new Set<number>();
  for (const zone of opts.zones) {
    await resolveZone(ctx, zone, false, settleMs, dryRunClaimedFx, write);
  }

  const rtaDump = await ctx.client.dump("/cfg/rta");
  const savedRta = Object.fromEntries(RTA_RESTORED_KEYS.flatMap((k) => (rtaDump[k] !== undefined ? [[k, rtaDump[k]]] : [])));
  let result: AutoEqBalanceResult;
  try {
    await ctx.client.bulkSet("/cfg/rta", { ...RTA_MEASURE_SETTINGS });
    result = await measureAndCorrect();
  } catch (err) {
    await restoreRta(ctx, savedRta).catch(() => undefined);
    throw err;
  }
  await restoreRta(ctx, savedRta);
  return result;

  async function measureAndCorrect(): Promise<AutoEqBalanceResult> {
    const ref = opts.zones[0];
    // Reference first: proves pink noise is flowing before anything on the console is changed.
    const reference = await capture({ type: ref.type, index: ref.index }, `${zoneLabel(ref)}'s input`);

    const claimedFx = new Set<number>();
    const targets: ZoneTarget[] = [];
    for (const zone of opts.zones) {
      targets.push(await resolveZone(ctx, zone, apply, settleMs, claimedFx, write));
    }
    const assigned = new Set(targets.flatMap((t) => t.bandIdx));

    const measure = async () => {
      const mic = await capture({ type: "channel", index: opts.micChannel }, `mic channel ${opts.micChannel}`, micCalibration?.offsets);
      const raw = mic.thirds.map((m, i) => {
        const r = reference.thirds[i];
        return inAnalysisRange(i) && assigned.has(i) && m > BAND_FLOOR_DB && r > BAND_FLOOR_DB ? m - r : NaN;
      });
      const valid = raw.flatMap((v, i) => (Number.isFinite(v) ? [i] : []));
      if (valid.length === 0) {
        throw new WingValueError("No usable frequency band was measured inside the requested zones.");
      }
      // Level-independent: only the shape matters, so centre the error on the target curve.
      const offset = valid.reduce((sum, i) => sum + raw[i] - target[i], 0) / valid.length;
      return raw.map((v) => v - offset);
    };

    const residualOf = (response: number[]) => {
      const errs = response.flatMap((v, i) => (Number.isFinite(v) ? [v - target[i]] : []));
      return {
        max: round1(Math.max(...errs.map(Math.abs))),
        rms: round1(Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length)),
      };
    };

    let response = await measure();
    const before = response;
    let iterations = 0;
    let stopReason: AutoEqStopReason;
    for (;;) {
      if (residualOf(response).max <= CONVERGED_MAX_DB) {
        stopReason = "converged";
        break;
      }
      if (iterations >= maxIterations) {
        stopReason = "max-iterations";
        break;
      }
      throwIfAborted(opts.signal, AUTO_EQ_LABEL);
      opts.onProgress?.({
        progress: iterations,
        total: maxIterations,
        message: `correction round ${iterations + 1} of ${maxIterations}`,
      });
      // NaN = band not measured (outside the analysed range, cut, or below the floor): leave it alone.
      const correction = smoothBands(response.map((v, i) => v - target[i])).map((e) => -e * STEP_FACTOR);
      let largestMove = 0;
      for (const t of targets) {
        largestMove = Math.max(largestMove, await applyCorrection(t, correction, maxBoost, maxCut, apply, write));
      }
      if (!apply) {
        stopReason = "preview";
        break;
      }
      iterations++;
      if (largestMove < MIN_EFFECTIVE_STEP_DB) {
        stopReason = "limits-reached";
        break;
      }
      response = await measure();
    }

    const residual = residualOf(response);
    const toJson = (values: number[]) => values.map((v) => (Number.isFinite(v) ? round1(v) : null));
    return {
      micChannel: opts.micChannel,
      applied: apply,
      frequenciesHz: [...ISO_THIRD_OCTAVE_NOMINAL_HZ],
      target,
      before: toJson(before),
      after: toJson(response),
      reference: { type: ref.type, index: ref.index, sampleCount: reference.count, sampleMs },
      zones: targets.map(zoneResult),
      iterations,
      stopReason,
      residualMaxDb: residual.max,
      residualRmsDb: residual.rms,
      micCalibration: micCalibration?.info ?? null,
    };
  }
}

async function restoreRta(ctx: WingPluginContext, saved: Record<string, number | string>): Promise<void> {
  if (Object.keys(saved).length > 0) await ctx.client.bulkSet("/cfg/rta", saved);
}

function insertBase(zone: AutoEqZone, slot: InsertSlot): string {
  return stripPath(zone, slot === "pre" ? "preins" : "postins");
}

async function getLeafString(ctx: WingPluginContext, path: string): Promise<string | null> {
  const r = await ctx.client.get(path);
  return r.kind === "leaf" ? String(r.value) : null;
}

async function readGeq(ctx: WingPluginContext, common: ZoneCommon, fxSlot: number, insert: GeqTarget["insert"]): Promise<GeqTarget | null> {
  const geq = resolveGeqBandKeys(parseWingDescribeParams((await ctx.client.describe(fxPath(fxSlot))).lines));
  if (!geq) return null;
  const values = await ctx.client.dump(fxPath(fxSlot));
  const gains = geq.keys.map((k) => dumpedNumber(values[k], 0));
  return {
    ...common, kind: "geq", fxSlot, keys: geq.keys, min: geq.min, max: geq.max, active: true,
    originalGains: [...gains], gains, clamped: new Set(), insert,
  };
}

async function readNativeEq(ctx: WingPluginContext, zone: AutoEqZone): Promise<NativeEqState> {
  const path = stripPath(zone, "eq");
  const [description, values] = await Promise.all([ctx.client.describe(path), ctx.client.dump(path)]);
  const params = parseWingDescribeParams(description.lines);
  const rangeOf = (key: string, fallbackRange: [number, number]): [number, number] => {
    const p = params.find((x) => x.key === key);
    const lo = p?.min ?? fallbackRange[0];
    const hi = p?.max ?? fallbackRange[1];
    return lo <= hi ? [lo, hi] : [hi, lo];
  };
  const [gMin, gMax] = rangeOf("1g", [-15, 15]);
  const [qMin, qMax] = rangeOf("1q", [0.44, 10]);
  const [fMin, fMax] = rangeOf("1f", [20, 20000]);
  const band = (prefix: string) => ({
    f: dumpedNumber(values[`${prefix}f`], 1000),
    g: dumpedNumber(values[`${prefix}g`], 0),
    q: dumpedNumber(values[`${prefix}q`], 1),
  });
  const eq: AutoEqNativeEq = {
    bands: Array.from({ length: PEQ_BAND_COUNT }, (_, i) => band(String(i + 1))),
    low: { type: String(values.leq ?? "SHV"), ...band("l") },
    high: { type: String(values.heq ?? "SHV"), ...band("h") },
  };
  return {
    path, wasOn: Number(values.on) === 1, turnedOn: false, limits: { gMin, gMax, qMin, qMax, fMin, fMax },
    original: structuredClone(eq), current: eq,
  };
}

const sideKey = (side: ShelfSide) => (side === "low" ? "l" : "h");

/**
 * Writes the zone's requested cuts (and turns the native EQ on if they need it), then works out which
 * bands the correction may touch: inside the zone's range and not attenuated by more than 1 dB by any
 * cut in effect — a cut already on the console counts too, so the loop never tries to boost it back.
 */
async function prepareZone(ctx: WingPluginContext, zone: AutoEqZone, apply: boolean, write: WriteFn): Promise<ZoneCommon> {
  const native = await readNativeEq(ctx, zone);
  const requested = { low: zone.lowCut, high: zone.highCut };
  for (const side of ["low", "high"] as const) {
    const cut = requested[side];
    const cur = native.current[side];
    if (!cut || !apply) continue;
    // The console quantizes frequencies (100 is stored as 100.2), so only rewrite a real change.
    if (cur.type !== cut.slope || Math.abs(cur.f / cut.hz - 1) > 0.01) {
      const k = sideKey(side);
      await write(native.path, { [`${k}f`]: cut.hz, [`${k}eq`]: cut.slope }, { [`${k}f`]: cur.f, [`${k}eq`]: cur.type });
      native.current[side] = { ...cur, type: cut.slope, f: cut.hz };
    }
    await ensureNativeOn(native, write);
  }
  const existing = (side: ShelfSide): AutoEqCut | null => {
    const s = native.current[side];
    return native.wasOn && isCutSlope(s.type) ? { hz: s.f, slope: s.type } : null;
  };
  const cuts = { low: requested.low ?? existing("low"), high: requested.high ?? existing("high") };
  const bandIdx = ISO_THIRD_OCTAVE_NOMINAL_HZ.flatMap((hz, i) => {
    if (hz < zone.fromHz || hz >= zone.toHz) return [];
    const exact = ISO_THIRD_OCTAVE_EXACT_HZ[i];
    const attenuation =
      (cuts.low ? cutResponseDb(exact, "low", cuts.low.hz, cuts.low.slope) : 0) +
      (cuts.high ? cutResponseDb(exact, "high", cuts.high.hz, cuts.high.slope) : 0);
    return attenuation < -1 ? [] : [i];
  });
  return { zone, bandIdx, native, cuts };
}

async function ensureNativeOn(native: NativeEqState, write: WriteFn): Promise<void> {
  if (native.wasOn || native.turnedOn) return;
  await write(native.path, { on: 1 }, { on: 0 });
  native.turnedOn = true;
}

async function resolveZone(
  ctx: WingPluginContext,
  zone: AutoEqZone,
  apply: boolean,
  settleMs: number,
  claimedFx: Set<number>,
  write: WriteFn,
): Promise<ZoneTarget> {
  const kind = zone.eq ?? "auto";
  const common = await prepareZone(ctx, zone, apply, write);
  const usePeq = async (fallbackReason?: string): Promise<PeqTarget> => {
    if (apply) await ensureNativeOn(common.native, write);
    return { ...common, kind: "peq", ...(fallbackReason ? { fallbackReason } : {}) };
  };
  const fallback = async (reason: string): Promise<ZoneTarget> => {
    if (kind === "geq") throw new WingValueError(`${zoneLabel(zone)}: ${reason}`);
    return usePeq(reason);
  };
  if (kind === "peq") return usePeq();

  const inserts = await Promise.all(
    (["pre", "post"] as const).map((slot) => getInsertStatus(ctx, { type: zone.type, index: zone.index, slot })),
  );

  for (const ins of inserts) {
    const m = /^FX(\d+)$/.exec(String(ins.fx));
    if (!m) continue;
    const slotNo = Number(m[1]);
    if ((await getLeafString(ctx, fxPath(slotNo, "mdl"))) !== GEQ_MODEL) continue;
    const turnOn = !ins.on && apply;
    const geq = await readGeq(ctx, common, slotNo, { slot: ins.slot, installed: false, turnedOn: turnOn });
    if (!geq) return fallback(`the GEQ on FX${slotNo} doesn't expose 31 identifiable band gains.`);
    claimedFx.add(slotNo);
    if (turnOn) await write(insertBase(zone, ins.slot), { on: 1 }, { on: 0 });
    geq.active = ins.on || turnOn;
    return geq;
  }

  const freeInsert = inserts.find((ins) => ins.fx === "NONE");
  if (!freeInsert) return fallback("no GEQ is inserted on it, and both its insert points are already used by other effects.");

  // `$a_chn` is the strip an FX slot is currently inserted on (0 = none) — never steal one in use.
  const insertedElsewhere = async (n: number) => Number(await getLeafString(ctx, fxPath(n, "$a_chn"))) > 0;
  let slotNo: number | undefined;
  let prevModel = EMPTY_FX_MODEL;
  if (zone.fxSlot !== undefined) {
    const mdl = await getLeafString(ctx, fxPath(zone.fxSlot, "mdl"));
    if ((mdl !== EMPTY_FX_MODEL && mdl !== GEQ_MODEL) || claimedFx.has(zone.fxSlot) || (await insertedElsewhere(zone.fxSlot))) {
      return fallback(`FX${zone.fxSlot} is already in use (${mdl ?? "unknown model"}).`);
    }
    slotNo = zone.fxSlot;
    prevModel = mdl!;
  } else {
    const models = await Promise.all(Array.from({ length: FX_COUNT }, (_, i) => getLeafString(ctx, fxPath(i + 1, "mdl"))));
    for (const [i, mdl] of models.entries()) {
      if (mdl === EMPTY_FX_MODEL && !claimedFx.has(i + 1) && !(await insertedElsewhere(i + 1))) {
        slotNo = i + 1;
        break;
      }
    }
  }
  if (slotNo === undefined) return fallback("no GEQ is inserted on it, and there is no empty FX slot to load one into.");

  const insert = { slot: freeInsert.slot, installed: true, turnedOn: true };
  if (!apply) {
    claimedFx.add(slotNo);
    const flat = new Array<number>(GEQ_BAND_COUNT).fill(0);
    return {
      ...common, kind: "geq", fxSlot: slotNo, keys: null, min: -15, max: 15, active: false,
      originalGains: [...flat], gains: flat, clamped: new Set(), insert,
    };
  }

  if (prevModel !== GEQ_MODEL) {
    await write(fxPath(slotNo), { mdl: GEQ_MODEL }, { mdl: prevModel });
    await sleep(settleMs);
  }
  const geq = await readGeq(ctx, common, slotNo, insert);
  if (!geq) {
    if (prevModel !== GEQ_MODEL) await write(fxPath(slotNo), { mdl: prevModel }, { mdl: GEQ_MODEL });
    return fallback(`the GEQ loaded on FX${slotNo} doesn't expose 31 identifiable band gains.`);
  }
  claimedFx.add(slotNo);
  await write(insertBase(zone, freeInsert.slot), { ins: `FX${slotNo}`, on: 1 }, { ins: "NONE", on: freeInsert.on ? 1 : 0 });
  return geq;
}

/** Applies (or in preview only computes) one round of correction; returns the largest band move in dB. */
async function applyCorrection(
  t: ZoneTarget,
  correction: number[],
  maxBoost: number,
  maxCut: number,
  apply: boolean,
  write: WriteFn,
): Promise<number> {
  if (t.kind === "geq") {
    const assignments: Record<string, number> = {};
    const restore: Record<string, number> = {};
    const next = [...t.gains];
    let largest = 0;
    for (const i of t.bandIdx) {
      const old = t.gains[i];
      // A GEQ that wasn't in the path during the measurement contributed nothing to it.
      const base = t.active ? old : 0;
      const lo = Math.max(t.min, Math.min(old, maxCut));
      const hi = Math.min(t.max, Math.max(old, maxBoost));
      const wanted = base + (Number.isFinite(correction[i]) ? correction[i] : 0);
      next[i] = round1(Math.min(hi, Math.max(lo, wanted)));
      if (wanted < lo || wanted > hi) t.clamped.add(i);
      else t.clamped.delete(i);
      largest = Math.max(largest, Math.abs(next[i] - old));
      if (next[i] !== old && t.keys) {
        assignments[t.keys[i]] = next[i];
        restore[t.keys[i]] = old;
      }
    }
    if (apply && Object.keys(assignments).length > 0) await write(fxPath(t.fxSlot), assignments, restore);
    t.gains = next;
    t.active = true;
    return round1(largest);
  }

  const n = t.native;
  const free = { low: !t.zone.lowCut && !isCutSlope(n.current.low.type), high: !t.zone.highCut && !isCutSlope(n.current.high.type) };
  // The adjustable part of the native EQ: bells, plus the low/high bands when they aren't cuts.
  const shapeOf = (eq: AutoEqNativeEq): NativeEqShape => {
    const bells = [...eq.bands];
    let lowShelf: PeqBand | null = null;
    let highShelf: PeqBand | null = null;
    for (const side of ["low", "high"] as const) {
      const b = eq[side];
      if (!free[side]) continue;
      if (b.type === "SHV") side === "low" ? (lowShelf = b) : (highShelf = b);
      else if (b.type === "PEQ") bells.push(b);
    }
    return { bells, lowShelf, highShelf };
  };
  const active = n.wasOn || n.turnedOn;
  const current = ISO_THIRD_OCTAVE_EXACT_HZ.map((hz) => (active ? nativeEqResponseDb(shapeOf(n.current), hz) : 0));
  const desired = ISO_THIRD_OCTAVE_EXACT_HZ.map((_, i) =>
    t.bandIdx.includes(i) && Number.isFinite(correction[i])
      ? Math.min(Math.max(current[i], maxBoost), Math.max(Math.min(current[i], maxCut), current[i] + correction[i]))
      : NaN,
  );
  const fit = fitNativeEq(ISO_THIRD_OCTAVE_EXACT_HZ, desired, {
    bellCount: PEQ_BAND_COUNT,
    lowBand: free.low,
    highBand: free.high,
    gMin: Math.max(n.limits.gMin, maxCut),
    gMax: Math.min(n.limits.gMax, maxBoost),
    qMin: n.limits.qMin,
    qMax: n.limits.qMax,
    fMin: n.limits.fMin,
    fMax: n.limits.fMax,
    minGainDb: 0.5,
  });
  // Lay bells out by ascending frequency like the console's EQ screen: bells beyond 1-6 take L (lowest)
  // and/or H (highest) when those are free and didn't become a shelf.
  const sorted = [...fit.bells].sort((a, b) => a.f - b.f);
  const openSides = (["low", "high"] as const).filter((side) => free[side] && !(side === "low" ? fit.lowShelf : fit.highShelf));
  const sideBell: Partial<Record<ShelfSide, PeqBand>> = {};
  const extra = sorted.length - PEQ_BAND_COUNT;
  if (extra === 2) {
    sideBell.low = sorted.shift();
    sideBell.high = sorted.pop();
  } else if (extra === 1) {
    const side = openSides.length === 2 ? (sorted[0].f < 1000 ? "low" : "high") : openSides[0];
    sideBell[side] = side === "low" ? sorted.shift() : sorted.pop();
  }
  const nextSide = (side: ShelfSide): AutoEqNativeSide => {
    const cur = n.current[side];
    if (!free[side]) return cur;
    const shelf = side === "low" ? fit.lowShelf : fit.highShelf;
    if (shelf) return { type: "SHV", ...shelf };
    const bell = sideBell[side];
    return bell ? { type: "PEQ", ...bell } : { ...cur, g: 0 };
  };
  const next: AutoEqNativeEq = {
    bands: n.current.bands.map((b, i) => sorted[i] ?? { f: b.f, g: 0, q: b.q }),
    low: nextSide("low"),
    high: nextSide("high"),
  };
  const largest = Math.max(0, ...t.bandIdx.map((i) => Math.abs(nativeEqResponseDb(shapeOf(next), ISO_THIRD_OCTAVE_EXACT_HZ[i]) - current[i])));

  if (apply) {
    const assignments: Record<string, number | string> = {};
    const restore: Record<string, number | string> = {};
    const diff = (prefix: string, nb: PeqBand & { type?: string }, ob: PeqBand & { type?: string }) => {
      for (const field of ["f", "g", "q"] as const) {
        if (nb[field] !== ob[field]) {
          assignments[`${prefix}${field}`] = nb[field];
          restore[`${prefix}${field}`] = ob[field];
        }
      }
      if (nb.type !== undefined && nb.type !== ob.type) {
        assignments[`${prefix}eq`] = nb.type;
        restore[`${prefix}eq`] = ob.type!;
      }
    };
    next.bands.forEach((b, i) => diff(String(i + 1), b, n.current.bands[i]));
    diff("l", next.low, n.current.low);
    diff("h", next.high, n.current.high);
    if (Object.keys(assignments).length > 0) await write(n.path, assignments, restore);
  }
  n.current = next;
  return round1(largest);
}

function zoneResult(t: ZoneTarget): AutoEqZoneResult {
  const base = {
    type: t.zone.type, index: t.zone.index, fromHz: t.zone.fromHz, toHz: t.zone.toHz,
    cuts: t.cuts, nativeEqTurnedOn: t.native.turnedOn,
  };
  if (t.kind === "geq") {
    return {
      ...base,
      eqKind: "geq",
      fxSlot: t.fxSlot,
      insert: t.insert,
      geqBands: t.bandIdx.map((i) => ({
        hz: ISO_THIRD_OCTAVE_NOMINAL_HZ[i],
        old: t.originalGains[i],
        new: t.gains[i],
        clamped: t.clamped.has(i),
      })),
    };
  }
  return {
    ...base,
    eqKind: "peq",
    ...(t.fallbackReason ? { fallbackReason: t.fallbackReason } : {}),
    peq: { old: t.native.original, new: t.native.current },
  };
}

export interface AutoEqUndoResult {
  restoredWrites: number;
}

/** Replays the last run's writes in reverse, restoring every EQ gain, insert and FX model it changed. */
/**
 * Upper bound on a run, from the same constants the run uses. One reference capture, one initial
 * measurement and up to `iterations` more, each capture being a settle plus a sampling window.
 */
export function estimateAutoEqMs(
  opts: Pick<AutoEqBalanceOptions, "iterations" | "sampleMs" | "settleMs">,
): number {
  const sampleMs = opts.sampleMs ?? DEFAULT_SAMPLE_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const captures = 2 + (opts.iterations ?? DEFAULT_ITERATIONS);
  return captures * (settleMs + sampleMs);
}

export async function undoAutoEqBalance(ctx: WingPluginContext): Promise<AutoEqUndoResult> {
  if (running) throw new WingValueError("An auto-EQ balance run is in progress — wait for it to finish before undoing.");
  const log = lastUndoLog;
  if (!log || log.length === 0) throw new WingValueError("Nothing to undo — no auto-EQ balance changes are recorded.");
  running = true;
  try {
    const total = log.length;
    while (log.length > 0) {
      const entry = log[log.length - 1];
      const ack = await ctx.client.bulkSet(entry.baseNode, entry.assignments);
      if (!ack.ok) {
        throw new WingValueError(`Console rejected restoring ${entry.baseNode} (${ack.status}) — undo stopped part-way; run it again to retry.`);
      }
      log.pop();
    }
    lastUndoLog = null;
    return { restoredWrites: total };
  } finally {
    running = false;
  }
}
