import { expect } from "chai";
import { EventBus } from "../../../src/core/event-bus.js";
import type { ScopedConfigStore } from "../../../src/core/config-store.js";
import { WingPlugin } from "../../../src/plugins/wing/wing-plugin.js";
import type { WingConfig } from "../../../src/plugins/wing/wing-config.js";

function fakeConfigStore(): ScopedConfigStore {
  return {
    get: () => undefined,
    set: async () => {},
  };
}

function buildConfig(overrides: Partial<WingConfig> = {}): WingConfig {
  return {
    host: "192.168.1.10",
    oscPort: 2223,
    discoveryPort: 2222,
    meterTcpPort: 2222,
    meterUdpPort: 14135,
    warmCacheOnConnect: true,
    oscMirrorEnabled: false,
    oscMirrorHost: "",
    oscMirrorPort: 0,
    ...overrides,
  };
}

/**
 * `setConfig()`'s reconnection branch (`connectionSettingsChanged()`) fixed a real production bug
 * per its own comment: without it, EVERY config save (even one that only touched an unrelated field
 * like `warmCacheOnConnect`) would drop the cache and reconnect both clients, and conversely a
 * genuine host/port change needs that reset — stale cache entries from the previous console would
 * otherwise keep being served forever, since an idle new console produces no subscription traffic to
 * naturally overwrite them. No test exercised this decision before.
 *
 * `connectionSettingsChanged` is `private` in the type system only — TypeScript's `private` is
 * erased at runtime, so it's still a real, callable method on the instance. Going through the public
 * `setConfig()` instead would require a real host to connect to: `WingOscClient` (UDP) resolves
 * instantly regardless of reachability, but `WingMeterClient` (TCP) has its own unbounded reconnect
 * loop that, against a real-but-refusing target, retries fast enough to make the whole test process
 * unusably slow/flaky (confirmed empirically). Calling the decision method directly tests the exact
 * logic in question without needing any socket at all.
 */
describe("WingPlugin: connectionSettingsChanged (setConfig's reconnect-vs-noop decision)", () => {
  function decide(previous: WingConfig | null, next: WingConfig): boolean {
    const plugin = new WingPlugin(fakeConfigStore(), new EventBus());
    return (
      plugin as unknown as { connectionSettingsChanged: (previous: WingConfig | null, next: WingConfig) => boolean }
    ).connectionSettingsChanged(previous, next);
  }

  it("is true on first connect (previous is null), regardless of what the config actually is", () => {
    expect(decide(null, buildConfig())).to.equal(true);
  });

  it("is false when every connection-relevant field is identical", () => {
    const config = buildConfig();
    expect(decide(config, { ...config })).to.equal(false);
  });

  it("is false when only a non-connection field changes (warmCacheOnConnect, oscMirror*)", () => {
    const previous = buildConfig({ warmCacheOnConnect: true, oscMirrorEnabled: false });
    const next = buildConfig({ warmCacheOnConnect: false, oscMirrorEnabled: true, oscMirrorHost: "10.0.0.5", oscMirrorPort: 9000 });
    expect(decide(previous, next)).to.equal(false);
  });

  it("is true when the host changes", () => {
    const previous = buildConfig({ host: "192.168.1.10" });
    const next = buildConfig({ host: "192.168.1.11" });
    expect(decide(previous, next)).to.equal(true);
  });

  for (const field of ["oscPort", "discoveryPort", "meterTcpPort", "meterUdpPort"] as const) {
    it(`is true when ${field} changes (host unchanged)`, () => {
      const previous = buildConfig();
      const next = buildConfig({ [field]: previous[field] + 1 });
      expect(decide(previous, next)).to.equal(true);
    });
  }
});

describe("WingPlugin: instructions returned on initialize", () => {
  const instructions = new WingPlugin(fakeConfigStore(), new EventBus()).getInstructions();

  it("warns that writes reach real hardware", () => {
    // The one thing a model cannot infer from tool names: this is a live desk, not a simulator.
    expect(instructions.toLowerCase()).to.include("immediately");
  });

  it("explains the generic-vs-typed split, which is the surface's whole shape", () => {
    expect(instructions).to.include("wing_get");
    expect(instructions).to.include("wing_channel_");
  });

  it("points at the batch reads rather than per-index loops", () => {
    expect(instructions).to.include("wing_list_names");
  });

  it("says what to do when a long run is refused", () => {
    expect(instructions).to.include("wing_auto_compress");
    expect(instructions.toLowerCase()).to.include("refuse");
  });
});
