// runCombinedAutoGain writes (trim reset, then preamp gain) and then measures. A real console takes
// a moment before its meters reflect a write, and the sampling window keeps the PEAK — so a window
// opened straight after the trim reset still sees the old, hotter trim and under-gains the preamp.
// This fake console applies every write after a lag, which is exactly what exposes that.

import { expect } from "chai";
import { EventEmitter } from "node:events";
import { runCombinedAutoGain } from "../../../src/plugins/wing/wing-autogain.js";
import { WingCancelledError } from "../../../src/plugins/wing/wing-errors.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

const SOURCE_DB = -40;
const APPLY_LAG_MS = 60;
const STRIP = "/ch/1";
const PREAMP = "/io/in/A/1";

function laggyConsole(startTrim: number) {
  const applied = { trim: startTrim, g: 0 };
  const writes: { baseNode: string; assignments: Record<string, number | string> }[] = [];
  const meterClient = new EventEmitter();
  const emitter = setInterval(() => {
    const level = SOURCE_DB + applied.g + applied.trim;
    meterClient.emit("snapshot", { frames: [{ type: "channel", index: 1, inputL_dB: level, inputR_dB: level }] });
  }, 5);

  const client = {
    async get(path: string) {
      const values: Record<string, number | string> = {
        [`${STRIP}/in/set/trim`]: applied.trim,
        [`${STRIP}/in/conn/grp`]: "A",
        [`${STRIP}/in/conn/in`]: 1,
      };
      return { path, kind: "leaf" as const, valueKind: "float" as const, value: values[path] ?? 0 };
    },
    async dump(path: string) {
      if (path === PREAMP) return { g: applied.g };
      if (path === `${STRIP}/in/set`) return { trim: applied.trim };
      return {};
    },
    async describe(path: string) {
      const lines = path === PREAMP ? ["g lin [-2.5 .. 45.0 dB]"] : ["trim lin [-18.0 .. 18.0 dB]"];
      return { path, raw: lines.join("~"), lines };
    },
    async bulkSet(baseNode: string, assignments: Record<string, number | string>) {
      writes.push({ baseNode, assignments });
      setTimeout(() => {
        if (baseNode === PREAMP && assignments.g !== undefined) applied.g = Number(assignments.g);
        if (baseNode === `${STRIP}/in/set` && assignments.trim !== undefined) applied.trim = Number(assignments.trim);
      }, APPLY_LAG_MS);
      return { status: "OK", ok: true, raw: "OK" };
    },
  };
  const ctx = { client, meterClient } as unknown as WingPluginContext;
  return { ctx, meterClient, writes, stop: () => clearInterval(emitter) };
}

describe("runCombinedAutoGain settle and cancellation", () => {
  it("waits for the trim reset to reach the meters before measuring the preamp gain", async () => {
    const desk = laggyConsole(10);
    try {
      const result = await runCombinedAutoGain(desk.ctx, { type: "channel", index: 1, targetDb: -18, settleMs: 150 });
      // Source -40 with trim 0: the preamp needs +22. Measuring the old +10 trim would give +12.
      expect(result.gain?.measuredPeakDb).to.equal(SOURCE_DB);
      expect(result.gain?.newValue).to.equal(22);
      expect(result.trim).to.equal(null);
    } finally {
      desk.stop();
    }
  });

  it("without a settle pause the same console is measured at the old trim (what the pause fixes)", async () => {
    const desk = laggyConsole(10);
    try {
      const result = await runCombinedAutoGain(desk.ctx, { type: "channel", index: 1, targetDb: -18, settleMs: 0 });
      expect(result.gain?.newValue).to.equal(12);
    } finally {
      desk.stop();
    }
  });

  it("stops on cancellation mid-window, restores the original trim and detaches its meter listener", async () => {
    const desk = laggyConsole(10);
    const controller = new AbortController();
    try {
      setTimeout(() => controller.abort(), 100);
      const started = Date.now();
      const err = await runCombinedAutoGain(desk.ctx, {
        type: "channel",
        index: 1,
        settleMs: 0,
        signal: controller.signal,
      }).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(WingCancelledError);
      expect(Date.now() - started, "must not sit out the rest of the 1.2 s window").to.be.below(800);
      expect(desk.writes.at(-1)).to.deep.equal({ baseNode: `${STRIP}/in/set`, assignments: { trim: 10 } });
      expect(desk.writes.some((w) => w.baseNode === PREAMP), "no preamp gain may be written").to.equal(false);
      expect(desk.meterClient.listenerCount("snapshot")).to.equal(0);
    } finally {
      desk.stop();
    }
  });

  it("rejects a negative settleMs before touching the console", async () => {
    const desk = laggyConsole(10);
    try {
      const err = await runCombinedAutoGain(desk.ctx, { type: "channel", index: 1, settleMs: -1 }).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(Error);
      expect(desk.writes).to.deep.equal([]);
    } finally {
      desk.stop();
    }
  });
});
