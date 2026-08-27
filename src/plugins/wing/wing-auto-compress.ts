import { gainReductionFullScaleDb, gainReductionScaleCorrection, isBidirectionalDynModel } from "./wing-dynamics-models.js";
import { WingUnavailableError, WingValueError } from "./wing-errors.js";
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
 * Two mutually exclusive ways to move the threshold, both validated against THIS model's actual
 * live describe() first (not every one of the 30+ gate/dyn models has a "thr" field at all — see the
 * describeParams check below):
 *  - `thresholdDb`: set this exact threshold, once. Caller already knows the number they want.
 *  - `targetReductionDb` (+ optional `targetMode`, "average" (default) or "peak"): don't ask the
 *    caller for a threshold at all — search for one. Each round samples the slot's own live
 *    gain-reduction field against real program material and compares the measured average (or peak)
 *    reduction to the requested target. Which way to nudge the threshold depends on which kind of
 *    processing is actually loaded — a downward compressor/limiter reduces MORE as the threshold
 *    drops (more of the signal exceeds it), while a gate/expander reduces MORE as the threshold
 *    RISES (more of the signal falls below it) — and the model list is large enough, and the only
 *    documentation of it "best-effort, not confirmed against hardware/firmware", that this doesn't
 *    hand-maintain a model->polarity table any more than it hand-maintains a model->field table
 *    above. Instead it assumes compressor-style polarity on the very first move, then empirically
 *    checks whether that move actually helped: two consecutive rounds where the error got worse
 *    instead of better (one alone is treated as possible noise from real, non-stationary program
 *    material rather than proof of a wrong direction) flips polarity once and keeps going in the
 *    corrected direction; two consecutive rounds with no measurable change either way does the same
 *    (this can mean a switch-like model, e.g. a gate, sitting in a "dead zone" nowhere near its
 *    actual transition point) — and once both directions have been tried and neither responds, it
 *    stops rather than keep pushing a control the material isn't responding to. A run of consecutive
 *    non-improving rounds also grows the step size (doubling each round, capped) so a search stuck in
 *    a wide dead zone escapes it in a couple of rounds instead of crawling through at a fixed rate.
 *    Repeats until the measurement lands within ~0.75dB of the target, the model's own thr range is
 *    exhausted, no measurable response is found in either direction, or `maxIterations` rounds have
 *    run — `target.stopReason` in the result says which. If the current threshold already produces
 *    the requested reduction, nothing is touched at all beyond turning the slot on.
 *
 * Whichever way the threshold ends up set (or left alone, if neither option is given): samples the
 * live meter's own gain-reduction field for that slot against real program material to measure the
 * actual average reduction now happening, and raises/lowers that slot's own makeup gain field by
 * that same amount so the strip's overall loudness stays roughly put even though it's squashing
 * peaks harder.
 */
export type AutoCompressType = "channel" | "aux" | "bus" | "main" | "matrix";
export type AutoCompressBlock = "gate" | "dyn";
export type AutoCompressTargetMode = "average" | "peak";
export type AutoCompressTargetStopReason = "converged" | "unresponsive" | "range-exhausted" | "max-iterations";

const AUTO_COMPRESS_DEFAULT_SAMPLE_MS = 3000;
/** Gives the console a moment to start applying a new threshold before sampling begins. */
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
  /** New threshold in dB for the targeted slot, set once and left alone. Mutually exclusive with
   * `targetReductionDb`. Omit both to leave the current threshold as-is and just re-balance makeup
   * gain against it (e.g. after moving the threshold by hand on the console). */
  thresholdDb?: number;
  /** Desired average (or peak, see `targetMode`) gain-reduction amount in dB (e.g. -5) to search for
   * a threshold that produces, by iteratively sampling real program material and nudging the
   * threshold toward the requested figure. Mutually exclusive with `thresholdDb`. */
  targetReductionDb?: number;
  /** Which measured statistic `targetReductionDb` tracks — "average" (default) aims for that mean
   * reduction across the sampling window; "peak" aims for the single deepest reduction sampled. */
  targetMode?: AutoCompressTargetMode;
  /** Caps the number of measure-then-adjust rounds `targetReductionDb` will run — default 5. */
  maxIterations?: number;
  /** Optional ratio to set alongside the threshold — channel takes one of the console's enum steps
   * (e.g. "4:1") for the "dyn" slot, plain numeric otherwise. Passed straight to the console rather
   * than locally validated, since the enum/numeric shape differs by strip type and slot. */
  ratio?: number | string;
  sampleMs?: number;
}

export interface AutoCompressResult {
  type: AutoCompressType;
  index: number;
  block: AutoCompressBlock;
  model: string | undefined;
  wasOn: boolean;
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
  makeupGain: { old: number; new: number; clamped: boolean };
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
export async function runAutoCompress(ctx: WingPluginContext, opts: AutoCompressOptions): Promise<AutoCompressResult> {
  const block = opts.block ?? "dyn";
  if (block === "gate" && opts.type !== "channel") {
    throw new WingValueError(
      `The "gate" slot only exists on channel strips — ${opts.type} strips only have the "dyn" slot. Use ` +
        `block: "dyn" (or omit block), or type: "channel".`,
    );
  }
  if (opts.thresholdDb !== undefined && opts.targetReductionDb !== undefined) {
    throw new WingValueError(
      `Pass either thresholdDb (a specific threshold to set) or targetReductionDb (a reduction amount to search ` +
        `for a threshold that produces), not both.`,
    );
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
  const thrParam = describeParams.find((p) => p.key === "thr");
  let [thrMin, thrMax] = AUTO_COMPRESS_THRESHOLD_FALLBACK_RANGE;
  if (thrParam?.min !== undefined) thrMin = thrParam.min;
  if (thrParam?.max !== undefined) thrMax = thrParam.max;

  const model = values.mdl !== undefined ? String(values.mdl) : undefined;
  const wasOn = asNumber(values.on, 0) === 1;
  const oldThreshold = asNumber(values.thr, 0);
  const oldMakeupGain = asNumber(values.gain, 0);

  // Every gate/dyn model has its own, often wildly different parameter set (see the "Gate/Compressor
  // plugins" appendix in WING_Remote-Protocols-3.1-03.pdf) — e.g. 76LA/LA/NSTR/WAVE/ECL33/LMT/ONEC/
  // L100/DS902 have no "thr" at all (76LA/NSTR use `in`/`out` gain-staging instead; ONEC/LMT have no
  // threshold-style control whatsoever), and Dynamic EQ (DEQ/DEQ2) uses per-band "1-thr"/"2-thr", not
  // a single "thr". Rather than hand-maintaining a model->field table (fragile, and the appendix
  // itself is "transcribed best-effort, not confirmed against hardware/firmware" in places), check
  // this slot's ACTUAL currently-loaded model via the describe() just fetched above — the console's
  // own live answer for what this model really exposes right now, immune to any transcription error
  // or future firmware change adding/renaming models.
  if ((opts.thresholdDb !== undefined || opts.targetReductionDb !== undefined) && !thrParam) {
    throw new WingValueError(
      `Model ${model ?? "(unknown)"} on ${opts.type} ${opts.index} ${block} has no "thr" field to set a ` +
        `threshold on — this model uses different controls. Available parameters: ` +
        `${describeParams.map((p) => p.key).join(", ")}. Omit thresholdDb/targetReductionDb to just re-balance ` +
        `makeup gain against this model's current settings instead.`,
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
    const onSnapshot = (snapshot: { frames: Array<Record<string, unknown>> }) => {
      for (const frame of snapshot.frames) {
        if (frame.type === opts.type && frame.index === opts.index) {
          gainSamples.push(Number(frame[gainField]) * gainScaleCorrection);
          peakInputDb = Math.max(peakInputDb, Number(frame.inputL_dB), Number(frame.inputR_dB));
        }
      }
    };
    ctx.meterClient.on("snapshot", onSnapshot);
    await new Promise((resolve) => setTimeout(resolve, ms));
    ctx.meterClient.off("snapshot", onSnapshot);

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
          `connected? Makeup gain was left unchanged.`,
      );
    }
    if (sample.peakInputDb <= AUTO_COMPRESS_NO_SIGNAL_FLOOR_DB) {
      throw new WingValueError(
        `${note || "No "}real signal was detected on ${opts.type} ${opts.index} while ${context} (peak input ` +
          `${sample.peakInputDb.toFixed(1)}dB) — send real program material through it, then run this again to ` +
          `compute and apply makeup gain. Makeup gain was left unchanged.`,
      );
    }
  }

  let currentThreshold = oldThreshold;
  let target: AutoCompressResult["target"] = null;
  let lastSample: SampleResult;

  if (opts.targetReductionDb !== undefined) {
    const targetMode = opts.targetMode ?? "average";
    const maxIterations = opts.maxIterations ?? AUTO_COMPRESS_TARGET_MAX_ITERATIONS;
    let thresholdTouched = false;

    // Turn the slot on if it wasn't, without touching its threshold value yet — the loop below only
    // moves `thr` once an actual measurement says it should (and not at all if the current threshold
    // already produces the requested reduction).
    if (!wasOn) {
      const onAck = await ctx.client.bulkSet(blockPath, { on: 1 });
      if (!onAck.ok) {
        throw new WingValueError(`Console rejected turning ${block} on (${onAck.status}) — nothing was changed.`);
      }
      await new Promise((resolve) => setTimeout(resolve, AUTO_COMPRESS_SETTLE_MS));
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
    // Assumes compressor-style polarity (lower threshold -> more reduction) on the first move, since
    // that's the more common case across the model list — but a gate/expander is the opposite
    // (raising the threshold gates more of the signal, so reduction goes UP as threshold goes up).
    // Rather than hand-classify all 30+ models' polarity from documentation the appendix itself
    // calls best-effort/unconfirmed, this checks empirically: if a move made the error worse instead
    // of better, flip once and keep going in the corrected direction.
    let polarity: 1 | -1 = 1;
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
      sample = await sampleReduction(sampleMs);
      const note = thresholdTouched ? `Threshold search moved the threshold to ${currentThreshold}dB, but ` : "";
      ensureSample(sample, note, "searching for a threshold");

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
        Number(Math.min(thrMax, Math.max(thrMin, currentThreshold + dir * error * AUTO_COMPRESS_TARGET_STEP_FACTOR * stepScale)).toFixed(1));
      let nextThreshold = clampedStep(polarity);
      if (nextThreshold === currentThreshold && !thresholdTouched && !hasFlipped) {
        // The very first move, in the default compressor-assumed direction, is already blocked by
        // the model's own thr range — e.g. the threshold is already sitting at that boundary. Rather
        // than give up having never taken a single real measurement to learn from, try the opposite
        // polarity once before concluding the range is genuinely exhausted: for a gate/expander this
        // first guess is backwards anyway, so this often recovers a search that would otherwise never
        // get the data point it needs to self-correct.
        polarity = polarity === 1 ? -1 : 1;
        hasFlipped = true;
        nextThreshold = clampedStep(polarity);
      }
      if (nextThreshold === currentThreshold) {
        // Already at the edge of this model's own thr range (in whichever direction) and still not
        // there — no further iteration can help, so stop instead of burning the rest of the budget.
        stopReason = "range-exhausted";
        iterations++;
        break;
      }
      currentThreshold = nextThreshold;
      const setAck = await ctx.client.bulkSet(blockPath, { thr: currentThreshold });
      if (!setAck.ok) {
        throw new WingValueError(`Console rejected threshold ${currentThreshold}dB while searching (${setAck.status}) — nothing more was changed.`);
      }
      thresholdTouched = true;
      await new Promise((resolve) => setTimeout(resolve, AUTO_COMPRESS_SETTLE_MS));
    }
    target = { reductionDb: opts.targetReductionDb, mode: targetMode, converged, iterations, stopReason };
    lastSample = sample as SampleResult;
  } else {
    const assignments: Record<string, number | string> = {};
    if (opts.thresholdDb !== undefined) {
      assignments.thr = opts.thresholdDb;
      assignments.on = 1;
    }
    if (opts.ratio !== undefined) {
      assignments.ratio = opts.ratio;
    }
    if (Object.keys(assignments).length > 0) {
      const setAck = await ctx.client.bulkSet(blockPath, assignments);
      if (!setAck.ok) {
        throw new WingValueError(`Console rejected the new threshold/ratio (${setAck.status}) — nothing was changed.`);
      }
      await new Promise((resolve) => setTimeout(resolve, AUTO_COMPRESS_SETTLE_MS));
    }
    currentThreshold = opts.thresholdDb ?? oldThreshold;
    const appliedNote = opts.thresholdDb !== undefined ? `Threshold was set to ${opts.thresholdDb}dB, but ` : "";

    lastSample = await sampleReduction(sampleMs);
    ensureSample(lastSample, appliedNote, "sampling");
  }

  const rawNewMakeupGain = oldMakeupGain - lastSample.mean;
  const newMakeupGain = Math.min(gainMax, Math.max(gainMin, rawNewMakeupGain));
  const roundedMakeupGain = Number(newMakeupGain.toFixed(1));

  const ack = await ctx.client.bulkSet(blockPath, { gain: roundedMakeupGain });

  return {
    type: opts.type,
    index: opts.index,
    block,
    model,
    wasOn,
    threshold: { old: oldThreshold, new: currentThreshold },
    ratio: opts.ratio !== undefined ? { new: opts.ratio } : null,
    target,
    measured: {
      meanGainReductionDb: lastSample.mean,
      peakGainReductionDb: lastSample.peak,
      sampleCount: lastSample.count,
      sampleMs,
      gainReductionFullScaleDb: gainReductionFullScaleDb(values),
    },
    makeupGain: { old: oldMakeupGain, new: roundedMakeupGain, clamped: newMakeupGain !== rawNewMakeupGain },
    ack,
  };
}
