import { useEffect, useRef, type JSX, type MutableRefObject } from "react";
import type { RtaFrame } from "../api/useLive.js";
import { schedulePaints, type PaintSignal } from "./paint-signal.js";

interface RtaSpectrumProps {
  /** Updated ~20 times a second by useRta(), which then notifies `signal`. */
  frameRef: MutableRefObject<RtaFrame | null>;
  signal: PaintSignal;
  min?: number;
  max?: number;
}

/**
 * The console's protocol reference gives the RTA's band count (120) but not each band's center
 * frequency, so bands are rendered in raw wire order (ascending frequency, unlabeled) rather than
 * with Hz ticks — labeling them would mean guessing a frequency mapping never confirmed against
 * hardware.
 *
 * A dB grid sits behind the bars, and each band keeps a falling peak marker so short transients stay
 * readable at 20 frames a second.
 *
 * Drawn on a canvas, not as 120 elements re-rendered by React: the spectrum moves 20 times a
 * second, and only the pixels need to. One animation frame is requested per new spectrum, rather
 * than a loop on every vsync.
 */
/** dB lines drawn behind the spectrum. */
const GRID_STEP_DB = 20;
/** Room on the left for the grid's dB labels. */
const LABEL_GUTTER = 26;
/** How fast a band's peak marker falls back once the band drops below it. */
const PEAK_FALL_DB_PER_S = 18;

export function RtaSpectrum({ frameRef, signal, min = -80, max = 0 }: RtaSpectrumProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let color = "";
    let gridColor = "";
    let labelColor = "";
    let font = "";
    let peaks: number[] = [];
    let lastDraw = 0;

    const yOf = (db: number): number => height - ((Math.min(max, Math.max(min, db)) - min) / (max - min)) * height;

    const draw = (): void => {
      const frame = frameRef.current;
      if (!frame) return;
      const bands = frame.bandsDb;
      const now = performance.now();
      const fall = lastDraw ? ((now - lastDraw) / 1000) * PEAK_FALL_DB_PER_S : 0;
      lastDraw = now;
      if (peaks.length !== bands.length) peaks = Array.from({ length: bands.length }, () => min);

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = gridColor;
      ctx.font = font;
      ctx.textBaseline = "middle";
      for (let db = max - GRID_STEP_DB; db > min; db -= GRID_STEP_DB) {
        const y = Math.round(yOf(db)) + 0.5;
        ctx.fillRect(LABEL_GUTTER, y, width - LABEL_GUTTER, 1);
      }
      ctx.fillStyle = labelColor;
      for (let db = max - GRID_STEP_DB; db > min; db -= GRID_STEP_DB) ctx.fillText(String(db), 2, yOf(db));

      const plotWidth = width - LABEL_GUTTER;
      const gap = 1;
      const barWidth = Math.max(1, (plotWidth - gap * (bands.length - 1)) / bands.length);
      // One path, one fill: a single draw call for all 120 bars, and another for their peaks.
      ctx.beginPath();
      for (let i = 0; i < bands.length; i++) {
        const db = Number.isFinite(bands[i]) ? bands[i] : min;
        const y = yOf(db);
        ctx.rect(LABEL_GUTTER + i * (barWidth + gap), y, barWidth, height - y);
        peaks[i] = Math.max(db, peaks[i] - fall);
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let i = 0; i < bands.length; i++) {
        if (peaks[i] <= min) continue;
        ctx.rect(LABEL_GUTTER + i * (barWidth + gap), yOf(peaks[i]) - 1, barWidth, 2);
      }
      ctx.fill();
    };
    const paints = schedulePaints(draw);

    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const style = getComputedStyle(canvas);
      color = style.color;
      gridColor = style.getPropertyValue("--border-color").trim() || "rgba(128,128,128,0.3)";
      labelColor = style.getPropertyValue("--text-muted").trim() || color;
      font = `10px ${style.fontFamily}`;
      paints.request();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    const unlisten = signal.listen(paints.request);

    return () => {
      unlisten();
      paints.cancel();
      observer.disconnect();
    };
  }, [frameRef, signal, min, max]);

  return (
    <div className="rta-spectrum">
      <canvas ref={canvasRef} className="rta-spectrum__canvas" />
    </div>
  );
}
