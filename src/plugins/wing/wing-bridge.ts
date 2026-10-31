import type { OscArgument } from "osc";
import { z } from "zod";
import { WingBridgeOsc, type BridgeBlockedWrite, type BridgeOscClientInfo, type WingBridgeOscStats } from "./wing-bridge-osc.js";
import { buildSafeRules, countSafes, type SafeRules, type StripSources } from "./wing-bridge-safes.js";
import { emptyBridgeSafes, type BridgeSafes, type WingConfig } from "./wing-config.js";
import { WingValueError } from "./wing-errors.js";
import { AUX_COUNT, BUS_COUNT, CHANNEL_COUNT, DCA_COUNT, MAIN_COUNT, MATRIX_COUNT } from "./wing-node-paths.js";
import type { WingPluginContext } from "./wing-plugin.js";
import type { WingOscClient, WingParamChange } from "./wing-osc-client.js";
import type { WingStateCache } from "./wing-state-cache.js";

/** The bridge settings in force, plus where the console is (the OSC proxy forwards there). */
export interface BridgeSettings {
  enabled: boolean;
  osc: boolean;
  native: boolean;
  oscPort: number;
  nativePort: number;
  discovery: boolean;
  bindAddress: string;
  name: string;
  advertiseHost: string;
  serialMode: "derived" | "real";
  protectGlobal: boolean;
  safes: BridgeSafes;
  consoleHost: string;
  consoleOscPort: number;
}

export interface BridgeStatus {
  enabled: boolean;
  osc: (WingBridgeOscStats & { enabled: boolean }) | null;
  /** Not built yet (phase 2): reported so a config asking for it says so. */
  native: { enabled: boolean; available: false };
  discovery: { enabled: boolean; available: false };
  bindAddress: string;
  protectGlobal: boolean;
  safes: BridgeSafes;
  safeCount: number;
  /** "ready" once every safe channel/aux's input patch is known; until then all of /io/in is refused. */
  safesState: "none" | "resolving" | "ready";
  protectedRoots: string[];
  clients: (BridgeOscClientInfo & { transport: "osc" })[];
  recentBlocks: BridgeBlockedWrite[];
  lastError: string | null;
}

export function bridgeSettingsFromConfig(config: WingConfig): BridgeSettings {
  return {
    enabled: config.bridgeEnabled,
    osc: config.bridgeOsc,
    native: config.bridgeNative,
    oscPort: config.bridgeOscPort,
    nativePort: config.bridgeNativePort,
    discovery: config.bridgeDiscovery,
    bindAddress: config.bridgeBindAddress,
    name: config.bridgeName,
    advertiseHost: config.bridgeAdvertiseHost,
    serialMode: config.bridgeSerialMode,
    protectGlobal: config.bridgeProtectGlobal,
    safes: config.bridgeSafes,
    consoleHost: config.host,
    consoleOscPort: config.oscPort,
  };
}

const MAX_RECENT_BLOCKS = 50;
/** A push on one of these, for a safe strip, means its input patch changed: resolve it again. */
const CONN_PATH_RE = /^\/(ch|aux)\/(\d+)\/in\/conn\/(grp|in|altgrp|altin)$/;

/** Only these change what the OSC listener is: the rest (safes, protection) apply in place. */
function listenerKey(s: BridgeSettings): string {
  return JSON.stringify([s.enabled && s.osc, s.oscPort, s.bindAddress, s.consoleHost, s.consoleOscPort]);
}

/**
 * Tablets and OSC apps connect to this server instead of the console, so the console sees one
 * connection, and strips marked safe cannot be changed from them. Owned by WingPlugin for the
 * process lifetime like the OSC mirror, and wired to whichever OSC client is current
 * (`attachClient`). Safes bind only bridged clients: MCP tools and the dashboard are not affected.
 *
 * Phase 1 serves OSC apps only. The native proxy (WING-Q, Co-Pilot) and discovery come later and
 * plug in next to `osc`.
 */
export class WingBridge {
  private settings: BridgeSettings | null = null;
  private osc: WingBridgeOsc | null = null;
  private oscKey = "";
  private client: WingOscClient | null = null;
  private rules: SafeRules = buildSafeRules(emptyBridgeSafes(), () => undefined);
  private readonly sources = new Map<string, StripSources>();
  private resolveGeneration = 0;
  private readonly recentBlocks: BridgeBlockedWrite[] = [];
  private lastError: string | null = null;
  /** Serializes listener restarts: two quick config saves must not race to bind the same port. */
  private chain: Promise<void> = Promise.resolve();

  private readonly onPush = (msg: { address: string; args: OscArgument[] }): void => {
    this.osc?.handleConsolePush(msg.address, msg.args);
  };

  constructor(private readonly cache: WingStateCache) {}

  /** Applies `next`; restarts the OSC listener only when its port, interface or console changed. Never throws. */
  configure(next: BridgeSettings): Promise<void> {
    const previous = this.settings;
    this.settings = next;
    if (!previous || JSON.stringify(previous.safes) !== JSON.stringify(next.safes) || previous.protectGlobal !== next.protectGlobal) {
      this.rebuildRules();
      void this.resolveSources();
    }
    const key = listenerKey(next);
    if (key === this.oscKey) return this.chain;
    this.oscKey = key;
    const run = this.chain.then(() => this.restartOsc(next));
    this.chain = run.catch(() => undefined);
    return this.chain;
  }

  /** The plugin's current OSC client (or null while disconnected): its pushes feed subscribed clients. */
  attachClient(client: WingOscClient | null): void {
    if (this.client === client) return;
    this.client?.off("push", this.onPush);
    this.client = client;
    client?.on("push", this.onPush);
    if (client) void this.resolveSources();
  }

  /** Every subscription push, so a re-patch of a safe strip moves its protected source with it. */
  onParamChange(change: WingParamChange): void {
    const match = CONN_PATH_RE.exec(change.path);
    if (!match || !this.settings) return;
    const kind = match[1] as "ch" | "aux";
    if (!this.settings.safes[kind].includes(Number(match[2]))) return;
    void this.resolveSources();
  }

  getRules(): SafeRules {
    return this.rules;
  }

  getStatus(): BridgeStatus {
    const s = this.settings;
    const safes = s?.safes ?? emptyBridgeSafes();
    const safeCount = countSafes(safes);
    return {
      enabled: s?.enabled ?? false,
      osc: this.osc ? { enabled: true, ...this.osc.getStats() } : s ? { enabled: false, ...idleOscStats(s.oscPort) } : null,
      native: { enabled: s?.native ?? false, available: false },
      discovery: { enabled: s?.discovery ?? false, available: false },
      bindAddress: s?.bindAddress ?? "",
      protectGlobal: s?.protectGlobal ?? true,
      safes,
      safeCount,
      safesState: safeCount === 0 ? "none" : this.rules.sourcesReady ? "ready" : "resolving",
      protectedRoots: this.rules.walkTargets(),
      clients: (this.osc?.getClients() ?? []).map((client) => ({ ...client, transport: "osc" as const })),
      recentBlocks: [...this.recentBlocks].reverse(),
      lastError: this.lastError,
    };
  }

  async close(): Promise<void> {
    this.attachClient(null);
    this.oscKey = "";
    const run = this.chain.then(() => this.stopOsc());
    this.chain = run.catch(() => undefined);
    await this.chain;
  }

  private async restartOsc(settings: BridgeSettings): Promise<void> {
    await this.stopOsc();
    if (!settings.enabled || !settings.osc) return;
    const osc = new WingBridgeOsc({
      port: settings.oscPort,
      bindAddress: settings.bindAddress,
      consoleHost: settings.consoleHost,
      consolePort: settings.consoleOscPort,
      getRules: () => this.rules,
      onBlocked: (blocked) => this.noteBlocked(blocked),
    });
    try {
      await osc.start();
      this.osc = osc;
      this.lastError = null;
    } catch (err) {
      await osc.close().catch(() => undefined);
      this.lastError = `OSC bridge could not listen on port ${settings.oscPort}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[wing-bridge] ${this.lastError}`);
    }
  }

  private async stopOsc(): Promise<void> {
    const osc = this.osc;
    this.osc = null;
    if (osc) await osc.close();
  }

  private noteBlocked(blocked: BridgeBlockedWrite): void {
    this.recentBlocks.push(blocked);
    if (this.recentBlocks.length > MAX_RECENT_BLOCKS) this.recentBlocks.shift();
  }

  private rebuildRules(): void {
    const s = this.settings;
    if (!s) return;
    this.rules = buildSafeRules(s.safes, (kind, index) => this.sources.get(`${kind}:${index}`), { protectGlobal: s.protectGlobal });
  }

  /**
   * Reads the input patch of every safe channel/aux: from the state cache when it holds it,
   * otherwise from the console. A strip that cannot be read stays unknown, which keeps all of
   * `/io/in` protected rather than guessing.
   */
  private async resolveSources(): Promise<void> {
    const s = this.settings;
    if (!s) return;
    const generation = ++this.resolveGeneration;
    const wanted = (["ch", "aux"] as const).flatMap((kind) => s.safes[kind].map((index) => ({ kind, index })));
    const resolved = new Map<string, StripSources>();
    for (const { kind, index } of wanted) {
      const sources = await this.readSources(kind, index);
      if (generation !== this.resolveGeneration) return;
      if (sources) resolved.set(`${kind}:${index}`, sources);
    }
    this.sources.clear();
    for (const [key, value] of resolved) this.sources.set(key, value);
    this.rebuildRules();
  }

  private async readSources(kind: "ch" | "aux", index: number): Promise<StripSources | undefined> {
    const base = `/${kind}/${index}/in/conn`;
    const values: Record<string, number | string> = {};
    for (const leaf of ["grp", "in", "altgrp", "altin"]) {
      const cached = this.cache.get(`${base}/${leaf}`);
      if (cached) {
        values[leaf] = cached.value;
        continue;
      }
      if (!this.client) return undefined;
      try {
        const result = await this.client.get(`${base}/${leaf}`);
        if (result.kind !== "leaf") return undefined;
        values[leaf] = result.value;
      } catch {
        return undefined;
      }
    }
    const ref = (group: number | string | undefined, input: number | string | undefined) => {
      const g = String(group ?? "");
      const n = Number(input);
      return !g || g === "OFF" || !Number.isInteger(n) ? null : { group: g, index: n };
    };
    return { main: ref(values.grp, values.in), alt: ref(values.altgrp, values.altin) };
  }
}

function idleOscStats(port: number): WingBridgeOscStats {
  return { listening: false, port, upstreamSockets: 0, messagesIn: 0, forwarded: 0, blocked: 0, pushesSent: 0, dropped: 0, lastError: null };
}

// ---------------------------------------------------------------------------------------------
// Changing the bridge from a tool or the dashboard. Both persist through ctx.updateConfig, the same
// path as the Config tab, so the change survives a restart and the next config save keeps it.

/** What `wing_bridge_configure` and `POST /bridge` accept. Native proxy and discovery come later. */
export const BRIDGE_CONFIGURE_SHAPE = {
  enabled: z.boolean().optional().describe("Turn the bridge on or off."),
  osc: z.boolean().optional().describe("Serve OSC apps (TouchOSC, Companion...)."),
  oscPort: z.number().int().min(1).max(65535).optional().describe("UDP port OSC apps connect to (2223 by default, like the console)."),
  bindAddress: z.string().optional().describe("Interface to listen on, e.g. the tablet-side NIC. Empty: every interface."),
  protectGlobal: z
    .boolean()
    .optional()
    .describe("While any strip is safe, also refuse scene recall (/$ctl/lib) and /cfg writes from bridged clients."),
};

const indexList = (max: number) => z.array(z.number().int().min(1).max(max)).optional();

/** What `wing_bridge_set_safes` and `PUT|POST /bridge/safes` accept. */
export const BRIDGE_SAFES_SHAPE = {
  mode: z
    .enum(["replace", "add", "remove"])
    .optional()
    .describe("replace (default): the lists given become the whole set, kinds left out are cleared. add/remove: change only what is listed."),
  ch: indexList(CHANNEL_COUNT),
  aux: indexList(AUX_COUNT),
  bus: indexList(BUS_COUNT),
  main: indexList(MAIN_COUNT),
  mtx: indexList(MATRIX_COUNT),
  dca: indexList(DCA_COUNT),
};

export type BridgeConfigureInput = { [K in keyof typeof BRIDGE_CONFIGURE_SHAPE]?: z.infer<(typeof BRIDGE_CONFIGURE_SHAPE)[K]> };
export type BridgeSafesMode = "replace" | "add" | "remove";
export type BridgeSafesChange = Partial<BridgeSafes>;

export function applySafesChange(current: BridgeSafes, mode: BridgeSafesMode, change: BridgeSafesChange): BridgeSafes {
  const next = emptyBridgeSafes();
  for (const kind of Object.keys(next) as (keyof BridgeSafes)[]) {
    const given = change[kind];
    const have = current[kind] ?? [];
    let values: number[];
    if (mode === "replace") values = given ?? [];
    else if (mode === "add") values = [...have, ...(given ?? [])];
    else values = have.filter((n) => !(given ?? []).includes(n));
    next[kind] = [...new Set(values)].sort((a, b) => a - b);
  }
  return next;
}

async function persist(ctx: WingPluginContext, patch: Partial<WingConfig>): Promise<BridgeStatus> {
  try {
    await ctx.updateConfig(patch);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new WingValueError(err.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; "));
    }
    throw err;
  }
  return ctx.bridge.getStatus();
}

export function configureBridge(ctx: WingPluginContext, input: BridgeConfigureInput): Promise<BridgeStatus> {
  const patch: Partial<WingConfig> = {};
  if (input.enabled !== undefined) patch.bridgeEnabled = input.enabled;
  if (input.osc !== undefined) patch.bridgeOsc = input.osc;
  if (input.oscPort !== undefined) patch.bridgeOscPort = input.oscPort;
  if (input.bindAddress !== undefined) patch.bridgeBindAddress = input.bindAddress.trim();
  if (input.protectGlobal !== undefined) patch.bridgeProtectGlobal = input.protectGlobal;
  if (Object.keys(patch).length === 0) {
    throw new WingValueError("Nothing to change: pass at least one of enabled, osc, oscPort, bindAddress, protectGlobal.");
  }
  return persist(ctx, patch);
}

export function setBridgeSafes(ctx: WingPluginContext, mode: BridgeSafesMode, change: BridgeSafesChange): Promise<BridgeStatus> {
  const next = applySafesChange(ctx.getConfig().bridgeSafes, mode, change);
  return persist(ctx, { bridgeSafes: next });
}
