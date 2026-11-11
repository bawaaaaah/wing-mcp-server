import { expect } from "chai";
import { EventEmitter } from "node:events";
import { runAutoGate } from "../../../src/plugins/wing/wing-auto-gate.js";
import { WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

/** A gate whose key alternates between a -50 dB noise floor and -10 dB of signal. */
function gateConsole(opts: { thrLine: string; ack?: { status: string; ok: boolean } }) {
  const writes: { baseNode: string; assignments: Record<string, number | string> }[] = [];
  const meterClient = new EventEmitter();
  let tick = 0;
  const emitter = setInterval(() => {
    tick++;
    const key = tick % 2 === 0 ? -50 : -10;
    meterClient.emit("snapshot", { frames: [{ type: "channel", index: 1, gateKey_dB: key }] });
  }, 5);
  const client = {
    async dump() {
      return { on: 0, mdl: "D241", thr: -40 };
    },
    async describe(path: string) {
      const lines = ["on int [0 .. 1]", opts.thrLine];
      return { path, raw: lines.join("~"), lines };
    },
    async bulkSet(baseNode: string, assignments: Record<string, number | string>) {
      writes.push({ baseNode, assignments });
      const ack = opts.ack ?? { status: "OK", ok: true };
      return { ...ack, raw: ack.status };
    },
  };
  const ctx = { client, meterClient } as unknown as WingPluginContext;
  return { ctx, writes, stop: () => clearInterval(emitter) };
}

describe("runAutoGate", () => {
  it("normalises a reversed threshold range instead of pinning every result to one end", async () => {
    // D241's describe() prints `thr` as "[0 .. -60]". Unswapped, the clamp is
    // Math.min(-60, Math.max(0, x)) = -60 whatever was measured.
    const desk = gateConsole({ thrLine: "thr lin [0.0 .. -60.0 dB], 121 steps" });
    try {
      const result = await runAutoGate(desk.ctx, { type: "channel", index: 1, sampleMs: 80 });
      expect(result.threshold.new).to.equal(-44); // -50 noise floor + 6 dB margin
      expect(result.threshold.clamped).to.equal(false);
      expect(desk.writes).to.deep.equal([{ baseNode: "/ch/1/gate", assignments: { thr: -44, on: 1 } }]);
    } finally {
      desk.stop();
    }
  });

  it("reports a write the console rejected as a failure, not a success", async () => {
    const desk = gateConsole({ thrLine: "thr lin [-80.0 .. 0.0 dB]", ack: { status: "NODE NOT FOUND", ok: false } });
    try {
      const err = await runAutoGate(desk.ctx, { type: "channel", index: 1, sampleMs: 80 }).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(WingValueError);
      expect((err as Error).message).to.include("NODE NOT FOUND");
    } finally {
      desk.stop();
    }
  });
});
