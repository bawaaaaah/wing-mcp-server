import { expect } from "chai";
import { getWLiveStatus, manageWLiveMarker } from "../../../src/plugins/wing/wing-live.js";
import { WingValueError } from "../../../src/plugins/wing/wing-errors.js";
import type { WingBulkSetResult, WingGetResult } from "../../../src/plugins/wing/wing-osc-client.js";
import type { WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

/**
 * `getWLiveStatus` only ever touches `ctx.client`, so this doesn't need the full MCP-server/fake-
 * client harness `wing-plugin-tools.test.ts` uses for the rest of the WING Live surface (installed
 * case, transport/session/marker/format actions) — a minimal hand-built context is enough to prove
 * the "no card" short-circuit never attempts a `dump()` on a subtree that might not exist.
 */
describe("wing-live: no card installed", () => {
  it("returns installed: false without dumping /cards/wlive when $type isn't WLIVE", async () => {
    let dumpCalled = false;
    const ctx = {
      client: {
        async get(path: string): Promise<WingGetResult> {
          expect(path).to.equal("/cards/$type");
          return { path, kind: "leaf", valueKind: "string", value: "WMADI" };
        },
        async dump() {
          dumpCalled = true;
          return {};
        },
      },
    } as unknown as WingPluginContext;

    const status = await getWLiveStatus(ctx);
    expect(status).to.deep.equal({ installed: false, cardType: "WMADI", global: null, cards: [] });
    expect(dumpCalled).to.equal(false);
  });
});

/**
 * `manageWLiveMarker`'s own bounds/required-field checks (`requireMarkerIndex`) are unreachable
 * through the `wing_wlive_marker` MCP tool for out-of-range/missing values — that tool's zod schema
 * (`markerIndex: z.number().int().min(0).max(100).optional()`) already rejects those before the
 * handler ever runs, so wing-plugin-tools.test.ts can only exercise the valid-index "edit"/"goto"/
 * "delete" paths. This is the one surface that actually reaches the business logic itself — the same
 * logic the REST route (POST /wlive/:card/marker, which has no such schema) relies on for its own
 * validation.
 */
describe("manageWLiveMarker", () => {
  function fakeCtx(): { ctx: WingPluginContext; calls: { baseNode: string; assignments: Record<string, number | string> }[] } {
    const calls: { baseNode: string; assignments: Record<string, number | string> }[] = [];
    const ctx = {
      client: {
        async bulkSet(baseNode: string, assignments: Record<string, number | string>): Promise<WingBulkSetResult> {
          calls.push({ baseNode, assignments });
          return { status: "OK", ok: true, raw: "OK" };
        },
      },
    } as unknown as WingPluginContext;
    return { ctx, calls };
  }

  it('"edit" writes editmarker for a valid index', async () => {
    const { ctx, calls } = fakeCtx();
    await manageWLiveMarker(ctx, { card: 1, action: "edit", markerIndex: 5 });
    expect(calls).to.deep.equal([{ baseNode: "/cards/wlive/1/$ctl", assignments: { editmarker: 5 } }]);
  });

  async function rejects(promise: Promise<unknown>): Promise<unknown> {
    let error: unknown;
    try {
      await promise;
    } catch (err) {
      error = err;
    }
    return error;
  }

  it('"goto" rejects markerIndex 101 — reserved for "seek"\'s internal commit signal, not a real 101st marker', async () => {
    const { ctx, calls } = fakeCtx();
    const error = await rejects(manageWLiveMarker(ctx, { card: 1, action: "goto", markerIndex: 101 }));
    expect(error).to.be.instanceOf(WingValueError);
    expect((error as Error).message).to.match(/between 0 and 100/);
    expect(calls).to.have.length(0);
  });

  it('"delete" rejects a negative markerIndex', async () => {
    const { ctx, calls } = fakeCtx();
    const error = await rejects(manageWLiveMarker(ctx, { card: 1, action: "delete", markerIndex: -1 }));
    expect(error).to.be.instanceOf(WingValueError);
    expect((error as Error).message).to.match(/between 0 and 100/);
    expect(calls).to.have.length(0);
  });

  it('"edit"/"goto"/"delete" reject a missing markerIndex', async () => {
    const { ctx, calls } = fakeCtx();
    const error = await rejects(manageWLiveMarker(ctx, { card: 1, action: "edit" }));
    expect(error).to.be.instanceOf(WingValueError);
    expect((error as Error).message).to.match(/requires an integer markerIndex/);
    expect(calls).to.have.length(0);
  });

  it('"seek" rejects a negative timeMs', async () => {
    const { ctx, calls } = fakeCtx();
    const error = await rejects(manageWLiveMarker(ctx, { card: 1, action: "seek", timeMs: -1 }));
    expect(error).to.be.instanceOf(WingValueError);
    expect((error as Error).message).to.match(/non-negative timeMs/);
    expect(calls).to.have.length(0);
  });
});
