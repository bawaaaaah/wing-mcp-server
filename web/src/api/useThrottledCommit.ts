import { useCallback, useEffect, useRef } from "react";

/**
 * Leading+trailing throttle for a single control's writes: the first call in a burst fires
 * immediately, and any further calls within `delayMs` are coalesced into one trailing call
 * carrying only the latest value. Used to keep fader/pan drag events (which fire on every pixel
 * of movement) from flooding the WING OSC client's single in-flight request queue — without this,
 * a fast drag would queue dozens of stale writes that keep "catching up" well after the user has
 * released the control.
 */
export function useThrottledCommit<T>(delayMs: number, commit: (value: T) => void): (value: T) => void {
  const lastSentAtRef = useRef(0);
  const pendingRef = useRef<T | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return useCallback(
    (value: T) => {
      pendingRef.current = value;
      const now = Date.now();
      const elapsed = now - lastSentAtRef.current;

      if (elapsed >= delayMs) {
        lastSentAtRef.current = now;
        pendingRef.current = undefined;
        commitRef.current(value);
        return;
      }

      if (timerRef.current === undefined) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = undefined;
          if (pendingRef.current !== undefined) {
            lastSentAtRef.current = Date.now();
            const latest = pendingRef.current;
            pendingRef.current = undefined;
            commitRef.current(latest);
          }
        }, delayMs - elapsed);
      }
    },
    [delayMs],
  );
}
