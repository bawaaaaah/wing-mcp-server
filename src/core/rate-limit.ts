import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * A fixed-window per-IP request limiter.
 *
 * Deliberately hand-rolled rather than pulling in express-rate-limit: the whole of it is the forty
 * lines below, and this server's reason for wanting a limiter at all is that it may be exposed to
 * the internet — which is also the worst moment to widen the production dependency surface.
 *
 * Fixed windows let through up to 2x `max` across a window boundary. That is fine for what this
 * defends against: slowing down online guessing of the bearer token, not metering an API. For the
 * same reason it charges responses rather than requests — see `countResponse`.
 *
 * Note this is per source IP, so it does not stop a distributed attempt. It is one layer, and the
 * reason the generated default token is 192 bits of randomness rather than something memorable.
 */
export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /**
   * Which responses count against the budget, inspected once the response is finished. Defaults to
   * all of them.
   *
   * The caller passes a failed-authentication predicate, which is what makes this safe to mount
   * app-wide: the threat is unlimited online guessing of the bearer token, not volume. Counting
   * every request instead would throttle a dashboard mid-show — meter polling, a fader drag, the
   * SPA's own asset loads — to defend against something none of those are.
   */
  countResponse?: (res: Response) => boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Above this many tracked IPs the oldest windows are dropped, so a spray of source addresses
 * cannot turn the limiter itself into the memory leak. */
const MAX_TRACKED_CLIENTS = 10_000;

export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();

  const sweep = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    if (buckets.size <= MAX_TRACKED_CLIENTS) return;
    // Map preserves insertion order, so the front is the least recently created window.
    const excess = buckets.size - MAX_TRACKED_CLIENTS;
    let dropped = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++dropped >= excess) break;
    }
  };

  const countResponse = options.countResponse ?? ((): boolean => true);

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      sweep(now);
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    if (bucket.count >= options.max) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "Too many failed attempts; try again later" });
      return;
    }

    // Charged on the way out, not the way in, so the predicate can see the outcome.
    const spent = bucket;
    res.once("finish", () => {
      if (countResponse(res)) spent.count += 1;
    });
    next();
  };
}
