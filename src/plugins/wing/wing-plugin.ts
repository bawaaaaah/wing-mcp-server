import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import type { ScopedConfigStore } from "../../core/config-store.js";
import type { EventBus } from "../../core/event-bus.js";
import type { McpPlugin, PluginHealth } from "../../core/plugin.js";
import { throttleLatest } from "../../core/throttle.js";
import { registerWingHttpRoutes } from "./http-routes.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, DCA_COUNT, MAIN_COUNT, channelPath } from "./wing-node-paths.js";
import { registerWingResources } from "./resources.js";
import { registerWingTools } from "./tools/index.js";
import { defaultWingConfigFromEnv, WingConfigSchema, wingConfigJsonSchema, type WingConfig } from "./wing-config.js";
import { WingMeterClient } from "./wing-meter-client.js";
import type { MeterFrame, MeterRequest, MeterSnapshot } from "./wing-meter-types.js";
import {
  WingOscClient,
  type WingParamChange,
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
/** Meter snapshots are high-rate; coalesce to at most one event-bus publish per this interval. */
const METER_PUBLISH_THROTTLE_MS = 100;
/** Warm a small, fixed sample of channels on connect rather than all 40, to keep startup snappy. */
const WARM_CACHE_CHANNEL_SAMPLE = Math.min(8, CHANNEL_COUNT);
/** Upper bound on how long start() will wait for the cache-warming dumps before moving on. */
const WARM_CACHE_BUDGET_MS = 3_000;

const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

/**
 * "Monitor a bit of everything" default: subscribe to every channel, bus, main and DCA meter on
 * connect, rather than requiring a separate opt-in action before the dashboard's Meters tab shows
 * anything. This is the one place meter groups are requested — there is currently no tool/REST
 * surface to change the subscribed set at runtime.
 */
function buildDefaultMeterRequests(): MeterRequest[] {
  return [
    { type: "channel", indices: range(CHANNEL_COUNT) },
    { type: "aux", indices: range(AUX_COUNT) },
    { type: "bus", indices: range(BUS_COUNT) },
    { type: "main", indices: range(MAIN_COUNT) },
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

  private lastRtaSnapshot: RtaSnapshot | null = null;

  private readonly onMeterSnapshot = throttleLatest<MeterSnapshot>(METER_PUBLISH_THROTTLE_MS, (snapshot) => {
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

  constructor(
    private readonly configStore: ScopedConfigStore,
    private readonly eventBus: EventBus,
  ) { }

  async start(): Promise<void> {
    const config = await this.resolveConfig();
    this.config = config;
    await this.connectClients(config);
  }

  async stop(): Promise<void> {
    await this.disconnectClients();
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

    if (this.connectionSettingsChanged(previous, parsed)) {
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
    this.subscriptionHandle = handle;

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

    try {
      await meterClient.connect();
      await meterClient.subscribe(buildDefaultMeterRequests());
    } catch (err) {
      console.error("[wing-plugin] meter client failed to connect/subscribe (continuing without live metering):", err);
    }
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
      try {
        await client.close();
      } catch (err) {
        console.error("[wing-plugin] error closing WING OSC client:", err);
      }
    }

    if (this.meterClient) {
      const meterClient = this.meterClient;
      this.meterClient = null;
      meterClient.off("snapshot", this.onMeterSnapshot);
      meterClient.off("status", this.onMeterStatus);
      meterClient.off("error", this.onMeterError);
      try {
        await meterClient.disconnect();
      } catch (err) {
        console.error("[wing-plugin] error disconnecting WING meter client:", err);
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

  private buildContext(): WingPluginContext {
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
    return {
      client: this.client,
      meterClient: this.meterClient,
      cache: this.cache,
      eventBus: this.eventBus,
      getConfig: () => this.config ?? defaultWingConfigFromEnv(),
      buildOverviewSnapshot: () => this.buildOverviewSnapshot(),
      getLastRta: () => this.lastRtaSnapshot,
    };
  }
}
