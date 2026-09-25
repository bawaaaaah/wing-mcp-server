// Unit cover for the shared plumbing behind the long-running automation tools. The end-to-end
// behaviour is exercised in wing-plugin-tools.test.ts; this pins the parts a passing integration
// test would not notice — chiefly that a cancelled wait releases its timer rather than leaving one
// armed for the rest of a 45-second window.

import { expect } from "chai";
import { WingCancelledError, WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import {
  abortableDelay,
  assertWithinCallBudget,
  LONG_TOOL_BUDGET_MS,
  progressReporterFor,
  throwIfAborted,
} from "../../../src/plugins/wing/long-running.js";

describe("assertWithinCallBudget", () => {
  it("passes anything inside the budget", () => {
    expect(() =>
      assertWithinCallBudget({ estimateMs: LONG_TOOL_BUDGET_MS, what: "A run", howToShorten: "n/a" }),
    ).to.not.throw();
  });

  it("refuses a run past the budget, and says which knob to turn back", () => {
    let error: unknown;
    try {
      assertWithinCallBudget({
        estimateMs: LONG_TOOL_BUDGET_MS + 1,
        what: "Auto-compress on channel 3",
        howToShorten: "Lower maxIterations or sampleMs.",
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(WingValueError);
    const message = (error as Error).message;
    expect(message).to.include("Auto-compress on channel 3");
    // The caller is usually a model that read these numbers off the schema's own maximums, so a
    // bare refusal would leave it with nothing to do differently.
    expect(message).to.include("Lower maxIterations or sampleMs.");
  });
});

describe("throwIfAborted", () => {
  it("does nothing without a signal, or with one that has not fired", () => {
    expect(() => throwIfAborted(undefined, "A run")).to.not.throw();
    expect(() => throwIfAborted(new AbortController().signal, "A run")).to.not.throw();
  });

  it("throws a cancellation naming the operation once the signal fires", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal, "Auto-EQ")).to.throw(WingCancelledError, /Auto-EQ/);
  });
});

describe("abortableDelay", () => {
  it("resolves normally when nothing cancels it", async () => {
    const start = Date.now();
    await abortableDelay(30, new AbortController().signal, "A run");
    expect(Date.now() - start).to.be.at.least(25);
  });

  it("rejects immediately when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    let error: unknown;
    try {
      await abortableDelay(5000, controller.signal, "A run");
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(WingCancelledError);
    expect(Date.now() - start).to.be.lessThan(100);
  });

  it("rejects as soon as the signal fires mid-wait", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const waiting = abortableDelay(5000, controller.signal, "A run");
    setTimeout(() => controller.abort(), 20);

    let error: unknown;
    await waiting.catch((err) => {
      error = err;
    });
    expect(error).to.be.instanceOf(WingCancelledError);
    expect(Date.now() - start, "it must not serve out the rest of the window").to.be.lessThan(1000);
  });

  it("clears its timer on cancellation rather than leaving one armed", async () => {
    // A leaked timer would hold the event loop open for the rest of the window — up to 45s per
    // cancelled call. Asserted through the handle's own state rather than by waiting it out.
    const controller = new AbortController();
    const armed: NodeJS.Timeout[] = [];
    const realSetTimeout = global.setTimeout;
    (global as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const timer = realSetTimeout(fn, ms, ...(rest as []));
      armed.push(timer);
      return timer;
    }) as typeof setTimeout;
    try {
      const waiting = abortableDelay(5000, controller.signal, "A run");
      controller.abort();
      await waiting.catch(() => undefined);
    } finally {
      global.setTimeout = realSetTimeout;
    }
    expect(armed).to.have.lengthOf(1);
    // Node marks a cleared timeout by dropping its internal callback.
    expect((armed[0] as unknown as { _destroyed?: boolean })._destroyed, "the timer must be cleared").to.equal(true);
  });
});

describe("progressReporterFor", () => {
  it("returns nothing when the caller did not ask for progress", () => {
    // The spec only allows progress notifications for a request that supplied a progressToken;
    // sending them unasked would be protocol noise.
    expect(progressReporterFor({ sendNotification: async () => undefined })).to.equal(undefined);
  });

  it("reports against the caller's token", () => {
    const sent: unknown[] = [];
    const report = progressReporterFor({
      _meta: { progressToken: "tok-1" },
      sendNotification: async (notification) => {
        sent.push(notification);
      },
    });
    expect(report).to.be.a("function");
    report?.({ progress: 2, total: 5, message: "round 3 of 5" });
    expect(sent).to.deep.equal([
      {
        method: "notifications/progress",
        params: { progressToken: "tok-1", progress: 2, total: 5, message: "round 3 of 5" },
      },
    ]);
  });

  it("swallows a delivery failure rather than taking down the run reporting it", () => {
    const report = progressReporterFor({
      _meta: { progressToken: 7 },
      sendNotification: async () => {
        throw new Error("stream already closed");
      },
    });
    expect(() => report?.({ progress: 1, total: 2 })).to.not.throw();
  });
});
