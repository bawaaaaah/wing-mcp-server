/**
 * Trailing-edge coalescer: calling the returned function repeatedly schedules onEmit(batch) at most
 * once per intervalMs, folding every value received during the window into one via `merge` — use
 * this where dropping intermediate values loses real information a single "latest" sample can't
 * recover — e.g. a fast transient (a compressor's gain-reduction meter dipping for a few ms) that
 * comes and goes between two `intervalMs` boundaries: publishing only the latest value at the tick
 * would very likely miss the transient entirely, whereas `merge` can fold every sample in the window
 * into one (e.g. keep the deepest dip).
 */
export function throttleMerge<T>(intervalMs: number, merge: (values: T[]) => T, onEmit: (v: T) => void): (v: T) => void {
  let timer: NodeJS.Timeout | undefined;
  let pending: T[] = [];

  return (value: T) => {
    pending.push(value);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const batch = pending;
      pending = [];
      onEmit(merge(batch));
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  };
}
