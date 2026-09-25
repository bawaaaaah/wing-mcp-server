// The fade engine writes up to twenty times a second with fire-and-forget SETs, straight past the
// ACK'd bulk-set path the typed setters validate through — so its own bounds are the only ones.

import { expect } from "chai";
import { WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import { cancelFade, startFade } from "../../../src/plugins/wing/wing-fade.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

interface SetCall {
  path: string;
  value: number | string;
  type?: string;
}

function fakeCtx(opts: { current?: number; failSets?: boolean } = {}): { ctx: WingPluginContext; sets: SetCall[]; bulk: unknown[] } {
  const sets: SetCall[] = [];
  const bulk: unknown[] = [];
  const client = {
    get: async (path: string) => ({ path, kind: "leaf", valueKind: "float", value: opts.current ?? -10 }),
    set: async (path: string, value: number | string, setOpts: { type?: string } = {}) => {
      sets.push({ path, value, type: setOpts.type });
      if (opts.failSets) throw new Error("socket closed");
    },
    bulkSet: async (baseNode: string, assignments: Record<string, number | string>) => {
      bulk.push({ baseNode, assignments });
      return { status: "OK", ok: true, raw: "OK" };
    },
  };
  return { ctx: { client } as unknown as WingPluginContext, sets, bulk };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("wing fade engine", () => {
  afterEach(() => {
    cancelFade("/ch/1/fdr");
    cancelFade("/ch/1/send/1/lvl");
  });

  it("refuses to ramp anything that is not a fader or a send level", async () => {
    const { ctx } = fakeCtx();
    for (const path of ["/ch/1/in/set/g", "/ch/1/pan", "/ch/1/eq/1/g"]) {
      const err = await startFade(ctx, { path, durationMs: 100, direction: "out" }).catch((e: unknown) => e);
      expect(err, path).to.be.instanceOf(WingValueError);
    }
    expect((await startFade(ctx, { path: "/ch/1/send/1/lvl", durationMs: 100, direction: "in" })).to).to.equal(0);
  });

  it("refuses a target above +10 dB, absolute or relative", async () => {
    const { ctx, sets } = fakeCtx({ current: 5 });
    for (const opts of [{ to: 20 }, { deltaDb: 12 }]) {
      const err = await startFade(ctx, { path: "/ch/1/fdr", durationMs: 100, direction: "in", ...opts }).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(WingValueError);
    }
    expect(sets).to.deep.equal([]);
  });

  it("treats a relative fade past the floor as all the way down", async () => {
    const { ctx } = fakeCtx({ current: -10 });
    expect((await startFade(ctx, { path: "/ch/1/fdr", durationMs: 100, direction: "out", deltaDb: -200 })).to).to.equal(-144);
  });

  it("sends every step as a float, whole numbers included, and lands on the target with an ACK'd write", async () => {
    const { ctx, sets, bulk } = fakeCtx({ current: -20 });
    await startFade(ctx, { path: "/ch/1/fdr", durationMs: 1000, direction: "in", to: 0 });
    await wait(1150);
    expect(sets.length).to.be.greaterThan(10);
    expect(sets.some((call) => Number.isInteger(call.value))).to.equal(true);
    expect(sets.every((call) => call.type === "f")).to.equal(true);
    expect(bulk).to.deep.equal([{ baseNode: "/ch/1", assignments: { fdr: 0 } }]);
  });

  it("stops at the first step that cannot be sent, instead of failing twenty times a second", async () => {
    const { ctx, sets } = fakeCtx({ failSets: true });
    await startFade(ctx, { path: "/ch/1/fdr", durationMs: 2000, direction: "out" });
    await wait(300);
    expect(sets).to.have.lengthOf(1);
    expect(cancelFade("/ch/1/fdr"), "the fade must no longer be registered as running").to.equal(false);
  });
});
