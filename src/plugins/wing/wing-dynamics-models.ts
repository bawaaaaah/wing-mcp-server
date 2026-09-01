// Shared classification for models loadable into a "gate" or "dyn" dynamics-processing slot — see
// wing-auto-compress.ts's header for why either slot can host any of these interchangeably.

import { DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB } from "./wing-meter-protocol.js";

/**
 * Every gate/compressor/ducker-type model verified against real hardware so far (CMB, 76LA, SBUS,
 * NSTR, GATE, COMP, ...) can only ever *cut* — its gain-reduction reading is negative (or a slight
 * positive idle-detector wobble that isn't a real boost, see GAIN_REDUCTION_ACTIVE_EPSILON_DB in
 * dynamics-status.ts). A Dynamic EQ model is different: it can legitimately *boost* a detected band
 * as well as cut it, so a positive reading there is real, not idle noise, and must not be clamped
 * away or mislabeled as "reducing". Confirmed live: channel 3's gate slot reported model "DEQ2" for a
 * Dynamic EQ plugin. Prefix-matched (not an exact-string list) since the console's own catalog
 * explicitly doesn't enumerate the 30+ gate/dyn models individually (wing-param-catalog.ts), so other
 * numbered Dynamic EQ variants (DEQ1, DEQ3, ...) are assumed to share the same bidirectional behavior
 * rather than only ever matching the one variant actually seen live.
 */
const BIDIRECTIONAL_MODEL_PREFIXES = ["DEQ"];

/** Whether `mdl` (the gate/dyn slot's model, e.g. from `dump()`'s `mdl` field) is a model known to
 * legitimately boost as well as cut — see BIDIRECTIONAL_MODEL_PREFIXES above. Unknown/undefined
 * models default to cut-only, matching every model verified against real hardware except Dynamic EQ. */
export function isBidirectionalDynModel(mdl: string | number | undefined): boolean {
  if (mdl === undefined) return false;
  const upper = String(mdl).toUpperCase();
  return BIDIRECTIONAL_MODEL_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * A gate/dyn slot's dumped OSC settings, as returned by `WingOscClient.dump()` — e.g. `{on, mdl, thr,
 * range, ...}`. Untyped beyond that (the actual field set varies wildly per model — CMB has
 * `depth`/`ingain`/`cpeak`, 76LA has `in`/`out`, GATE has `range`, COMP has none of those — see
 * wing-auto-compress.ts's header and the per-model appendices in WING_Remote-Protocols-3.1-03.pdf).
 */
export type DynSlotSettings = Record<string, string | number>;

/**
 * Which live parameter `wing-auto-compress` should drive to change how hard a gate/dyn slot
 * compresses. `kind: "threshold"` — a downward compressor/limiter reduces MORE as the threshold
 * drops, hence `initialPolarity: 1` (matching the search loop's historical assumption). `kind:
 * "input-gain"` — an 1176/LA-2A/one-knob-style model has no threshold knob; you compress harder by
 * pushing its drive/amount control UP, so reduction goes UP as the control goes UP: `initialPolarity:
 * -1`. `key` is the raw describe() key and drives the human label downstream (see
 * tools/auto-compress.ts's `controlLabel`), so it is intentionally left as a free `string`.
 */
export type CompressionControl =
  | { kind: "threshold"; key: string; initialPolarity: 1 }
  | { kind: "input-gain"; key: string; initialPolarity: -1 };

/** Threshold-style keys, highest priority first — driven "down for more reduction". */
const THRESHOLD_CONTROL_KEYS = ["thr", "cthr", "1-thr"] as const;
/**
 * Drive/amount-style keys, highest priority first — driven "up for more reduction". Order matters
 * for models that expose more than one: the ones that ACTUALLY change how hard the model compresses
 * come first, and `ingain` is dead last because on the two models that have it (LA-2A "LA", L100)
 * it's the make-up/input trim, not a compression amount — verified live: sweeping `ingain` on either
 * produces no measurable gain-reduction change at all, while `peak` (LA-2A's one "Peak Reduction"
 * knob) and `gr` (L100's reduction-amount knob, same as ONEC's) do.
 */
const INPUT_GAIN_CONTROL_KEYS = ["peak", "gr", "comp", "in", "ingain"] as const;

/**
 * Resolves the `CompressionControl` for a gate/dyn slot from its ACTUAL live `describe()` keys —
 * never a hardcoded model->field table (same reasoning as the rest of this file and
 * wing-auto-compress.ts's header). Priority:
 *   threshold: `thr` (most models) -> `cthr` (ECL33 "Even Comp/Limiter" — split comp/limiter
 *     thresholds, no plain `thr`; drive the COMPRESSOR threshold, its `lthr` is left alone) ->
 *     `1-thr` (DEQ2 "Dual Dynamic EQ" — per-band thresholds, no plain `thr`; drive band 1, band 2's
 *     `2-thr` is left alone).
 *   input-gain: `peak` (LA-2A "LA" — its single "Peak Reduction" knob; checked before `ingain`,
 *     which on the LA-2A is only the make-up trim) -> `gr` (ONEC "One Knob Compressor", and L100
 *     "LTA100 Leveler" which exposes both `gr` and an inert `ingain`) -> `comp` (LMT — a unitless
 *     0..100 "comp" amount) -> `in` (76LA "LE1176", NSTR — a genuine input-drive control, no
 *     separate amount knob) -> `ingain` (last resort — the make-up trim on LA/L100, only reached if
 *     a model somehow exposes it and nothing better).
 * A model that exposes none of these (DS902 de-esser, WAVE transient designer, WARM saturation)
 * returns `null` and stays rejected by the caller — there's nothing meaningful for a search to drive.
 */
export function resolveCompressionControl(describeKeys: readonly string[]): CompressionControl | null {
  for (const key of THRESHOLD_CONTROL_KEYS) {
    if (describeKeys.includes(key)) return { kind: "threshold", key, initialPolarity: 1 };
  }
  for (const key of INPUT_GAIN_CONTROL_KEYS) {
    if (describeKeys.includes(key)) return { kind: "input-gain", key, initialPolarity: -1 };
  }
  return null;
}

/**
 * `wing-meter-protocol.ts`'s `toGainReductionDb()` bakes in the protocol doc's DEFAULT full-scale
 * range for gate/dyn gain-reduction words (20dB — "For most of them 1.0 (256) maps to 20 dB gain
 * reduction", WING_Remote-Protocols-3.1-03.pdf p.98) because that parsing layer has no way to know
 * which model occupies a given slot (that's OSC-side info from an entirely separate connection, and
 * from a completely separate GET/dump() call at that). The doc calls out exactly one documented
 * exception: "Standard Wing gate is 60 dB" for the model named exactly `"GATE"` — but 60dB isn't a
 * fixed constant to hardcode: it's that model's own `range` parameter (describe()'d as 3..60dB,
 * user-adjustable) at its default/maximum. Reading the slot's *current* `range` value here instead of
 * assuming 60 means this stays correct if the range knob is ever turned down — the metering full-scale
 * tracks the model's own configured ceiling, not a snapshot of it. Every other model name (including
 * Dynamic EQ "DEQ"/"DEQ2", and any model without its own documented range knob) uses the 20dB default.
 *
 * Always call this with the slot's OWN freshly-dumped settings (fetched via `dump()` before sampling
 * the live meter, never cached from an earlier call) — the `mdl` and `range` fields it reads can both
 * change at any time (a different plugin loaded, or the range knob turned), and a stale correction
 * factor would silently mis-scale a live reading using a slot's PREVIOUS model/range.
 */
export function gainReductionFullScaleDb(settings: DynSlotSettings | undefined): number {
  if (!settings || settings.mdl === undefined || String(settings.mdl).toUpperCase() !== "GATE") {
    return DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB;
  }
  const range = Number(settings.range);
  return Number.isFinite(range) ? range : 60;
}

/**
 * Models verified live to report their gain-reduction meter word with the OPPOSITE sign to the
 * usual "reduction is negative dB" convention that COMP/SBUS/NSTR/ONEC/LMT/… and every gate-type
 * model follow:
 *  - `76LA` (1176 "LE1176"), `L100` (LTA100 leveler), `RIDE` (auto-rider): a controlled control
 *    sweep with program material held steady read a clean, monotonic 0 → +full-scale that DEEPENS
 *    as compression increases (76LA `in` −48→0: 0 → +20; L100 `gr` 0→10: 0 → +14; RIDE similar).
 *  - `DEQ`/`DEQ2` (Dynamic EQ, prefix-matched like `isBidirectionalDynModel`): a band CUT reads
 *    POSITIVE (~+19 for a 15 dB cut) and a BOOST reads NEGATIVE — flipping makes a cut a negative
 *    "reduction" and a boost a positive gain, which is what every consumer expects and what makes
 *    the bidirectional makeup-gain compensation move the right way.
 * Left uncorrected this showed a positive "reduction" in `wing_dynamics_status`/`wing_meter_stats`
 * (a DEQ2 cut even displayed as a boost) and broke `wing_auto_compress`'s `targetReductionDb`
 * search for these models (wrong-signed error term drove the control to its rail). Narrow model
 * list, same idea as `gainReductionFullScaleDb`'s "GATE" exception above.
 */
function isGainReductionSignInverted(mdl: string): boolean {
  const upper = mdl.toUpperCase();
  return upper === "76LA" || upper === "L100" || upper === "RIDE" || upper.startsWith("DEQ");
}

/** Multiply an already-parsed `gateGain_dB`/`dynGain_dB` value (which assumed the meter protocol's
 * DEFAULT 20dB full-scale range) by this to correct it for the slot's actual model/range: the
 * model/range full-scale scaling (see `gainReductionFullScaleDb`), and a sign flip for the models
 * that report reduction with inverted polarity (see above). Needs the slot's live settings, not
 * just `mdl` — same reason as `gainReductionFullScaleDb`. */
export function gainReductionScaleCorrection(settings: DynSlotSettings | undefined): number {
  const magnitude = gainReductionFullScaleDb(settings) / DEFAULT_GAIN_REDUCTION_FULL_SCALE_DB;
  const mdl = settings?.mdl === undefined ? "" : String(settings.mdl);
  return magnitude * (isGainReductionSignInverted(mdl) ? -1 : 1);
}
