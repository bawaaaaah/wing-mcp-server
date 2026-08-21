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
 * picture grid with only these category number ranges printed next to it. So this groups the
 * picker by category without inventing names the spec itself doesn't give.
 */
const ICON_CATEGORIES: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "General", min: 0, max: 14 },
  { label: "Vocals & Mics", min: 100, max: 114 },
  { label: "Drums & Percussion", min: 200, max: 224 },
  { label: "Strings & Winds", min: 300, max: 319 },
  { label: "Keys", min: 400, max: 409 },
  { label: "Speakers", min: 500, max: 524 },
  { label: "Specials", min: 600, max: 614 },
];
const ICON_OTHER = "Other / raw number";

function iconCategoryOf(value: number) {
  return ICON_CATEGORIES.find((c) => value >= c.min && value <= c.max);
}

function IconField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
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
          {Array.from({ length: category.max - category.min + 1 }, (_, i) => category.min + i).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      ) : (
        <input type="number" min={0} max={999} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      )}
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
