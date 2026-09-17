import { BUS_COUNT, MAIN_COUNT, MATRIX_COUNT } from "./wing-node-paths.js";

/**
 * Metadata for a WING OSC node template. `pathTemplate` uses the literal
 * token "{n}" to mark the position of the per-index dimension that the
 * owning object is enumerated over (e.g. "/ch/{n}/fdr" applies to channels
 * 1..40, "/bus/{n}/fdr" to buses 1..16). Secondary index dimensions that are
 * a small fixed set (EQ band number, send target bus/matrix/main number)
 * are enumerated as literal, separate catalog entries instead of a second
 * placeholder token, so every entry has at most one "{n}".
 *
 * Exact node names/ranges below are transcribed from the WING Remote
 * Protocols 3.1 reference used to write this plugin. Where the reference
 * did not give an authoritative range or enum list (e.g. gate/dyn model
 * names, several ms/dB ranges), a reasonable engineering estimate is used
 * and flagged in `description`. Treat those as best-effort defaults for
 * client-side validation/docs, not a certified hardware spec — clamp
 * behavior should stay forgiving where precision is uncertain.
 */
export interface WingParamMeta {
  pathTemplate: string;
  label: string;
  type: "float" | "int" | "string" | "enum";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  enumValues?: readonly string[];
  readOnly?: boolean;
  models?: Array<"ngc-full" | "wing-rack" | "wing-compact">;
  description?: string;
}

const EQ_MODELS = ["STD", "SOUL", "E88", "E84", "F110", "PULSAR", "MACH4"] as const;
/**
 * The bus/main/matrix EQ model list is the channel list with a different last slot: "PIA" there,
 * "MACH4" on a channel. Confirmed live 2026-09-16 — describe() on `/ch/1/eq` ends the list with
 * MACH4, while `/bus/9/eq`, `/main/4/eq` and `/mtx/3/eq` all end it with PIA.
 */
const BUS_EQ_MODELS = ["STD", "SOUL", "E88", "E84", "F110", "PULSAR", "PIA"] as const;
/** Aux EQ models: six only — the aux node has no 7th slot (no MACH4, no PIA). */
const AUX_EQ_MODELS = ["STD", "SOUL", "E88", "E84", "F110", "PULSAR"] as const;
/** Channel L/H band shapes — describe(): `leq list [PEQ, SHV]`. */
const CHANNEL_EQ_BAND_TYPES = ["PEQ", "SHV"] as const;
/** Aux L/H band shapes — the channel pair plus a cut filter. */
const AUX_EQ_BAND_TYPES = ["PEQ", "SHV", "CUT"] as const;
/**
 * Bus/main/matrix L/H band shapes. The same PEQ/SHV a channel offers plus a full set of cut and
 * crossover filters, which is why these bands are modeled as bands rather than as fixed shelves.
 */
const BUS_EQ_BAND_TYPES = [
  "PEQ", "SHV", "CUT", "BW6", "BW12", "BS12", "LR12", "BW18", "BW24", "BS24", "LR24", "BW48", "LR48",
] as const;
const PTAP_VALUES = ["IN", "FILT", "3", "4", "5", "PFL", "AFL", "POST"] as const;
const MON_VALUES = ["A", "B", "A+B"] as const;
const MATRIX_DIR_IN_VALUES = ["OFF", "AES", "MON.PH", "MON.SPK", "MON.BUS"] as const;
const SCENE_ACTION_VALUES = ["IDLE", "GOPREV", "GONEXT", "GO", "PREV", "NEXT", "GOTAG"] as const;
const CHANNEL_DYN_RATIO_VALUES = [
  "1.1:1", "1.3:1", "1.6:1", "2:1", "2.5:1", "3.2:1", "4:1", "5.6:1", "8:1", "16:1", "32:1", "INF:1",
] as const;
const APPROX = "Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference.";

/**
 * The console's describe() gives `col` no names either — just `col int [1..18]` — but unlike
 * `icon`, the 18 slots correspond to the console's fixed color palette (visible on the physical
 * strip's LED and the WING app's color picker). Names/hex below are transcribed from the actual
 * hex values read off a real console session (an earlier hand-guessed pass had several indices
 * wrong — e.g. 12 was guessed "Brown" but is actually purple). Mirrors the web UI's WING_COLORS
 * list (web/src/components/ParamPanel.tsx) — kept in sync by hand since the two packages don't
 * share a module. Baked into every `col` entry's `description` below so it reaches the MCP tool
 * docs (and thus the calling LLM), not just the human-facing web UI.
 */
export const WING_COLOR_NAMES = [
  "Blue", // #3e63cc
  "Azure", // #0180ff
  "Indigo", // #5a33ff
  "Turquoise", // #00ced1
  "Green", // #00b23e
  "Lime", // #96cc00
  "Yellow", // #f2dd00
  "Brown", // #c06a1f
  "Red", // #e02040
  "Salmon", // #ff7a7a
  "Magenta", // #ff33f6
  "Purple", // #a533ff
  "Amber", // #ffb81a
  "Sky Blue", // #25c3ff
  "Orange Red", // #ff5a30
  "Mint Green", // #33e6a5
  "Gray", // #707070
  "White", // #e0e0e0
] as const;
export const COLOR_DESCRIPTION = WING_COLOR_NAMES.map((name, i) => `${i + 1}=${name}`).join(", ");

/** 1-based `col` index -> palette name, or `undefined` if out of the console's [1, 18] range. */
export function wingColorName(index: number): string | undefined {
  return WING_COLOR_NAMES[index - 1];
}

/**
 * The console's describe() gives `icon` no names either — just `icon int [0..999]` — and the
 * official WING OSC protocol reference's own icon appendix doesn't publish per-icon names: it's a
 * picture grid, with only these category number ranges printed next to it. Names below are a
 * hand-authored transcription of that picture grid (not from the protocol reference text), grouped
 * into the same category ranges the console/app group them into. Mirrors the web UI's
 * WING_ICON_CATEGORIES list (web/src/components/ParamPanel.tsx) — kept in sync by hand since the
 * two packages don't share a module. Baked into every `icon` entry's `description` below so it
 * reaches the MCP tool docs (and thus the calling LLM), not just the human-facing web UI.
 */
export interface WingIconCategory {
  label: string;
  min: number;
  max: number;
  names: readonly string[];
}

export const WING_ICON_CATEGORIES: readonly WingIconCategory[] = [
  {
    label: "General",
    min: 0,
    max: 14,
    names: [
      "Vide",
      "XLR",
      "Jack TRS",
      "Mini-Jack TRS",
      "RCA",
      "Faders / EQ",
      "FX",
      "Routing / Modular",
      "Clé de fa (bass)",
      "Clé de sol (treble)",
      "Multi-EQ / Matrix faders",
      "Sends / Bus arrows",
      "Multi-out / Parallel lines",
      "Smiley",
      "W",
    ],
  },
  {
    label: "Vocals & Mics",
    min: 100,
    max: 114,
    names: [
      "Micro main (handheld)",
      "Micro main à boule",
      "Micro sans fil (wireless)",
      "Micro canon (shotgun)",
      "Micro scène / broadcast",
      "Micro pupitre (gooseneck / podium)",
      "Micro sur pied",
      "Casque-micro (headset)",
      "Casque avec micro (over-ear)",
      "Micro studio vertical",
      "Micro vintage / ruban",
      "Micro condensateur",
      "Chœur / groupe",
      "Chanteuse (femme)",
      "Chanteur (homme)",
    ],
  },
  {
    label: "Drums & Percussion",
    min: 200,
    max: 224,
    names: [
      "Grosse caisse (kick)",
      "Caisse claire (snare)",
      "Caisse claire + baguettes",
      "Tom",
      "Tom + baguettes",
      "Charleston (hi-hat)",
      "Tom aigu (H)",
      "Tom medium (M)",
      "Tom grave (L)",
      "Floor tom (F)",
      "Batterie complète",
      "Cymbale crash (C)",
      "Cymbale ride (R)",
      "Cowbell",
      "Tambourin",
      "Congas",
      "Bongos",
      "Timbales / grosse percussion",
      "Cajón",
      "Maracas",
      "Xylophone / vibraphone",
      "Cymbale / splash",
      "Triangle",
      "Boîte à rythmes / pad électronique",
      "Claquements de mains (clap)",
    ],
  },
  {
    label: "Strings & Winds",
    min: 300,
    max: 319,
    names: [
      "Guitare électrique",
      "Guitare acoustique",
      "Guitare classique",
      "Banjo",
      "Guitare folk / ukulélé",
      "Guitare électrique (type Strat)",
      "Guitare électrique (type SG)",
      "Guitare électrique (Flying V)",
      "Guitare électrique double manche",
      "Basse électrique",
      "Violon",
      "Clarinette",
      "Saxophone",
      "Trombone",
      "Trompette",
      "Harpe",
      "Accordéon",
      "Harmonica / mélodica",
      "Flûte",
      "Hautbois / clarinette basse",
    ],
  },
  {
    label: "Keys",
    min: 400,
    max: 409,
    names: [
      "Piano à queue",
      "Piano droit / piano électrique",
      "Synthétiseur / workstation",
      "Clavier avec pads",
      "Piano de scène / digital piano",
      "Synthétiseur",
      "Keytar",
      "Clavier sur pied",
      "Clavier sur stand en X",
      "Orgue / clavier double manuel",
    ],
  },
  {
    label: "Speakers",
    min: 500,
    max: 524,
    names: [
      "Ampli guitare (combo)",
      "Ampli basse / stack",
      "Ampli 4 haut-parleurs",
      "Enceinte PA",
      "Moniteurs de studio (paire)",
      "Enceinte + micro",
      "Caisson de basse (sub)",
      "Enceinte pleine bande",
      "Enceinte double horizontale",
      "Enceintes sur pied (paire)",
      "Enceintes murales / stéréo",
      "Enceinte suspendue",
      "Enceinte sur pied",
      "Enceintes sur mât (paire)",
      "Enceintes avec délai (Δt)",
      "Enceinte gauche (L)",
      "Enceinte droite (R)",
      "Enceinte centrale / double",
      "Colonne PA",
      "Enceintes PA (paire)",
      "Retour de scène (wedge gauche)",
      "Retour de scène (wedge droit)",
      "Moniteur de sol (wedge)",
      "Line array / enceinte courbe",
      "Enceinte plafond / suspendue",
    ],
  },
  {
    label: "Specials",
    min: 600,
    max: 614,
    names: [
      "Signe rock (cornes)",
      "Oreille (écoute)",
      "Casque",
      "Piste A",
      "Piste B",
      "Ordinateur portable",
      "Lecteur multimédia / iPod",
      "Smartphone",
      "Clé USB",
      "Carte mémoire / SD",
      "CD / disque",
      "Vinyle / platine",
      "Magnétophone à bandes",
      "Cassette",
      "Serveur / baie de disques",
    ],
  },
] as const;

export const ICON_DESCRIPTION = WING_ICON_CATEGORIES.map(
  (c) => `${c.label} [${c.min}-${c.max}]: ${c.names.map((name, i) => `${c.min + i}=${name}`).join(", ")}`
).join(" | ");

/** `icon` index -> name, or `undefined` if out of the console's known category ranges. */
export function wingIconName(index: number): string | undefined {
  const category = WING_ICON_CATEGORIES.find((c) => index >= c.min && index <= c.max);
  return category?.names[index - category.min];
}

type NumOpts = {
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  readOnly?: boolean;
  models?: WingParamMeta["models"];
  description?: string;
};
type StrOpts = Omit<NumOpts, "unit" | "min" | "max" | "step">;

function f(pathTemplate: string, label: string, opts: NumOpts = {}): WingParamMeta {
  return { pathTemplate, label, type: "float", ...opts };
}
function iP(pathTemplate: string, label: string, opts: NumOpts = {}): WingParamMeta {
  return { pathTemplate, label, type: "int", ...opts };
}
function sP(pathTemplate: string, label: string, opts: StrOpts = {}): WingParamMeta {
  return { pathTemplate, label, type: "string", ...opts };
}
function eP(pathTemplate: string, label: string, enumValues: readonly string[], opts: StrOpts = {}): WingParamMeta {
  return { pathTemplate, label, type: "enum", enumValues, ...opts };
}

/** fdr/mute/pan/wid[/busmono]/name/col/icon/led — shared by channel/bus/main/matrix. */
function stripBlock(prefix: string, opts: { busmono: boolean; nameMaxLen: number }): WingParamMeta[] {
  const list: WingParamMeta[] = [
    f(`${prefix}/fdr`, "Fader level", { unit: "dB", min: -144, max: 10, description: '1024 steps; -144 renders as "-oo".' }),
    iP(`${prefix}/mute`, "Mute", { min: 0, max: 1 }),
    f(`${prefix}/pan`, "Pan", { min: -100, max: 100 }),
    f(`${prefix}/wid`, "Stereo width", { min: -150, max: 150 }),
  ];
  if (opts.busmono) {
    list.push(iP(`${prefix}/busmono`, "Mono sum", { min: 0, max: 1 }));
  }
  list.push(
    sP(`${prefix}/name`, "Name", { description: `Up to ${opts.nameMaxLen} characters.` }),
    iP(`${prefix}/col`, "Color", { min: 1, max: 18, description: COLOR_DESCRIPTION }),
    iP(`${prefix}/icon`, "Icon", { min: 0, max: 999, description: ICON_DESCRIPTION }),
    iP(`${prefix}/led`, "LED state", { min: 0, max: 1 })
  );
  return list;
}

/**
 * The three EQ node shapes a strip can carry. Every leaf below is verified live against real
 * hardware (2026-09-16): describe() was run on the `eq` node of all 40 channels, all 8 auxes, all
 * 16 buses, all 4 mains and all 8 matrices, and within each of those five groups every index
 * returned a byte-identical node — but the five groups collapse into only THREE distinct shapes:
 *
 * | | channel (40) | aux (8) | bus/main/matrix (28) |
 * |---|---|---|---|
 * | bands | L + 1-4 + H | L + 1-4 + H | L + 1-6 + H |
 * | `mdl` last slot | MACH4 | *(none — 6 models)* | PIA |
 * | `leq`/`heq` | PEQ, SHV | PEQ, SHV, CUT | 13 filter types |
 * | `tilt` | — | — | -6..+6 dB |
 *
 * Everything else is common to all three: `on`, `mix` (0..125 %), gains lin -15..+15 dB, frequencies
 * log 20..20000 Hz (including `lf`/`hf` — the L/H bands are NOT restricted to a shelf's half of the
 * spectrum), and Qs log 0.44..10.00. The `$solo`/`$solobd` leaves the console also reports on these
 * nodes are console-computed and read-only, so they are deliberately not modeled here.
 */
interface EqShape {
  /** `mdl` enum — the model list differs per strip type. */
  models: readonly string[];
  /** `leq`/`heq` enum — the L/H band shapes offered. */
  bandTypes: readonly string[];
  /** Number of fully parametric mid bands between the L and H bands. */
  midBands: 4 | 6;
  /** Whether the node carries the `tilt` leaf (bus/main/matrix only). */
  tilt: boolean;
}

const CHANNEL_EQ_SHAPE: EqShape = { models: EQ_MODELS, bandTypes: CHANNEL_EQ_BAND_TYPES, midBands: 4, tilt: false };
const AUX_EQ_SHAPE: EqShape = { models: AUX_EQ_MODELS, bandTypes: AUX_EQ_BAND_TYPES, midBands: 4, tilt: false };
const BUS_EQ_SHAPE: EqShape = { models: BUS_EQ_MODELS, bandTypes: BUS_EQ_BAND_TYPES, midBands: 6, tilt: true };

/**
 * The standard (non-GEQ) parametric EQ node carried by every channel/aux/bus/main/matrix strip.
 * Emits leaves in the same order the console's own describe() lists them.
 *
 * The L and H bands are labeled "band", not "shelf": `leq`/`heq` select the shape, and on every
 * strip type that includes a non-shelf option (PEQ everywhere, plus CUT and — on bus/main/matrix —
 * the crossover slopes), so calling them shelves would misdescribe the node.
 */
function eqBlock(prefix: string, shape: EqShape): WingParamMeta[] {
  const list: WingParamMeta[] = [
    iP(`${prefix}/eq/on`, "EQ on", { min: 0, max: 1 }),
    eP(`${prefix}/eq/mdl`, "EQ model", shape.models),
    f(`${prefix}/eq/mix`, "EQ mix", { unit: "%", min: 0, max: 125 }),
    f(`${prefix}/eq/lg`, "Low band gain", { unit: "dB", min: -15, max: 15 }),
    f(`${prefix}/eq/lf`, "Low band frequency", { unit: "Hz", min: 20, max: 20000 }),
    f(`${prefix}/eq/lq`, "Low band Q", { min: 0.44, max: 10 }),
    eP(`${prefix}/eq/leq`, "Low band type", shape.bandTypes),
  ];
  for (let n = 1; n <= shape.midBands; n++) {
    list.push(
      f(`${prefix}/eq/${n}g`, `Band ${n} gain`, { unit: "dB", min: -15, max: 15 }),
      f(`${prefix}/eq/${n}f`, `Band ${n} frequency`, { unit: "Hz", min: 20, max: 20000 }),
      f(`${prefix}/eq/${n}q`, `Band ${n} Q`, { min: 0.44, max: 10 })
    );
  }
  list.push(
    f(`${prefix}/eq/hg`, "High band gain", { unit: "dB", min: -15, max: 15 }),
    f(`${prefix}/eq/hf`, "High band frequency", { unit: "Hz", min: 20, max: 20000 }),
    f(`${prefix}/eq/hq`, "High band Q", { min: 0.44, max: 10 }),
    eP(`${prefix}/eq/heq`, "High band type", shape.bandTypes)
  );
  if (shape.tilt) {
    list.push(f(`${prefix}/eq/tilt`, "EQ tilt", { unit: "dB", min: -6, max: 6 }));
  }
  return list;
}

function gateBlock(prefix: string): WingParamMeta[] {
  return [
    iP(`${prefix}/gate/on`, "Gate on", { min: 0, max: 1 }),
    sP(`${prefix}/gate/mdl`, "Gate model", { description: `30+ models in firmware; not individually enumerated. ${APPROX}` }),
    f(`${prefix}/gate/thr`, "Gate threshold", { unit: "dB", min: -80, max: 0 }),
    // Verified against real hardware: the "GATE" model's `range` describes as lin [3 .. 60 dB], not
    // the -80..0 this static fallback used to assume — which silently clamped every positive write to
    // 0 (raw), collapsing the range knob to its 3 dB minimum. Widened to span every gate-slot model's
    // `range` (a de-esser-style model can go negative); the console still does the real per-model
    // bounds check. The describe-driven paths (auto-gate, dashboard panels) already read live bounds.
    f(`${prefix}/gate/range`, "Gate range", { unit: "dB", min: -80, max: 60, description: APPROX }),
    f(`${prefix}/gate/att`, "Gate attack", { unit: "ms", min: 0, max: 100, description: APPROX }),
    f(`${prefix}/gate/hld`, "Gate hold", { unit: "ms", min: 0, max: 2000, description: APPROX }),
    f(`${prefix}/gate/rel`, "Gate release", { unit: "ms", min: 0, max: 4000, description: APPROX }),
    f(`${prefix}/gate/ratio`, "Gate ratio", { min: 1, max: 100, description: APPROX }),
    f(`${prefix}/gate/mix`, "Gate mix", { unit: "%", min: 0, max: 100 }),
    f(`${prefix}/gate/gain`, "Gate makeup gain", { unit: "dB", min: -20, max: 20, description: APPROX }),
  ];
}

function dynBlock(prefix: string, ratioEnum: boolean): WingParamMeta[] {
  return [
    iP(`${prefix}/dyn/on`, "Dynamics on", { min: 0, max: 1 }),
    sP(`${prefix}/dyn/mdl`, "Dynamics model", { description: `Compressor model selector; not individually enumerated. ${APPROX}` }),
    f(`${prefix}/dyn/thr`, "Dynamics threshold", { unit: "dB", min: -60, max: 0 }),
    ratioEnum
      ? eP(`${prefix}/dyn/ratio`, "Dynamics ratio", CHANNEL_DYN_RATIO_VALUES, { description: APPROX })
      : f(`${prefix}/dyn/ratio`, "Dynamics ratio", { min: 1.1, max: 100 }),
    f(`${prefix}/dyn/knee`, "Dynamics knee", { min: 0, max: 10, description: APPROX }),
    eP(`${prefix}/dyn/det`, "Dynamics detector", ["PEAK", "RMS"], { description: APPROX }),
    f(`${prefix}/dyn/att`, "Dynamics attack", { unit: "ms", min: 0, max: 100, description: APPROX }),
    f(`${prefix}/dyn/hld`, "Dynamics hold", { unit: "ms", min: 0, max: 2000, description: APPROX }),
    f(`${prefix}/dyn/rel`, "Dynamics release", { unit: "ms", min: 0, max: 4000, description: APPROX }),
    sP(`${prefix}/dyn/env`, "Dynamics envelope mode", { description: APPROX }),
    iP(`${prefix}/dyn/auto`, "Dynamics auto release", { min: 0, max: 1 }),
    f(`${prefix}/dyn/mix`, "Dynamics mix", { unit: "%", min: 0, max: 100 }),
    f(`${prefix}/dyn/gain`, "Dynamics makeup gain", { unit: "dB", min: -20, max: 20, description: APPROX }),
  ];
}

/** on/lvl/pon/mode/plink/pan for one send instance (channel->bus, channel->mtx, bus->bus, etc). */
function sendParamsBlock(prefix: string): WingParamMeta[] {
  return [
    iP(`${prefix}/on`, "Send on", { min: 0, max: 1 }),
    f(`${prefix}/lvl`, "Send level", { unit: "dB", min: -144, max: 10 }),
    iP(`${prefix}/pon`, "Pre-fader send", { min: 0, max: 1 }),
    eP(`${prefix}/mode`, "Send mode", ["PRE", "POST"], { description: APPROX }),
    iP(`${prefix}/plink`, "Pan link", { min: 0, max: 1 }),
    f(`${prefix}/pan`, "Send pan", { min: -100, max: 100 }),
  ];
}

function mainAssignBlock(prefix: string, mainIndex: number): WingParamMeta[] {
  const p = `${prefix}/main/${mainIndex}`;
  return [
    iP(`${p}/on`, `Main ${mainIndex} assign on`, { min: 0, max: 1 }),
    f(`${p}/lvl`, `Main ${mainIndex} assign level`, { unit: "dB", min: -144, max: 10 }),
    iP(`${p}/pre`, `Main ${mainIndex} assign pre-fader`, { min: 0, max: 1 }),
  ];
}

// --- Channel (/ch/{n}, 1..40) ---
const CHANNEL_PREFIX = "/ch/{n}";
const channelEntries: WingParamMeta[] = [
  ...stripBlock(CHANNEL_PREFIX, { busmono: false, nameMaxLen: 16 }),
  ...eqBlock(CHANNEL_PREFIX, CHANNEL_EQ_SHAPE),
  ...gateBlock(CHANNEL_PREFIX),
  ...dynBlock(CHANNEL_PREFIX, true),
];
for (let b = 1; b <= BUS_COUNT; b++) {
  channelEntries.push(...sendParamsBlock(`${CHANNEL_PREFIX}/send/${b}`));
}
for (let m = 1; m <= MATRIX_COUNT; m++) {
  channelEntries.push(...sendParamsBlock(`${CHANNEL_PREFIX}/send/MX${m}`));
}
for (let mn = 1; mn <= MAIN_COUNT; mn++) {
  channelEntries.push(...mainAssignBlock(CHANNEL_PREFIX, mn));
}
channelEntries.push(
  sP(`${CHANNEL_PREFIX}/tags`, "Tags", { description: "Free-form tag string used for filtering/search on the console." }),
  sP(`${CHANNEL_PREFIX}/clink`, "Link customization to source", {
    description:
      `On WING (unlike the X32/XR18 protocol reference this catalog was transcribed from, where the ` +
      `same name means stereo/group channel pairing), this is confirmed — live packet capture, ` +
      `2026-08-28 — to be the console app's "link customization to source" toggle: ` +
      `{path: "/ch/{n}/clink", value: "1"}. See wing-input-patch.ts's setSrcAuto(). ${APPROX}`,
  }),
  eP(`${CHANNEL_PREFIX}/ptap`, "PFL tap point", PTAP_VALUES, { description: APPROX }),
  eP(`${CHANNEL_PREFIX}/mon`, "Monitor bus assignment", MON_VALUES, { description: APPROX })
);

// --- Bus/Main/Matrix (/bus/{n} 1..16, /main/{n} 1..4, /mtx/{n} 1..8) ---
/**
 * Aux strips are otherwise ABSENT from this catalog — only their EQ node is modeled, because only
 * it has been read off real hardware (2026-09-16, describe() on all 8 `/aux/N/eq`). The rest of an
 * aux strip (`fdr`, `mute`, `name`, its gate/dyn/sends, ...) is still uncovered, so `wing_set`
 * applies no catalog validation there and falls back to letting the console do the bounds check.
 * Adding those blocks is a matter of describing the nodes, not of guessing them.
 */
const auxEntries: WingParamMeta[] = [
  ...eqBlock("/aux/{n}", AUX_EQ_SHAPE),
];

const busEntries: WingParamMeta[] = [
  ...stripBlock("/bus/{n}", { busmono: true, nameMaxLen: 16 }),
  ...eqBlock("/bus/{n}", BUS_EQ_SHAPE),
  ...dynBlock("/bus/{n}", false),
];
for (let b = 1; b <= BUS_COUNT; b++) {
  busEntries.push(...sendParamsBlock(`/bus/{n}/send/${b}`));
}
for (let m = 1; m <= MATRIX_COUNT; m++) {
  busEntries.push(...sendParamsBlock(`/bus/{n}/send/MX${m}`));
}
for (let mn = 1; mn <= MAIN_COUNT; mn++) {
  busEntries.push(...mainAssignBlock("/bus/{n}", mn));
}

const mainEntries: WingParamMeta[] = [
  ...stripBlock("/main/{n}", { busmono: true, nameMaxLen: 16 }),
  ...eqBlock("/main/{n}", BUS_EQ_SHAPE),
  ...dynBlock("/main/{n}", false),
];
for (let m = 1; m <= MATRIX_COUNT; m++) {
  mainEntries.push(...sendParamsBlock(`/main/{n}/send/MX${m}`));
}

const matrixEntries: WingParamMeta[] = [
  ...stripBlock("/mtx/{n}", { busmono: true, nameMaxLen: 16 }),
  ...eqBlock("/mtx/{n}", BUS_EQ_SHAPE),
  ...dynBlock("/mtx/{n}", false),
  iP("/mtx/{n}/dir/on", "Direct tap on", { min: 0, max: 1 }),
  f("/mtx/{n}/dir/lvl", "Direct tap level", { unit: "dB", min: -144, max: 10 }),
  iP("/mtx/{n}/dir/inv", "Direct tap invert", { min: 0, max: 1 }),
  eP("/mtx/{n}/dir/in", "Direct tap source", MATRIX_DIR_IN_VALUES),
];

// --- DCA (/dca/{n}, 1..16) ---
const dcaEntries: WingParamMeta[] = [
  sP("/dca/{n}/name", "Name", { description: "Up to 8 characters." }),
  iP("/dca/{n}/col", "Color", { min: 1, max: 18, description: COLOR_DESCRIPTION }),
  iP("/dca/{n}/icon", "Icon", { min: 0, max: 999, description: ICON_DESCRIPTION }),
  iP("/dca/{n}/led", "LED state", { min: 0, max: 1 }),
  iP("/dca/{n}/mute", "Mute", { min: 0, max: 1 }),
  f("/dca/{n}/fdr", "Fader level", { unit: "dB", min: -144, max: 10 }),
  iP("/dca/{n}/$solo", "Solo state (effective, read-only)", { min: 0, max: 1, readOnly: true }),
  eP("/dca/{n}/mon", "Monitor bus assignment", MON_VALUES, { description: APPROX }),
];

// --- Mute group (/mgrp/{n}, 1..8) ---
const mutegroupEntries: WingParamMeta[] = [
  sP("/mgrp/{n}/name", "Name", { description: "Up to 8 characters." }),
  iP("/mgrp/{n}/mute", "Mute", { min: 0, max: 1 }),
];

// --- Scenes / library ($ctl/lib, singleton — no per-index dimension) ---
const sceneEntries: WingParamMeta[] = [
  sP("/$ctl/lib/$scenes", "Scene list (read-only)", {
    readOnly: true,
    description: "Bare GET returns only the first scene name; use describe('?') for the full list.",
  }),
  iP("/$ctl/lib/$actidx", "Active scene index (read-only)", { readOnly: true }),
  sP("/$ctl/lib/$active", "Active scene name (read-only)", { readOnly: true }),
  sP("/$ctl/lib/$actshow", "Active show name (read-only)", { readOnly: true }),
  eP("/$ctl/lib/$action", "Scene action", SCENE_ACTION_VALUES, {
    description: "Set $actionidx first, then set $action=GO (or GOTAG for a tag target).",
  }),
  iP("/$ctl/lib/$actionidx", "Scene action target index/tag", { min: 0, max: 16384 }),
  iP("/$ctl/lib/$activeid", "Active scene tag id (read-only)", { readOnly: true }),
];

export const WING_PARAM_CATALOG: WingParamMeta[] = [
  ...channelEntries,
  ...auxEntries,
  ...busEntries,
  ...mainEntries,
  ...matrixEntries,
  ...dcaEntries,
  ...mutegroupEntries,
  ...sceneEntries,
];

export function findParamMeta(pathTemplate: string): WingParamMeta | undefined {
  return WING_PARAM_CATALOG.find((m) => m.pathTemplate === pathTemplate);
}

/** The root node names the catalog enumerates a "{n}" primary index over — see `WingParamMeta`'s
 * doc for why every other index (EQ band, send target, ...) is a literal in the template instead. */
const TEMPLATED_ROOTS = ["ch", "aux", "bus", "main", "mtx", "dca", "mgrp"] as const;
const PATH_TO_TEMPLATE_RE = new RegExp(`^/(${TEMPLATED_ROOTS.join("|")})/\\d+(/.*)?$`);

/**
 * Converts a real OSC leaf path (e.g. "/ch/5/fdr", "/ch/5/main/2/on") into the `pathTemplate` form
 * `findParamMeta` looks up by (e.g. "/ch/{n}/fdr", "/ch/{n}/main/2/on") — replaces only the primary
 * per-object index immediately after one of `TEMPLATED_ROOTS` with "{n}"; any further index in the
 * path (EQ band, send target, main-assign target, ...) is left untouched since the catalog bakes
 * those in as literal, separate entries rather than a second placeholder. A path whose root isn't in
 * `TEMPLATED_ROOTS` (e.g. "/fx/...", "/$ctl/...") is returned unchanged — `/$ctl/...` catalog
 * entries are already literal (no per-index dimension at all), and a root the catalog doesn't cover
 * is expected to fail the subsequent `findParamMeta` lookup, which callers treat as "no
 * catalog-based validation for this node" rather than an error. The same is true of a templated
 * root the catalog covers only partially: "aux" is in the list, but only `/aux/{n}/eq/*` resolves
 * to an entry, so `/aux/3/fdr` templates cleanly and then simply isn't found — the catalog is an
 * admittedly incomplete, best-effort transcription (see `WingParamMeta`'s doc), not an exhaustive
 * protocol spec.
 */
export function pathToTemplate(path: string): string {
  const m = PATH_TO_TEMPLATE_RE.exec(path);
  return m ? `/${m[1]}/{n}${m[2] ?? ""}` : path;
}
