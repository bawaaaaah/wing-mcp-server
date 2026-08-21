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
