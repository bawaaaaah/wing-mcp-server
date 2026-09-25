import { WingTimeoutError } from "./wing-errors.js";

/**
 * How many reads a single REST request may have in the OSC queue at once.
 *
 * Every request to the console funnels through one FIFO queue of at most 100 entries
 * (wing-osc-client.ts). `/mixer-state` used to enqueue its ~100 dumps in one go: with a single
 * heartbeat already in flight the last dump overflowed and a strip silently vanished from the
 * dashboard, and for the whole load every MCP tool call and every heartbeat was refused with "queue
 * is full" — the heartbeat failure then read as the console going away and dropped the state cache.
 * Keeping a few reads in flight is just as fast (the queue serializes them anyway) and leaves room.
 */
export const ROUTE_READ_CONCURRENCY = 8;

export interface BoundedReads {
  /** Runs `task` once fewer than the limit are in flight. Rejects without running once the budget ran out. */
  run<R>(task: () => Promise<R>): Promise<R>;
  /** `work`'s result, or "timeout" after the budget — at which point reads not yet started never start. */
  within<T>(work: Promise<T>): Promise<T | "timeout">;
}

/**
 * A per-request limiter and deadline for a burst of console reads. Unlike a bare `Promise.race`
 * against a timer, running out of budget also stops the reads that had not started yet, instead
 * of leaving them to occupy the queue for a response nobody is waiting for any more.
 */
export function boundedReads(budgetMs: number, concurrency = ROUTE_READ_CONCURRENCY): BoundedReads {
  let active = 0;
  let expired = false;
  const waiting: Array<{ start: () => void; cancel: (err: Error) => void }> = [];

  const next = (): void => {
    while (!expired && active < concurrency && waiting.length > 0) {
      waiting.shift()?.start();
    }
  };

  return {
    run<R>(task: () => Promise<R>): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        const start = (): void => {
          active += 1;
          task().then(resolve, reject).finally(() => {
            active -= 1;
            next();
          });
        };
        waiting.push({ start, cancel: reject });
        next();
      });
    },

    async within<T>(work: Promise<T>): Promise<T | "timeout"> {
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), budgetMs);
        timer.unref?.();
      });
      // Whatever `work` does after the deadline must not surface as an unhandled rejection.
      work.catch(() => undefined);
      const result = await Promise.race([work, budget]);
      clearTimeout(timer);
      if (result === "timeout") {
        expired = true;
        for (const pending of waiting.splice(0)) {
          pending.cancel(new WingTimeoutError("The request ran out of time before this read started"));
        }
      }
      return result;
    },
  };
}
