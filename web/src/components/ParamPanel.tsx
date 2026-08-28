import { useState } from "react";
import type { WingDescribeParam, WingParamPanel } from "../api/queries.js";
import { useThrottledCommit } from "../api/useThrottledCommit.js";
import { SliderControl } from "./SliderControl.js";

interface ParamPanelProps {
  panel: WingParamPanel;
  /** Called with the field's key (not the full path) and its new value. May return a promise. */
  onSet: (key: string, value: number | string) => void | Promise<unknown>;
  /** Called after a field whose change reshapes the rest of the panel (e.g. FX's "mdl") is committed —
   * only once `onSet`'s promise (if any) resolves, so the refetch it triggers doesn't race the write. */
  onStructuralChange?: () => void;
  /** Field keys to render specially at the top of the panel (e.g. FX's "mdl") instead of in describe order. */
  leadingKeys?: string[];
}

function formatWithUnit(value: number, unit: string | undefined): string {
  const rounded = Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(1);
  return unit ? `${rounded} ${unit}` : rounded;
}

/**
 * The console's own describe() gives icon no names — just `icon int [0..999]` — and the official
 * WING OSC protocol reference's own icon appendix doesn't publish per-icon names either: it's a
 * picture grid with only these category number ranges printed next to it. Names below are a
 * hand-authored transcription of that picture grid (not from the protocol reference text). Mirrors
 * the MCP server's WING_ICON_CATEGORIES list (src/plugins/wing/wing-param-catalog.ts) — kept in
 * sync by hand since the two packages don't share a module.
 */
const ICON_CATEGORIES: ReadonlyArray<{ label: string; min: number; max: number; names: readonly string[] }> = [
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
];
const ICON_OTHER = "Other / raw number";

function iconCategoryOf(value: number) {
  return ICON_CATEGORIES.find((c) => value >= c.min && value <= c.max);
}

export function IconField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const category = iconCategoryOf(value);

  return (
    <div className="param-field">
      <span className="param-field__label">icon</span>
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
        <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
          {category.names.map((name, i) => {
            const n = category.min + i;
            return (
              <option key={n} value={n}>
                {n}: {name}
              </option>
            );
          })}
        </select>
      ) : (
        <input type="number" min={0} max={999} value={value} onChange={(event) => onChange(Number(event.target.value))} />
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
const WING_COLORS: ReadonlyArray<{ name: string; hex: string }> = [
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

export function ColorField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const color = WING_COLORS[value - 1];
  return (
    <div className="param-field">
      <span className="param-field__label">col</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {WING_COLORS.map((c, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1}: {c.name}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "1em",
          height: "1em",
          borderRadius: "0.2em",
          border: "1px solid var(--border-color)",
          background: color?.hex ?? "transparent",
          verticalAlign: "middle",
        }}
      />
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
const PITCH_CORRECTOR_NOTE_KEYS: ReadonlyArray<{ key: string; label: string }> = [
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
export function ParamPanel({ panel, onSet, onStructuralChange, leadingKeys = [] }: ParamPanelProps) {
  const byKey = new Map(panel.params.map((p) => [p.key, p]));
  const ordered = [
    ...leadingKeys.map((k) => byKey.get(k)).filter((p): p is WingDescribeParam => p !== undefined),
    ...panel.params.filter((p) => !leadingKeys.includes(p.key)),
  ];

  const hasPitchCorrectorScale = PITCH_CORRECTOR_NOTE_KEYS.every((n) => byKey.has(n.key));

  return (
    <div className="param-panel">
      {ordered
        .filter((param) => !hasPitchCorrectorScale || !PITCH_CORRECTOR_NOTE_KEY_SET.has(param.key))
        .map((param) => (
          <ParamField
            key={param.key}
            param={param}
            value={panel.values[param.key]}
            onSet={onSet}
            onStructuralChange={param.key === "mdl" ? onStructuralChange : undefined}
          />
        ))}
      {hasPitchCorrectorScale && <PitchCorrectorScaleField values={panel.values} onSet={onSet} />}
    </div>
  );
}

function ParamField({
  param,
  value,
  onSet,
  onStructuralChange,
}: {
  param: WingDescribeParam;
  value: number | string | undefined;
  onSet: (key: string, value: number | string) => void | Promise<unknown>;
  onStructuralChange?: () => void;
}) {
  // "$"-prefixed keys are the read-only DCA/mutegroup-adjusted mirror of a writable sibling (see
  // wing-osc-client.ts's isShadowAddress) — display them, but never as an editable control.
  const readOnly = param.key.startsWith("$");
  const [local, setLocal] = useState<number | string | undefined>(value);
  const current = local ?? value;

  const commit = useThrottledCommit<number | string>(120, (v) => onSet(param.key, v));

  if (readOnly) {
    return (
      <div className="param-field param-field--readonly">
        <span className="param-field__label">{param.key}</span>
        <span className="param-field__value">{String(value ?? "—")}</span>
      </div>
    );
  }

  if (param.kind === "list") {
    return (
      <div className="param-field">
        <span className="param-field__label">{param.key}</span>
        <select
          value={String(current ?? "")}
          onChange={async (event) => {
            const next = event.target.value;
            setLocal(next);
            await onSet(param.key, next);
            onStructuralChange?.();
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
        <span className="param-field__label">{param.key}</span>
        <input
          type="text"
          maxLength={param.maxLength}
          value={String(current ?? "")}
          onChange={(event) => setLocal(event.target.value)}
          onBlur={() => onSet(param.key, String(current ?? ""))}
        />
      </div>
    );
  }

  // "icon" is a plain 0..999 int on the wire with no enum — see IconField's doc comment for why
  // this is a name-keyed special case rather than describe()-driven like the branches above/below.
  if (param.key === "icon" && param.kind === "int") {
    const numeric = typeof current === "number" ? current : Number(current ?? 0);
    return (
      <IconField
        value={numeric}
        onChange={(next) => {
          setLocal(next);
          void onSet(param.key, next);
        }}
      />
    );
  }

  // "col" is a plain 1..18 int on the wire with no enum — see WING_COLORS' doc comment.
  if (param.key === "col" && param.kind === "int") {
    const numeric = typeof current === "number" ? current : Number(current ?? 1);
    return (
      <ColorField
        value={numeric}
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
        <span className="param-field__label">{param.key}</span>
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

  return (
    <SliderControl
      label={param.key}
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
