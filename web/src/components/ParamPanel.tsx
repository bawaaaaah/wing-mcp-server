import { useState, type JSX } from "react";
import type { WingDescribeParam, WingParamPanel } from "../api/queries.js";
import { useThrottledCommit } from "../api/useThrottledCommit.js";
import { EqCurve, isDrawableEq } from "./EqCurve.js";
import { WingIcon } from "./WingIcon.js";
import { FADER_MAX_DB, FADER_MIN_DB, FaderControl, SliderControl } from "./SliderControl.js";

/**
 * Readable labels for the console's short parameter keys; the raw key stays in the tooltip. Only
 * keys whose meaning holds across every block/model are listed — anything else shows its own key.
 */
const PARAM_LABELS: Record<string, string> = {
  on: "On",
  mdl: "Model",
  mix: "Mix",
  gain: "Gain",
  thr: "Threshold",
  range: "Range",
  ratio: "Ratio",
  knee: "Knee",
  att: "Attack",
  hld: "Hold",
  rel: "Release",
  lg: "Low gain",
  lf: "Low freq",
  lq: "Low Q",
  leq: "Low type",
  hg: "High gain",
  hf: "High freq",
  hq: "High Q",
  heq: "High type",
  fxmix: "Mix",
};

/**
 * Effect parameters' names, from the protocol reference's effects appendix (p. 158 on): the keys
 * shared by its reverbs, delays and modulation effects. Effect-only, since a key like `lc` or `g`
 * means something else on a strip (its low-cut switch, a band gain).
 */
export const FX_PARAM_LABELS: Record<string, string> = {
  pdel: "Pre-delay",
  size: "Size",
  dcy: "Decay",
  mult: "Bass multiplier",
  lmult: "Low multiplier",
  hmult: "High multiplier",
  damp: "Damping",
  lc: "Low cut",
  hc: "High cut",
  shp: "Shape",
  sprd: "Spread",
  diff: "Diffusion",
  spin: "Spin",
  mspd: "Mod speed",
  ecl: "Echo left",
  ecr: "Echo right",
  efl: "Feed left",
  efr: "Feed right",
  ell: "Echo left level",
  elr: "Echo right level",
  dens: "Density",
  att: "Attack",
  hld: "Hold",
  rel: "Release",
  thr: "Threshold",
  dly: "Delay",
  dlyl: "Delay left",
  dlyr: "Delay right",
  time: "Time",
  feed: "Feedback",
  flc: "Feedback low cut",
  fhc: "Feedback high cut",
  depth: "Depth",
  depl: "Depth left",
  depr: "Depth right",
  spd: "Speed",
  wid: "Width",
  mix: "Mix",
  gain: "Gain",
  drv: "Drive",
  tone: "Tone",
  sust: "Sustain",
  bal: "Balance",
  erlvl: "Early reflections",
  rvlvl: "Reverb level",
  mdep: "Mod depth",
  mrate: "Mod rate",
  frz: "Freeze",
  shim: "Shimmer",
};

function paramLabel(key: string): string {
  const band = /^(\d)([gfq])$/.exec(key);
  if (band) return `Band ${band[1]} ${{ g: "gain", f: "freq", q: "Q" }[band[2] as "g" | "f" | "q"]}`;
  return PARAM_LABELS[key] ?? key;
}

function ParamLabel({ paramKey, label = paramLabel(paramKey) }: { paramKey: string; label?: string }): JSX.Element {
  return (
    <span className="param-field__label" title={label === paramKey ? undefined : paramKey}>
      {label}
    </span>
  );
}

/** An EQ band's own key (`lg`, `2f`, `heq`…): which band, and the field's short name within it. */
const EQ_BAND_KEY = /^([lh]|\d)(g|f|q|eq)$/;
const EQ_FIELD_LABELS: Record<string, string> = { g: "Gain", f: "Freq", q: "Q", eq: "Type" };
const EQ_FIELD_ORDER = ["eq", "g", "f", "q"];

function eqBandTitle(band: string): string {
  return band === "l" ? "Low" : band === "h" ? "High" : `Band ${band}`;
}

/** An EQ's per-band fields gathered band by band (low, 1…n, high), in the order type/gain/freq/Q. */
function groupEqBands(params: readonly WingDescribeParam[]): { band: string; fields: { param: WingDescribeParam; field: string }[] }[] {
  const bands = new Map<string, { param: WingDescribeParam; field: string }[]>();
  for (const param of params) {
    const match = EQ_BAND_KEY.exec(param.key);
    if (!match) continue;
    const list = bands.get(match[1]) ?? [];
    list.push({ param, field: match[2] });
    bands.set(match[1], list);
  }
  const rank = (band: string) => (band === "l" ? -1 : band === "h" ? 99 : Number(band));
  return [...bands.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([band, fields]) => ({ band, fields: fields.sort((a, b) => EQ_FIELD_ORDER.indexOf(a.field) - EQ_FIELD_ORDER.indexOf(b.field)) }));
}

interface ParamPanelProps {
  panel: WingParamPanel;
  /** Called with the field's key (not the full path) and its new value. May return a promise. */
  onSet: (key: string, value: number | string) => void | Promise<unknown>;
  /** Called after a field whose change reshapes the rest of the panel (e.g. FX's "mdl") is committed —
   * only once `onSet`'s promise (if any) resolves, so the refetch it triggers doesn't race the write. */
  onStructuralChange?: () => void;
  /** Field keys to render specially at the top of the panel (e.g. FX's "mdl") instead of in describe order. */
  leadingKeys?: string[];
  /** Names for this panel's own keys (an effect's), over the generic ones. */
  labels?: Record<string, string>;
}

function formatWithUnit(value: number, unit: string | undefined): string {
  // 10000 Hz reads (and fits) better as 10.0 kHz.
  if (unit === "Hz" && Math.abs(value) >= 1000) return `${(value / 1000).toFixed(Math.abs(value) < 10000 ? 2 : 1)} kHz`;
  const rounded = Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(1);
  return unit ? `${rounded} ${unit}` : rounded;
}

/** Slider positions for a log-scaled parameter (frequency, Q, times), so each octave gets the same travel. */
const LOG_SLIDER_STEPS = 1000;

function toLogPosition(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return Math.round((Math.log(clamped / min) / Math.log(max / min)) * LOG_SLIDER_STEPS);
}

function fromLogPosition(position: number, min: number, max: number): number {
  const value = min * Math.pow(max / min, position / LOG_SLIDER_STEPS);
  // Three significant figures: the console quantizes to its own step count anyway.
  return Number(value.toPrecision(3));
}

/**
 * The console's own describe() gives icon no names — just `icon int [0..999]` — and the official
 * WING OSC protocol reference's own icon appendix doesn't publish per-icon names either: it's a
 * picture grid with only these category number ranges printed next to it. Names below are a
 * hand-authored transcription of that picture grid (not from the protocol reference text),
 * re-checked cell by cell against it (p. 247–248). Mirrors
 * the MCP server's WING_ICON_CATEGORIES list (src/plugins/wing/wing-param-catalog.ts) — kept in
 * sync by hand since the two packages don't share a module.
 */
const ICON_CATEGORIES: readonly { label: string; min: number; max: number; names: readonly string[] }[] = [
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
      "Faders",
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
      "Micro interview (avec flag)",
      "Casque avec micro (headset)",
      "Micro serre-tête (headset léger)",
      "Micro sur pied de table (studio)",
      "Micro vintage (broadcast)",
      "Micro condensateur sur trépied",
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
      "Grosse caisse, côté pédale (kick in)",
      "Grosse caisse, face avant (kick out)",
      "Caisse claire, dessus (snare top)",
      "Caisse claire, dessous (snare bottom)",
      "Caisse claire + baguettes",
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
      "Timbale d'orchestre (timpani)",
      "Cajón",
      "Maracas",
      "Xylophone / vibraphone",
      "Handpan / steel drum",
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
      "Guitare demi-caisse (hollow body)",
      "Guitare jazz (archtop)",
      "Banjo",
      "Guitare acoustique (folk)",
      "Guitare électrique (type Les Paul)",
      "Guitare électrique (type superstrat)",
      "Guitare électrique (Flying V)",
      "Violon",
      "Violon électrique",
      "Violoncelle",
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
      "Synthétiseur (curseurs et boutons)",
      "Clavier workstation (écran)",
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
      "Ampli stack (tête + baffle)",
      "Ampli 4 haut-parleurs",
      "Enceinte PA",
      "Moniteurs de studio (paire)",
      "Enceinte + micro",
      "Caisson de basse (sub)",
      "Enceinte pleine bande",
      "Enceinte double horizontale",
      "Enceintes suspendues (paire)",
      "Enceintes sur pont / mât",
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
      "Moniteur de sol (vue de face)",
      "Line array / enceinte courbe",
      "Enceinte de plafond",
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
      "Talkback A",
      "Talkback B",
      "Ordinateur portable",
      "Lecteur multimédia",
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
];
const ICON_OTHER = "Other / raw number";

function iconCategoryOf(value: number) {
  return ICON_CATEGORIES.find((c) => value >= c.min && value <= c.max);
}

export function IconField({ value, onChange }: { value: number; onChange: (n: number) => void }): JSX.Element {
  const category = iconCategoryOf(value);

  return (
    <div className="param-field param-field--wrap">
      <span className="param-field__label">Icon</span>
      <select
        value={category?.label ?? ICON_OTHER}
        onChange={(event) => {
          const next = ICON_CATEGORIES.find((c) => c.label === event.target.value);
          if (next) onChange(next.min);
        }}
      >
        {ICON_CATEGORIES.map((c) => (
          <option key={c.label} value={c.label}>
            {c.label} ({c.min}-{c.max})
          </option>
        ))}
        <option value={ICON_OTHER}>{ICON_OTHER}</option>
      </select>
      {category ? (
        <span className="icon-picker__current">
          <WingIcon id={value} />
          {value}: {category.names[value - category.min] ?? "?"}
        </span>
      ) : (
        <input type="number" min={0} max={999} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      )}
      {category && (
        <div className="icon-picker" role="radiogroup" aria-label={`${category.label} icons`}>
          {category.names.map((name, i) => {
            const n = category.min + i;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={n === value}
                aria-label={`${n}: ${name}`}
                title={`${n}: ${name}`}
                className={n === value ? "icon-picker__option icon-picker__option--selected" : "icon-picker__option"}
                onClick={() => onChange(n)}
              >
                {n === 0 ? <span className="icon-picker__none">∅</span> : <WingIcon id={n} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The console's describe() gives `col` no names either — just `col int [1..18]` — but unlike
 * `icon`, the 18 slots correspond to the console's fixed color palette (visible on the physical
 * strip's LED and the WING app's color picker). Names/hex below are transcribed from the actual
 * hex values read off a real console session (an earlier hand-guessed pass had several indices
 * wrong — e.g. 12 was guessed "Brown" but is actually purple). Mirrors the MCP server's
 * WING_COLOR_NAMES list (src/plugins/wing/wing-param-catalog.ts) — kept in sync by hand since the
 * two packages don't share a module.
 */
const WING_COLORS: readonly { name: string; hex: string }[] = [
  { name: "Blue", hex: "#3e63cc" },
  { name: "Azure", hex: "#0180ff" },
  { name: "Indigo", hex: "#5a33ff" },
  { name: "Turquoise", hex: "#00ced1" },
  { name: "Green", hex: "#00b23e" },
  { name: "Lime", hex: "#96cc00" },
  { name: "Yellow", hex: "#f2dd00" },
  { name: "Brown", hex: "#c06a1f" },
  { name: "Red", hex: "#e02040" },
  { name: "Salmon", hex: "#ff7a7a" },
  { name: "Magenta", hex: "#ff33f6" },
  { name: "Purple", hex: "#a533ff" },
  { name: "Amber", hex: "#ffb81a" },
  { name: "Sky Blue", hex: "#25c3ff" },
  { name: "Orange Red", hex: "#ff5a30" },
  { name: "Mint Green", hex: "#33e6a5" },
  { name: "Gray", hex: "#707070" },
  { name: "White", hex: "#e0e0e0" },
];

/** The swatch colour of a WING `col` value (1..18), or undefined outside the palette. */
export function wingColorHex(col: number): string | undefined {
  return WING_COLORS[col - 1]?.hex;
}

export function ColorField({ value, onChange }: { value: number; onChange: (n: number) => void }): JSX.Element {
  const color = WING_COLORS[value - 1];
  return (
    <div className="param-field param-field--wrap">
      <span className="param-field__label">Color</span>
      <div className="color-picker" role="radiogroup" aria-label="Color">
        {WING_COLORS.map((c, i) => (
          <button
            key={i + 1}
            type="button"
            role="radio"
            aria-checked={i + 1 === value}
            aria-label={`${i + 1}: ${c.name}`}
            title={`${i + 1}: ${c.name}`}
            className={i + 1 === value ? "color-picker__swatch color-picker__swatch--selected" : "color-picker__swatch"}
            style={{ background: c.hex }}
            onClick={() => onChange(i + 1)}
          />
        ))}
      </div>
      <span className="color-picker__current">{color ? `${value}: ${color.name}` : `${value}`}</span>
    </div>
  );
}

/**
 * The Pitch Corrector effect's (`mdl` "PCORR") 12 per-note enable switches — verified against real
 * hardware (a live FX slot loaded with PCORR, describe()'d directly) that unlike every other 0..1
 * boolean in this protocol, these are INVERTED: `0` means the note is active/allowed in the scale,
 * `1` means it's excluded. The console's own describe() gives no hint of this (just "int [0..1]"
 * like any other boolean) and the raw key names (sw_c, sw_db, ...) aren't self-explanatory either,
 * so both the inversion and the labeling are a name-keyed special case, rendered as one compact
 * "scale" row instead of 12 near-identical generic toggle rows.
 */
const PITCH_CORRECTOR_NOTE_KEYS: readonly { key: string; label: string }[] = [
  { key: "sw_c", label: "C" },
  { key: "sw_db", label: "C♯/D♭" },
  { key: "sw_d", label: "D" },
  { key: "sw_eb", label: "D♯/E♭" },
  { key: "sw_e", label: "E" },
  { key: "sw_f", label: "F" },
  { key: "sw_gb", label: "F♯/G♭" },
  { key: "sw_g", label: "G" },
  { key: "sw_ab", label: "G♯/A♭" },
  { key: "sw_a", label: "A" },
  { key: "sw_bb", label: "A♯/B♭" },
  { key: "sw_b", label: "B" },
];
const PITCH_CORRECTOR_NOTE_KEY_SET = new Set(PITCH_CORRECTOR_NOTE_KEYS.map((n) => n.key));

function PitchCorrectorScaleField({
  values,
  onSet,
}: {
  values: Record<string, number | string>;
  onSet: (key: string, value: number | string) => void | Promise<unknown>;
}) {
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  return (
    <div className="mixer-groups__row">
      <span className="param-field__label">Scale</span>
      {PITCH_CORRECTOR_NOTE_KEYS.map(({ key, label }) => {
        const raw = Number(overrides[key] ?? values[key] ?? 0);
        const active = raw === 0; // inverted — see the doc comment above
        return (
          <button
            key={key}
            className={active ? "mixer-mute mixer-mute--on" : "mixer-mute"}
            title={active ? `${label}: in scale` : `${label}: excluded`}
            onClick={() => {
              const next = active ? 1 : 0;
              setOverrides((prev) => ({ ...prev, [key]: next }));
              void onSet(key, next);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Renders one processing node's parameters (EQ/Gate/Dynamics/FX) purely from the console's own
 * "?" describe metadata — see wing-value-codec.ts's parseWingDescribeParams. Deliberately generic
 * rather than a per-domain hand-built form: verified against real hardware, gate/dyn/FX parameter
 * sets diverge from the hand-transcribed catalog (firmware-version-dependent) and FX additionally
 * changes shape entirely depending on the loaded effect model, so a static form would drift out of
 * sync with reality in exactly the cases that matter most.
 */
export function ParamPanel({ panel, onSet, onStructuralChange, leadingKeys = [], labels }: ParamPanelProps): JSX.Element {
  const byKey = new Map(panel.params.map((p) => [p.key, p]));
  const ordered = [
    ...leadingKeys.map((k) => byKey.get(k)).filter((p): p is WingDescribeParam => p !== undefined),
    ...panel.params.filter((p) => !leadingKeys.includes(p.key)),
  ];

  const hasPitchCorrectorScale = PITCH_CORRECTOR_NOTE_KEYS.every((n) => byKey.has(n.key));

  // What has been sent since the panel loaded, so the EQ curve follows a slider as it moves rather
  // than waiting for the next refetch.
  const [sent, setSent] = useState<Record<string, number | string>>({});
  const liveValues = { ...panel.values, ...sent };
  const send = (key: string, value: number | string) => {
    setSent((prev) => ({ ...prev, [key]: value }));
    return onSet(key, value);
  };

  // An EQ's bands get a column each under the curve instead of one long list of "Band 3 freq" rows.
  const eqBands = isDrawableEq(liveValues) ? groupEqBands(ordered) : [];
  const bandKeys = new Set(eqBands.flatMap((b) => b.fields.map((f) => f.param.key)));

  return (
    <div className="param-panel">
      {isDrawableEq(liveValues) && <EqCurve values={liveValues} />}
      {ordered
        .filter((param) => !hasPitchCorrectorScale || !PITCH_CORRECTOR_NOTE_KEY_SET.has(param.key))
        .filter((param) => !bandKeys.has(param.key))
        .map((param) => (
          <ParamField
            key={param.key}
            param={param}
            label={labels?.[param.key] ?? paramLabel(param.key)}
            value={panel.values[param.key]}
            onSet={send}
            onStructuralChange={param.key === "mdl" ? onStructuralChange : undefined}
          />
        ))}
      {hasPitchCorrectorScale && <PitchCorrectorScaleField values={panel.values} onSet={send} />}
      {eqBands.length > 0 && (
        <div className="eq-bands">
          {eqBands.map(({ band, fields }) => (
            <fieldset key={band} className="eq-band">
              <legend className="eq-band__title">{eqBandTitle(band)}</legend>
              {fields.map(({ param, field }) => (
                <ParamField
                  key={param.key}
                  param={param}
                  label={EQ_FIELD_LABELS[field]}
                  fullLabel={paramLabel(param.key)}
                  value={panel.values[param.key]}
                  onSet={send}
                />
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The option a list value selects. A numeric enum (a compressor's ratio: "1.1", "4.0", "10") may
 * come back as a bare number (4), which matches no option text exactly — compare numerically then,
 * rather than showing the first option as if it were selected.
 */
function matchOption(options: readonly string[], value: number | string | undefined): string {
  const text = String(value ?? "");
  if (options.includes(text)) return text;
  const numeric = Number(value);
  return (Number.isFinite(numeric) && text !== "" ? options.find((opt) => Number(opt) === numeric) : undefined) ?? text;
}

function ParamField({
  param,
  label = paramLabel(param.key),
  fullLabel = label,
  value,
  onSet,
  onStructuralChange,
}: {
  param: WingDescribeParam;
  /** Shown instead of the key's usual label (an EQ band column says "Gain", not "Band 2 gain"). */
  label?: string;
  /** The name read out by assistive tech, when `label` leans on its surroundings ("Band 2 gain"). */
  fullLabel?: string;
  value: number | string | undefined;
  onSet: (key: string, value: number | string) => void | Promise<unknown>;
  onStructuralChange?: () => void;
}) {
  // "$"-prefixed keys are the read-only DCA/mutegroup-adjusted mirror of a writable sibling (see
  // wing-osc-client.ts's isShadowAddress) — display them, but never as an editable control.
  const readOnly = param.key.startsWith("$");
  const [local, setLocal] = useState<number | string | undefined>(value);
  const current = local ?? value;

  const commit = useThrottledCommit<number | string>(120, (v) => void onSet(param.key, v));

  if (readOnly) {
    return (
      <div className="param-field param-field--readonly">
        <ParamLabel paramKey={param.key} label={label} />
        <span className="param-field__value">{String(value ?? "—")}</span>
      </div>
    );
  }

  if (param.kind === "list") {
    return (
      <div className="param-field">
        <ParamLabel paramKey={param.key} label={label} />
        <select
          value={matchOption(param.options ?? [], current)}
          onChange={(event) => {
            const next = event.target.value;
            setLocal(next);
            void Promise.resolve(onSet(param.key, next)).then(() => onStructuralChange?.());
          }}
        >
          {(param.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (param.kind === "string") {
    return (
      <div className="param-field">
        <ParamLabel paramKey={param.key} label={label} />
        <input
          type="text"
          maxLength={param.maxLength}
          value={String(current ?? "")}
          onChange={(event) => setLocal(event.target.value)}
          onBlur={() => void onSet(param.key, String(current ?? ""))}
        />
      </div>
    );
  }

  // "icon" is a plain 0..999 int on the wire with no enum — see IconField's doc comment for why
  // this is a name-keyed special case rather than describe()-driven like the branches above/below.
  if (param.key === "icon" && param.kind === "int") {
    const iconValue = typeof current === "number" ? current : Number(current ?? 0);
    return (
      <IconField
        value={iconValue}
        onChange={(next) => {
          setLocal(next);
          void onSet(param.key, next);
        }}
      />
    );
  }

  // "col" is a plain 1..18 int on the wire with no enum — see WING_COLORS' doc comment.
  if (param.key === "col" && param.kind === "int") {
    const colorValue = typeof current === "number" ? current : Number(current ?? 1);
    return (
      <ColorField
        value={colorValue}
        onChange={(next) => {
          setLocal(next);
          void onSet(param.key, next);
        }}
      />
    );
  }

  // A 0..1 int is a boolean on real hardware (mute/on/vph/pol/...) — a slider with two positions
  // reads as broken, not "just a narrow range", so render it as a toggle instead. Driven by the
  // describe()'d min/max, not a hardcoded field-name list, so this applies uniformly everywhere
  // ParamPanel is used (EQ/Gate/Dynamics/FX "on", and now I/O's mute/vph/pol too).
  if (param.kind === "int" && param.min === 0 && param.max === 1) {
    const boolValue = Number(current ?? 0) === 1;
    return (
      <div className="param-field">
        <ParamLabel paramKey={param.key} label={label} />
        <button
          className={boolValue ? "mixer-mute mixer-mute--on" : "mixer-mute"}
          onClick={() => {
            const next = boolValue ? 0 : 1;
            setLocal(next);
            void onSet(param.key, next);
          }}
        >
          {boolValue ? "On" : "Off"}
        </button>
      </div>
    );
  }

  // int / lin / log / fader: render as a slider. Fall back to a permissive 0..1 range for the
  // rare case describe() didn't yield bounds, so the control is still usable rather than absent.
  const min = param.min ?? 0;
  const max = param.max ?? 1;
  const step = param.kind === "int" ? 1 : param.steps && param.steps > 1 ? (max - min) / (param.steps - 1) : 0.1;
  const numeric = typeof current === "number" ? current : Number(current ?? min);

  // describe() marks frequencies, Qs and times "log": a linear slider would cram 20 Hz–2 kHz into
  // its first tenth. A log range needs a positive floor; one that starts at 0 stays linear.
  if (param.kind === "log" && min > 0 && max > min) {
    return (
      <SliderControl
        label={label}
        ariaLabel={fullLabel}
        value={toLogPosition(numeric, min, max)}
        min={0}
        max={LOG_SLIDER_STEPS}
        step={1}
        format={(position) =>
          // Untouched, show the console's own value rather than its round trip through a slider step.
          formatWithUnit(position === toLogPosition(numeric, min, max) ? numeric : fromLogPosition(position, min, max), param.unit)
        }
        onChange={(position) => {
          const v = fromLogPosition(position, min, max);
          setLocal(v);
          commit(v);
        }}
      />
    );
  }

  // A level on the console's fader scale (an FX return, an input's own fader…) moves like one.
  if (param.kind === "fader" && min === FADER_MIN_DB && max === FADER_MAX_DB) {
    return (
      <FaderControl
        label={label}
        value={numeric}
        onChange={(v) => {
          setLocal(v);
          commit(v);
        }}
      />
    );
  }

  // A dB gain that can go either way (EQ band gains, make-up) resets to flat on double-click.
  const resetValue = param.unit === "dB" && /(^|\d|[lh])g$|^gain$/.test(param.key) && min < 0 && max > 0 ? 0 : undefined;

  return (
    <SliderControl
      label={label}
      ariaLabel={fullLabel}
      resetValue={resetValue}
      value={numeric}
      min={min}
      max={max}
      step={step}
      format={(v) => formatWithUnit(v, param.unit)}
      onChange={(v) => {
        setLocal(v);
        commit(v);
      }}
    />
  );
}
