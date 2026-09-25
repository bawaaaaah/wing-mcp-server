import { useEffect, useState, type JSX } from "react";
import {
  useAutoEqBalance,
  useAutoEqUndo,
  useMicCalibrations,
  useMixerState,
  AUTO_EQ_CUT_SLOPES,
  type AutoEqBalanceRequest,
  type AutoEqCut,
  type AutoEqCutSlope,
  type AutoEqNativeSide,
  type AutoEqBalanceResult,
  type AutoEqKind,
  type AutoEqStripType,
  type AutoEqZoneResult,
  type MicCalibrationSummary,
  type MicOrientation,
} from "../api/queries.js";
import { MeasurementMics } from "./WingMicCalibrations.js";

interface ZoneForm {
  type: AutoEqStripType;
  index: string;
  /** Empty = no cut requested. */
  lowCutHz: string;
  lowCutSlope: AutoEqCutSlope;
  highCutHz: string;
  highCutSlope: AutoEqCutSlope;
  fromHz: string;
  toHz: string;
  eq: AutoEqKind;
}

interface AutoEqForm {
  mic: string;
  /** Saved mic name, "" = uncalibrated. */
  micCalibration: string;
  micOrientation: "0" | "90";
  zones: ZoneForm[];
  targetMode: "flat" | "custom";
  customCurve: string;
  maxBoost: string;
  maxCut: string;
  iterations: string;
  sampleSec: string;
}

const STORAGE_KEY = "wing-auto-eq-form";
const STRIP_TYPES: readonly { type: AutoEqStripType; label: string; short: string; count: number }[] = [
  { type: "matrix", label: "Matrix", short: "Mtx", count: 8 },
  { type: "bus", label: "Bus", short: "Bus", count: 16 },
  { type: "main", label: "Main", short: "Main", count: 4 },
];
const stripInfo = (type: AutoEqStripType) => STRIP_TYPES.find((t) => t.type === type)!;
const NO_CUTS = { lowCutHz: "", lowCutSlope: "LR24", highCutHz: "", highCutSlope: "LR24" } as const;
const SETTLE_SEC = 1;
const DEFAULT_FORM: AutoEqForm = {
  mic: "",
  micCalibration: "",
  micOrientation: "0",
  zones: [
    { type: "matrix", index: "1", fromHz: "100", toHz: "20000", eq: "auto", ...NO_CUTS },
    { type: "matrix", index: "5", fromHz: "20", toHz: "100", eq: "auto", ...NO_CUTS },
  ],
  targetMode: "flat",
  customCurve: "31.5 4\n100 2\n1000 0\n10000 -2",
  maxBoost: "3",
  maxCut: "-9",
  iterations: "2",
  sampleSec: "4",
};

function loadForm(): AutoEqForm {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AutoEqForm>;
      // Forms saved before bus/main support stored zones as { matrix }.
      const zones = saved.zones?.map((z) => {
        const legacy = z as ZoneForm & { matrix?: string };
        return { ...NO_CUTS, ...(legacy.type ? z : { ...z, type: "matrix" as const, index: legacy.matrix ?? "1" }) };
      });
      return { ...DEFAULT_FORM, ...saved, ...(zones ? { zones } : {}) };
    }
  } catch {
    // storage unavailable or corrupt — defaults are fine
  }
  return DEFAULT_FORM;
}

/** Raw text in, number only once it's a finite value — keeps a leading "-" typeable (see WingMixerTab). */
function parseNumberField(text: string): number | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function parseCurve(text: string): { hz: number; db: number }[] | string {
  const points: { hz: number; db: number }[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    const [hz, db] = line.trim().split(/[\s,;]+/).map(Number);
    if (!(hz > 0) || !Number.isFinite(db)) return `Target curve line ${i + 1} should be "Hz dB" (got "${line.trim()}").`;
    points.push({ hz, db });
  }
  return points.length > 0 ? points : "The custom target curve is empty.";
}

/** The chosen orientation, or the mic's only curve when it doesn't have that one. */
function effectiveOrientation(form: AutoEqForm, mic: MicCalibrationSummary | undefined): MicOrientation {
  const wanted = Number(form.micOrientation) as MicOrientation;
  return mic && !mic.orientations.includes(wanted) ? mic.orientations[0] : wanted;
}

function buildRequest(form: AutoEqForm, apply: boolean, mic: MicCalibrationSummary | undefined): AutoEqBalanceRequest | string {
  const micChannel = parseNumberField(form.mic);
  if (micChannel === undefined) return "Pick the channel the measurement mic is on.";
  const zones = [];
  for (const [i, z] of form.zones.entries()) {
    const fromHz = parseNumberField(z.fromHz);
    const toHz = parseNumberField(z.toHz);
    if (fromHz === undefined || toHz === undefined) return `Zone ${i + 1}: enter a frequency range.`;
    const cut = (hzText: string, slope: AutoEqCutSlope): AutoEqCut | undefined => {
      const hz = parseNumberField(hzText);
      return hz === undefined ? undefined : { hz, slope };
    };
    zones.push({
      type: z.type,
      index: Number(z.index),
      fromHz,
      toHz,
      eq: z.eq,
      lowCut: cut(z.lowCutHz, z.lowCutSlope),
      highCut: cut(z.highCutHz, z.highCutSlope),
    });
  }
  if (zones.length === 0) return "Add at least one zone.";
  let targetCurve: AutoEqBalanceRequest["targetCurve"];
  if (form.targetMode === "custom") {
    const parsed = parseCurve(form.customCurve);
    if (typeof parsed === "string") return parsed;
    targetCurve = parsed;
  }
  const sampleSec = parseNumberField(form.sampleSec);
  return {
    micChannel,
    zones,
    targetCurve,
    maxBoostDb: parseNumberField(form.maxBoost),
    maxCutDb: parseNumberField(form.maxCut),
    iterations: parseNumberField(form.iterations),
    sampleMs: sampleSec === undefined ? undefined : Math.min(20000, Math.max(1000, sampleSec * 1000)),
    apply,
    micCalibration: form.micCalibration ? { name: form.micCalibration, orientation: effectiveOrientation(form, mic) } : undefined,
  };
}

const STOP_REASON_TEXT: Record<AutoEqBalanceResult["stopReason"], string> = {
  converged: "converged — every band is within 1.5 dB of the target",
  "limits-reached": "stopped — the remaining error is outside the boost/cut limits",
  "max-iterations": "stopped after the maximum number of rounds",
  preview: "preview only — nothing was written",
};

export function WingAutoEqTab(): JSX.Element {
  const [form, setForm] = useState<AutoEqForm>(loadForm);
  const [formError, setFormError] = useState<string | null>(null);
  const mixer = useMixerState();
  const mics = useMicCalibrations();
  const selectedMic = mics.data?.find((m) => m.name === form.micCalibration);
  const balance = useAutoEqBalance();
  const undo = useAutoEqUndo();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {
      // not persisting is harmless
    }
  }, [form]);

  const update = (patch: Partial<AutoEqForm>) => setForm((prev) => ({ ...prev, ...patch }));
  const updateZone = (i: number, patch: Partial<ZoneForm>) =>
    setForm((prev) => ({ ...prev, zones: prev.zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) }));

  const run = (apply: boolean) => {
    const req = buildRequest(form, apply, selectedMic);
    if (typeof req === "string") {
      setFormError(req);
      return;
    }
    setFormError(null);
    undo.reset();
    balance.mutate(req);
  };

  const rounds = parseNumberField(form.iterations) ?? 2;
  const estimateSec = Math.round((2 + rounds) * ((parseNumberField(form.sampleSec) ?? 4) + SETTLE_SEC));
  const busy = balance.isPending || undo.isPending;

  return (
    <section className="card auto-eq">
      <h3>System auto EQ</h3>
      <p className="auto-eq__notice">
        Send pink noise through the system, place the measurement mic, and <strong>mute its channel</strong> (the RTA
        reads the channel input, so the measurement still works). The mic is compared to the first zone's input — for a wedge, use one bus zone per run with the mic in front of it.
      </p>

      <div className="param-field">
        <span className="param-field__label">Mic channel</span>
        <select value={form.mic} onChange={(e) => update({ mic: e.target.value })}>
          <option value="">— choose —</option>
          {Array.from({ length: 40 }, (_, i) => i + 1).map((n) => {
            const name = mixer.data?.channels.find((c) => c.index === n)?.name;
            return (
              <option key={n} value={String(n)}>
                Ch {n}
                {name ? ` — ${name}` : ""}
              </option>
            );
          })}
        </select>
      </div>
      <div className="param-field auto-eq__mic-calibration">
        <span className="param-field__label">Mic calibration</span>
        <select value={form.micCalibration} onChange={(e) => update({ micCalibration: e.target.value })}>
          <option value="">None (uncalibrated)</option>
          {mics.data?.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
              {m.serial ? ` — SN ${m.serial}` : ""}
            </option>
          ))}
          {form.micCalibration && mics.data && !selectedMic && <option value={form.micCalibration}>{form.micCalibration} (not found)</option>}
        </select>
      </div>
      {selectedMic && (
        <div className="auto-eq__target auto-eq__orientation">
          {(["0", "90"] as const).map((o) => (
            <label key={o} title={o === "0" ? "mic pointed at the source" : "mic pointed at the ceiling"}>
              <input
                type="radio"
                name="auto-eq-mic-orientation"
                checked={effectiveOrientation(form, selectedMic) === Number(o)}
                disabled={!selectedMic.orientations.includes(Number(o) as MicOrientation)}
                onChange={() => update({ micOrientation: o })}
              />{" "}
              {o}° {o === "0" ? "(pointed at the source)" : "(pointed at the ceiling)"}
            </label>
          ))}
        </div>
      )}
      <MeasurementMics
        onSaved={(name, renamedFrom) =>
          setForm((prev) => (!prev.micCalibration || prev.micCalibration === renamedFrom ? { ...prev, micCalibration: name } : prev))
        }
        onDeleted={(name) => setForm((prev) => (prev.micCalibration === name ? { ...prev, micCalibration: "" } : prev))}
      />

      <h4>Zones</h4>
      <div className="auto-eq__zones">
        {form.zones.map((zone, i) => (
          <div className="auto-eq__zone" key={i}>
            <select
              value={zone.type}
              onChange={(e) => {
                const type = e.target.value as AutoEqStripType;
                updateZone(i, { type, index: String(Math.min(Number(zone.index), stripInfo(type).count)) });
              }}
              aria-label="Strip type"
            >
              {STRIP_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
            <select value={zone.index} onChange={(e) => updateZone(i, { index: e.target.value })} aria-label="Strip">
              {Array.from({ length: stripInfo(zone.type).count }, (_, n) => n + 1).map((n) => {
                const strips = zone.type === "matrix" ? mixer.data?.matrices : zone.type === "bus" ? mixer.data?.buses : mixer.data?.mains;
                const name = strips?.find((x) => x.index === n)?.name;
                return (
                  <option key={n} value={String(n)}>
                    {n}
                    {name ? ` — ${name}` : ""}
                  </option>
                );
              })}
            </select>
            <input type="number" inputMode="decimal" value={zone.fromHz} onChange={(e) => updateZone(i, { fromHz: e.target.value })} aria-label="From Hz" />
            <span>to</span>
            <input type="number" inputMode="decimal" value={zone.toHz} onChange={(e) => updateZone(i, { toHz: e.target.value })} aria-label="To Hz" />
            <span>Hz</span>
            <select value={zone.eq} onChange={(e) => updateZone(i, { eq: e.target.value as AutoEqKind })} aria-label="EQ">
              <option value="auto">GEQ, else 8-band EQ</option>
              <option value="geq">GEQ only</option>
              <option value="peq">8-band EQ only</option>
            </select>
            <button type="button" onClick={() => update({ zones: form.zones.filter((_, j) => j !== i) })} disabled={form.zones.length === 1}>
              Remove
            </button>
            <div className="auto-eq__cuts">
              {(["low", "high"] as const).map((side) => {
                const hzKey = side === "low" ? "lowCutHz" : "highCutHz";
                const slopeKey = side === "low" ? "lowCutSlope" : "highCutSlope";
                return (
                  <label key={side} className="auto-eq__cut">
                    {side === "low" ? "Low cut" : "High cut"}
                    <input
                      type="number"
                      inputMode="decimal"
                      placeholder="off"
                      value={zone[hzKey]}
                      onChange={(e) => updateZone(i, { [hzKey]: e.target.value })}
                      aria-label={`${side === "low" ? "Low" : "High"} cut Hz`}
                    />
                    <span>Hz</span>
                    <select
                      value={zone[slopeKey]}
                      onChange={(e) => updateZone(i, { [slopeKey]: e.target.value as AutoEqCutSlope })}
                      aria-label={`${side === "low" ? "Low" : "High"} cut slope`}
                    >
                      {AUTO_EQ_CUT_SLOPES.map((slope) => (
                        <option key={slope} value={slope}>
                          {slope}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        <button
          type="button"
          className="auto-eq__add"
          onClick={() => update({ zones: [...form.zones, { type: "bus", index: "1", fromHz: "20", toHz: "20000", eq: "auto", ...NO_CUTS }] })}
          disabled={form.zones.length >= 8}
        >
          Add zone
        </button>
      </div>

      <h4>Target</h4>
      <div className="auto-eq__target">
        <label>
          <input type="radio" checked={form.targetMode === "flat"} onChange={() => update({ targetMode: "flat" })} /> Flat
        </label>
        <label>
          <input type="radio" checked={form.targetMode === "custom"} onChange={() => update({ targetMode: "custom" })} /> Custom curve
        </label>
      </div>
      {form.targetMode === "custom" && (
        <textarea
          className="auto-eq__curve"
          rows={5}
          value={form.customCurve}
          onChange={(e) => update({ customCurve: e.target.value })}
          aria-label="Custom target curve, one Hz dB pair per line"
        />
      )}

      <details className="auto-eq__advanced">
        <summary>Limits and timing</summary>
        <div className="auto-eq__advanced-grid">
          <NumberField label="Max boost" unit="dB" value={form.maxBoost} onChange={(v) => update({ maxBoost: v })} />
          <NumberField label="Max cut" unit="dB" value={form.maxCut} onChange={(v) => update({ maxCut: v })} />
          <NumberField label="Rounds" unit="" value={form.iterations} onChange={(v) => update({ iterations: v })} />
          <NumberField label="Measure for" unit="s" value={form.sampleSec} onChange={(v) => update({ sampleSec: v })} />
        </div>
      </details>

      <div className="auto-eq__actions">
        <button type="button" onClick={() => run(false)} disabled={busy}>
          Preview
        </button>
        <button type="button" className="auto-eq__primary" onClick={() => run(true)} disabled={busy}>
          Measure &amp; apply
        </button>
        <button type="button" onClick={() => undo.mutate()} disabled={busy}>
          Undo last run
        </button>
        {balance.isPending && <span className="meters-status">Measuring… up to ~{estimateSec} s</span>}
      </div>

      {formError && <p className="error">{formError}</p>}
      {balance.isError && <p className="error">{balance.error.message}</p>}
      {undo.isError && <p className="error">{undo.error.message}</p>}
      {undo.isSuccess && <p>Undone — {undo.data.restoredWrites} change(s) restored.</p>}
      {balance.isSuccess && !undo.isSuccess && <AutoEqResultView result={balance.data} />}
    </section>
  );
}

function NumberField({ label, unit, value, onChange }: { label: string; unit: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="param-field">
      <span className="param-field__label">{label}</span>
      <input type="number" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: "none", width: "5rem" }} />
      <span className="param-field__value">{unit}</span>
    </div>
  );
}

function AutoEqResultView({ result }: { result: AutoEqBalanceResult }) {
  return (
    <div className="auto-eq__result">
      <p>
        <strong>{STOP_REASON_TEXT[result.stopReason]}</strong>
        {result.applied && ` after ${result.iterations} round(s)`}. {result.applied ? "Remaining" : "Measured"} error: max{" "}
        {result.residualMaxDb} dB, rms {result.residualRmsDb} dB.
        {result.micCalibration && (
          <span className="meters-status">
            {" "}
            Mic calibrated with{" "}
            {result.micCalibration.name ? `${result.micCalibration.name} (${result.micCalibration.orientation}°)` : "a one-off curve"}.
          </span>
        )}
      </p>
      <AutoEqChart result={result} />
      {result.zones.map((zone) => (
        <ZoneSummary key={`${zone.type}${zone.index}`} zone={zone} applied={result.applied} />
      ))}
    </div>
  );
}

function ZoneSummary({ zone, applied }: { zone: AutoEqZoneResult; applied: boolean }) {
  const title = `${stripInfo(zone.type).label} ${zone.index} (${zone.fromHz}–${zone.toHz} Hz)`;
  const cutText = [zone.cuts.low && `low cut ${formatCut(zone.cuts.low)}`, zone.cuts.high && `high cut ${formatCut(zone.cuts.high)}`]
    .filter(Boolean)
    .join(", ");
  const nativeNote = `${cutText ? ` · ${cutText}` : ""}${zone.nativeEqTurnedOn ? " · native EQ turned on" : ""}`;
  if (zone.eqKind === "geq") {
    const changed = (zone.geqBands ?? []).filter((b) => b.new !== b.old);
    const insertText = zone.insert?.installed
      ? `GEQ ${applied ? "loaded" : "would be loaded"} on FX${zone.fxSlot} and patched on the ${zone.insert.slot}-insert`
      : `GEQ on FX${zone.fxSlot} (${zone.insert?.slot}-insert${zone.insert?.turnedOn ? ", turned on" : ""})`;
    return (
      <div className="auto-eq__zone-result">
        <h4>{title}</h4>
        <p className="meters-status">
          {insertText}
          {nativeNote}
        </p>
        {changed.length === 0 ? (
          <p>No band changed.</p>
        ) : (
          <div className="auto-eq__bands">
            {changed.map((b) => (
              <span key={b.hz} className={b.clamped ? "auto-eq__band auto-eq__band--clamped" : "auto-eq__band"} title={b.clamped ? "held at a limit" : undefined}>
                {formatHz(b.hz)}: {b.old} → {b.new} dB
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="auto-eq__zone-result">
      <h4>{title}</h4>
      <p className="meters-status">
        Native EQ{nativeNote}
        {zone.fallbackReason ? ` — GEQ not used: ${zone.fallbackReason}` : ""}
      </p>
      <table className="plugin-table">
        <thead>
          <tr>
            <th>Band</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {zone.peq && (
            <>
              <tr>
                <td>Low</td>
                <td>{formatSide(zone.peq.old.low)}</td>
                <td>{formatSide(zone.peq.new.low)}</td>
              </tr>
              {zone.peq.new.bands.map((band, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{formatBand(zone.peq!.old.bands[i])}</td>
                  <td>{formatBand(band)}</td>
                </tr>
              ))}
              <tr>
                <td>High</td>
                <td>{formatSide(zone.peq.old.high)}</td>
                <td>{formatSide(zone.peq.new.high)}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${Number((hz / 1000).toFixed(2))}k` : String(hz);
}

function formatBand(b: { f: number; g: number; q: number }): string {
  return b.g === 0 ? "—" : `${formatHz(b.f)} Hz, ${b.g > 0 ? "+" : ""}${b.g} dB, Q ${b.q}`;
}

function formatCut(cut: AutoEqCut): string {
  return `${formatHz(cut.hz)} Hz ${cut.slope}`;
}

function formatSide(side: AutoEqNativeSide): string {
  if (side.type === "SHV") return side.g === 0 ? "—" : `shelf ${formatBand(side)}`;
  if (side.type === "PEQ") return formatBand(side);
  return `cut ${formatHz(side.f)} Hz ${side.type}`;
}

const CHART = { width: 640, height: 220, left: 34, right: 8, top: 12, bottom: 24, rangeDb: 12 };
const FREQ_TICKS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function AutoEqChart({ result }: { result: AutoEqBalanceResult }) {
  const plotW = CHART.width - CHART.left - CHART.right;
  const plotH = CHART.height - CHART.top - CHART.bottom;
  const x = (hz: number) => CHART.left + ((Math.log10(hz) - Math.log10(20)) / 3) * plotW;
  const y = (db: number) => CHART.top + ((CHART.rangeDb - Math.max(-CHART.rangeDb, Math.min(CHART.rangeDb, db))) / (2 * CHART.rangeDb)) * plotH;
  const path = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(result.frequenciesHz[i]).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const gains = new Map<number, number>();
  for (const zone of result.zones) for (const b of zone.geqBands ?? []) gains.set(b.hz, b.new);
  const barW = (plotW / 31) * 0.55;

  return (
    <figure className="auto-eq__chart">
      <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-label="Measured response versus target">
        {result.zones.map((zone, i) => (
          <g key={`${zone.type}${zone.index}`}>
            <rect
              x={x(Math.max(20, zone.fromHz))}
              y={CHART.top}
              width={x(Math.min(20000, zone.toHz)) - x(Math.max(20, zone.fromHz))}
              height={plotH}
              className={i % 2 === 0 ? "auto-eq__zone-band" : "auto-eq__zone-band auto-eq__zone-band--alt"}
            />
            <text x={x(Math.max(20, zone.fromHz)) + 4} y={CHART.top + 11} className="auto-eq__axis">
              {stripInfo(zone.type).short} {zone.index}
            </text>
          </g>
        ))}
        {[-12, -6, 0, 6, 12].map((db) => (
          <g key={db}>
            <line x1={CHART.left} x2={CHART.width - CHART.right} y1={y(db)} y2={y(db)} className={db === 0 ? "auto-eq__zero" : "auto-eq__grid"} />
            <text x={CHART.left - 4} y={y(db) + 3} textAnchor="end" className="auto-eq__axis">
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}
        {FREQ_TICKS.map((hz) => (
          <text key={hz} x={x(hz)} y={CHART.height - 6} textAnchor="middle" className="auto-eq__axis">
            {formatHz(hz)}
          </text>
        ))}
        {result.frequenciesHz.map((hz) =>
          gains.has(hz) ? (
            <rect
              key={hz}
              x={x(hz) - barW / 2}
              width={barW}
              y={Math.min(y(0), y(gains.get(hz)!))}
              height={Math.abs(y(gains.get(hz)!) - y(0))}
              className="auto-eq__gain"
            />
          ) : null,
        )}
        <path d={path(result.target)} className="auto-eq__line auto-eq__line--target" />
        <path d={path(result.before)} className="auto-eq__line auto-eq__line--before" />
        {result.applied && <path d={path(result.after)} className="auto-eq__line auto-eq__line--after" />}
      </svg>
      <figcaption className="auto-eq__legend">
        <span className="auto-eq__key auto-eq__key--before">measured before</span>
        {result.applied && <span className="auto-eq__key auto-eq__key--after">after correction</span>}
        <span className="auto-eq__key auto-eq__key--target">target</span>
        {gains.size > 0 && <span className="auto-eq__key auto-eq__key--gain">GEQ gain {result.applied ? "" : "(proposed)"}</span>}
      </figcaption>
    </figure>
  );
}
