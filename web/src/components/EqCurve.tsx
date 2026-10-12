import { useMemo, useState, type JSX } from "react";

// An approximate frequency response for a WING EQ block, drawn from its own parameters: the low and
// high bands (`lg/lf/lq` + `leq`, `hg/hf/hq` + `heq`) and up to four parametric bands (`1g/1f/1q`…).
// The bands are modelled with the standard RBJ biquads (peaking, shelving) and Butterworth /
// Linkwitz-Riley magnitude for the bus/main cut filters. The console's own models (SOUL, E88…) are
// not published, so this is a guide to the shape, not a measurement.

type Values = Record<string, number | string | undefined>;

const SAMPLE_RATE = 48000;
const F_MIN = 20;
const F_MAX = 20000;
const WIDTH = 600;
const HEIGHT = 170;
const PAD = { top: 10, right: 10, bottom: 20, left: 30 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const POINTS = 240;

interface Band {
  label: string;
  /** Magnitude in dB at frequency f. */
  response: (f: number) => number;
  freq: number;
}

function num(values: Values, key: string): number | undefined {
  const v = values[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** |H(e^jw)| in dB of a normalized biquad at frequency f. */
function biquadDb(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number, f: number): number {
  const w = (2 * Math.PI * f) / SAMPLE_RATE;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const numRe = b0 + b1 * cos1 + b2 * cos2;
  const numIm = -(b1 * sin1 + b2 * sin2);
  const denRe = a0 + a1 * cos1 + a2 * cos2;
  const denIm = -(a1 * sin1 + a2 * sin2);
  const mag2 = (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm);
  return 10 * Math.log10(mag2);
}

function peaking(gainDb: number, f0: number, q: number): (f: number) => number {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  return (f) => biquadDb(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A, f);
}

function shelf(kind: "low" | "high", gainDb: number, f0: number, q: number): (f: number) => number {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  const s = 2 * Math.sqrt(A) * alpha;
  if (kind === "low") {
    return (f) =>
      biquadDb(
        A * (A + 1 - (A - 1) * c + s),
        2 * A * (A - 1 - (A + 1) * c),
        A * (A + 1 - (A - 1) * c - s),
        A + 1 + (A - 1) * c + s,
        -2 * (A - 1 + (A + 1) * c),
        A + 1 + (A - 1) * c - s,
        f,
      );
  }
  return (f) =>
    biquadDb(
      A * (A + 1 + (A - 1) * c + s),
      -2 * A * (A - 1 + (A + 1) * c),
      A * (A + 1 + (A - 1) * c - s),
      A + 1 - (A - 1) * c + s,
      2 * (A - 1 - (A + 1) * c),
      A + 1 - (A - 1) * c - s,
      f,
    );
}

/** A low (high-pass) or high (low-pass) cut: "CUT" is 12 dB/oct, BWn/BSn/LRn are n dB/oct. */
function cut(kind: "low" | "high", type: string, f0: number): (f: number) => number {
  const slope = type === "CUT" ? 12 : Number(type.replace(/\D/g, "")) || 12;
  const order = slope / 6;
  const linkwitzRiley = type.startsWith("LR");
  return (f) => {
    const ratio = kind === "low" ? f0 / f : f / f0;
    // Butterworth: 1/sqrt(1 + r^2n). Linkwitz-Riley of the same slope: a squared Butterworth of half the order.
    return linkwitzRiley ? -10 * Math.log10(1 + Math.pow(ratio, order)) * 2 : -10 * Math.log10(1 + Math.pow(ratio, 2 * order));
  };
}

function edgeBand(values: Values, prefix: "l" | "h"): Band | null {
  const freq = num(values, `${prefix}f`);
  if (freq === undefined) return null;
  const gain = num(values, `${prefix}g`) ?? 0;
  const q = num(values, `${prefix}q`) ?? 0.707;
  const type = String(values[`${prefix}eq`] ?? "SHV");
  const kind = prefix === "l" ? "low" : "high";
  const label = prefix === "l" ? "Low" : "High";
  if (type === "PEQ") return { label, freq, response: peaking(gain, freq, q) };
  if (type === "SHV") return { label, freq, response: shelf(kind, gain, freq, q) };
  return { label: `${label} cut`, freq, response: cut(kind, type, freq) };
}

function bandsOf(values: Values): Band[] {
  const bands: Band[] = [];
  const low = edgeBand(values, "l");
  if (low) bands.push(low);
  for (let n = 1; n <= 8; n++) {
    const freq = num(values, `${n}f`);
    if (freq === undefined) break;
    bands.push({ label: `Band ${n}`, freq, response: peaking(num(values, `${n}g`) ?? 0, freq, num(values, `${n}q`) ?? 1) });
  }
  const high = edgeBand(values, "h");
  if (high) bands.push(high);
  return bands;
}

/** True when a describe()'d panel has the band keys this curve knows how to draw. */
export function isDrawableEq(values: Values): boolean {
  return num(values, "lf") !== undefined && num(values, "hf") !== undefined && num(values, "1f") !== undefined;
}

const xOf = (f: number) => PAD.left + (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * PLOT_W;
const fOf = (x: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, (x - PAD.left) / PLOT_W)));

function formatHz(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
}

const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const LABEL_HZ: [number, string][] = [
  [100, "100"],
  [1000, "1k"],
  [10000, "10k"],
];

export function EqCurve({ values }: { values: Values }): JSX.Element {
  const bands = useMemo(() => bandsOf(values), [values]);
  const total = (f: number) => bands.reduce((sum, band) => sum + band.response(f), 0);
  const bypassed = Number(values.on ?? 1) === 0;

  const curve = useMemo(() => {
    const points: [number, number][] = [];
    for (let i = 0; i <= POINTS; i++) {
      const f = F_MIN * Math.pow(F_MAX / F_MIN, i / POINTS);
      points.push([f, bands.reduce((sum, band) => sum + band.response(f), 0)]);
    }
    return points;
  }, [bands]);

  // ±15 dB covers every gain the console allows; deeper cuts (filters) are clipped at the floor.
  const range = 18;
  const yOf = (db: number) => PAD.top + ((range - Math.max(-range, Math.min(range, db))) / (2 * range)) * PLOT_H;
  const path = curve.map(([f, db], i) => `${i === 0 ? "M" : "L"}${xOf(f).toFixed(1)},${yOf(db).toFixed(1)}`).join("");
  const area = `${path}L${xOf(F_MAX)},${yOf(0)}L${xOf(F_MIN)},${yOf(0)}Z`;

  const [hoverX, setHoverX] = useState<number | null>(null);
  const hoverF = hoverX === null ? null : fOf(hoverX);
  const hoverDb = hoverF === null ? null : total(hoverF);

  return (
    <figure className={"eq-curve" + (bypassed ? " eq-curve--bypassed" : "")}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`EQ response${bypassed ? " (bypassed)" : ""}: ${bands
          .map((b) => `${b.label} at ${formatHz(b.freq)}`)
          .join(", ")}`}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHoverX(((event.clientX - rect.left) / rect.width) * WIDTH);
        }}
        onPointerLeave={() => setHoverX(null)}
      >
        {GRID_HZ.map((f) => (
          <line key={f} className="eq-curve__grid" x1={xOf(f)} x2={xOf(f)} y1={PAD.top} y2={PAD.top + PLOT_H} />
        ))}
        {[-12, -6, 6, 12].map((db) => (
          <line key={db} className="eq-curve__grid" x1={PAD.left} x2={PAD.left + PLOT_W} y1={yOf(db)} y2={yOf(db)} />
        ))}
        <line className="eq-curve__zero" x1={PAD.left} x2={PAD.left + PLOT_W} y1={yOf(0)} y2={yOf(0)} />
        {[-12, 0, 12].map((db) => (
          <text key={db} className="eq-curve__axis" x={PAD.left - 6} y={yOf(db) + 3} textAnchor="end">
            {db > 0 ? `+${db}` : db}
          </text>
        ))}
        {LABEL_HZ.map(([f, label]) => (
          <text key={f} className="eq-curve__axis" x={xOf(f)} y={HEIGHT - 5} textAnchor="middle">
            {label}
          </text>
        ))}
        <path className="eq-curve__area" d={area} />
        <path className="eq-curve__line" d={path} />
        {bands.map((band) => (
          <circle key={band.label} className="eq-curve__band" cx={xOf(band.freq)} cy={yOf(total(band.freq))} r={4}>
            <title>{`${band.label}: ${formatHz(band.freq)}`}</title>
          </circle>
        ))}
        {hoverX !== null && hoverF !== null && hoverDb !== null && (
          <g className="eq-curve__hover" pointerEvents="none">
            <line x1={xOf(hoverF)} x2={xOf(hoverF)} y1={PAD.top} y2={PAD.top + PLOT_H} />
            <circle cx={xOf(hoverF)} cy={yOf(hoverDb)} r={4} />
          </g>
        )}
      </svg>
      <figcaption>
        {hoverF !== null && hoverDb !== null ? (
          <span className="eq-curve__readout">
            {formatHz(hoverF)} · {hoverDb >= 0 ? "+" : ""}
            {hoverDb.toFixed(1)} dB
          </span>
        ) : (
          <span>{bypassed ? "EQ off — curve shown for reference." : "Approximate response, from the band settings."}</span>
        )}
      </figcaption>
    </figure>
  );
}
