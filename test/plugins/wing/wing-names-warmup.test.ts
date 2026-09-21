// warmNames() used to issue every name read in a single tick via Promise.all. The categories
// total exactly 100 entries and WingOscClient's request queue holds exactly 100, so a cold warm-up
// filled the queue to its limit and enqueue() — which rejects rather than blocks — turned away
// every concurrent caller: any MCP tool call, any dashboard route, the 7s heartbeat. This pins the
// concurrency bound that fixes it.
//
// Driven through a stub context rather than a real client, because the invariant under test is how
// many reads are in flight at once, which is exactly what a stub can observe and a real socket
// cannot.

import { expect } from "chai";
import { WingQueueOverflowError } from "../../../src/plugins/wing/wing-errors.js";
import { warmNames } from "../../../src/plugins/wing/tools/names.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

/** Total of the seven name categories: 40 + 8 + 16 + 4 + 8 + 16 + 8. */
const TOTAL_NAMED_ENTRIES = 100;

interface StubResult {
  paths: string[];
  peakConcurrency: number;
}

function stubContext(onGet?: (path: string) => void): { ctx: WingPluginContext; result: StubResult } {
  const result: StubResult = { paths: [], peakConcurrency: 0 };
  let inFlight = 0;
  const ctx = {
    // Always a miss, so every entry takes the live-fetch path.
    cache: { get: () => undefined, applyChange: () => undefined },
    client: {
      get: async (path: string) => {
        onGet?.(path);
        inFlight += 1;
        result.peakConcurrency = Math.max(result.peakConcurrency, inFlight);
        result.paths.push(path);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { path, kind: "leaf" as const, valueKind: "string" as const, value: "name" };
      },
    },
  } as unknown as WingPluginContext;
  return { ctx, result };
}

describe("warmNames() keeps the OSC request queue usable while it runs", () => {
  it("reads every name without ever exceeding the concurrency bound", async () => {
    const { ctx, result } = stubContext();
    await warmNames(ctx);

    expect(result.paths).to.have.lengthOf(TOTAL_NAMED_ENTRIES);
    expect(new Set(result.paths).size, "every path read exactly once").to.equal(TOTAL_NAMED_ENTRIES);
    // The bound is 8; asserting "well under the queue's 100" is the property that matters, and
    // leaves room to retune the constant without rewriting the test.
    expect(result.peakConcurrency).to.be.at.most(8);
    expect(result.peakConcurrency).to.be.lessThan(TOTAL_NAMED_ENTRIES);
  });

  it("surfaces a full request queue instead of returning a listing of blank names", async () => {
    // readEffectiveName() deliberately swallows per-entry failures (unreachable console, index out
    // of range) and returns "". A full queue is not per-entry: it means the client as a whole is
    // saturated, and hiding it produced 100 silent blanks with nothing to explain them.
    const { ctx } = stubContext((path) => {
      if (path.includes("/ch/5/")) throw new WingQueueOverflowError("WING OSC request queue is full (max 100)");
    });

    let error: unknown;
    try {
      await warmNames(ctx);
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(WingQueueOverflowError);
  });
});
