// Trailing-edge coalescer: calling the returned function repeatedly schedules
// onEmit(latestValue) at most once per intervalMs, always with the most
// recently passed value.
export function throttleLatest<T>(intervalMs: number, onEmit: (v: T) => void): (v: T) => void {
  let timer: NodeJS.Timeout | undefined;
  let latest: T;

  return (value: T) => {
    latest = value;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      onEmit(latest);
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  };
}

/**
 * Trailing-edge coalescer like `throttleLatest`, but instead of discarding every value except the
 * most recent one, it hands the *entire* batch of values received during the window to `merge` and
 * emits its result. Use this where dropping intermediate values loses real information a single
 * "latest" sample can't recover — e.g. a fast transient (a compressor's gain-reduction meter dipping
 * for a few ms) that comes and goes between two `intervalMs` boundaries: `throttleLatest` would very
 * likely publish whatever the signal happened to be doing exactly at the tick, missing the transient
 * entirely, whereas `merge` can fold every sample in the window into one (e.g. keep the deepest dip).
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
