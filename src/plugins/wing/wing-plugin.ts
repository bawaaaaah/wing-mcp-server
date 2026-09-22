import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import type { OscArgument } from "osc";
import type { ScopedConfigStore } from "../../core/config-store.js";
import type { EventBus } from "../../core/event-bus.js";
import { getEnvString } from "../../core/env.js";
import type { McpPlugin, PluginHealth } from "../../core/plugin.js";
import { throttleMerge } from "../../core/throttle.js";
import { registerWingHttpRoutes } from "./http-routes.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, DCA_COUNT, MAIN_COUNT, MATRIX_COUNT, channelPath } from "./wing-node-paths.js";
import { WingMicCalibrationStore } from "./wing-mic-calibration-store.js";
import { WingPresetStore } from "./wing-preset-store.js";
import { registerWingResources } from "./resources.js";
import { registerWingTools } from "./tools/index.js";
import { warmNames } from "./tools/names.js";
import { defaultWingConfigFromEnv, WingConfigSchema, wingConfigJsonSchema, type WingConfig } from "./wing-config.js";
import { WingMeterClient } from "./wing-meter-client.js";
import { mergeMeterSnapshots } from "./wing-meter-protocol.js";
import type { MeterFrame, MeterRequest, MeterSnapshot } from "./wing-meter-types.js";
import { WingOscMirror } from "./wing-osc-mirror.js";
import {
  WingOscClient,
  type WingParamChange,
  type WingSubscriptionGap,
  type WingSubscriptionHandle,
} from "./wing-osc-client.js";
import { WingStateCache } from "./wing-state-cache.js";

/**
 * The seam handed to the tools/resources/HTTP-routes layer (owned by another
 * module): everything it needs to read/write console state, subscribe to
 * live updates, and report a snapshot, without reaching back into
 * `WingPlugin`'s private lifecycle/config-resolution logic.
 */
export interface WingPluginContext {
  client: WingOscClient;
  meterClient: WingMeterClient;
  cache: WingStateCache;
  eventBus: EventBus;
  getConfig(): WingConfig;
  buildOverviewSnapshot(): Promise<unknown>;
  getLastRta(): RtaSnapshot | null;
  presetStore: WingPresetStore;
  /** Saved measurement mics and their calibration curves (auto-EQ). */
  micCalibrationStore: WingMicCalibrationStore;
  oscMirror: WingOscMirror;
}

/** The RTA (real-time spectrum analyzer) is a singleton, index-less meter group (token 0xaa) — see
 * `04-metering.md`. The console's protocol reference documents the 120-band word count but not each
 * band's center frequency, so bands are kept in their raw wire order (ascending frequency) rather
 * than labeled in Hz. */
export interface RtaSnapshot {
  bandsDb: number[];
  receivedAt: number;
}

type MeterClientStatus = "connected" | "disconnected" | "reconnecting";

/** No successful OSC request within this window (or none ever) is reported as unhealthy. */
const OSC_HEALTH_STALE_MS = 15_000;
/**
 * How often to poll a cheap, always-present leaf purely to prove the OSC link is alive. Needed
 * because the `/*S` subscription only pushes on an actual value *change* — verified against real
 * hardware that an idle console (nobody touching a control) produces zero subscription traffic —
 * so without an active heartbeat, `OSC_HEALTH_STALE_MS` would eventually trip on a perfectly
 * healthy, simply-quiet connection. Comfortably under `OSC_HEALTH_STALE_MS` to tolerate one missed
 * or timed-out cycle.
 */
const OSC_HEARTBEAT_INTERVAL_MS = 7_000;
/** Cheap, read-only, always-present leaf used for the heartbeat above — the console's model name. */
const OSC_HEARTBEAT_PATH = "/$syscfg/$cnsmdl";
/**
 * Meter snapshots are high-rate; coalesce to at most one event-bus publish per this interval. Uses
 * `throttleMerge`/`mergeMeterSnapshots`, not a plain "keep the latest" throttle — a fast transient
 * (e.g. a compressor's gain-reduction meter dipping several dB for a few ms) can easily happen and
 * fully release again within one 100ms window, and a "latest sample" throttle would silently drop it.
 */
const METER_PUBLISH_THROTTLE_MS = 100;
/** Warm a small, fixed sample of channels on connect rather than all 40, to keep startup snappy. */
const WARM_CACHE_CHANNEL_SAMPLE = Math.min(8, CHANNEL_COUNT);
/** Upper bound on how long start() will wait for the cache-warming dumps before moving on. */
const WARM_CACHE_BUDGET_MS = 3_000;
/**
 * A fresh `subscribe()` appears to make the console replay an initial burst of current-value pushes
 * for every subscribed parameter — including names — over the same UDP socket `warmNames()` is about
 * to send its own live GETs on. The WING OSC protocol has no request/reply correlation ID, so
 * `wing-osc-client.ts`'s `handleMessage()` can only match an incoming message to our pending GET by
 * address: if one of that burst's pushes lands on the same address while our GET for it is the
 * current queue head, the push silently resolves our GET instead of the console's real reply —
 * verified live against real hardware that this can permanently poison a name in the cache (a mute
 * group whose name read back correctly via a direct `wing_get` stayed cached as empty through
 * `wing_list_names` for the rest of the session, since name fields are only re-pushed on an actual
 * rename, never on subscription renewal, so nothing ever naturally overwrites the bad value).
 * `waitForSubscriptionBurstToSettle()` below detects when that burst is actually done (rather than
 * guessing a fixed delay) so post-burst work like `warmNames()` can safely wait on it.
 */
const SUBSCRIPTION_BURST_QUIET_MS = 150;
/** Hard cap on `waitForSubscriptionBurstToSettle()` — a console under continuous live use may never
 * go fully quiet, so this bounds how long post-burst work stays deferred waiting for it. */
const SUBSCRIPTION_BURST_MAX_WAIT_MS = 2_000;

/**
 * Resolves once `handle`'s push stream has gone quiet for `SUBSCRIPTION_BURST_QUIET_MS` — i.e. the
 * console's initial post-subscribe burst (or, absent one, simply the first idle moment) — or after
 * `SUBSCRIPTION_BURST_MAX_WAIT_MS` total, whichever comes first. See the doc comment above for why
 * racing that burst with our own live GETs is unsafe.
 */
function waitForSubscriptionBurstToSettle(handle: WingSubscriptionHandle): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      handle.off("change", onChange);
      resolve();
    };
    const onChange = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, SUBSCRIPTION_BURST_QUIET_MS);
    };
    const maxTimer = setTimeout(finish, SUBSCRIPTION_BURST_MAX_WAIT_MS);
    quietTimer = setTimeout(finish, SUBSCRIPTION_BURST_QUIET_MS);
    handle.on("change", onChange);
  });
}

const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

/**
 * "Monitor a bit of everything" default: subscribe to every channel/aux/bus/main/matrix/DCA meter
 * on connect, rather than requiring a separate opt-in action before the dashboard's Meters tab (or
 * a gate/dyn status/auto-compress tool call against a matrix strip) shows anything. This is the one
 * place meter groups are requested — there is currently no tool/REST surface to change the
 * subscribed set at runtime.
 */
function buildDefaultMeterRequests(): MeterRequest[] {
  return [
    { type: "channel", indices: range(CHANNEL_COUNT) },
    { type: "aux", indices: range(AUX_COUNT) },
    { type: "bus", indices: range(BUS_COUNT) },
    { type: "main", indices: range(MAIN_COUNT) },
    { type: "matrix", indices: range(MATRIX_COUNT) },
    { type: "dca", indices: range(DCA_COUNT) },
    { type: "rta" },
  ];
}

export class WingPlugin implements McpPlugin {
  readonly id = "wing";
  readonly name = "Behringer WING";

  private config: WingConfig | null = null;
  private client: WingOscClient | null = null;
  private meterClient: WingMeterClient | null = null;
  private readonly cache = new WingStateCache();
  private readonly presetStore = new WingPresetStore({ dir: getEnvString("WING_PRESETS_DIR", "./data/presets") });
  private readonly micCalibrationStore = new WingMicCalibrationStore({
    dir: getEnvString("WING_MIC_CALIBRATIONS_DIR", "./data/mic-calibrations"),
  });
  private readonly oscMirror = new WingOscMirror();
  private subscriptionHandle: WingSubscriptionHandle | null = null;
  private meterStatus: MeterClientStatus = "disconnected";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onParamChange = (change: WingParamChange): void => {
    this.cache.applyChange({ path: change.path, value: change.value, raw: change.raw });
    this.eventBus.publish({
      pluginId: this.id,
      type: "param-change",
      payload: change,
      timestamp: change.receivedAt,
    });
  };

  /**
   * The subscription went quiet for longer than the console tolerates, so it was dead for part of
   * that window and every change made meanwhile was never pushed. The subscription itself repairs
   * itself on the next renewal; the cache does not, and nothing would ever reveal the divergence —
   * the heartbeat keeps health green, and a name only gets re-pushed on an actual rename.
   *
   * So the cache is dropped rather than trusted. Reads fall back to the console until it refills,
   * and the names are warmed again in the background exactly as on connect, so this costs a
   * slightly slower next read instead of an answer that is quietly wrong.
   */
  private readonly onSubscriptionGap = (gap: WingSubscriptionGap): void => {
    console.warn(
      `[wing-plugin] subscription renewal was ${gap.gapMs}ms apart, past the console's ` +
        `${gap.inactivityTimeoutMs}ms inactivity timeout — dropping the state cache, which may have ` +
        "missed changes while the subscription was down",
    );
    this.cache.clear();
    this.eventBus.publish({
      pluginId: this.id,
      type: "cache-invalidated",
      payload: { reason: "subscription-renewal-gap", ...gap },
      timestamp: Date.now(),
    });
    warmNames(this.buildContext()).catch((err) => {
      console.error("[wing-plugin] failed to re-warm the name cache after a subscription gap:", err);
    });
  };

  private lastRtaSnapshot: RtaSnapshot | null = null;

  private readonly onMeterSnapshot = throttleMerge<MeterSnapshot>(METER_PUBLISH_THROTTLE_MS, mergeMeterSnapshots, (snapshot) => {
    const rtaFrame = snapshot.frames.find((frame): frame is Extract<MeterFrame, { type: "rta" }> => frame.type === "rta");
    if (rtaFrame) {
      this.lastRtaSnapshot = { bandsDb: rtaFrame.bands_dB, receivedAt: snapshot.receivedAt };
    }
    this.eventBus.publish({ pluginId: this.id, type: "meters", payload: snapshot, timestamp: Date.now() });
  });

  private readonly onMeterStatus = (status: MeterClientStatus): void => {
    this.meterStatus = status;
    this.eventBus.publish({
      pluginId: this.id,
      type: "connection",
      payload: { meterStatus: status },
      timestamp: Date.now(),
    });
  };

  private readonly onMeterError = (err: Error): void => {
    console.error("[wing-plugin] meter client error:", err);
  };

  private readonly onRawOscMessage = (msg: { address: string; args: OscArgument[] }): void => {
    this.oscMirror.mirrorOscMessage(msg.address, msg.args);
  };

  private readonly onRawMeterPacket = (buf: Buffer): void => {
    this.oscMirror.mirrorRawBuffer(buf);
  };

  constructor(
    private readonly configStore: ScopedConfigStore,
    private readonly eventBus: EventBus,
  ) { }

  async start(): Promise<void> {
    const config = await this.resolveConfig();
    this.config = config;
    this.applyOscMirrorConfig(config);
    await this.connectClients(config);
  }

  async stop(): Promise<void> {
    await this.disconnectClients();
    this.oscMirror.close();
  }

  async getHealth(): Promise<PluginHealth> {
    const detail: Record<string, unknown> = {
      host: this.config?.host ?? null,
    };

    if (!this.config?.host) {
      return {
        status: "ERROR",
        detail,
        errorMessage: "WING_HOST is not configured yet — set the console's IP address from the dashboard's Wing > Config tab.",
      };
    }

    const lastSuccessAt = this.client?.getLastSuccessAt() ?? null;
    // Staleness is judged on *any* OSC activity (including unsolicited subscription pushes), not
    // just request/response round trips — verified against real hardware that a live Mixer session
    // can go many seconds without issuing a single GET/dump/bulkSet once loaded, since it relies on
    // `/*S` pushes rather than polling. Using request success alone here would report a perfectly
    // healthy, actively-updating connection as an error.
    const lastActivityAt = this.client?.getLastActivityAt() ?? null;
    const queueDepth = this.client?.getQueueDepth() ?? 0;
    const oscStale = lastActivityAt === null || Date.now() - lastActivityAt > OSC_HEALTH_STALE_MS;

    detail.oscLastSuccessAt = lastSuccessAt !== null ? new Date(lastSuccessAt).toISOString() : null;
    detail.oscLastActivityAt = lastActivityAt !== null ? new Date(lastActivityAt).toISOString() : null;
    detail.oscQueueDepth = queueDepth;
    detail.meterStatus = this.meterStatus;
    detail.cacheWarm = this.cache.isWarm();

    if (oscStale) {
      return {
        status: "ERROR",
        detail,
        errorMessage:
          lastActivityAt === null
            ? "No OSC activity yet — console may be unreachable."
            : `No OSC activity in the last ${OSC_HEALTH_STALE_MS / 1000}s.`,
      };
    }

    if (this.meterStatus === "disconnected" || this.meterStatus === "reconnecting") {
      return { status: "DEGRADED", detail, errorMessage: `Meter client is ${this.meterStatus}.` };
    }

    return { status: "HEALTHY", detail };
  }

  /**
   * Returned to the client in `initialize`, so a model has this before its first call rather than
   * having to infer it from 116 tool names. Kept to what changes what a caller does — the split
   * between the generic escape hatch and the typed families, the batch reads worth preferring, and
   * the fact that every write lands on real hardware, often mid-show.
   */
  getInstructions(): string {
    return [
      "This server drives a physical Behringer WING mixing console over its OSC protocol. Writes take",
      "effect immediately and are audible: during a show, a fader move or a scene recall is heard by the",
      "audience. There is no undo beyond the tools that explicitly offer one.",
      "",
      "Two overlapping ways to reach the console, and the choice matters:",
      "",
      "- The typed families (wing_channel_*, wing_bus_*, wing_dca_*, wing_scene_*, ...) are the default.",
      "  They validate ranges before writing, resolve the console's shadow (\"$\") addressing, and report",
      "  the console's acknowledgement, so a rejected write is visible rather than silent.",
      "- wing_get / wing_set / wing_dump / wing_describe are the escape hatch for the parts of the node",
      "  tree no family covers. They accept any path and are correspondingly unforgiving. Read the",
      "  wing-docs:// resources for the node tree before guessing a path.",
      "",
      "Prefer one batched read over a loop: wing_list_names returns every strip name in one call, and",
      "wing_*_get_summary returns a whole strip at once. Calling a per-index tool N times is slower and",
      "no more accurate, because everything funnels through a single in-flight request queue anyway.",
      "",
      "The automation tools (wing_auto_gain, wing_auto_compress, wing_auto_gate, wing_auto_eq_balance)",
      "measure live audio for several seconds and then move real controls, so they need program material",
      "actually playing. They refuse parameters that would make a single call run longer than a client",
      "will wait — if one is refused, lower the sampling window or the iteration count and run it again",
      "rather than trying to force it through.",
    ].join("\n");
  }

  registerTools(server: McpServer): void {
    const ctx = this.buildContext();
    registerWingTools(server, ctx);
    registerWingResources(server, ctx);
  }

  getConfigSchema(): object {
    return wingConfigJsonSchema();
  }

  getConfig(): unknown {
    return this.config;
  }

  async setConfig(config: unknown): Promise<void> {
    const parsed = WingConfigSchema.parse(config);
    const previous = this.config;
    await this.configStore.set(parsed);
    this.config = parsed;
    this.applyOscMirrorConfig(parsed);

    if (this.connectionSettingsChanged(previous, parsed)) {
      // Drop every cached name/mute/fader value before switching consoles — otherwise
      // cache-first reads (readEffectiveName in tools/names.ts) would keep serving the
      // previous console's stale patch/names, since an idle new console produces no
      // subscription traffic to naturally overwrite them.
      this.cache.clear();
      await this.disconnectClients();
      await this.connectClients(parsed);
    }
  }

  registerHttpRoutes(router: Router): void {
    registerWingHttpRoutes(router, this.buildContext());
  }

  /**
   * Best-effort overview: channel strips from whatever the cache has warmed
   * up so far, plus a couple of scene reads. Never throws — a console that's
   * unreachable or slow just yields a sparser snapshot.
   */
  async buildOverviewSnapshot(): Promise<unknown> {
    const snapshot: Record<string, unknown> = {
      connected: this.client !== null,
      cacheWarm: this.cache.isWarm(),
      meterStatus: this.meterStatus,
      channels: this.cache.snapshotChannels(),
    };

    if (this.client) {
      try {
        const activeScene = await this.client.get("/$ctl/lib/$active");
        if (activeScene.kind === "leaf") {
          snapshot.activeScene = activeScene.value;
        }
      } catch (err) {
        console.error("[wing-plugin] overview snapshot: failed to read active scene:", err);
      }

      try {
        const activeSceneIndex = await this.client.get("/$ctl/lib/$actidx");
        if (activeSceneIndex.kind === "leaf") {
          snapshot.activeSceneIndex = activeSceneIndex.value;
        }
      } catch (err) {
        console.error("[wing-plugin] overview snapshot: failed to read active scene index:", err);
      }
    }

    return snapshot;
  }

  /**
   * Resolves the plugin's config from the store, falling back to
   * environment-derived defaults (and persisting them) on first boot or if
   * the persisted value is missing/invalid. Never throws.
   */
  private async resolveConfig(): Promise<WingConfig> {
    let stored: unknown;
    try {
      stored = this.configStore.get();
    } catch (err) {
      console.error("[wing-plugin] failed to read persisted config, falling back to env defaults:", err);
    }

    if (stored) {
      try {
        return WingConfigSchema.parse(stored);
      } catch (err) {
        console.error("[wing-plugin] persisted config failed validation, falling back to env defaults:", err);
      }
    }

    const fromEnv = defaultWingConfigFromEnv();
    try {
      await this.configStore.set(fromEnv);
    } catch (err) {
      console.error("[wing-plugin] failed to persist default config:", err);
    }
    return fromEnv;
  }

  private connectionSettingsChanged(previous: WingConfig | null, next: WingConfig): boolean {
    if (!previous) {
      return true;
    }
    return (
      previous.host !== next.host ||
      previous.oscPort !== next.oscPort ||
      previous.discoveryPort !== next.discoveryPort ||
      previous.meterTcpPort !== next.meterTcpPort ||
      previous.meterUdpPort !== next.meterUdpPort
    );
  }

  /**
   * Applies the persisted mirror settings (dashboard Config tab / config file / WING_OSC_MIRROR_*
   * env vars — see wing-config.ts) to the live oscMirror singleton. Deliberately independent of
   * connectionSettingsChanged()/connectClients(): the mirror has nothing to do with the console
   * connection, so a mirror-only config change never drops the cache or reconnects the clients.
   * WingConfigSchema's superRefine already rejects enabled=true with a missing/invalid host/port at
   * parse time, so `configure()` here should never actually throw — the try/catch is defense in
   * depth, consistent with the rest of this file's "config application never crashes start()" rule.
   */
  private applyOscMirrorConfig(config: WingConfig): void {
    try {
      this.oscMirror.configure({ enabled: config.oscMirrorEnabled, host: config.oscMirrorHost, port: config.oscMirrorPort });
    } catch (err) {
      console.error("[wing-plugin] failed to apply OSC mirror config:", err);
    }
  }

  /**
   * Constructs and connects both clients, warms the cache (if configured),
   * and wires subscriptions/events. Never throws — every I/O step is
   * best-effort so a temporarily (or permanently) unreachable console never
   * prevents the plugin from starting/registering its tools.
   *
   * If `host` is empty (not configured yet — e.g. first boot with no
   * WING_HOST env var and nothing saved via the dashboard yet), skip
   * connecting entirely rather than pointlessly hammering an empty address;
   * `setConfig()` will call this again once a real host is saved.
   */
  private async connectClients(config: WingConfig): Promise<void> {
    if (!config.host) {
      this.client = null;
      this.meterClient = null;
      this.meterStatus = "disconnected";
      return;
    }

    const client = new WingOscClient({
      host: config.host,
      port: config.oscPort,
      discoveryPort: config.discoveryPort,
    });
    const meterClient = new WingMeterClient({
      host: config.host,
      tcpPort: config.meterTcpPort,
      udpListenPort: config.meterUdpPort,
    });

    this.client = client;
    this.meterClient = meterClient;
    this.meterStatus = "disconnected";

    client.on("raw", this.onRawOscMessage);
    meterClient.on("raw", this.onRawMeterPacket);

    try {
      await client.connect();
    } catch (err) {
      console.error("[wing-plugin] failed to connect the WING OSC client:", err);
    }

    if (config.warmCacheOnConnect) {
      await this.warmCache(client);
    }

    const handle = client.subscribe();
    handle.on("change", this.onParamChange);
    handle.on("renewal-gap", this.onSubscriptionGap);
    this.subscriptionHandle = handle;

    // Fire-and-forget: seeds the name cache (see tools/names.ts) so the first `wing_list_names` call
    // or per-strip name lookup doesn't pay for ~100 sequential OSC round trips itself. The
    // subscription above is already live by this point, so any rename/re-patch/link toggle that
    // happens mid-warm-up still lands its own fresh push on top of whatever this fetches. Waits for
    // the initial subscription burst to settle first — see that function's doc for why racing it is
    // unsafe.
    waitForSubscriptionBurstToSettle(handle)
      .then(() => warmNames(this.buildContext()))
      .catch((err) => {
        console.error("[wing-plugin] failed to warm the name cache:", err);
      });

    this.heartbeatTimer = setInterval(() => {
      client.get(OSC_HEARTBEAT_PATH).catch(() => {
        // Swallowed: a failed heartbeat simply means lastActivityAt won't advance, which
        // getHealth() already surfaces as ERROR — no need to also spam the log every cycle.
      });
    }, OSC_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();

    meterClient.on("snapshot", this.onMeterSnapshot);
    meterClient.on("status", this.onMeterStatus);
    meterClient.on("error", this.onMeterError);

    // Not awaited: an unreachable console's TCP connect can sit on the OS-level timeout (tens of
    // seconds) before rejecting, and blocking start() on it would delay the HTTP server binding its
    // port — which is exactly when the dashboard is needed to fix a wrong WING_HOST. The client's own
    // reconnect loop (see wing-meter-client.ts) takes over from here regardless of how this settles.
    meterClient
      .connect()
      .then(() => meterClient.subscribe(buildDefaultMeterRequests()))
      .catch((err) => {
        console.error("[wing-plugin] meter client failed to connect/subscribe (continuing without live metering):", err);
      });
  }

  private async disconnectClients(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.subscriptionHandle) {
      this.subscriptionHandle.off("change", this.onParamChange);
      this.subscriptionHandle.close();
      this.subscriptionHandle = null;
    }

    if (this.client) {
      const client = this.client;
      this.client = null;
      client.off("raw", this.onRawOscMessage);
      try {
        await client.close();
      } catch (err) {
        console.error("[wing-plugin] error closing WING OSC client:", err);
      }
    }

    if (this.meterClient) {
      const meterClient = this.meterClient;
      this.meterClient = null;
      meterClient.off("raw", this.onRawMeterPacket);
      meterClient.off("snapshot", this.onMeterSnapshot);
      meterClient.off("status", this.onMeterStatus);
      // Keep the 'error' listener attached until disconnect() has settled — an
      // EventEmitter with no 'error' listener throws on an emitted error, and a real
      // network error (e.g. ECONNRESET) during teardown is exactly when one can fire.
      try {
        await meterClient.disconnect();
      } catch (err) {
        console.error("[wing-plugin] error disconnecting WING meter client:", err);
      } finally {
        meterClient.off("error", this.onMeterError);
      }
    }
  }

  /**
   * Best-effort: dumps a small, fixed sample of channels into the state
   * cache so `buildOverviewSnapshot()`/tools have something useful
   * immediately, without waiting on the (change-driven) OSC subscription to
   * naturally observe every channel. Bounded by `WARM_CACHE_BUDGET_MS` so a
   * slow or unreachable console never blocks `start()` for long — any dumps
   * still in flight past the budget keep running in the background and
   * populate the cache whenever (if ever) they resolve.
   */
  private async warmCache(client: WingOscClient): Promise<void> {
    const dumps = Promise.allSettled(
      Array.from({ length: WARM_CACHE_CHANNEL_SAMPLE }, (_, i) => i + 1).map(async (n) => {
        const path = channelPath(n);
        const flat = await client.dump(path);
        for (const [key, value] of Object.entries(flat)) {
          // "name" is deliberately skipped here: `dump()` only ever returns the channel's own
          // literal name, never the "$name" shadow — which is the effective, source-link-aware
          // value `tools/names.ts`'s cache (this same `this.cache`, same "/ch/{n}/name" key) is
          // meant to hold. Applying the literal value here would race whichever of `warmCache()`/
          // `warmNames()` happens to run last, sometimes clobbering the correct value with the
          // wrong one. `warmNames()` (fired right after this) is the sole source of truth for names.
          if (key === "name") {
            continue;
          }
          this.cache.applyChange({ path: `${path}/${key.replace(/\./g, "/")}`, value });
        }
      }),
    );
    const budget = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WARM_CACHE_BUDGET_MS);
      timer.unref?.();
    });
    await Promise.race([dumps, budget]);
  }

  private ensureClients(): { client: WingOscClient; meterClient: WingMeterClient } {
    if (!this.client || !this.meterClient) {
      // Expected whenever the host isn't configured yet (connectClients()
      // deliberately skips creating clients in that case), and also a safe
      // fallback if this were ever called before start() resolves. Tool
      // calls against this unconnected pair will simply time out with a
      // clear WingTimeoutError until a real host is set via setConfig().
      const fallbackConfig = this.config ?? defaultWingConfigFromEnv();
      this.client ??= new WingOscClient({ host: fallbackConfig.host, port: fallbackConfig.oscPort });
      this.meterClient ??= new WingMeterClient({ host: fallbackConfig.host, tcpPort: fallbackConfig.meterTcpPort });
    }
    return { client: this.client, meterClient: this.meterClient };
  }

  /**
   * `registerHttpRoutes()` builds its context exactly once, at gateway startup, and closes over it
   * for the lifetime of the process — unlike `registerTools()`, which is called fresh per MCP
   * session. `client`/`meterClient` must therefore be live getters, not a one-time snapshot: a
   * `setConfig()` call replaces both fields with brand-new instances (see `connectClients()`), and
   * an HTTP route holding onto the original (by-then-disconnected) client would silently fail every
   * request afterward — verified live, this is exactly what made the dashboard go blank after
   * changing the console's host from the Config tab.
   */
  private buildContext(): WingPluginContext {
    const self = this;
    return {
      get client() {
        return self.ensureClients().client;
      },
      get meterClient() {
        return self.ensureClients().meterClient;
      },
      cache: this.cache,
      eventBus: this.eventBus,
      getConfig: () => this.config ?? defaultWingConfigFromEnv(),
      buildOverviewSnapshot: () => this.buildOverviewSnapshot(),
      getLastRta: () => this.lastRtaSnapshot,
      presetStore: this.presetStore,
      micCalibrationStore: this.micCalibrationStore,
      oscMirror: this.oscMirror,
    };
  }
}
