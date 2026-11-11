import { expect } from "chai";
import { EventEmitter } from "node:events";
import {
  AUTO_COMPRESS_SETTLE_MS,
  AUTO_COMPRESS_SETTLE_MS_ENV,
  estimateAutoCompressMs,
  runAutoCompress,
} from "../../../src/plugins/wing/wing-auto-compress.js";
import { WingUnavailableError, WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

const INPUT_DB = -10;
const DYN_PATH = "/ch/1/dyn";

/** A downward compressor whose reduction is half of how far the input sits over its threshold. */
function compressorConsole(state: Record<string, number | string>) {
  const writes: Record<string, number | string>[] = [];
  const meterClient = new EventEmitter();
  const emitter = setInterval(() => {
    const over = Math.max(0, INPUT_DB - Number(state.thr));
    meterClient.emit("snapshot", {
      frames: [{ type: "channel", index: 1, inputL_dB: INPUT_DB, inputR_dB: INPUT_DB, dynGain_dB: -(over * 0.5) }],
    });
  }, 5);
  const client = {
    async dump(path: string) {
      return path === DYN_PATH ? { ...state } : {};
    },
    async describe(path: string) {
      const lines = ["on int [0 .. 1]", "thr lin [-80.0 .. 0.0 dB], 161 steps", "gain lin [-6.0 .. 12.0 dB], 37 steps"];
      return { path, raw: lines.join("~"), lines };
    },
    async bulkSet(baseNode: string, assignments: Record<string, number | string>) {
      if (baseNode === DYN_PATH) {
        writes.push(assignments);
        Object.assign(state, assignments);
      }
      return { status: "OK", ok: true, raw: "OK" };
    },
  };
  const ctx = { client, meterClient } as unknown as WingPluginContext;
  return { ctx, writes, stop: () => clearInterval(emitter) };
}

describe("runAutoCompress", () => {
  it("measures the setting it left behind when the iteration budget runs out right after a move", async () => {
    // thr -12 on a -10 input: 2 dB over -> -1 dB reduction. One round toward -6 moves thr to
    // -12 + (-5 * 0.7) = -15.5 -> 5.5 dB over -> -2.75 dB. Makeup must compensate THAT, not the
    // -1 dB measured before the move.
    const desk = compressorConsole({ on: 1, mdl: "STD", thr: -12, gain: 0 });
    try {
      const result = await runAutoCompress(desk.ctx, {
        type: "channel",
        index: 1,
        targetReductionDb: -6,
        maxIterations: 1,
        sampleMs: 40,
        settleMs: 0,
      });
      expect(result.target?.stopReason).to.equal("max-iterations");
      expect(result.control.new).to.equal(-15.5);
      expect(result.measured.meanGainReductionDb).to.equal(-2.75);
      expect(result.makeupGain.new).to.equal(2.8);
      expect(desk.writes.at(-1)).to.deep.equal({ gain: 2.8 });
    } finally {
      desk.stop();
    }
  });

  it("does not re-measure after a converged search (its last sample already describes the console)", async () => {
    const desk = compressorConsole({ on: 1, mdl: "STD", thr: -22, gain: 0 }); // 12 over -> -6
    let progressCalls = 0;
    try {
      const result = await runAutoCompress(desk.ctx, {
        type: "channel",
        index: 1,
        targetReductionDb: -6,
        sampleMs: 40,
        settleMs: 0,
        onProgress: () => progressCalls++,
      });
      expect(result.target?.stopReason).to.equal("converged");
      expect(progressCalls).to.equal(1);
      expect(desk.writes).to.deep.equal([{ gain: 6 }]);
    } finally {
      desk.stop();
    }
  });

  it("refuses to search from a threshold it could not read, instead of writing NaN", async () => {
    const desk = compressorConsole({ on: 1, mdl: "STD", thr: "garbage", gain: 0 });
    try {
      const err = await runAutoCompress(desk.ctx, {
        type: "channel",
        index: 1,
        targetReductionDb: -6,
        sampleMs: 20,
        settleMs: 0,
      }).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(WingUnavailableError);
      expect(desk.writes, "nothing may be written, NaN least of all").to.deep.equal([]);
    } finally {
      desk.stop();
    }
  });

  it("rejects a negative settleMs", async () => {
    const desk = compressorConsole({ on: 1, mdl: "STD", thr: -12, gain: 0 });
    try {
      const err = await runAutoCompress(desk.ctx, { type: "channel", index: 1, settleMs: -5 }).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(WingValueError);
    } finally {
      desk.stop();
    }
  });

  describe("settle pause", () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env[AUTO_COMPRESS_SETTLE_MS_ENV];
    });
    afterEach(() => {
      if (saved === undefined) delete process.env[AUTO_COMPRESS_SETTLE_MS_ENV];
      else process.env[AUTO_COMPRESS_SETTLE_MS_ENV] = saved;
    });

    it("defaults to AUTO_COMPRESS_SETTLE_MS, follows the env override, and an explicit option wins", () => {
      delete process.env[AUTO_COMPRESS_SETTLE_MS_ENV];
      const opts = { targetReductionDb: -6, maxIterations: 2, sampleMs: 100 };
      expect(estimateAutoCompressMs(opts)).to.equal(2 * (100 + AUTO_COMPRESS_SETTLE_MS) + 100);
      process.env[AUTO_COMPRESS_SETTLE_MS_ENV] = "0";
      expect(estimateAutoCompressMs(opts)).to.equal(300);
      expect(estimateAutoCompressMs({ ...opts, settleMs: 10 })).to.equal(320);
      process.env[AUTO_COMPRESS_SETTLE_MS_ENV] = "not a number";
      expect(estimateAutoCompressMs(opts), "a bad env value falls back to the default").to.equal(700);
    });
  });
});
