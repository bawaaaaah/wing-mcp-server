import { expect } from "chai";
import { getWLiveStatus } from "../../../src/plugins/wing/wing-live.js";
import type { WingGetResult } from "../../../src/plugins/wing/wing-osc-client.js";
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
