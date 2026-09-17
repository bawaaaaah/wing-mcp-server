/**
 * Pure spectrum/EQ math behind the auto-EQ balance (wing-auto-eq.ts) — no console I/O here, so every
 * step can be unit-tested against known curves.
 */

export const RTA_BAND_COUNT = 120;

/**
 * 1/12-octave bands whose lower edge starts at 20 Hz (120 bands = 10 octaves x 12). The protocol
 * reference doesn't document band frequencies; verified on hardware by sweeping the internal
 * oscillator's sine (31.5 Hz..16 kHz) — each peak landed in exactly the band this predicts.
 */
export function rtaBandCenterHz(index: number): number {
  return 20 * 2 ** ((index + 0.5) / 12);
}

/** ISO 266 nominal third-octave labels, 20 Hz..20 kHz — the 31 bands of the console's GEQ model. */
export const ISO_THIRD_OCTAVE_NOMINAL_HZ: readonly number[] = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

/** Exact base-2 centers (1 kHz * 2^(k/3)) behind the nominal labels above. */
export const ISO_THIRD_OCTAVE_EXACT_HZ: readonly number[] = ISO_THIRD_OCTAVE_NOMINAL_HZ.map((_, i) => 1000 * 2 ** ((i - 17) / 3));

const dbToPower = (db: number): number => 10 ** (db / 10);
const powerToDb = (p: number): number => (p > 0 ? 10 * Math.log10(p) : -Infinity);

/** Accumulates RTA frames and returns their per-band power average in dB. */
export class RtaAverager {
  private readonly sums = new Float64Array(RTA_BAND_COUNT);
  count = 0;

  add(bandsDb: readonly number[]): void {
    if (bandsDb.length !== RTA_BAND_COUNT) return;
    for (let i = 0; i < RTA_BAND_COUNT; i++) {
      const db = bandsDb[i];
      if (Number.isFinite(db)) this.sums[i] += dbToPower(db);
    }
    this.count++;
  }

  averageDb(): number[] {
    return Array.from(this.sums, (sum) => (this.count > 0 ? powerToDb(sum / this.count) : -Infinity));
  }
}

/**
 * Power-sums the RTA bands whose center falls inside each third-octave band's edges (center * 2^±1/6).
 * A third-octave band that no RTA band lands in comes back NaN.
 */
export function rtaToThirdOctaves(bandsDb: readonly number[]): number[] {
  return ISO_THIRD_OCTAVE_EXACT_HZ.map((center) => {
    const lo = center * 2 ** (-1 / 6);
    const hi = center * 2 ** (1 / 6);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < bandsDb.length; i++) {
      const hz = rtaBandCenterHz(i);
      if (hz >= lo && hz < hi && Number.isFinite(bandsDb[i])) {
        sum += dbToPower(bandsDb[i]);
        n++;
      }
    }
    return n > 0 ? powerToDb(sum / n) : NaN;
  });
}

export interface CurvePoint {
  hz: number;
  db: number;
}

/** Linear-in-log-frequency interpolation, holding the end values flat beyond the first/last point. */
export function interpolateCurveDb(points: readonly CurvePoint[], hz: number): number {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => a.hz - b.hz);
  if (hz <= sorted[0].hz) return sorted[0].db;
  const last = sorted[sorted.length - 1];
  if (hz >= last.hz) return last.db;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (hz <= b.hz) {
      const t = Math.log(hz / a.hz) / Math.log(b.hz / a.hz);
      return a.db + t * (b.db - a.db);
    }
  }
  return last.db;
}

/** [1/4 1/2 1/4] smoothing across neighbouring bands; NaN bands stay NaN and are skipped as neighbours. */
export function smoothBands(values: readonly number[]): number[] {
  return values.map((v, i) => {
    if (!Number.isFinite(v)) return NaN;
    let sum = v * 0.5;
    let weight = 0.5;
    for (const j of [i - 1, i + 1]) {
      if (j >= 0 && j < values.length && Number.isFinite(values[j])) {
        sum += values[j] * 0.25;
        weight += 0.25;
      }
    }
    return sum / weight;
  });
}

const SAMPLE_RATE_HZ = 48_000;

function biquadDb(hz: number, b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): number {
  const w = (2 * Math.PI * hz) / SAMPLE_RATE_HZ;
  const mag2 = (c0: number, c1: number, c2: number): number => {
    const re = c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
    const im = -c1 * Math.sin(w) - c2 * Math.sin(2 * w);
    return re * re + im * im;
  };
  return 10 * Math.log10(mag2(b0, b1, b2) / mag2(a0, a1, a2));
}

/** Magnitude response in dB of an RBJ-cookbook peaking EQ at `hz`. */
export function peakingResponseDb(hz: number, centerHz: number, gainDb: number, q: number): number {
  if (gainDb === 0) return 0;
  const a = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * centerHz) / SAMPLE_RATE_HZ;
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);
  return biquadDb(hz, 1 + alpha * a, -2 * cosW0, 1 - alpha * a, 1 + alpha / a, -2 * cosW0, 1 - alpha / a);
}

export type ShelfSide = "low" | "high";

/** RBJ-cookbook shelf. Verified on hardware: the WING's SHV bands reach half their gain at the set frequency. */
export function shelfResponseDb(hz: number, side: ShelfSide, cornerHz: number, gainDb: number, q: number): number {
  if (gainDb === 0) return 0;
  const a = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * cornerHz) / SAMPLE_RATE_HZ;
  const cosW0 = Math.cos(w0);
  const k = 2 * Math.sqrt(a) * (Math.sin(w0) / (2 * q));
  if (side === "low") {
    return biquadDb(
      hz,
      a * (a + 1 - (a - 1) * cosW0 + k),
      2 * a * (a - 1 - (a + 1) * cosW0),
      a * (a + 1 - (a - 1) * cosW0 - k),
      a + 1 + (a - 1) * cosW0 + k,
      -2 * (a - 1 + (a + 1) * cosW0),
      a + 1 + (a - 1) * cosW0 - k,
    );
  }
  return biquadDb(
    hz,
    a * (a + 1 + (a - 1) * cosW0 + k),
    -2 * a * (a - 1 + (a + 1) * cosW0),
    a * (a + 1 + (a - 1) * cosW0 - k),
    a + 1 - (a - 1) * cosW0 + k,
    2 * (a - 1 - (a + 1) * cosW0),
    a + 1 - (a - 1) * cosW0 - k,
  );
}

/** The WING's low/high band cut types (leq/heq values other than PEQ and SHV). */
export const CUT_SLOPES = ["CUT", "BW6", "BW12", "BS12", "LR12", "BW18", "BW24", "BS24", "LR24", "BW48", "LR48"] as const;
export type CutSlope = (typeof CUT_SLOPES)[number];

export function isCutSlope(type: string): type is CutSlope {
  return (CUT_SLOPES as readonly string[]).includes(type);
}

/**
 * Low cut (side "low", a high-pass) or high cut response in dB. Butterworth order n is -10*log10(1 + r^2n);
 * a Linkwitz-Riley of 2n is two Butterworths of n. Bessel is approximated as the Butterworth of the same
 * order. Measured on hardware: BW12 is -3.8 dB at the corner and 12 dB/oct; "CUT" matches LR24.
 */
export function cutResponseDb(hz: number, side: ShelfSide, cornerHz: number, slope: CutSlope): number {
  const r = side === "low" ? cornerHz / hz : hz / cornerHz;
  const bw = (order: number) => -10 * Math.log10(1 + r ** (2 * order));
  switch (slope) {
    case "BW6":
      return bw(1);
    case "BW12":
    case "BS12":
      return bw(2);
    case "LR12":
      return 2 * bw(1);
    case "BW18":
      return bw(3);
    case "BW24":
    case "BS24":
      return bw(4);
    case "LR24":
    case "CUT":
      return 2 * bw(2);
    case "BW48":
      return bw(8);
    case "LR48":
      return 2 * bw(4);
  }
}

export interface PeqBand {
  f: number;
  g: number;
  q: number;
}

/** Q of a peaking band whose half-gain points are `octaves` apart (RBJ bandwidth definition). */
export function qFromBandwidthOctaves(octaves: number): number {
  const r = 2 ** octaves;
  return Math.sqrt(r) / (r - 1);
}

export interface NativeEqShape {
  bells: readonly PeqBand[];
  lowShelf: PeqBand | null;
  highShelf: PeqBand | null;
}

export function nativeEqResponseDb(shape: NativeEqShape, hz: number): number {
  let db = shape.bells.reduce((sum, b) => sum + peakingResponseDb(hz, b.f, b.g, b.q), 0);
  if (shape.lowShelf) db += shelfResponseDb(hz, "low", shape.lowShelf.f, shape.lowShelf.g, shape.lowShelf.q);
  if (shape.highShelf) db += shelfResponseDb(hz, "high", shape.highShelf.f, shape.highShelf.g, shape.highShelf.q);
  return db;
}

export interface NativeEqFitOptions {
  /** Bands that can only be bells (the WING's bands 1-6). */
  bellCount: number;
  /** Whether the L / H band is free (not a cut) to become a shelf or an extra bell. */
  lowBand: boolean;
  highBand: boolean;
  gMin: number;
  gMax: number;
  qMin: number;
  qMax: number;
  fMin: number;
  fMax: number;
  /** Stop once the largest remaining deviation is below this. */
  minGainDb: number;
}

/** Gentle shelf slope (no overshoot bump); the measure-correct loop absorbs any modelling error. */
export const FIT_SHELF_Q = 0.7;
const LOW_SHELF_MAX_HZ = 1000;
const HIGH_SHELF_MIN_HZ = 1000;

/**
 * Greedy fit of the strip's 8-band native EQ (bells 1-6 plus L/H, each a shelf or a bell when not a cut)
 * to `desiredDb` (sampled at `freqsHz`, one per third octave; NaN = don't care). Each step considers the
 * best low shelf, the best high shelf and the best bell — sized from the run of same-signed neighbours
 * above half the largest deviation, so a broad bump gets a wide Q and a narrow peak a tight one — and
 * keeps whichever removes the most squared error, until the deviation is small or no band is left.
 * Returned bells beyond `bellCount` belong on whichever of L/H didn't take a shelf.
 */
export function fitNativeEq(freqsHz: readonly number[], desiredDb: readonly number[], opts: NativeEqFitOptions): NativeEqShape {
  let residual = [...desiredDb];
  const shape: { bells: PeqBand[]; lowShelf: PeqBand | null; highShelf: PeqBand | null } = { bells: [], lowShelf: null, highShelf: null };
  const clampG = (g: number) => Number(Math.min(opts.gMax, Math.max(opts.gMin, g)).toFixed(1));
  const clampF = (f: number) => Math.round(Math.min(opts.fMax, Math.max(opts.fMin, f)));
  const sse = (values: number[]) => values.reduce((sum, v) => (Number.isFinite(v) ? sum + v * v : sum), 0);
  const without = (response: (hz: number) => number) =>
    residual.map((r, i) => (Number.isFinite(r) ? r - response(freqsHz[i]) : r));

  const bestShelf = (side: ShelfSide): { band: PeqBand; next: number[] } | null => {
    let best: { band: PeqBand; next: number[]; err: number } | null = null;
    for (const fc of freqsHz) {
      if (side === "low" ? fc > LOW_SHELF_MAX_HZ : fc < HIGH_SHELF_MIN_HZ) continue;
      let num = 0;
      let den = 0;
      residual.forEach((r, i) => {
        if (!Number.isFinite(r)) return;
        const unit = shelfResponseDb(freqsHz[i], side, fc, 6, FIT_SHELF_Q) / 6;
        num += r * unit;
        den += unit * unit;
      });
      if (den === 0) continue;
      const g = clampG(num / den);
      if (Math.abs(g) < opts.minGainDb) continue;
      const band = { f: clampF(fc), g, q: FIT_SHELF_Q };
      const next = without((hz) => shelfResponseDb(hz, side, band.f, band.g, band.q));
      const err = sse(next);
      if (!best || err < best.err) best = { band, next, err };
    }
    return best;
  };

  const bestBell = (): { band: PeqBand; next: number[] } | null => {
    let peakIdx = -1;
    residual.forEach((r, i) => {
      if (Number.isFinite(r) && (peakIdx < 0 || Math.abs(r) > Math.abs(residual[peakIdx]))) peakIdx = i;
    });
    if (peakIdx < 0) return null;
    const peak = residual[peakIdx];
    const inRun = (i: number) =>
      i >= 0 && i < residual.length && Number.isFinite(residual[i]) && Math.sign(residual[i]) === Math.sign(peak) && Math.abs(residual[i]) >= Math.abs(peak) / 2;
    let lo = peakIdx;
    let hi = peakIdx;
    while (inRun(lo - 1)) lo--;
    while (inRun(hi + 1)) hi++;
    const band: PeqBand = {
      f: clampF(freqsHz[peakIdx]),
      g: clampG(peak),
      q: Number(Math.min(opts.qMax, Math.max(opts.qMin, qFromBandwidthOctaves((hi - lo + 1) / 3))).toFixed(2)),
    };
    return { band, next: without((hz) => peakingResponseDb(hz, band.f, band.g, band.q)) };
  };

  const totalSlots = opts.bellCount + (opts.lowBand ? 1 : 0) + (opts.highBand ? 1 : 0);
  for (;;) {
    const largest = residual.reduce((m, r) => (Number.isFinite(r) ? Math.max(m, Math.abs(r)) : m), 0);
    if (largest < opts.minGainDb) break;
    const slotsLeft = totalSlots - shape.bells.length - (shape.lowShelf ? 1 : 0) - (shape.highShelf ? 1 : 0);
    if (slotsLeft <= 0) break;
    const current = sse(residual);
    const options: Array<{ gain: number; commit: () => void }> = [];
    if (opts.lowBand && !shape.lowShelf) {
      const c = bestShelf("low");
      if (c) options.push({ gain: current - sse(c.next), commit: () => ((shape.lowShelf = c.band), (residual = c.next)) });
    }
    if (opts.highBand && !shape.highShelf) {
      const c = bestShelf("high");
      if (c) options.push({ gain: current - sse(c.next), commit: () => ((shape.highShelf = c.band), (residual = c.next)) });
    }
    {
      const c = bestBell();
      if (c) options.push({ gain: current - sse(c.next), commit: () => (shape.bells.push(c.band), (residual = c.next)) });
    }
    const best = options.sort((a, b) => b.gain - a.gain)[0];
    if (!best || best.gain < opts.minGainDb * opts.minGainDb) break;
    best.commit();
  }
  return shape;
}
