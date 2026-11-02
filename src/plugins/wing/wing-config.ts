import { z } from "zod";
import { getEnvBool, getEnvInt, getEnvString } from "../../core/env.js";

/**
 * One stage box plugged into a range of an AES50/StageConnect port, e.g. ports 9..16 of AES50-A are
 * a DL8's local inputs 1..8. Used to label patch exports with the physical connector a source is.
 */
export const WingBoxSchema = z.object({
  range: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  device: z.string().min(1),
  model: z.string().optional(),
  /** The box's own port numbers for `range`; defaults to 1..(range length). */
  localPorts: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
});
export type WingBox = z.infer<typeof WingBoxSchema>;

/** Keyed by console I/O group: "A", "B", "C" (AES50), "SC" (StageConnect), "LCL", ... */
export const WingBoxMapSchema = z.record(z.string(), z.array(WingBoxSchema));
export type WingBoxMap = z.infer<typeof WingBoxMapSchema>;

/** Strips a bridged client may not change — see wing-bridge-safes.ts. 1-based, as the console shows them. */
export const BridgeSafesSchema = z.object({
  ch: z.array(z.number().int().min(1)).default([]),
  aux: z.array(z.number().int().min(1)).default([]),
  bus: z.array(z.number().int().min(1)).default([]),
  main: z.array(z.number().int().min(1)).default([]),
  mtx: z.array(z.number().int().min(1)).default([]),
  dca: z.array(z.number().int().min(1)).default([]),
});
export type BridgeSafes = z.infer<typeof BridgeSafesSchema>;

export function emptyBridgeSafes(): BridgeSafes {
  return { ch: [], aux: [], bus: [], main: [], mtx: [], dca: [] };
}

/**
 * Rights for one device on the bridge (see wing-bridge-safes.ts, buildClientPolicy). Recognised by
 * every criterion given in `match` (IP, MAC from the server's ARP table, model from WING-Q's user
 * agent). Global safes apply too, unless an "allow" profile turns `applyGlobal` off.
 * - mode "allow": only the strips listed in `allow` may be changed; everything else is read-only.
 *   `scope` "mix": an allowed bus/main/matrix entirely (it is the device's own mix) — its inserts may
 *   be switched and their FX's parameters set, not which FX is loaded nor its model, nor its own
 *   outgoing sends to matrices/buses/mains — only the mixing
 *   controls of the sends into it (level, on, pan, pre/post, pan links), and only fader/mute/pan of an
 *   allowed channel/aux/DCA, whose processing reaches every mix. "full": everything about them.
 * - mode "safes": `safes` are added to the global safes for this device.
 */
export const BridgeProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "id: lowercase letters, digits and dashes"),
  name: z.string().min(1).max(40),
  match: z
    .object({
      ip: z.string().trim().optional(),
      mac: z.string().trim().optional(),
      model: z.string().trim().optional(),
    })
    .refine((m) => Boolean(m.ip || m.mac || m.model), "match needs at least one of ip, mac, model"),
  mode: z.enum(["allow", "safes"]),
  scope: z.enum(["mix", "full"]).default("mix"),
  /**
   * "allow" only: whether the global safe strips still hold for this device (default). Off, the
   * profile's own list wins: e.g. every bus safe for unknown devices, each musician given theirs.
   */
  applyGlobal: z.boolean().default(true),
  allow: BridgeSafesSchema.default(emptyBridgeSafes()),
  safes: BridgeSafesSchema.default(emptyBridgeSafes()),
});
export type BridgeProfile = z.infer<typeof BridgeProfileSchema>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const WingConfigSchema = z
  .object({
    // Empty string means "not configured yet" — the plugin must boot successfully either way
    // (the whole point of the dashboard's Config tab is to let the user set this *after* the
    // server is already running), and simply skip connecting until a real host is set.
    host: z.string(),
    oscPort: z.number().int().default(2223),
    discoveryPort: z.number().int().default(2222),
    meterTcpPort: z.number().int().default(2222),
    meterUdpPort: z.number().int().default(14135),
    warmCacheOnConnect: z.boolean().default(true),
    // Raw OSC/meter mirror (see wing-osc-mirror.ts) — off by default. Unlike the connection
    // fields above, changing these never reconnects the console clients (see
    // WingPlugin.connectionSettingsChanged) — they only reconfigure WingPlugin's own oscMirror.
    oscMirrorEnabled: z.boolean().default(false),
    oscMirrorHost: z.string().default(""),
    oscMirrorPort: z.number().int().default(0),
    // Show mode: every audible write (anything but name/color/icon/led/tags/clink), from any tool, is
    // refused unless the call passes confirm: true. See journalWriteTools in tools/index.ts.
    showMode: z.boolean().default(false),
    // What is plugged into each AES50/StageConnect port range — see WingBoxSchema.
    boxMap: WingBoxMapSchema.default({}),
    // Bridge (see wing-bridge.ts): tablets and OSC apps connect to this server instead of the
    // console. Like the mirror, changing these never reconnects the console clients.
    bridgeEnabled: z.boolean().default(false),
    bridgeOsc: z.boolean().default(true),
    // The native proxy (WING-Q / Co-Pilot / WING Edit, see wing-bridge-native.ts). Off by default
    // until checked against a real tablet: its design rests on assumptions the capture tool verifies.
    bridgeNative: z.boolean().default(false),
    bridgeOscPort: z.number().int().default(2223),
    bridgeNativePort: z.number().int().default(2222),
    // Answer WING? on UDP bridgeNativePort so native apps list the bridge; only with bridgeNative.
    bridgeDiscovery: z.boolean().default(false),
    // Interface the bridge listens on; empty means every interface.
    bridgeBindAddress: z.string().default(""),
    bridgeName: z.string().default(""),
    bridgeAdvertiseHost: z.string().default(""),
    bridgeSerialMode: z.enum(["derived", "real"]).default("derived"),
    // While any strip is safe, bridged clients may not recall scenes or write /$ctl/lib or /cfg.
    bridgeProtectGlobal: z.boolean().default(true),
    bridgeSafes: BridgeSafesSchema.default(emptyBridgeSafes()),
    // How bridgeSafes reads: "blacklist" (default), the strips listed are protected; "whitelist", only
    // the strips listed may be changed by a device no profile matches, with bridgeSafesScope's reach
    // ("mix" or "full", as for a profile).
    bridgeSafesMode: z.enum(["blacklist", "whitelist"]).default("blacklist"),
    bridgeSafesScope: z.enum(["mix", "full"]).default("mix"),
    // Per-device rights (see BridgeProfileSchema); a device no profile matches gets the safes above.
    bridgeProfiles: z.array(BridgeProfileSchema).default([]),
  })
  .superRefine((config, ctx) => {
    for (const field of ["oscPort", "discoveryPort", "meterTcpPort", "meterUdpPort", "bridgeOscPort", "bridgeNativePort"] as const) {
      const value = config[field];
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be an integer between 1 and 65535 (got ${value}).` });
      }
    }
    if (config.bridgeEnabled) refineBridge(config, ctx);
    const ids = new Set<string>();
    for (const [i, profile] of config.bridgeProfiles.entries()) {
      if (ids.has(profile.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bridgeProfiles", i, "id"], message: `Duplicate profile id "${profile.id}".` });
      ids.add(profile.id);
    }
    if (!config.oscMirrorEnabled) {
      return;
    }
    if (!config.oscMirrorHost) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oscMirrorHost"], message: "A target host is required to enable the OSC mirror." });
    }
    if (!Number.isInteger(config.oscMirrorPort) || config.oscMirrorPort < 1 || config.oscMirrorPort > 65535) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oscMirrorPort"], message: "A valid port (1..65535) is required to enable the OSC mirror." });
    }
  });

export type WingConfig = z.infer<typeof WingConfigSchema>;

/**
 * Port clashes the bridge would only discover when binding, reported at save time instead. The
 * console's own ports matter only when the console runs on this machine (fake-wing in development):
 * a bridge listening on them would answer this server's own requests.
 */
function refineBridge(
  config: { host: string; oscPort: number; discoveryPort: number; meterTcpPort: number; bridgeOsc: boolean; bridgeNative: boolean; bridgeDiscovery: boolean; bridgeOscPort: number; bridgeNativePort: number },
  ctx: z.RefinementCtx,
): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (config.bridgeOsc && config.bridgeNative && config.bridgeOscPort === config.bridgeNativePort) {
    issue("bridgeNativePort", "The bridge's OSC and native ports must differ.");
  }
  const consoleIsLocal = LOCAL_HOSTS.has(config.host.trim().toLowerCase());
  if (!consoleIsLocal) return;
  const consolePorts = new Set([config.oscPort, config.discoveryPort, config.meterTcpPort]);
  if (config.bridgeOsc && consolePorts.has(config.bridgeOscPort)) {
    issue("bridgeOscPort", `The console runs on this machine and already uses port ${config.bridgeOscPort}: pick another bridge OSC port (e.g. 3223).`);
  }
  if ((config.bridgeNative || config.bridgeDiscovery) && consolePorts.has(config.bridgeNativePort)) {
    issue("bridgeNativePort", `The console runs on this machine and already uses port ${config.bridgeNativePort}: pick another bridge native port (e.g. 3222).`);
  }
}

/** "1,2, 5" -> [1, 2, 5]; anything that is not a positive integer is dropped. */
function envIndexList(name: string): number[] {
  return getEnvString(name, "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1);
}

export function wingConfigJsonSchema(): object {
  // The input side, so fields with a default stay out of `required` as they
  // did with zod-to-json-schema: the dashboard's schema-driven form (and
  // getConfigSchema()'s contract) walks this flat object schema directly.
  return z.toJSONSchema(WingConfigSchema, { io: "input", target: "draft-7" });
}

/**
 * Builds the default config from process.env, used only:
 * - on first boot (nothing persisted yet in the config store), and
 * - as a fallback if `configStore.get()` returns nothing.
 * Once persisted, the dashboard/config store is the source of truth.
 */
export function defaultWingConfigFromEnv(): WingConfig {
  return WingConfigSchema.parse({
    host: getEnvString("WING_HOST", ""),
    oscPort: getEnvInt("WING_OSC_PORT", 2223),
    discoveryPort: getEnvInt("WING_DISCOVERY_PORT", 2222),
    meterTcpPort: getEnvInt("WING_METER_TCP_PORT", 2222),
    meterUdpPort: getEnvInt("WING_METER_UDP_PORT", 14135),
    warmCacheOnConnect: true,
    oscMirrorEnabled: getEnvBool("WING_OSC_MIRROR_ENABLED", false),
    oscMirrorHost: getEnvString("WING_OSC_MIRROR_HOST", ""),
    oscMirrorPort: getEnvInt("WING_OSC_MIRROR_PORT", 0),
    showMode: getEnvBool("WING_SHOW_MODE", false),
    boxMap: {},
    bridgeEnabled: getEnvBool("WING_BRIDGE_ENABLED", false),
    bridgeOsc: getEnvBool("WING_BRIDGE_OSC", true),
    bridgeNative: getEnvBool("WING_BRIDGE_NATIVE", false),
    bridgeOscPort: getEnvInt("WING_BRIDGE_OSC_PORT", 2223),
    bridgeNativePort: getEnvInt("WING_BRIDGE_NATIVE_PORT", 2222),
    bridgeDiscovery: getEnvBool("WING_BRIDGE_DISCOVERY", false),
    bridgeBindAddress: getEnvString("WING_BRIDGE_BIND_ADDRESS", ""),
    bridgeName: getEnvString("WING_BRIDGE_NAME", ""),
    bridgeAdvertiseHost: getEnvString("WING_BRIDGE_ADVERTISE_HOST", ""),
    bridgeSerialMode: getEnvString("WING_BRIDGE_SERIAL_MODE", "derived") === "real" ? "real" : "derived",
    bridgeProtectGlobal: getEnvBool("WING_BRIDGE_PROTECT_GLOBAL", true),
    bridgeSafes: {
      ch: envIndexList("WING_BRIDGE_SAFE_CH"),
      aux: envIndexList("WING_BRIDGE_SAFE_AUX"),
      bus: envIndexList("WING_BRIDGE_SAFE_BUS"),
      main: envIndexList("WING_BRIDGE_SAFE_MAIN"),
      mtx: envIndexList("WING_BRIDGE_SAFE_MTX"),
      dca: envIndexList("WING_BRIDGE_SAFE_DCA"),
    },
  });
}

/** The bridge fields at their defaults — for building a full WingConfig by hand (tests, fixtures). */
export function bridgeConfigDefaults(): Pick<WingConfig, Extract<keyof WingConfig, `bridge${string}`>> {
  return {
    bridgeEnabled: false,
    bridgeOsc: true,
    bridgeNative: false,
    bridgeOscPort: 2223,
    bridgeNativePort: 2222,
    bridgeDiscovery: false,
    bridgeBindAddress: "",
    bridgeName: "",
    bridgeAdvertiseHost: "",
    bridgeSerialMode: "derived",
    bridgeProtectGlobal: true,
    bridgeSafes: emptyBridgeSafes(),
    bridgeSafesMode: "blacklist",
    bridgeSafesScope: "mix",
    bridgeProfiles: [],
  };
}
