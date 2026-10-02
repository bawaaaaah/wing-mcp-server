import { useEffect, useRef, type JSX } from "react";
import { PaintSignal, schedulePaints } from "./paint-signal.js";

export interface MeterGridEntry {
  label: string;
  db: number;
}

/**
 * What MeterGrid draws, written by the live-data handler without any React state: `set` each
 * reading, then `commit` once per meter frame to have the canvas paint it.
 */
export class MeterGridStore {
  /** key → reading, in display order. */
  entries = new Map<string, MeterGridEntry>();
  /** Bumped when keys or labels change: only then is the static layer (labels, tracks) redrawn. */
  layoutVersion = 0;
  readonly signal = new PaintSignal();
  private added = false;

  set(key: string, label: string, db: number): void {
    const entry = this.entries.get(key);
    if (!entry) {
      this.entries.set(key, { label, db });
      this.added = true;
      this.layoutVersion += 1;
      return;
    }
    if (entry.label !== label) {
      entry.label = label;
      this.layoutVersion += 1;
    }
    entry.db = db;
  }

  /** `order` sorts the keys whenever new ones arrived. */
  commit(order: (a: string, b: string) => number): void {
    if (this.added) {
      this.entries = new Map([...this.entries].sort(([a], [b]) => order(a, b)));
      this.added = false;
    }
    this.signal.notify();
  }
}

interface MeterGridProps {
  store: MeterGridStore;
  min?: number;
  max?: number;
  /** dB level where the fixed color scale switches from green to orange. */
  orangeAt?: number;
  /** dB level where the fixed color scale switches from orange to red. */
  redAt?: number;
}

// Cell geometry, in CSS pixels — the same footprint as MeterBar's 3rem-wide column with an 8rem
// track, so the Meters tab keeps its look.
const CELL_WIDTH = 48;
const GAP_X = 16;
const GAP_Y = 16;
const TRACK_WIDTH = 18;
const TRACK_HEIGHT = 128;
const LABEL_HEIGHT = 16;
const VALUE_HEIGHT = 14;
const TRACK_TOP = LABEL_HEIGHT + 6;
const VALUE_TOP = TRACK_TOP + TRACK_HEIGHT + 6;
const CELL_HEIGHT = VALUE_TOP + VALUE_HEIGHT;

const GREEN = "#3aa657";
const ORANGE = "#d69e2e";
const RED = "#e05252";

/**
 * Every level meter of the Meters tab drawn on one canvas, instead of ~90 MeterBar elements
 * re-rendered by React on every meter frame (a reconciliation, a style recalc and a layout of the
 * whole grid, ten times a second). Painted only when the store commits a frame. The labels and
 * empty tracks sit on an offscreen layer redrawn only when a name changes; a frame copies it and
 * draws the fills and values on top. The color scale is fixed to the track's min..max (green,
 * orange from orangeAt, red from redAt), exactly like MeterBar, so a given height is always the
 * same color.
 */
export function MeterGrid({ store, min = -60, max = 6, orangeAt = -18, redAt = -3 }: MeterGridProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const layer = document.createElement("canvas");
    const layerCtx = layer.getContext("2d");
    if (!canvas || !ctx || !layerCtx) return;

    let ratio = 1;
    let width = 0;
    let columns = 1;
    let rows = 0;
    let layerVersion = -1;
    let textColor = "";
    let borderColor = "";
    let font = "";
    let gradient: CanvasGradient | null = null;

    const fraction = (db: number): number => Math.min(1, Math.max(0, (db - min) / (max - min)));
    const cellOrigin = (i: number): [number, number] => [(i % columns) * (CELL_WIDTH + GAP_X), Math.floor(i / columns) * (CELL_HEIGHT + GAP_Y)];

    /** Height follows the number of rows; changing it is the only thing here that causes a layout. */
    const fitRows = (count: number): void => {
      const needed = Math.max(1, Math.ceil(count / columns));
      if (needed === rows) return;
      rows = needed;
      const height = rows * CELL_HEIGHT + (rows - 1) * GAP_Y;
      canvas.style.height = height + "px";
      for (const [c, c2d] of [
        [canvas, ctx],
        [layer, layerCtx],
      ] as const) {
        c.width = Math.round(width * ratio);
        c.height = Math.round(height * ratio);
        c2d.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      layerVersion = -1;
    };

    /** Labels and empty tracks. */
    const drawLayer = (): void => {
      layerVersion = store.layoutVersion;
      layerCtx.clearRect(0, 0, layer.width, layer.height);
      layerCtx.font = font;
      layerCtx.textAlign = "center";
      layerCtx.textBaseline = "middle";
      layerCtx.fillStyle = textColor;
      layerCtx.strokeStyle = borderColor;
      let i = 0;
      for (const entry of store.entries.values()) {
        const [x, y] = cellOrigin(i++);
        const trackX = x + (CELL_WIDTH - TRACK_WIDTH) / 2;
        layerCtx.fillText(fitText(layerCtx, entry.label, CELL_WIDTH), x + CELL_WIDTH / 2, y + LABEL_HEIGHT / 2);
        layerCtx.fillStyle = "rgba(127, 127, 127, 0.15)";
        layerCtx.fillRect(trackX, y + TRACK_TOP, TRACK_WIDTH, TRACK_HEIGHT);
        layerCtx.fillStyle = textColor;
        layerCtx.strokeRect(trackX + 0.5, y + TRACK_TOP + 0.5, TRACK_WIDTH - 1, TRACK_HEIGHT - 1);
      }
    };

    const paint = (): void => {
      const entries = store.entries;
      fitRows(entries.size);
      if (layerVersion !== store.layoutVersion) drawLayer();

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(layer, 0, 0);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = textColor;
      ctx.globalAlpha = 0.8;
      let i = 0;
      for (const entry of entries.values()) {
        const [x, y] = cellOrigin(i++);
        const db = Number.isFinite(entry.db) ? entry.db : -144;
        const fill = Math.round(fraction(db) * (TRACK_HEIGHT - 2));
        if (fill > 0 && gradient) {
          // The gradient is anchored to the track (y = 0 at its top), so translate into it.
          const trackX = x + (CELL_WIDTH - TRACK_WIDTH) / 2;
          ctx.globalAlpha = 1;
          ctx.translate(trackX, y + TRACK_TOP);
          ctx.fillStyle = gradient;
          ctx.fillRect(1, TRACK_HEIGHT - 1 - fill, TRACK_WIDTH - 2, fill);
          ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
          ctx.fillStyle = textColor;
          ctx.globalAlpha = 0.8;
        }
        ctx.fillText(db <= -144 ? "-inf" : db.toFixed(1), x + CELL_WIDTH / 2, y + VALUE_TOP + VALUE_HEIGHT / 2);
      }
      ctx.globalAlpha = 1;
    };
    const paints = schedulePaints(paint);

    const resize = (): void => {
      ratio = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      columns = Math.max(1, Math.floor((width + GAP_X) / (CELL_WIDTH + GAP_X)));
      const style = getComputedStyle(canvas);
      textColor = style.color;
      borderColor = style.getPropertyValue("--border-color").trim() || "#3a3a3a";
      font = `${style.fontWeight} 12px ${style.fontFamily}`;
      // Hard stops anchored to the track, not to the fill: see the doc comment above.
      gradient = ctx.createLinearGradient(0, TRACK_HEIGHT, 0, 0);
      const o = fraction(orangeAt);
      const r = fraction(redAt);
      gradient.addColorStop(0, GREEN);
      gradient.addColorStop(o, GREEN);
      gradient.addColorStop(o, ORANGE);
      gradient.addColorStop(r, ORANGE);
      gradient.addColorStop(r, RED);
      gradient.addColorStop(1, RED);
      rows = 0;
      paints.request();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    const unlisten = store.signal.listen(paints.request);

    return () => {
      unlisten();
      paints.cancel();
      observer.disconnect();
    };
  }, [store, min, max, orangeAt, redAt]);

  return <canvas ref={canvasRef} className="meter-grid-canvas" role="img" aria-label="Level meters" />;
}

/** Truncates with an ellipsis to fit `maxWidth`, like the old label's text-overflow. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(text.slice(0, end) + "…").width > maxWidth) end -= 1;
  return text.slice(0, end) + "…";
}
