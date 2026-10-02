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
 * Drawn on a canvas, not as 120 elements re-rendered by React: the spectrum moves 20 times a
 * second, and only the pixels need to. One animation frame is requested per new spectrum, rather
 * than a loop on every vsync.
 */
export function RtaSpectrum({ frameRef, signal, min = -80, max = 0 }: RtaSpectrumProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let color = "";

    const draw = (): void => {
      const frame = frameRef.current;
      if (!frame) return;
      const bands = frame.bandsDb;
      const gap = 1;
      const barWidth = Math.max(1, (width - gap * (bands.length - 1)) / bands.length);
      ctx.clearRect(0, 0, width, height);
      // One path, one fill: a single draw call for all 120 bars.
      ctx.beginPath();
      for (let i = 0; i < bands.length; i++) {
        const db = Number.isFinite(bands[i]) ? bands[i] : min;
        const fraction = (Math.min(max, Math.max(min, db)) - min) / (max - min);
        const barHeight = fraction * height;
        ctx.rect(i * (barWidth + gap), height - barHeight, barWidth, barHeight);
      }
      ctx.fillStyle = color;
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
      color = getComputedStyle(canvas).color;
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
