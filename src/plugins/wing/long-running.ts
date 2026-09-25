// Shared plumbing for the tools that drive the console over seconds or minutes rather than a
// single round trip: auto-compress, auto-EQ, auto-gate, auto-gain and meter-stats.
//
// Three of those accept parameters that let a single call run far past the point where any MCP
// client is still listening. The SDK's own client gives up after DEFAULT_REQUEST_TIMEOUT_MSEC
// (60s) — and crucially it only extends that on progress notifications when the *caller* asked for
// it, since `resetTimeoutOnProgress` defaults to false. So emitting progress helps some clients and
// no others, and cannot be the whole answer: past the timeout the client abandons the call while
// this server carries on writing to a live console, which on a show is the part that matters.
//
// Hence two mechanisms here. `assertWithinCallBudget` refuses, up front and with an actionable
// message, a request that cannot finish in time — that one works for every client. `throwIfAborted`
// makes a cancellation actually stop the work rather than letting it run to completion unheard.

import { WingCancelledError, WingValueError } from "./wing-errors.js";

/** The MCP SDK client's default per-request timeout (`shared/protocol.js`). */
export const MCP_DEFAULT_CLIENT_TIMEOUT_MS = 60_000;

/**
 * What a single tool call may plan to spend. Deliberately well under the client timeout: the
 * estimate covers the sampling windows this server controls, not the console's own latency, the
 * OSC round trips around them or the transport.
 */
export const LONG_TOOL_BUDGET_MS = 45_000;

const seconds = (ms: number): string => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);

/**
 * Rejects a request whose own parameters put it past the budget, before a single value is written.
 *
 * `howToShorten` is not decoration: the caller is usually a model that picked these numbers from
 * the schema's stated maximums, so the error has to say which knob to turn back rather than just
 * refusing.
 */
export function assertWithinCallBudget(opts: { estimateMs: number; what: string; howToShorten: string }): void {
  if (opts.estimateMs <= LONG_TOOL_BUDGET_MS) {
    return;
  }
  throw new WingValueError(
    `${opts.what} would take about ${seconds(opts.estimateMs)}s, beyond the ~${seconds(LONG_TOOL_BUDGET_MS)}s a ` +
      `single tool call can safely take. MCP clients abandon a call after ${seconds(MCP_DEFAULT_CLIENT_TIMEOUT_MS)}s ` +
      "by default, and this server would keep driving the console after they stopped listening. " +
      `${opts.howToShorten}`,
  );
}

/**
 * Checked between rounds and around each sampling window. Without it, `notifications/cancelled`
 * aborts the SDK's request but the handler carries on measuring and writing — so a cancelled
 * auto-compress keeps moving a live desk for minutes.
 */
export function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted) {
    throw new WingCancelledError(what);
  }
}

/** Reports how far along a long run is. Mapped onto MCP progress notifications by the tool layer. */
export type ProgressReporter = (update: { progress: number; total: number; message?: string }) => void;

/** The part of the SDK's tool-handler `extra` this layer uses. */
export interface ToolProgressContext {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

/**
 * Turns a tool call's `extra` into a progress reporter, or `undefined` when the caller did not ask
 * for progress — the MCP spec only allows progress notifications for a request that supplied a
 * `progressToken`, so sending them unasked would be protocol noise.
 *
 * Failures are swallowed: a progress update that cannot be delivered (the stream already closed
 * because the client gave up) must not take down the operation reporting it.
 */
export function progressReporterFor(extra: ToolProgressContext): ProgressReporter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return undefined;
  }
  return (update) => {
    void extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, ...update } })
      .catch(() => undefined);
  };
}

/**
 * An interruptible sleep: resolves after `ms`, or rejects as soon as the caller cancels.
 *
 * A plain `setTimeout` would hold a cancelled call for the rest of its sampling window — up to 20
 * seconds of a desk being driven by a request nobody is waiting for any more.
 */
export function abortableDelay(ms: number, signal: AbortSignal | undefined, what: string): Promise<void> {
  throwIfAborted(signal, what);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new WingCancelledError(what));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
