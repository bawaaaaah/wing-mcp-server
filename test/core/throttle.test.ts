import { expect } from "chai";
import { throttleMerge } from "../../src/core/throttle.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Feeds `count` values `periodMs` apart and records every emission with its time. */
async function drive(intervalMs: number, periodMs: number, count: number) {
  const emits: { at: number; batch: number[] }[] = [];
  const push = throttleMerge<number[]>(
    intervalMs,
    (values) => values.flat(),
    (batch) => emits.push({ at: Date.now(), batch }),
  );
  for (let i = 0; i < count; i++) {
    push([i]);
    await delay(periodMs);
  }
  await delay(intervalMs * 2);
  return emits;
}

describe("throttleMerge", () => {
  it("keeps up with a source just faster than its interval instead of halving it", async function () {
    this.timeout(10_000);
    // The console's meter stream: a snapshot every ~48 ms through the 50 ms RTA throttle.
    const emits = await drive(50, 48, 40);
    // The old first-value-opens-the-window behaviour gave ~20 here (two samples per emission).
    expect(emits.length).to.be.at.least(32);
  });

  it("emits at most once per interval", async function () {
    this.timeout(10_000);
    const emits = await drive(100, 10, 60);
    for (let i = 1; i < emits.length; i++) {
      expect(emits[i].at - emits[i - 1].at).to.be.at.least(95);
    }
  });

  it("delivers every value exactly once, in order", async () => {
    const emits = await drive(30, 7, 50);
    expect(emits.flatMap((e) => e.batch)).to.deep.equal(Array.from({ length: 50 }, (_, i) => i));
  });

  it("emits a value at once when the previous emission is a full interval old", () => {
    const emitted: number[] = [];
    const push = throttleMerge<number>(1000, (values) => values[values.length - 1], (v) => emitted.push(v));
    push(1);
    expect(emitted).to.deep.equal([1]);
  });

  it("keeps working after a consumer throws", async () => {
    let calls = 0;
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const push = throttleMerge<number>(
        10,
        (values) => values[0],
        () => {
          calls += 1;
          throw new Error("consumer failed");
        },
      );
      expect(() => push(1)).to.not.throw();
      await delay(20);
      push(2);
      await delay(20);
    } finally {
      console.error = originalError;
    }
    expect(calls).to.equal(2);
  });
});
