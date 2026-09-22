// runAutoCompress reads the control's *current* value off the console at the start of every run
// (wing-auto-compress.ts, `oldControl` from the live dump), so calling it again continues the
// search from wherever the previous call left the threshold instead of restarting.
//
// That is a real and useful property — it is what makes "the run was refused as too long, lower
// the iterations and call again" actually work — but until now it was emergent, not guaranteed.
// Nothing said it, and nothing would have failed if someone made the engine start from a fixed
// value. This pins it before the tool descriptions start promising it.
//
// The shared harness in wing-plugin-tools.test.ts cannot express this: its fake console returns
// static dumps, so a second run would read the same starting threshold as the first and the test
// would pass no matter what the engine did. A stateful console is the whole point here.

import { expect } from "chai";
import { EventEmitter } from "node:events";
import { runAutoCompress } from "../../../src/plugins/wing/wing-auto-compress.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

const CHANNEL = 1;
const DYN_PATH = "/ch/1/dyn";
const INPUT_DB = -10;
/** Gain reduction the simulated compressor produces: half of however far the input is over the threshold. */
const RATIO_SLOPE = 0.5;

interface FakeConsole {
  ctx: WingPluginContext;
  thr: () => number;
  stop: () => void;
}

/**
 * A console that remembers what was written to it. `dump` reflects previous `bulkSet` calls, which
 * is exactly the behaviour the resume property depends on, and exactly what a static fixture
 * cannot reproduce.
 */
function statefulConsole(startingThreshold: number): FakeConsole {
  const state: Record<string, number | string> = {
    on: 1,
    mdl: "STD",
    thr: startingThreshold,
    gain: 0,
    ratio: 4,
    mix: 100,
  };

  const meterClient = new EventEmitter();
  const emitter = setInterval(() => {
    const over = Math.max(0, INPUT_DB - Number(state.thr));
    meterClient.emit("snapshot", {
      frames: [
        {
          type: "channel",
          index: CHANNEL,
          inputL_dB: INPUT_DB,
          inputR_dB: INPUT_DB,
          outputL_dB: INPUT_DB,
          outputR_dB: INPUT_DB,
          dynKey_dB: INPUT_DB,
          dynGain_dB: -(over * RATIO_SLOPE),
          gateKey_dB: -60,
          gateGain_dB: 0,
        },
      ],
    });
  }, 5);

  const client = {
    async dump(path: string) {
      if (path === DYN_PATH) return { ...state };
      return {};
    },
    async describe(path: string) {
      const lines = [
        "on int [0 .. 1]",
        "thr lin [-80.0 .. 0.0 dB], 161 steps",
        "gain lin [-6.0 .. 12.0 dB], 37 steps",
        "ratio list [2, 3, 4, 6, 10]",
      ];
      return { path, raw: lines.join("~"), lines };
    },
    async bulkSet(baseNode: string, assignments: Record<string, number | string>) {
      if (baseNode === DYN_PATH) Object.assign(state, assignments);
      return { status: "OK", ok: true, raw: "OK" };
    },
    async get(path: string) {
      return { path, kind: "leaf" as const, valueKind: "float" as const, value: 0 };
    },
  };

  const ctx = {
    client,
    meterClient,
    cache: { get: () => undefined, applyChange: () => undefined },
    getConfig: () => ({ host: "127.0.0.1" }),
  } as unknown as WingPluginContext;

  return { ctx, thr: () => Number(state.thr), stop: () => clearInterval(emitter) };
}

describe("wing_auto_compress resumes instead of restarting", () => {
  const TARGET_DB = -6;
  const START_THRESHOLD = -12;
  const RUN = { type: "channel" as const, index: CHANNEL, targetReductionDb: TARGET_DB, sampleMs: 30 };

  it("starts the second run from where the first one left the threshold", async () => {
    const desk = statefulConsole(START_THRESHOLD);
    try {
      const first = await runAutoCompress(desk.ctx, { ...RUN, maxIterations: 1 });
      expect(first.target?.stopReason, "one round must not be enough to converge").to.equal("max-iterations");
      expect(first.control.new, "the first run must have moved the control").to.not.equal(START_THRESHOLD);

      const second = await runAutoCompress(desk.ctx, { ...RUN, maxIterations: 1 });

      // The assertion that matters: the second run's starting point is the first run's endpoint,
      // read back off the console — not START_THRESHOLD, and not anything hardcoded. Make the
      // engine start from a fixed value and this is the line that fails.
      expect(second.control.old).to.equal(first.control.new);
    } finally {
      desk.stop();
    }
  });

  it("lands where one long run lands, given the same total number of rounds", async () => {
    // This is what licenses the advice "lower maxIterations and call again": split runs must not
    // be a degraded path.
    const inOneGo = statefulConsole(START_THRESHOLD);
    const inThree = statefulConsole(START_THRESHOLD);
    try {
      await runAutoCompress(inOneGo.ctx, { ...RUN, maxIterations: 3 });
      for (let i = 0; i < 3; i += 1) {
        await runAutoCompress(inThree.ctx, { ...RUN, maxIterations: 1 });
      }
      // Not exactly equal: each run ends with its own verification sample and makeup-gain pass, so
      // the split path takes a slightly different route to the same place.
      expect(Math.abs(inThree.thr() - inOneGo.thr()), "split runs must converge to the same setting").to.be.at.most(1);
    } finally {
      inOneGo.stop();
      inThree.stop();
    }
  });

  it("reports max-iterations rather than pretending it converged", async () => {
    // The signal a caller needs in order to know it should call again.
    const desk = statefulConsole(-40);
    try {
      const result = await runAutoCompress(desk.ctx, { ...RUN, maxIterations: 1 });
      expect(result.target?.converged).to.equal(false);
      expect(result.target?.stopReason).to.equal("max-iterations");
    } finally {
      desk.stop();
    }
  });
});
