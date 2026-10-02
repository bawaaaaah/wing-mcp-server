/**
 * Lets a live-data producer tell a canvas it has something new to paint, so the canvas asks for an
 * animation frame only when there is — instead of a requestAnimationFrame loop that wakes the
 * page's whole frame pipeline on every vsync (60-120 times a second) to find nothing changed most
 * of the time. One listener: the canvas that draws the data.
 */
export class PaintSignal {
  private listener: (() => void) | undefined;

  notify(): void {
    this.listener?.();
  }

  listen(listener: () => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }
}

/** Coalesces notifications into at most one paint per animation frame. */
export function schedulePaints(paint: () => void): { request: () => void; cancel: () => void } {
  let raf = 0;
  return {
    request() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint();
      });
    },
    cancel() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
