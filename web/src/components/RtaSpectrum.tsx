import { useEffect, useRef, type JSX, type MutableRefObject } from "react";
import type { RtaFrame } from "../api/useLive.js";

interface RtaSpectrumProps {
  /** Updated ~20 times a second by useRta(); read here once per animation frame. */
  frameRef: MutableRefObject<RtaFrame | null>;
  min?: number;
  max?: number;
}

/**
 * The console's protocol reference gives the RTA's band count (120) but not each band's center
 * frequency, so bands are rendered in raw wire order (ascending frequency, unlabeled) rather than
 * with Hz ticks — labeling them would mean guessing a frequency mapping never confirmed against
 * hardware.
 *
 * Drawn on a canvas from requestAnimationFrame, not as 120 elements re-rendered by React: the
 * spectrum moves 20 times a second, and only the pixels need to.
 */
export function RtaSpectrum({ frameRef, min = -80, max = 0 }: RtaSpectrumProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let raf = 0;
    let drawnAt: number | undefined;
    let width = 0;
    let height = 0;
    let color = "";

    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      color = getComputedStyle(canvas).color;
      drawnAt = undefined;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const frame = frameRef.current;
      // Nothing new since the last paint: leave the pixels alone.
      if (!frame || frame.receivedAt === drawnAt) return;
      drawnAt = frame.receivedAt;

      const bands = frame.bandsDb;
      const gap = 1;
      const barWidth = Math.max(1, (width - gap * (bands.length - 1)) / bands.length);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      for (let i = 0; i < bands.length; i++) {
        const db = Number.isFinite(bands[i]) ? bands[i] : min;
        const fraction = (Math.min(max, Math.max(min, db)) - min) / (max - min);
        const barHeight = fraction * height;
        ctx.fillRect(i * (barWidth + gap), height - barHeight, barWidth, barHeight);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [frameRef, min, max]);

  return (
    <div className="rta-spectrum">
      <canvas ref={canvasRef} className="rta-spectrum__canvas" />
    </div>
  );
}
