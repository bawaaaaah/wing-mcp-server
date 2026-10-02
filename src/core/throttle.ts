/**
 * Coalescer: calling the returned function repeatedly calls onEmit(batch) at most once per
 * intervalMs, folding every value received since the previous emission into one via `merge` — use
 * this where dropping intermediate values loses real information a single "latest" sample can't
 * recover — e.g. a fast transient (a compressor's gain-reduction meter dipping for a few ms) that
 * comes and goes between two `intervalMs` boundaries: publishing only the latest value at the tick
 * would very likely miss the transient entirely, whereas `merge` can fold every sample in the window
 * into one (e.g. keep the deepest dip).
 *
 * Paced from the previous emission, not from the first value after it: a value arriving once a
 * full interval has passed goes out at once, and one arriving sooner waits only for the rest of
 * that interval. The first version opened a fresh window on the first value after each emission,
 * so a source just faster than the interval was halved — the console's 20 Hz meter stream (a
 * snapshot every ~48 ms) came out at ~10 Hz through a 50 ms throttle and ~7 Hz through a 100 ms
 * one, measured on hardware.
 */
export function throttleMerge<T>(
  intervalMs: number,
  merge: (values: T[]) => T,
  onEmit: (v: T) => void,
  now: () => number = Date.now,
): (v: T) => void {
  let timer: NodeJS.Timeout | undefined;
  let pending: T[] = [];
  let lastEmitAt = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    timer = undefined;
    const batch = pending;
    pending = [];
    lastEmitAt = now();
    try {
      onEmit(merge(batch));
    } catch (err) {
      // Runs on the caller's stack (a meter packet handler) or on a timer: either way, a failing
      // consumer must not take the producer down with it.
      console.error("throttleMerge: emitting failed:", err);
    }
  };

  return (value: T) => {
    pending.push(value);
    if (timer) return;
    const wait = lastEmitAt + intervalMs - now();
    if (wait <= 0) {
      flush();
      return;
    }
    timer = setTimeout(flush, wait);
    if (typeof timer.unref === "function") timer.unref();
  };
}
