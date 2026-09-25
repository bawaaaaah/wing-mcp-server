import { useState, type ChangeEvent, type JSX } from "react";
import {
  useDeleteMicCalibration,
  useMicCalibration,
  useMicCalibrations,
  useParseMicCalibration,
  useSaveMicCalibration,
  type MicCalibrationCandidate,
  type MicCalibrationCurve,
  type MicCalibrationFile,
  type MicCurveKey,
} from "../api/queries.js";

/** Saved measurement mics ("presets par micro") and their calibration files, for the Auto EQ tab. */

const CURVE_KEYS: readonly MicCurveKey[] = ["deg0", "deg90"];
const CURVE_LABELS: Record<MicCurveKey, string> = { deg0: "0° curve", deg90: "90° curve" };
const CURVE_HINTS: Record<MicCurveKey, string> = { deg0: "mic pointed at the source", deg90: "mic pointed at the ceiling" };
const CALIBRATION_ACCEPT = ".txt,.cal,.frd,.csv,.tsv,.dat,.mic,.rtf,.ods,.xlsx,.zip";

function formatHz(hz: number): string {
  return hz >= 1000 ? `${Number((hz / 1000).toFixed(1))} kHz` : `${Math.round(hz)} Hz`;
}

function describeCurve(curve: { points: { hz: number }[] }): string {
  return `${curve.points.length} points, ${formatHz(curve.points[0].hz)}–${formatHz(curve.points[curve.points.length - 1].hz)}`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function MeasurementMics({ onSaved, onDeleted }: { onSaved: (name: string, renamedFrom?: string) => void; onDeleted: (name: string) => void }): JSX.Element {
  const mics = useMicCalibrations();
  const remove = useDeleteMicCalibration();
  /** null = not editing, "" = adding a new mic, else the name of the mic being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const existing = useMicCalibration(editing ? editing : null);

  return (
    <details className="auto-eq__advanced auto-eq__mics">
      <summary>Measurement mics{mics.data ? ` (${mics.data.length})` : ""}</summary>
      <p className="auto-eq__notice">
        Save each measurement mic with its calibration file — txt, cal, frd, csv, rtf, ods, xlsx, or the manufacturer's zip as
        downloaded. Its own response is then subtracted from what it measures.
      </p>
      {mics.isError && <p className="error">{mics.error.message}</p>}
      {mics.data?.length === 0 && <p>No mic saved yet.</p>}
      {mics.data && mics.data.length > 0 && (
        <table className="plugin-table auto-eq__mic-table">
          <tbody>
            {mics.data.map((mic) => (
              <tr key={mic.name}>
                <td>
                  <strong>{mic.name}</strong>
                  {mic.serial && ` · SN ${mic.serial}`}
                  {mic.notes && <div className="meters-status">{mic.notes}</div>}
                </td>
                <td className="meters-status">
                  {CURVE_KEYS.flatMap((key) => {
                    const range = mic.ranges[key];
                    return range ? [`${key === "deg0" ? "0°" : "90°"}: ${range.pointCount} points, ${formatHz(range.minHz)}–${formatHz(range.maxHz)}`] : [];
                  }).join(" · ")}
                </td>
                <td className="auto-eq__mic-actions">
                  <button type="button" onClick={() => setEditing(mic.name)} disabled={editing !== null}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete the mic "${mic.name}" and its calibration?`)) {
                        remove.mutate(mic.name, { onSuccess: () => onDeleted(mic.name) });
                      }
                    }}
                    disabled={editing !== null || remove.isPending}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {remove.isError && <p className="error">{remove.error.message}</p>}

      {editing === null && (
        <button type="button" className="auto-eq__add" onClick={() => setEditing("")}>
          Add a mic
        </button>
      )}
      {editing === "" && <MicEditor initial={null} onSaved={onSaved} onClose={() => setEditing(null)} />}
      {editing &&
        (existing.isError ? (
          <p className="error">{existing.error.message}</p>
        ) : existing.data ? (
          <MicEditor key={editing} initial={existing.data} onSaved={onSaved} onClose={() => setEditing(null)} />
        ) : (
          <p className="meters-status">Loading…</p>
        ))}
    </details>
  );
}

function MicEditor({
  initial,
  onSaved,
  onClose,
}: {
  initial: MicCalibrationFile | null;
  onSaved: (name: string, renamedFrom?: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [serial, setSerial] = useState(initial?.serial ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [curves, setCurves] = useState<Record<MicCurveKey, MicCalibrationCurve | null>>(initial?.curves ?? { deg0: null, deg90: null });
  const [formError, setFormError] = useState<string | null>(null);
  const save = useSaveMicCalibration();

  const submit = () => {
    if (!name.trim()) return setFormError("Give the mic a name.");
    if (!curves.deg0 && !curves.deg90) return setFormError("Import at least one calibration file.");
    setFormError(null);
    save.mutate(
      { name: name.trim(), serial, notes, curves, renameFrom: initial?.name },
      {
        onSuccess: (saved) => {
          onSaved(saved.name, initial?.name);
          onClose();
        },
      },
    );
  };

  return (
    <div className="auto-eq__mic-editor">
      <h4>{initial ? `Edit ${initial.name}` : "New mic"}</h4>
      <div className="auto-eq__mic-fields">
        <label className="param-field">
          <span className="param-field__label">Name</span>
          <input type="text" value={name} placeholder="ECM8000" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="param-field">
          <span className="param-field__label">Serial number</span>
          <input type="text" value={serial} placeholder="optional" onChange={(e) => setSerial(e.target.value)} />
        </label>
        <label className="param-field">
          <span className="param-field__label">Notes</span>
          <input type="text" value={notes} placeholder="optional" onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      {CURVE_KEYS.map((key) => (
        <CurveField
          key={key}
          curveKey={key}
          curve={curves[key]}
          onChange={(curve, fileName) => {
            setCurves((prev) => ({ ...prev, [key]: curve }));
            // "ECM8000.zip" -> "ECM8000" when the mic has no name yet.
            if (curve && fileName) setName((prev) => (prev.trim() ? prev : fileName.replace(/\.[^.]+$/, "")));
          }}
        />
      ))}
      <CalibrationChart curves={curves} />
      <div className="auto-eq__actions">
        <button type="button" className="auto-eq__primary" onClick={submit} disabled={save.isPending}>
          Save mic
        </button>
        <button type="button" onClick={onClose} disabled={save.isPending}>
          Cancel
        </button>
      </div>
      {formError && <p className="error">{formError}</p>}
      {save.isError && <p className="error">{save.error.message}</p>}
    </div>
  );
}

function CurveField({
  curveKey,
  curve,
  onChange,
}: {
  curveKey: MicCurveKey;
  curve: MicCalibrationCurve | null;
  onChange: (curve: MicCalibrationCurve | null, fileName?: string) => void;
}) {
  const parse = useParseMicCalibration();
  const [choices, setChoices] = useState<{ fileName: string; candidates: MicCalibrationCandidate[] } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const use = (candidate: MicCalibrationCandidate, fileName: string) => onChange({ sourceFiles: candidate.files, points: candidate.points }, fileName);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setChoices(null);
    setReadError(null);
    try {
      const { candidates } = await parse.mutateAsync({ fileName: file.name, contentBase64: toBase64(await file.arrayBuffer()) });
      if (candidates.length === 1) use(candidates[0], file.name);
      else setChoices({ fileName: file.name, candidates });
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="auto-eq__curve-field">
      <div className="auto-eq__curve-row">
        <span className="param-field__label" title={CURVE_HINTS[curveKey]}>
          {CURVE_LABELS[curveKey]}
        </span>
        <span className={curve ? undefined : "meters-status"}>
          {curve ? describeCurve(curve) : CURVE_HINTS[curveKey]}
          {curve && curve.sourceFiles.length > 0 && <span className="meters-status"> · from {curve.sourceFiles.join(" + ")}</span>}
        </span>
        <label className={parse.isPending ? "auto-eq__file auto-eq__file--busy" : "auto-eq__file"}>
          <input type="file" accept={CALIBRATION_ACCEPT} onChange={(e) => void onFile(e)} disabled={parse.isPending} />
          {parse.isPending ? "Reading…" : curve ? "Replace file" : "Import file"}
        </label>
        {curve && (
          <button type="button" onClick={() => onChange(null)}>
            Remove
          </button>
        )}
      </div>
      {choices && (
        <select
          value=""
          onChange={(e) => {
            use(choices.candidates[Number(e.target.value)], choices.fileName);
            setChoices(null);
          }}
          aria-label="Pick the calibration curve"
        >
          <option value="" disabled>
            {choices.fileName} holds {choices.candidates.length} different curves — pick one
          </option>
          {choices.candidates.map((c, i) => (
            <option key={i} value={i}>
              {c.files.join(" + ")} ({describeCurve(c)})
            </option>
          ))}
        </select>
      )}
      {readError && <p className="error">{readError}</p>}
    </div>
  );
}

const CAL_CHART = { width: 640, height: 150, left: 34, right: 8, top: 10, bottom: 22 };
const CAL_FREQ_TICKS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function CalibrationChart({ curves }: { curves: Record<MicCurveKey, MicCalibrationCurve | null> }) {
  const lines = CURVE_KEYS.flatMap((key) => (curves[key] ? [{ key, points: curves[key]!.points }] : []));
  if (lines.length === 0) return null;
  const maxAbs = Math.max(...lines.flatMap((line) => line.points.map((p) => Math.abs(p.db))));
  const rangeDb = Math.max(6, Math.ceil(maxAbs / 3) * 3);
  const plotW = CAL_CHART.width - CAL_CHART.left - CAL_CHART.right;
  const plotH = CAL_CHART.height - CAL_CHART.top - CAL_CHART.bottom;
  const x = (hz: number) => CAL_CHART.left + ((Math.log10(Math.min(20000, Math.max(20, hz))) - Math.log10(20)) / 3) * plotW;
  const y = (db: number) => CAL_CHART.top + ((rangeDb - db) / (2 * rangeDb)) * plotH;
  const path = (points: { hz: number; db: number }[]) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.hz).toFixed(1)},${y(p.db).toFixed(1)}`).join("");

  return (
    <figure className="auto-eq__chart">
      <svg viewBox={`0 0 ${CAL_CHART.width} ${CAL_CHART.height}`} role="img" aria-label="Mic calibration curves">
        {[-rangeDb, -rangeDb / 2, 0, rangeDb / 2, rangeDb].map((db) => (
          <g key={db}>
            <line x1={CAL_CHART.left} x2={CAL_CHART.width - CAL_CHART.right} y1={y(db)} y2={y(db)} className={db === 0 ? "auto-eq__zero" : "auto-eq__grid"} />
            <text x={CAL_CHART.left - 4} y={y(db) + 3} textAnchor="end" className="auto-eq__axis">
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}
        {CAL_FREQ_TICKS.map((hz) => (
          <text key={hz} x={x(hz)} y={CAL_CHART.height - 6} textAnchor="middle" className="auto-eq__axis">
            {hz >= 1000 ? `${hz / 1000}k` : hz}
          </text>
        ))}
        {lines.map((line) => (
          <path key={line.key} d={path(line.points)} className={`auto-eq__line auto-eq__line--${line.key}`} />
        ))}
      </svg>
      <figcaption className="auto-eq__legend">
        {lines.map((line) => (
          <span key={line.key} className={`auto-eq__key auto-eq__key--${line.key}`}>
            {CURVE_LABELS[line.key]} (mic response, dB)
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
