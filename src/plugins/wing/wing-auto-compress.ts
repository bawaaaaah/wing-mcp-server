import {
  gainReductionFullScaleDb,
  gainReductionScaleCorrection,
  isBidirectionalDynModel,
  resolveCompressionControl,
} from "./wing-dynamics-models.js";
import { WingUnavailableError, WingValueError } from "./wing-errors.js";
import { abortableDelay, throwIfAborted, type ProgressReporter } from "./long-running.js";
import { resolveStripPath } from "./wing-node-paths.js";
import { parseWingDescribeParams } from "./wing-value-codec.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Auto Compress: a client-side control loop for a dynamics-processing slot — the console has no
 * "auto" mode of its own for either slot (see wing-autogain.ts's header note on why gate/dyn fields
 * are off-limits to that tool). "gate" and "dyn" are both generic dynamics-processing slots on this
 * console, not fixed algorithms: each one's `mdl` field independently selects what actually runs
 * there, so a compressor-type model can be loaded into the "gate" slot (and a gate/ducker-type model
 * into the "dyn" slot) just as easily as the conventional pairing — `block` picks which OSC slot to
 * drive, and callers should check wing_dynamics_status's `mdl` first if they're not sure which slot
 * actually has a compressor loaded on a given strip.
 *
 * `resolveCompressionControl` (wing-dynamics-models.ts) picks, from THIS model's actual live
 * describe() keys, the ONE control that changes how hard it compresses: a threshold (`thr` on most
 * models; `cthr` on ECL33's split comp/limiter; `1-thr` on a Dual Dynamic EQ's band 1), or, on a
 * model with no threshold, a drive/amount knob — `in` (76LA "LE1176", NSTR), `peak` (LA-2A "LA"),
 * `gr` (ONEC, and L100 "LTA100 Leveler" — whose own `ingain` is just make-up trim and never
 * touched), `comp` (LMT). Models with none of these (DS902 de-esser, WAVE transient designer, WARM
 * saturation) are rejected. Three mutually exclusive ways to move it:
 *  - `thresholdDb`: set this exact threshold (`thr`/`cthr`/`1-thr`), once. Rejected for an input-gain model.
 *  - `inputGainDb`: set the drive/amount control (`in`/`ingain`/`gr`/`comp`) to this exact value,
 *    once. Rejected for a model that has a threshold.
 *  - `targetReductionDb` (+ optional `targetMode`, "average" (default) or "peak"): don't ask the
 *    caller for a setting at all — search for one. Each round samples the slot's own live
 *    gain-reduction field against real program material and compares the measured average (or peak)
 *    reduction to the requested target. Which way to nudge the control depends on which kind of
 *    processing is actually loaded — a downward compressor reduces MORE as its threshold drops, a
 *    gate/expander reduces MORE as its threshold RISES, and an 1176-style model reduces MORE as its
 *    input drive RISES — so this seeds the direction from the resolved control's `initialPolarity`,
 *    then empirically checks whether the move helped: two consecutive rounds where the error got
 *    worse instead of better (one alone is treated as possible noise from real, non-stationary
 *    program material) flips polarity once and keeps going in the corrected direction; two
 *    consecutive rounds with no measurable change either way does the same (a switch-like model in a
 *    "dead zone" nowhere near its transition point) — and once both directions have been tried and
 *    neither responds, it stops. A run of consecutive non-improving rounds also grows the step size
 *    (doubling each round, capped). The step is scaled by the control's own native span when its
 *    describe() unit isn't dB (NSTR/L100/LA drive knobs, F670/2250 unitless `thr`) so a few dB of
 *    error doesn't slam a 0..10 knob; a dB-native control keeps a scale of exactly 1. Repeats until
 *    the measurement lands within ~0.75dB of the target, the model's own control range is exhausted,
 *    no measurable response is found in either direction, or `maxIterations` rounds have run —
 *    `target.stopReason` says which. If the current setting already produces the requested reduction,
 *    nothing is touched beyond turning the slot on.
 *
 * Whichever way the control ends up set (or left alone, if no option is given): samples the live
 * meter's own gain-reduction field for that slot against real program material to measure the actual
 * average reduction now happening, and raises/lowers that slot's own makeup gain field by that same
 * amount (plus, for a dB-native input-drive control, the dB it was just pushed by) so the strip's
 * overall loudness stays roughly put. A model with no makeup-gain field at all (LA-2A "LA") reports
 * `makeupGain.applied: false` and nothing is written there.
 */
export type AutoCompressType = "channel" | "aux" | "bus" | "main" | "matrix";
export type AutoCompressBlock = "gate" | "dyn";
export type AutoCompressTargetMode = "average" | "peak";
export type AutoCompressTargetStopReason = "converged" | "unresponsive" | "range-exhausted" | "max-iterations";

const AUTO_COMPRESS_DEFAULT_SAMPLE_MS = 3000;
/** Gives the console a moment to start applying a new threshold before sampling begins. */
/** Names this operation in cancellation messages and progress updates. */
const AUTO_COMPRESS_LABEL = "Auto-compress";

const AUTO_COMPRESS_SETTLE_MS = 200;
/**
 * Below this, treat the input as "nothing to compress" rather than compute a meaningless near-zero
 * makeup adjustment — mirrors AUTOGAIN_NO_SIGNAL_FLOOR_DB's reasoning (wing-autogain.ts). This is a
 * check on the actual audio level (peak input), not on the slot's own threshold parameter, so the
 * same floor applies regardless of which slot ("gate" or "dyn") is being driven.
 */
const AUTO_COMPRESS_NO_SIGNAL_FLOOR_DB = -60;
export const AUTO_COMPRESS_GAIN_FALLBACK_RANGE: readonly [number, number] = [-20, 20];
export const AUTO_COMPRESS_THRESHOLD_FALLBACK_RANGE: readonly [number, number] = [-80, 0];
/** Stop the target-reduction search once the measured value is this close to the request. */
const AUTO_COMPRESS_TARGET_TOLERANCE_DB = 0.75;
const AUTO_COMPRESS_TARGET_MAX_ITERATIONS = 5;
/**
 * Damping factor applied to each round's error before moving the threshold — the actual
 * error-per-dB-of-threshold-move isn't linear (knee, ratio, and the input's own level distribution
 * all affect it), so a full 1:1 correction would tend to overshoot and oscillate; a fraction
 * converges over a few rounds instead without needing to model the compressor's real transfer curve.
 */
const AUTO_COMPRESS_TARGET_STEP_FACTOR = 0.7;
/**
 * Below this much change in |error| between two rounds, treat the last threshold move as having had
 * no measurable effect (rather than as "still converging slowly") — see the polarity note below.
 */
const AUTO_COMPRESS_TARGET_FLAT_EPS = 0.2;
/**
 * How many consecutive flat rounds to require before giving up as "unresponsive" — live program
 * material is noisy enough (verified against a real console: two back-to-back ~1.5s windows on the
 * same steady pink-noise source differed by more than FLAT_EPS purely from sampling variance, with
 * the search still genuinely trending toward the target) that bailing out on a single flat reading
 * risks mistaking normal noise for "nothing is happening" and stopping just short of convergence.
 */
const AUTO_COMPRESS_TARGET_UNRESPONSIVE_STREAK = 2;
/**
 * Each consecutive non-improving round (see deadZoneStreak above) multiplies the step by this much,
 * so a search stuck in a wide dead zone accelerates instead of crawling through it at a fixed rate —
 * capped at AUTO_COMPRESS_TARGET_STEP_GROWTH_CAP_ROUNDS applications so it can't blow up indefinitely
 * against a very long run of non-improving rounds.
 */
const AUTO_COMPRESS_TARGET_STEP_GROWTH = 2;
const AUTO_COMPRESS_TARGET_STEP_GROWTH_CAP_ROUNDS = 3;
/**
 * A dB of reduction error moves a dB-native control (a threshold, or an 1176-style "in" drive whose
 * describe() unit is "dB") roughly 1:1 before STEP_FACTOR damping. A drive knob with NO dB unit
 * (NSTR "in" 0..10, LA-2A "ingain" 0..100, and the unitless "thr" on F670/2250) has no dB scale at
 * all, so its proportional step is remapped: this many dB of useful travel is taken to span the
 * knob's whole native range, keeping the search from slamming a 0..10 knob for a few dB of error.
 * dB-native controls resolve to a scale of exactly 1, so every existing threshold search is
 * bit-for-bit unchanged.
 */
const AUTO_COMPRESS_CTRL_REFERENCE_SPAN_DB = 40;

const BLOCK_METER_FIELDS: Record<AutoCompressBlock, { gainField: string }> = {
  gate: { gainField: "gateGain_dB" },
  dyn: { gainField: "dynGain_dB" },
};

function asNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export interface AutoCompressOptions {
  type: AutoCompressType;
  index: number;
  /** Which dynamics-processing slot to drive — defaults to "dyn", the conventional placement for a
   * compressor, but "gate" is equally valid if that's where a compressor-type model is loaded. */
  block?: AutoCompressBlock;
  /** New threshold in dB for the targeted slot, set once and left alone. On a split comp/limiter
   * model (ECL33) this drives the compressor threshold `cthr`. Mutually exclusive with
   * `targetReductionDb`/`inputGainDb`, and rejected for a model that has no threshold at all (an
   * 1176-style model — use `inputGainDb`/`targetReductionDb` there). Omit all three to leave the
   * current setting as-is and just re-balance makeup gain against it (e.g. after moving it by hand
   * on the console). */
  thresholdDb?: number;
  /** Desired average (or peak, see `targetMode`) gain-reduction amount in dB (e.g. -5) to search for
   * a control setting that produces, by iteratively sampling real program material and nudging the
   * model's own reduction control (threshold `thr`/`cthr`, or input-drive `in`/`ingain` for an
   * 1176-style model) toward the requested figure. Mutually exclusive with `thresholdDb`/`inputGainDb`. */
  targetReductionDb?: number;
  /** Which measured statistic `targetReductionDb` tracks — "average" (default) aims for that mean
   * reduction across the sampling window; "peak" aims for the single deepest reduction sampled. */
  targetMode?: AutoCompressTargetMode;
  /** Caps the number of measure-then-adjust rounds `targetReductionDb` will run — default 5. */
  maxIterations?: number;
  /** Directly set the input-drive control (`in`/`ingain`) to this value, once, on a model that has
   * NO threshold (76LA "LE1176", NSTR, L100, LA). The number is in that control's own units — dB for
   * 76LA, an unitless 0..N knob for the others — and is clamped to the control's live range. Mutually
   * exclusive with `thresholdDb`/`targetReductionDb`, and rejected for a model that does have a
   * threshold (use `thresholdDb` there). */
  inputGainDb?: number;
  /** Optional ratio to set alongside the threshold — channel takes one of the console's enum steps
   * (e.g. "4:1") for the "dyn" slot, plain numeric otherwise. Passed straight to the console rather
   * than locally validated, since the enum/numeric shape differs by strip type and slot. */
  ratio?: number | string;
  sampleMs?: number;
  /** Cancels the run between rounds and during each sampling window — see long-running.ts. Without
   * it a cancelled request keeps measuring and writing to a live desk until it finishes. */
  signal?: AbortSignal;
  /** Called once per measure-then-adjust round, so a client that extends its timeout on progress
   * gets the chance to, and a human watching sees something other than a stalled call. */
  onProgress?: ProgressReporter;
}

export interface AutoCompressResult {
  type: AutoCompressType;
  index: number;
  block: AutoCompressBlock;
  model: string | undefined;
  wasOn: boolean;
  /** The one live parameter the search/set actually drove to change the reduction amount. For a
   * normal compressor `kind: "threshold"`, `key: "thr"`, mirroring `threshold` below; for a split
   * comp/limiter `key: "cthr"`; for a Dual Dynamic EQ `key: "1-thr"`; for an 1176-style model
   * `kind: "input-gain"`, `key: "in"`/`"ingain"`; for a one-knob model `key: "gr"`/`"comp"`. Exactly
   * one control is ever driven — never both. `unit` is `"dB"` for a dB-scaled control, `""` for a
   * unitless knob (NSTR/L100/F670/... — see the step-scale note in the search loop). */
  control: { kind: "threshold" | "input-gain"; key: string; old: number; new: number; unit: string };
  /** Back-compat: still the `thr` field specifically. Mirrors `control` for any threshold-kind model
   * (including `cthr`); for an input-gain model `thr` is never touched, so both read the dumped `thr`
   * (0 when absent) — read `control` for those. */
  threshold: { old: number; new: number };
  ratio: { new: number | string } | null;
  /** Present only when `targetReductionDb` was requested — reports how the search went. */
  target: {
    reductionDb: number;
    mode: AutoCompressTargetMode;
    converged: boolean;
    iterations: number;
    stopReason: AutoCompressTargetStopReason;
  } | null;
  measured: { meanGainReductionDb: number; peakGainReductionDb: number; sampleCount: number; sampleMs: number; gainReductionFullScaleDb: number };
  /** `applied: false` when the model has no makeup-gain (`gain`) field at all (LA-2A "LA") — nothing
   * was written and `new` equals `old`. */
  makeupGain: { old: number; new: number; clamped: boolean; applied: boolean };
  ack: { status: string; ok: boolean; raw: string };
}

interface SampleResult {
  mean: number;
  peak: number;
  count: number;
  peakInputDb: number;
}

/**
 * Throws `WingUnavailableError`/`WingValueError` on failure. If a new threshold was requested, it
 * has already been applied to the console by the time any measurement-stage error is thrown (that
 * part of the request is real and permanent even if audio happened to be quiet during the sampling
 * window) — the error message says so, and only the makeup-gain step is left undone.
 */
/**
 * Upper bound on how long a run will take, derived from the same constants the run itself uses
 * rather than restated. The tool layer refuses a request whose estimate exceeds what a client will
 * wait for — see long-running.ts.
 */
export function estimateAutoCompressMs(
  opts: Pick<AutoCompressOptions, "maxIterations" | "sampleMs" | "targetReductionDb">,
): number {
  const sampleMs = opts.sampleMs ?? AUTO_COMPRESS_DEFAULT_SAMPLE_MS;
  // Without a target there is a single measurement; with one, up to maxIterations measure-then-
  // adjust rounds (each a sampling window plus a settle), and a final verification sample.
  const rounds = opts.targetReductionDb === undefined ? 0 : (opts.maxIterations ?? AUTO_COMPRESS_TARGET_MAX_ITERATIONS);
  return rounds * (sampleMs + AUTO_COMPRESS_SETTLE_MS) + sampleMs;
}

export async function runAutoCompress(ctx: WingPluginContext, opts: AutoCompressOptions): Promise<AutoCompressResult> {
  const block = opts.block ?? "dyn";
  if (block === "gate" && opts.type !== "channel") {
    throw new WingValueError(
      `The "gate" slot only exists on channel strips — ${opts.type} strips only have the "dyn" slot. Use ` +
        `block: "dyn" (or omit block), or type: "channel".`,
    );
  }
  const setModes: string[] = [];
  if (opts.thresholdDb !== undefined) setModes.push("thresholdDb");
  if (opts.targetReductionDb !== undefined) setModes.push("targetReductionDb");
  if (opts.inputGainDb !== undefined) setModes.push("inputGainDb");
  if (setModes.length > 1) {
    throw new WingValueError(
      "Pass at most one of thresholdDb (set an exact threshold), targetReductionDb (search for the control " +
        "setting that produces a given reduction), or inputGainDb (set an exact input-drive value) — got " +
        `${setModes.join(" + ")}.`,
    );
  }
  if (opts.maxIterations !== undefined && (!Number.isInteger(opts.maxIterations) || opts.maxIterations < 1)) {
    throw new WingValueError(`maxIterations must be a positive integer (got ${opts.maxIterations}).`);
  }
  const blockPath = `${resolveStripPath(opts.type, opts.index)}/${block}`;
  const gainField = BLOCK_METER_FIELDS[block].gainField;
  const sampleMs = opts.sampleMs ?? AUTO_COMPRESS_DEFAULT_SAMPLE_MS;

  const [description, values] = await Promise.all([ctx.client.describe(blockPath), ctx.client.dump(blockPath)]);
  const describeParams = parseWingDescribeParams(description.lines);
  const gainParam = describeParams.find((p) => p.key === "gain");
  let [gainMin, gainMax] = AUTO_COMPRESS_GAIN_FALLBACK_RANGE;
  if (gainParam?.min !== undefined) gainMin = gainParam.min;
  if (gainParam?.max !== undefined) gainMax = gainParam.max;
  // Which one control this model uses to change its reduction amount, resolved from its ACTUAL live
  // describe() keys (thr -> cthr -> in -> ingain -> none) — never a hand-maintained model->field
  // table. See resolveCompressionControl in wing-dynamics-models.ts for the per-model reasoning.
  const control = resolveCompressionControl(describeParams.map((p) => p.key));
  const ctrlParam = control ? describeParams.find((p) => p.key === control.key) : undefined;
  let [ctrlMin, ctrlMax] = AUTO_COMPRESS_THRESHOLD_FALLBACK_RANGE;
  if (ctrlParam?.min !== undefined) ctrlMin = ctrlParam.min;
  if (ctrlParam?.max !== undefined) ctrlMax = ctrlParam.max;
  // Some describe()/appendix lines print the bounds reversed (e.g. D241's `thr` as "[0 .. -60]") —
  // normalise so the clamp math below always has min <= max.
  if (ctrlMin > ctrlMax) [ctrlMin, ctrlMax] = [ctrlMax, ctrlMin];
  // A dB of reduction error maps ~1:1 onto a dB-native control; a knob with no dB unit (NSTR/L100/LA
  // drive, or the unitless `thr` on F670/2250) is remapped to its own native span — see the const.
  const ctrlIsDb = ctrlParam?.unit?.toLowerCase() === "db" || (ctrlParam?.unit === undefined && ctrlMin < 0);
  const ctrlUnitScale = ctrlIsDb ? 1 : (ctrlMax - ctrlMin) / AUTO_COMPRESS_CTRL_REFERENCE_SPAN_DB;
  const ctrlUnitSuffix = ctrlIsDb ? "dB" : "";

  const model = values.mdl !== undefined ? String(values.mdl) : undefined;
  const wasOn = asNumber(values.on, 0) === 1;
  const oldThresholdRaw = asNumber(values.thr, 0);
  const oldMakeupGain = asNumber(values.gain, 0);
  const oldControl = control ? asNumber(values[control.key], NaN) : oldThresholdRaw;

  // Every gate/dyn model has its own, often wildly different parameter set (see the "Gate/Compressor
  // plugins" appendix in WING_Remote-Protocols-3.1-03.pdf) — most expose "thr", but ECL33 splits it
  // into "cthr"/"lthr", a Dual Dynamic EQ uses per-band "1-thr"/"2-thr", 76LA/NSTR drive off an "in"
  // knob, L100/LA off "ingain", and one-knob models (ONEC/LMT) off a "gr"/"comp" amount knob. A few
  // (DS902 de-esser, WAVE transient designer, WARM saturation) have no reduction-amount control at
  // all. `resolveCompressionControl` above picks the ONE control this model actually uses, from the
  // live describe() — never a hand-maintained table.
  const anySet = opts.thresholdDb !== undefined || opts.targetReductionDb !== undefined || opts.inputGainDb !== undefined;
  if (anySet && !control) {
    throw new WingValueError(
      `Model ${model ?? "(unknown)"} on ${opts.type} ${opts.index} ${block} has no threshold or drive/amount ` +
        "control to move — this model uses different controls. Available parameters: " +
        `${describeParams.map((p) => p.key).join(", ")}. Omit thresholdDb/targetReductionDb/inputGainDb to just ` +
        "re-balance makeup gain against this model's current settings instead.",
    );
  }
  if (opts.thresholdDb !== undefined && control?.kind === "input-gain") {
    throw new WingValueError(
      `Model ${model ?? "(unknown)"} on ${opts.type} ${opts.index} ${block} has no threshold — it is driven by ` +
        `its "${control.key}" control instead. Use inputGainDb to set it directly, or targetReductionDb to ` +
        "search for the value that produces the reduction you want.",
    );
  }
  if (opts.inputGainDb !== undefined && control?.kind === "threshold") {
    throw new WingValueError(
      `Model ${model ?? "(unknown)"} on ${opts.type} ${opts.index} ${block} has a threshold ("${control.key}") — ` +
        "use thresholdDb (or targetReductionDb), not inputGainDb.",
    );
  }
  if (
    control?.kind === "input-gain" &&
    (opts.targetReductionDb !== undefined || opts.inputGainDb !== undefined) &&
    (ctrlParam?.min === undefined || ctrlParam?.max === undefined)
  ) {
    throw new WingValueError(
      `Model ${model ?? "(unknown)"} on ${opts.type} ${opts.index} ${block} exposes "${control.key}" but the ` +
        "console didn't report its range — an input-gain control can't be driven safely without its bounds.",
    );
  }
  if (control?.kind === "input-gain" && anySet && !Number.isFinite(oldControl)) {
    throw new WingUnavailableError(
      `Couldn't read the current "${control.key}" value for ${opts.type} ${opts.index} ${block} from the console ` +
        "dump — can't move it from an unknown starting point. Nothing was changed.",
    );
  }
  if (opts.ratio !== undefined && !describeParams.some((p) => p.key === "ratio")) {
    throw new WingValueError(
      `Model ${model ?? "(unknown)"} on ${opts.type} ${opts.index} ${block} has no "ratio" field to set — ` +
        `this model uses different controls. Available parameters: ${describeParams.map((p) => p.key).join(", ")}.`,
    );
  }

  // The meter protocol's gate/dyn gain words only carry the DEFAULT 20dB-full-scale scaling (it has
  // no way to know which model is loaded — see wing-meter-protocol.ts's toGainReductionDb) — correct
  // for the one documented exception (the "GATE" model, whose true full-scale is its own live `range`
  // knob) using the settings just freshly dumped above, before any sampling happens.
  const gainScaleCorrection = gainReductionScaleCorrection(values);
  const bidirectional = isBidirectionalDynModel(model);

  async function sampleReduction(ms: number): Promise<SampleResult> {
    let peakInputDb = -Infinity;
    const gainSamples: number[] = [];
    const onSnapshot = (snapshot: { frames: Record<string, unknown>[] }) => {
      for (const frame of snapshot.frames) {
        if (frame.type === opts.type && frame.index === opts.index) {
          gainSamples.push(Number(frame[gainField]) * gainScaleCorrection);
          peakInputDb = Math.max(peakInputDb, Number(frame.inputL_dB), Number(frame.inputR_dB));
        }
      }
    };
    // Captured once: ctx.meterClient is a live getter that can re-resolve to a new instance across
    // this await (a host/config change mid-sample) — attaching on one instance and detaching from
    // a different one would silently leave the listener stuck on the old, discarded client.
    const meterClient = ctx.meterClient;
    meterClient.on("snapshot", onSnapshot);
    try {
      await abortableDelay(ms, opts.signal, AUTO_COMPRESS_LABEL);
    } finally {
      // In a finally because the delay now rejects on cancellation: an early return would otherwise
      // leave this listener attached to the meter client for the life of the process.
      meterClient.off("snapshot", onSnapshot);
    }

    if (gainSamples.length === 0) {
      return { mean: NaN, peak: NaN, count: 0, peakInputDb };
    }
    // Verified against real hardware: some cut-only models idle with a slight positive wobble in
    // their own gain-reduction reading (detector ripple, not an actual gain boost) — clamp each raw
    // sample to <=0 before averaging, so idle noise never computes a small makeup-gain nudge in the
    // wrong direction (or dilutes a real reduction average) when nothing is actually being
    // compressed. A Dynamic EQ model is the one exception: it can legitimately boost as well as cut,
    // so a positive sample there is real activity, not idle noise, and must NOT be clamped away — the
    // makeup-gain formula compensates correctly in either direction regardless.
    const reductionSamples = bidirectional ? gainSamples : gainSamples.map((v) => Math.min(v, 0));
    const mean = reductionSamples.reduce((sum, v) => sum + v, 0) / reductionSamples.length;
    const peak = reductionSamples.reduce((p, v) => (Math.abs(v) > Math.abs(p) ? v : p), 0);
    return { mean, peak, count: gainSamples.length, peakInputDb };
  }

  function ensureSample(sample: SampleResult, note: string, context: string): void {
    if (sample.count === 0) {
      throw new WingUnavailableError(
        `${note}no live meter data was received for ${opts.type} ${opts.index} — is the meter client ` +
          "connected? Makeup gain was left unchanged.",
      );
    }
    if (sample.peakInputDb <= AUTO_COMPRESS_NO_SIGNAL_FLOOR_DB) {
      throw new WingValueError(
        `${note || "No "}real signal was detected on ${opts.type} ${opts.index} while ${context} (peak input ` +
          `${sample.peakInputDb.toFixed(1)}dB) — send real program material through it, then run this again to ` +
          "compute and apply makeup gain. Makeup gain was left unchanged.",
      );
    }
  }

  let currentControl = oldControl;
  let target: AutoCompressResult["target"] = null;
  let lastSample: SampleResult;

  if (opts.targetReductionDb !== undefined) {
    const targetMode = opts.targetMode ?? "average";
    const maxIterations = opts.maxIterations ?? AUTO_COMPRESS_TARGET_MAX_ITERATIONS;
    let controlTouched = false;

    // Turn the slot on if it wasn't, without touching its reduction control yet — the loop below only
    // moves the control once an actual measurement says it should (and not at all if the current
    // setting already produces the requested reduction).
    if (!wasOn) {
      const onAck = await ctx.client.bulkSet(blockPath, { on: 1 });
      if (!onAck.ok) {
        throw new WingValueError(`Console rejected turning ${block} on (${onAck.status}) — nothing was changed.`);
      }
      await abortableDelay(AUTO_COMPRESS_SETTLE_MS, opts.signal, AUTO_COMPRESS_LABEL);
    }
    if (opts.ratio !== undefined) {
      const ratioAck = await ctx.client.bulkSet(blockPath, { ratio: opts.ratio });
      if (!ratioAck.ok) {
        throw new WingValueError(`Console rejected the new ratio (${ratioAck.status}) — nothing else was changed.`);
      }
    }

    let converged = false;
    let stopReason: AutoCompressTargetStopReason = "max-iterations";
    let iterations = 0;
    let sample: SampleResult | null = null;
    // Seed the search direction from the resolved control's `initialPolarity` (+1 for a threshold:
    // lower -> more reduction; -1 for an input-drive knob: push harder -> more reduction). That's
    // only the first guess — a gate/expander loaded into this slot inverts the threshold rule, and
    // the model list is too large (and its documentation too "best-effort/unconfirmed") to hand-
    // classify — so this still checks empirically: if a move made the error worse instead of better,
    // flip once and keep going in the corrected direction.
    let polarity: 1 | -1 = control ? control.initialPolarity : 1;
    let hasFlipped = false;
    let flatStreak = 0;
    // Counts consecutive non-improving rounds regardless of a polarity flip in between (unlike
    // flatStreak, which resets on flip so each direction gets its own fair give-up window) — used
    // only to grow the step size. A model can have a wide "dead zone" (e.g. a gate whose threshold
    // starts far below the key level, so nothing measurable happens until the threshold gets close)
    // that AUTO_COMPRESS_TARGET_STEP_FACTOR's small fixed fraction would take many rounds to cross —
    // more than the unresponsive-streak tolerance allows before giving up. Doubling the step each
    // additional non-improving round lets the search escape a dead zone in a couple of rounds instead
    // of crawling through it at a fixed rate.
    let deadZoneStreak = 0;
    // Consecutive worsened rounds seen before the one-time flip is actually committed. Verified live
    // against real (non-stationary) music: a single worsened reading isn't reliable proof the assumed
    // polarity is backwards, because the program material's OWN loudness can drift between two ~1-2s
    // sampling windows by more than AUTO_COMPRESS_TARGET_FLAT_EPS regardless of which way the
    // threshold just moved — on a genuinely correctly-guessed compressor this masqueraded as a
    // "worsened" round and triggered a spurious flip that then fought the correct direction for the
    // rest of the search. Requiring AUTO_COMPRESS_TARGET_UNRESPONSIVE_STREAK worsened rounds in a row
    // (same tolerance already used for the flat/give-up case) before committing to the flip is enough
    // to tell a genuine polarity mismatch (worsens repeatedly, since every move is backwards) apart
    // from one noisy/content-driven blip (usually followed by an improving round once the real,
    // correctly-signed error reasserts itself).
    let worsenStreak = 0;
    let prevError: number | null = null;
    for (; iterations < maxIterations; iterations++) {
      throwIfAborted(opts.signal, AUTO_COMPRESS_LABEL);
      opts.onProgress?.({
        progress: iterations,
        total: maxIterations,
        message: `measuring round ${iterations + 1} of ${maxIterations}`,
      });
      sample = await sampleReduction(sampleMs);
      const note = controlTouched
        ? `${control!.kind === "input-gain" ? "Input-gain" : "Threshold"} search moved ${control!.key} to ` +
          `${currentControl}${ctrlUnitSuffix}, but `
        : "";
      ensureSample(
        sample,
        note,
        control!.kind === "input-gain" ? "searching for an input-gain setting" : "searching for a threshold",
      );

      const measuredValue = targetMode === "peak" ? sample.peak : sample.mean;
      const error = opts.targetReductionDb - measuredValue;
      if (Math.abs(error) <= AUTO_COMPRESS_TARGET_TOLERANCE_DB) {
        converged = true;
        stopReason = "converged";
        iterations++;
        break;
      }

      if (prevError !== null) {
        const worsened = Math.abs(error) > Math.abs(prevError) + AUTO_COMPRESS_TARGET_FLAT_EPS;
        const improved = Math.abs(error) < Math.abs(prevError) - AUTO_COMPRESS_TARGET_FLAT_EPS;
        if (improved) {
          flatStreak = 0;
          deadZoneStreak = 0;
          worsenStreak = 0;
        } else if (worsened) {
          // A "worsened" reading means the last move DID change something — that's real information,
          // just possibly an overshoot (e.g. a proportional step crossing a steep, near switch-like
          // transfer curve typical of a gate near its threshold), or on real (non-stationary) program
          // material, just the content itself getting momentarily louder/softer between windows,
          // independent of the threshold move. Unlike a flat round, this doesn't count against the
          // give-up streak. Before the flip has happened, require two worsened rounds in a row before
          // committing to it — a single one is exactly as likely to be content-driven noise as a real
          // polarity mismatch, and this mirrors the same reasoning already used for flat rounds.
          if (!hasFlipped) {
            worsenStreak++;
            if (worsenStreak >= AUTO_COMPRESS_TARGET_UNRESPONSIVE_STREAK) {
              polarity = polarity === 1 ? -1 : 1;
              hasFlipped = true;
              worsenStreak = 0;
            }
          }
          // After the flip, a worsened round is most likely a step-size overshoot, and the next
          // round's freshly signed error naturally corrects back the other way — reset both give-up
          // streaks either way so this fresh information gets its own full grace period rather than
          // inheriting a count built up from earlier, unrelated flat (no-response) rounds.
          flatStreak = 0;
          deadZoneStreak = 0;
        } else {
          // Flat: no measurable change either way. Real program material is noisy enough that a
          // single flat round can just be sampling variance rather than genuine non-response, so
          // this only gives up after AUTO_COMPRESS_TARGET_UNRESPONSIVE_STREAK consecutive flat
          // rounds — otherwise it keeps trying the same direction (with a growing step, see
          // deadZoneStreak above) in case the next round clears.
          flatStreak++;
          deadZoneStreak++;
          if (flatStreak >= AUTO_COMPRESS_TARGET_UNRESPONSIVE_STREAK) {
            if (!hasFlipped) {
              // Every round so far, in the assumed compressor direction, produced no measurable
              // response at all (e.g. already fully open/closed and pushing further that way can
              // never change anything) — try the opposite polarity once before concluding neither
              // direction responds, same reasoning as the boundary-probe case below.
              polarity = polarity === 1 ? -1 : 1;
              hasFlipped = true;
              flatStreak = 0;
            } else {
              stopReason = "unresponsive";
              iterations++;
              break;
            }
          }
        }
      }
      prevError = error;

      const stepScale = AUTO_COMPRESS_TARGET_STEP_GROWTH ** Math.min(deadZoneStreak, AUTO_COMPRESS_TARGET_STEP_GROWTH_CAP_ROUNDS);
      const clampedStep = (dir: 1 | -1) =>
        Number(
          Math.min(
            ctrlMax,
            Math.max(ctrlMin, currentControl + dir * error * AUTO_COMPRESS_TARGET_STEP_FACTOR * stepScale * ctrlUnitScale),
          ).toFixed(1),
        );
      let nextControl = clampedStep(polarity);
      if (nextControl === currentControl && !controlTouched && !hasFlipped) {
        // The very first move, in the seeded direction, is already blocked by the model's own control
        // range — e.g. the control is already sitting at that boundary. Rather than give up having
        // never taken a single real measurement to learn from, try the opposite polarity once before
        // concluding the range is genuinely exhausted: if the seed was backwards for this slot, this
        // often recovers a search that would otherwise never get the data point it needs to self-correct.
        polarity = polarity === 1 ? -1 : 1;
        hasFlipped = true;
        nextControl = clampedStep(polarity);
      }
      if (nextControl === currentControl) {
        // Already at the edge of this model's own control range (in whichever direction) and still
        // not there — no further iteration can help, so stop instead of burning the rest of the budget.
        stopReason = "range-exhausted";
        iterations++;
        break;
      }
      currentControl = nextControl;
      const setAck = await ctx.client.bulkSet(blockPath, { [control!.key]: currentControl });
      if (!setAck.ok) {
        throw new WingValueError(
          `Console rejected ${control!.key} ${currentControl}${ctrlUnitSuffix} while searching (${setAck.status}) — ` +
            "nothing more was changed.",
        );
      }
      controlTouched = true;
      await abortableDelay(AUTO_COMPRESS_SETTLE_MS, opts.signal, AUTO_COMPRESS_LABEL);
    }
    target = { reductionDb: opts.targetReductionDb, mode: targetMode, converged, iterations, stopReason };
    lastSample = sample as SampleResult;
  } else {
    const assignments: Record<string, number | string> = {};
    if (opts.thresholdDb !== undefined) {
      // control is guaranteed non-null here (a set was requested and !control already threw) and,
      // for thresholdDb specifically, kind === "threshold" (input-gain models were rejected above).
      // Clamp to the control's own live range, same as inputGainDb below — a threshold isn't always
      // negative dB (E88C/B560 have positive headroom; B160/F670/2250 have a unitless `thr`).
      assignments[control!.key] = Number(Math.min(ctrlMax, Math.max(ctrlMin, opts.thresholdDb)).toFixed(1));
      assignments.on = 1;
    } else if (opts.inputGainDb !== undefined) {
      assignments[control!.key] = Number(Math.min(ctrlMax, Math.max(ctrlMin, opts.inputGainDb)).toFixed(1));
      assignments.on = 1;
    }
    if (opts.ratio !== undefined) {
      assignments.ratio = opts.ratio;
    }
    if (Object.keys(assignments).length > 0) {
      const setAck = await ctx.client.bulkSet(blockPath, assignments);
      if (!setAck.ok) {
        throw new WingValueError(
          `Console rejected the new ${control?.key ?? "control"}/ratio (${setAck.status}) — nothing was changed.`,
        );
      }
      await abortableDelay(AUTO_COMPRESS_SETTLE_MS, opts.signal, AUTO_COMPRESS_LABEL);
    }
    currentControl = control && assignments[control.key] !== undefined ? Number(assignments[control.key]) : oldControl;
    const appliedNote =
      opts.thresholdDb !== undefined
        ? `${control?.key === "cthr" ? "Compressor threshold" : "Threshold"} was set to ${currentControl}${ctrlUnitSuffix}, but `
        : opts.inputGainDb !== undefined
          ? `Input gain was set to ${currentControl}${ctrlUnitSuffix}, but `
          : "";

    lastSample = await sampleReduction(sampleMs);
    ensureSample(lastSample, appliedNote, "sampling");
  }

  // A dB-native input-drive control we just pushed also makes the signal that much hotter going into
  // the compressor, on top of the measured reduction — subtract both so the block stays ~unity. A
  // unitless drive knob has no dB delta to compensate (and currentControl === oldControl on a no-op
  // rebalance), so that term is 0.
  const controlDeltaDb = control?.kind === "input-gain" && ctrlIsDb ? currentControl - oldControl : 0;
  const rawNewMakeupGain = oldMakeupGain - lastSample.mean - controlDeltaDb;

  let makeupGain: AutoCompressResult["makeupGain"];
  let ack: AutoCompressResult["ack"];
  if (gainParam) {
    const newMakeupGain = Math.min(gainMax, Math.max(gainMin, rawNewMakeupGain));
    const roundedMakeupGain = Number(newMakeupGain.toFixed(1));
    ack = await ctx.client.bulkSet(blockPath, { gain: roundedMakeupGain });
    makeupGain = { old: oldMakeupGain, new: roundedMakeupGain, clamped: newMakeupGain !== rawNewMakeupGain, applied: true };
  } else {
    // LA-2A ("LA") has no makeup-gain field at all — nothing to write, nothing to compensate.
    ack = { status: "OK", ok: true, raw: "OK (model has no makeup-gain field)" };
    makeupGain = { old: oldMakeupGain, new: oldMakeupGain, clamped: false, applied: false };
  }

  const controlOld = Number.isFinite(oldControl) ? oldControl : oldThresholdRaw;
  const controlNew = Number.isFinite(currentControl) ? currentControl : oldThresholdRaw;

  return {
    type: opts.type,
    index: opts.index,
    block,
    model,
    wasOn,
    control: {
      kind: control ? control.kind : "threshold",
      key: control ? control.key : "thr",
      old: controlOld,
      new: controlNew,
      unit: ctrlUnitSuffix,
    },
    threshold: {
      old: control?.kind === "threshold" ? controlOld : oldThresholdRaw,
      new: control?.kind === "threshold" ? controlNew : oldThresholdRaw,
    },
    ratio: opts.ratio !== undefined ? { new: opts.ratio } : null,
    target,
    measured: {
      meanGainReductionDb: lastSample.mean,
      peakGainReductionDb: lastSample.peak,
      sampleCount: lastSample.count,
      sampleMs,
      gainReductionFullScaleDb: gainReductionFullScaleDb(values),
    },
    makeupGain,
    ack,
  };
}
