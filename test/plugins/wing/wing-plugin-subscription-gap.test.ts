// The client half of this is covered in wing-subscription-gap.test.ts: a subscription whose
// renewals fall further apart than the console tolerates was dead for part of the gap, and every
// change pushed meanwhile is gone. This covers what the plugin does about it, which is the part a
// user would notice — without it the cache keeps serving values that silently stopped being true,
// and nothing ever corrects them: a name is only re-pushed on an actual rename, and the heartbeat
// keeps health reporting green.
//
// `onSubscriptionGap` is private in the type system only; TypeScript's `private` is erased at
// runtime. Driving it directly follows the precedent set in wing-plugin.test.ts for
// `connectionSettingsChanged`, and for the same reason: reaching it through the public surface
// would mean a real console, a real subscription and a real multi-second stall.

import { expect } from "chai";
import type { ScopedConfigStore } from "../../../src/core/config-store.js";
import { EventBus, type PluginEvent } from "../../../src/core/event-bus.js";
import { WingPlugin } from "../../../src/plugins/wing/wing-plugin.js";
import type { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import type { WingSubscriptionGap } from "../../../src/plugins/wing/wing-osc-client.js";

function fakeConfigStore(): ScopedConfigStore {
  return { get: () => undefined, set: async () => {} };
}

interface PluginInternals {
  cache: WingStateCache;
  onSubscriptionGap: (gap: WingSubscriptionGap) => void;
}

const GAP: WingSubscriptionGap = { gapMs: 12_000, inactivityTimeoutMs: 10_000 };

describe("WingPlugin: reacting to a subscription renewal gap", () => {
  let plugin: WingPlugin;
  let internals: PluginInternals;
  let events: PluginEvent[];

  beforeEach(() => {
    const bus = new EventBus();
    events = [];
    bus.subscribe((event) => events.push(event));
    plugin = new WingPlugin(fakeConfigStore(), bus);
    internals = plugin as unknown as PluginInternals;
  });

  it("drops cached state that may have gone stale while the subscription was down", () => {
    internals.cache.applyChange({ path: "/ch/1/name", value: "Kick" });
    internals.cache.applyChange({ path: "/ch/1/fdr", value: -6, raw: 0.53 });
    expect(internals.cache.get("/ch/1/name")?.value).to.equal("Kick");

    internals.onSubscriptionGap(GAP);

    // Names are the reason this matters: unlike a fader, nothing re-pushes one until somebody
    // renames the strip, so a value that went stale in the dark would never be corrected.
    expect(internals.cache.get("/ch/1/name"), "the cache must not be trusted after a gap").to.equal(undefined);
    expect(internals.cache.get("/ch/1/fdr")).to.equal(undefined);
  });

  it("announces the invalidation rather than dropping state silently", () => {
    internals.onSubscriptionGap(GAP);

    const invalidated = events.filter((event) => event.type === "cache-invalidated");
    expect(invalidated).to.have.lengthOf(1);
    expect(invalidated[0]?.pluginId).to.equal("wing");
    expect(invalidated[0]?.payload).to.include({
      reason: "subscription-renewal-gap",
      gapMs: GAP.gapMs,
      inactivityTimeoutMs: GAP.inactivityTimeoutMs,
    });
  });

  it("does not throw when there is no console to re-warm from", () => {
    // The handler fires a background name re-warm. With no connected client that work fails, and
    // it must fail into its own catch rather than out of an event handler.
    expect(() => internals.onSubscriptionGap(GAP)).to.not.throw();
  });
});
