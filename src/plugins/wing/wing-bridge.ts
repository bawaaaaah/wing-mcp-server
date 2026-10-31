import type { OscArgument } from "osc";
import { z } from "zod";
import { WingBridgeOsc, type BridgeBlockedWrite, type BridgeOscClientInfo, type WingBridgeOscStats } from "./wing-bridge-osc.js";
import { buildClientPolicy, buildSafeRules, countSafes, policyFromRules, type ClientPolicy, type SafeRules, type StripSources } from "./wing-bridge-safes.js";
import { MacResolver, matchProfile, parseDeviceModel, type ClientIdentity } from "./wing-bridge-identity.js";
import { WingBridgeMeters, type BridgeMeterStatus } from "./wing-bridge-meters.js";
import { WingNativeProxy, type NativeProxyStatus } from "./wing-bridge-native.js";
import { WingDiscoveryResponder, type DiscoveryResponderStatus } from "./wing-bridge-discovery.js";
import type { WingDiscoveryResult } from "./wing-discovery.js";
import type { WingMeterClient } from "./wing-meter-client.js";
import { BridgeProfileSchema, emptyBridgeSafes, type BridgeProfile, type BridgeSafes, type WingConfig } from "./wing-config.js";
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
  profiles: BridgeProfile[];
  consoleHost: string;
  consoleOscPort: number;
  /** The console's native TCP port (the server's meter connection uses it too). */
  consoleNativePort: number;
  consoleDiscoveryPort: number;
}

export interface BridgeStatus {
  enabled: boolean;
  osc: (WingBridgeOscStats & { enabled: boolean }) | null;
  native: { enabled: boolean; available: true; proxy: NativeProxyStatus | null; meters: BridgeMeterStatus };
  discovery: { enabled: boolean; available: true; responder: DiscoveryResponderStatus | null };
  bindAddress: string;
  protectGlobal: boolean;
  safes: BridgeSafes;
  safeCount: number;
  /** "ready" once every safe channel/aux's input patch is known; until then all of /io/in is refused. */
  safesState: "none" | "resolving" | "ready";
  protectedRoots: string[];
  profiles: BridgeProfile[];
  clients: (BridgeOscClientInfo & { transport: "osc" | "native"; identity: BridgeClientIdentityStatus })[];
  recentBlocks: BridgeBlockedWrite[];
  lastError: string | null;
}

/** Who a client is, as far as the bridge can tell, and which profile that gives it. */
export interface BridgeClientIdentityStatus {
  mac: string | null;
  model: string | null;
  /** The matching profile's id, or null for the global safes; undefined while still identifying. */
  profile: string | null | undefined;
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
    profiles: config.bridgeProfiles,
    consoleHost: config.host,
    consoleOscPort: config.oscPort,
    consoleNativePort: config.meterTcpPort,
    consoleDiscoveryPort: config.discoveryPort,
  };
}

const MAX_RECENT_BLOCKS = 50;
/** A push on one of these, for a safe strip, means its input patch changed: resolve it again. */
const CONN_PATH_RE = /^\/(ch|aux)\/(\d+)\/in\/conn\/(grp|in|altgrp|altin)$/;

/** Only these change what the OSC listener is: the rest (safes, protection) apply in place. */
function listenerKey(s: BridgeSettings): string {
  return JSON.stringify([s.enabled && s.osc, s.oscPort, s.bindAddress, s.consoleHost, s.consoleOscPort]);
}

function nativeKey(s: BridgeSettings): string {
  return JSON.stringify([s.enabled && s.native, s.nativePort, s.bindAddress, s.consoleHost, s.consoleNativePort]);
}

function discoveryKey(s: BridgeSettings): string {
  return JSON.stringify([s.enabled && s.native && s.discovery, s.nativePort, s.consoleHost, s.consoleDiscoveryPort, s.name, s.advertiseHost, s.serialMode]);
}

/** Which FX an insert holds: a mix profile may set that FX's parameters, so the bridge follows it. */
const INSERT_PATH_RE = /^\/(bus|main|mtx)\/(\d+)\/(preins|postins)\/ins$/;

/** A processing model leaf: changing it gives the nodes below its parent new ids (assumed, A15). */
const MODEL_PATH_RE = /^(.*)\/\$?mdl$/i;

/**
 * Tablets and OSC apps connect to this server instead of the console, so the console sees one
 * connection, and strips marked safe cannot be changed from them. Owned by WingPlugin for the
 * process lifetime like the OSC mirror, and wired to whichever OSC client is current
 * (`attachClient`). Safes bind only bridged clients: MCP tools and the dashboard are not affected.
 *
 * Three listeners, each started and stopped on its own: `osc` (OSC apps), `native` (WING-Q,
 * Co-Pilot, WING Edit: all of them on one console connection, meters served from the server's own
 * subscription by `meters`) and `discovery` (answers WING? so those apps list the bridge).
 */
export class WingBridge {
  private settings: BridgeSettings | null = null;
  private osc: WingBridgeOsc | null = null;
  private oscKey = "";
  private native: WingNativeProxy | null = null;
  private nativeKeyInUse = "";
  private discovery: WingDiscoveryResponder | null = null;
  private discoveryKeyInUse = "";
  private readonly meters = new WingBridgeMeters();
  private ioSizesReading: Promise<void> | null = null;
  private client: WingOscClient | null = null;
  private rules: SafeRules = buildSafeRules(emptyBridgeSafes(), () => undefined);
  private globalPolicy: ClientPolicy = policyFromRules(this.rules);
  private readonly profilePolicies = new Map<string, ClientPolicy>();
  private readonly macResolver = new MacResolver();
  /** Identities by "ip|user agent", looked up once (MAC from ARP) and refreshed after a minute. */
  private readonly identities = new Map<string, { identity: ClientIdentity | null; at: number; looking: boolean }>();
  private readonly sources = new Map<string, StripSources>();
  /** FX slots inserted in each bus/main/matrix a mix profile allows ("bus:6" -> [3]). */
  private readonly inserts = new Map<string, number[]>();
  private insertGeneration = 0;
  private resolveGeneration = 0;
  private readonly recentBlocks: BridgeBlockedWrite[] = [];
  private lastError: string | null = null;
  /** Serializes listener restarts: two quick config saves must not race to bind the same port. */
  private chain: Promise<void> = Promise.resolve();

  private readonly onPush = (msg: { address: string; args: OscArgument[] }): void => {
    this.osc?.handleConsolePush(msg.address, msg.args);
  };

  constructor(private readonly cache: WingStateCache) {
    this.meters.onNeedIoSizes = (meterClient) => {
      this.ioSizesReading ??= this.readIoSizes(meterClient).finally(() => (this.ioSizesReading = null));
    };
  }

  /**
   * Reads how many inputs/outputs each I/O group has (`/io/in`, `/io/out`, in the console's order):
   * a tablet's `source`/`output` meters are that long, and are held back until it is known.
   */
  private async readIoSizes(meterClient: WingMeterClient): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const sizesOf = async (direction: "in" | "out"): Promise<number[]> => {
        const groups = await client.get(`/io/${direction}`);
        if (groups.kind !== "branch") throw new Error(`/io/${direction} is not a branch`);
        const sizes: number[] = [];
        for (const group of groups.children) {
          const entries = await client.get(`/io/${direction}/${group}`);
          sizes.push(entries.kind === "branch" ? entries.children.length : 0);
        }
        return sizes;
      };
      meterClient.setIoSizes({ source: await sizesOf("in"), output: await sizesOf("out") });
    } catch (err) {
      this.lastError = `could not read the I/O group sizes for tablet meters: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Applies `next`; restarts the OSC listener only when its port, interface or console changed. Never throws. */
  configure(next: BridgeSettings): Promise<void> {
    const previous = this.settings;
    this.settings = next;
    if (
      !previous ||
      JSON.stringify(previous.safes) !== JSON.stringify(next.safes) ||
      previous.protectGlobal !== next.protectGlobal ||
      JSON.stringify(previous.profiles) !== JSON.stringify(next.profiles)
    ) {
      this.rebuildRules();
      void this.resolveSources();
      void this.resolveInserts();
    }
    const steps: (() => Promise<void>)[] = [];
    const key = listenerKey(next);
    if (key !== this.oscKey) {
      this.oscKey = key;
      steps.push(() => this.restartOsc(next));
    }
    const nKey = nativeKey(next);
    if (nKey !== this.nativeKeyInUse) {
      this.nativeKeyInUse = nKey;
      steps.push(() => this.restartNative(next));
    }
    const dKey = discoveryKey(next);
    if (dKey !== this.discoveryKeyInUse) {
      this.discoveryKeyInUse = dKey;
      steps.push(() => this.restartDiscovery(next));
    }
    for (const step of steps) {
      const run = this.chain.then(step);
      this.chain = run.catch(() => undefined);
    }
    return this.chain;
  }

  /** The plugin's current meter client (null while disconnected): tablets' meters come from it. */
  attachMeterClient(client: WingMeterClient | null): void {
    this.meters.attachMeterClient(client);
  }

  /** True when a discovery result is this bridge answering, so a console search can leave it out. */
  isOwnDiscoveryReply(result: WingDiscoveryResult): boolean {
    return this.discovery?.isOwnReply(result) ?? false;
  }

  /** The plugin's current OSC client (or null while disconnected): its pushes feed subscribed clients. */
  attachClient(client: WingOscClient | null): void {
    if (this.client === client) return;
    this.client?.off("push", this.onPush);
    this.client = client;
    client?.on("push", this.onPush);
    if (client) {
      void this.resolveSources();
      void this.resolveInserts();
    }
  }

  /** Every subscription push, so a re-patch of a safe strip moves its protected source with it. */
  onParamChange(change: WingParamChange): void {
    const model = MODEL_PATH_RE.exec(change.path);
    if (model && this.native && this.hasRestrictions()) {
      this.native.forgetSubtree(model[1]);
    }
    const insert = INSERT_PATH_RE.exec(change.path);
    if (insert && this.mixStrips().some((strip) => strip.kind === insert[1] && strip.index === Number(insert[2]))) {
      void this.resolveInserts();
    }
    const match = CONN_PATH_RE.exec(change.path);
    if (!match || !this.settings) return;
    const kind = match[1] as "ch" | "aux";
    if (!this.safeStrips(kind).includes(Number(match[2]))) return;
    void this.resolveSources();
  }

  /** Anything restricted for anyone: global safes, or a device profile. */
  private hasRestrictions(): boolean {
    return !this.rules.empty || (this.settings?.profiles.length ?? 0) > 0;
  }

  /** Buses/mains/matrices a "mix" profile allows: the FX inserted in them is followed (resolveInserts). */
  private mixStrips(): { kind: "bus" | "main" | "mtx"; index: number }[] {
    const strips = new Map<string, { kind: "bus" | "main" | "mtx"; index: number }>();
    for (const profile of this.settings?.profiles ?? []) {
      if (profile.mode !== "allow" || profile.scope !== "mix") continue;
      for (const kind of ["bus", "main", "mtx"] as const) {
        for (const index of profile.allow[kind]) strips.set(`${kind}:${index}`, { kind, index });
      }
    }
    return [...strips.values()];
  }

  /**
   * Reads which FX slot each insert of those strips holds — state cache first, then the console. A
   * strip that cannot be read keeps no FX writable rather than guessing.
   */
  private async resolveInserts(): Promise<void> {
    const generation = ++this.insertGeneration;
    const resolved = new Map<string, number[]>();
    for (const { kind, index } of this.mixStrips()) {
      const slots: number[] = [];
      let known = true;
      for (const insert of ["preins", "postins"]) {
        const path = `/${kind}/${index}/${insert}/ins`;
        let value = this.cache.get(path)?.value;
        if (value === undefined && this.client) {
          try {
            const result = await this.client.get(path);
            if (result.kind === "leaf") value = result.value;
          } catch {
            // Unknown: no FX writable for this strip.
          }
        }
        if (value === undefined) known = false;
        const slot = /^FX(\d+)$/i.exec(String(value ?? ""));
        if (slot) slots.push(Number(slot[1]));
      }
      if (generation !== this.insertGeneration) return;
      if (known) resolved.set(`${kind}:${index}`, slots);
    }
    this.inserts.clear();
    for (const [key, value] of resolved) this.inserts.set(key, value);
    this.rebuildRules();
  }

  /** Channels/auxes made safe globally or by a profile: their input patch decides what /io/in protects. */
  private safeStrips(kind: "ch" | "aux"): number[] {
    const s = this.settings;
    if (!s) return [];
    return [...new Set([...s.safes[kind], ...s.profiles.flatMap((p) => (p.mode === "safes" ? p.safes[kind] : []))])];
  }

  /**
   * The policy for one client. With no device profile, everyone gets the global safes. Otherwise the
   * client is identified first — IP, model from its user agent, and MAC from the ARP table when a
   * profile asks for one — and gets its profile's policy, or the global one when none matches. Null
   * while that first lookup runs (a few ms): its writes are refused meanwhile, never let through.
   */
  policyFor(client: { address: string; userAgent?: string }): ClientPolicy | null {
    const profiles = this.settings?.profiles ?? [];
    if (profiles.length === 0) return this.globalPolicy;
    const identity = this.identify(client);
    if (!identity) return null;
    const profile = matchProfile(profiles, identity);
    return profile ? (this.profilePolicies.get(profile.id) ?? null) : this.globalPolicy;
  }

  /**
   * The client's identity. Its MAC is looked up (ARP, cached a minute) the first time it is seen,
   * profiles or not, so the Bridge tab can show it and a profile can be keyed on it. Returns null only
   * while a profile needs the MAC and the first lookup has not answered yet.
   */
  private identify(client: { address: string; userAgent?: string }): ClientIdentity | null {
    const model = parseDeviceModel(client.userAgent);
    const key = `${client.address}|${client.userAgent ?? ""}`;
    const entry = this.identities.get(key);
    if ((!entry || Date.now() - entry.at > 60_000) && !entry?.looking) {
      this.identities.set(key, { identity: entry?.identity ?? null, at: entry?.at ?? 0, looking: true });
      void this.macResolver.lookup(client.address).then((mac) => {
        this.identities.set(key, { identity: { ip: client.address, mac, model }, at: Date.now(), looking: false });
      });
    }
    const known = this.identities.get(key)?.identity;
    if (known) return known;
    const needsMac = (this.settings?.profiles ?? []).some((p) => p.match.mac);
    return needsMac ? null : { ip: client.address, mac: null, model };
  }

  private identityStatus(client: { address: string; userAgent?: string }): BridgeClientIdentityStatus {
    const profiles = this.settings?.profiles ?? [];
    const identity = this.identify(client);
    if (!identity) return { mac: null, model: parseDeviceModel(client.userAgent), profile: undefined };
    return { mac: identity.mac, model: identity.model, profile: matchProfile(profiles, identity)?.id ?? null };
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
      native: { enabled: s?.native ?? false, available: true, proxy: this.native?.getStatus() ?? null, meters: this.meters.getStatus() },
      discovery: { enabled: s?.discovery ?? false, available: true, responder: this.discovery?.getStatus() ?? null },
      bindAddress: s?.bindAddress ?? "",
      protectGlobal: s?.protectGlobal ?? true,
      safes,
      safeCount,
      safesState: safeCount === 0 ? "none" : this.rules.sourcesReady ? "ready" : "resolving",
      protectedRoots: this.rules.walkTargets(),
      profiles: s?.profiles ?? [],
      clients: [
        ...(this.osc?.getClients() ?? []).map((client) => ({ ...client, transport: "osc" as const, identity: this.identityStatus(client) })),
        ...(this.native?.getStatus().sessions ?? []).map((session) => ({
          address: session.address.replace(/:\d+$/, ""),
          port: Number(session.address.split(":").pop()),
          firstSeenAt: session.since,
          lastSeenAt: Date.now(),
          messages: session.requests + session.writesForwarded + session.writesBlocked,
          writesForwarded: session.writesForwarded,
          writesBlocked: session.writesBlocked,
          subscription: null,
          transport: "native" as const,
          identity: this.identityStatus({ address: session.address.replace(/:\d+$/, ""), userAgent: session.userAgent ?? undefined }),
        })),
      ],
      recentBlocks: [...this.recentBlocks].reverse(),
      lastError: this.lastError,
    };
  }

  async close(): Promise<void> {
    this.attachClient(null);
    this.oscKey = "";
    this.nativeKeyInUse = "";
    this.discoveryKeyInUse = "";
    const run = this.chain.then(async () => {
      await this.stopOsc();
      await this.stopNative();
      await this.stopDiscovery();
    });
    this.chain = run.catch(() => undefined);
    await this.chain;
    this.meters.close();
  }

  private async restartNative(settings: BridgeSettings): Promise<void> {
    await this.stopNative();
    if (!settings.enabled || !settings.native || !settings.consoleHost) return;
    const native = new WingNativeProxy({
      consoleHost: () => settings.consoleHost,
      consolePort: () => settings.consoleNativePort,
      listenPort: settings.nativePort,
      bindAddress: settings.bindAddress || "0.0.0.0",
      safety: {
        hasSafes: () => this.hasRestrictions(),
        policyFor: (client) => this.policyFor(client),
        walkTargets: () => [...new Set([this.globalPolicy, ...this.profilePolicies.values()].flatMap((policy) => policy.walkPatterns()))],
      },
      createMeterSession: (peer) => this.meters.createSession(peer),
    });
    native.on("blocked", (entry: { at: number; client: string; path: string | null; reason: string }) =>
      this.noteBlocked({ at: entry.at, transport: "native", client: entry.client, path: entry.path ?? "(node not mapped)", reason: entry.reason }),
    );
    try {
      await native.start();
      this.native = native;
    } catch (err) {
      await native.stop().catch(() => undefined);
      this.lastError = `native bridge could not listen on port ${settings.nativePort}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[wing-bridge] ${this.lastError}`);
    }
  }

  private async stopNative(): Promise<void> {
    const native = this.native;
    this.native = null;
    if (native) await native.stop();
  }

  private async restartDiscovery(settings: BridgeSettings): Promise<void> {
    await this.stopDiscovery();
    if (!settings.enabled || !settings.native || !settings.discovery || !settings.consoleHost) return;
    const discovery = new WingDiscoveryResponder({
      port: settings.nativePort,
      consoleHost: settings.consoleHost,
      consoleDiscoveryPort: settings.consoleDiscoveryPort,
      name: settings.name,
      advertiseHost: settings.advertiseHost,
      serialMode: settings.serialMode,
    });
    try {
      await discovery.start();
      this.discovery = discovery;
      this.meters.setSender((packet, port, address) => discovery.send(packet, port, address));
    } catch (err) {
      await discovery.close().catch(() => undefined);
      this.lastError = `discovery could not listen on UDP ${settings.nativePort}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[wing-bridge] ${this.lastError}`);
    }
  }

  private async stopDiscovery(): Promise<void> {
    const discovery = this.discovery;
    this.discovery = null;
    this.meters.setSender(null);
    if (discovery) await discovery.close();
  }

  private async restartOsc(settings: BridgeSettings): Promise<void> {
    await this.stopOsc();
    if (!settings.enabled || !settings.osc) return;
    const osc = new WingBridgeOsc({
      port: settings.oscPort,
      bindAddress: settings.bindAddress,
      consoleHost: settings.consoleHost,
      consolePort: settings.consoleOscPort,
      getPolicy: (client) => this.policyFor(client),
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
    const lookup = (kind: "ch" | "aux", index: number) => this.sources.get(`${kind}:${index}`);
    this.rules = buildSafeRules(s.safes, lookup, { protectGlobal: s.protectGlobal });
    this.globalPolicy = policyFromRules(this.rules);
    this.profilePolicies.clear();
    for (const profile of s.profiles) {
      this.profilePolicies.set(
        profile.id,
        buildClientPolicy(profile, s.safes, lookup, { protectGlobal: s.protectGlobal }, (kind, index) => this.inserts.get(`${kind}:${index}`)),
      );
    }
    // What is protected moved: native writes wait until the node map covers it again.
    this.native?.markMapStale();
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
    const wanted = (["ch", "aux"] as const).flatMap((kind) => this.safeStrips(kind).map((index) => ({ kind, index })));
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

/** What `wing_bridge_configure` and `POST /bridge` accept. */
export const BRIDGE_CONFIGURE_SHAPE = {
  enabled: z.boolean().optional().describe("Turn the bridge on or off."),
  osc: z.boolean().optional().describe("Serve OSC apps (TouchOSC, Companion...)."),
  oscPort: z.number().int().min(1).max(65535).optional().describe("UDP port OSC apps connect to (2223 by default, like the console)."),
  native: z.boolean().optional().describe("Serve the console's own apps (WING-Q, Co-Pilot, WING Edit), all on one console connection."),
  nativePort: z.number().int().min(1).max(65535).optional().describe("TCP port native apps connect to (2222 by default, like the console)."),
  discovery: z.boolean().optional().describe("Answer WING? discovery (UDP, native port) so native apps list the bridge."),
  name: z.string().max(16).optional().describe('Name native apps see. Empty: the console\'s name followed by "-BR".'),
  advertiseHost: z.string().optional().describe("Address put in discovery replies. Empty: the interface facing each app."),
  serialMode: z.enum(["derived", "real"]).optional().describe('"derived" (default) advertises "<serial>-BR" so apps keep the bridge and the console apart; "real" the console\'s own.'),
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
  if (input.native !== undefined) patch.bridgeNative = input.native;
  if (input.nativePort !== undefined) patch.bridgeNativePort = input.nativePort;
  if (input.discovery !== undefined) patch.bridgeDiscovery = input.discovery;
  if (input.name !== undefined) patch.bridgeName = input.name.trim();
  if (input.advertiseHost !== undefined) patch.bridgeAdvertiseHost = input.advertiseHost.trim();
  if (input.serialMode !== undefined) patch.bridgeSerialMode = input.serialMode;
  if (input.bindAddress !== undefined) patch.bridgeBindAddress = input.bindAddress.trim();
  if (input.protectGlobal !== undefined) patch.bridgeProtectGlobal = input.protectGlobal;
  if (Object.keys(patch).length === 0) {
    throw new WingValueError(`Nothing to change: pass at least one of ${Object.keys(BRIDGE_CONFIGURE_SHAPE).join(", ")}.`);
  }
  return persist(ctx, patch);
}

/** What `wing_bridge_set_profiles` and the profile routes accept. */
export const BRIDGE_PROFILES_SHAPE = {
  mode: z
    .enum(["replace", "upsert", "remove"])
    .optional()
    .describe("replace (default): `profiles` becomes the whole list. upsert: add or update `profiles` by id. remove: delete the profiles whose id is in `ids`."),
  profiles: z.array(BridgeProfileSchema).optional(),
  ids: z.array(z.string()).optional(),
};

export type BridgeProfilesMode = "replace" | "upsert" | "remove";

export function applyProfilesChange(current: BridgeProfile[], mode: BridgeProfilesMode, profiles: BridgeProfile[] = [], ids: string[] = []): BridgeProfile[] {
  if (mode === "replace") return profiles;
  if (mode === "remove") return current.filter((p) => !ids.includes(p.id));
  const next = [...current];
  for (const profile of profiles) {
    const at = next.findIndex((p) => p.id === profile.id);
    if (at >= 0) next[at] = profile;
    else next.push(profile);
  }
  return next;
}

export function setBridgeProfiles(ctx: WingPluginContext, mode: BridgeProfilesMode, profiles?: BridgeProfile[], ids?: string[]): Promise<BridgeStatus> {
  if (mode === "remove" && !ids?.length) throw new WingValueError("remove needs `ids`.");
  if (mode !== "remove" && !profiles) throw new WingValueError(`${mode} needs \`profiles\`.`);
  return persist(ctx, { bridgeProfiles: applyProfilesChange(ctx.getConfig().bridgeProfiles, mode, profiles, ids) });
}

export function setBridgeSafes(ctx: WingPluginContext, mode: BridgeSafesMode, change: BridgeSafesChange): Promise<BridgeStatus> {
  const next = applySafesChange(ctx.getConfig().bridgeSafes, mode, change);
  return persist(ctx, { bridgeSafes: next });
}
