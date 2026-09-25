import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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
export const WingBoxMapSchema = z.record(z.array(WingBoxSchema));
export type WingBoxMap = z.infer<typeof WingBoxMapSchema>;

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
  })
  .superRefine((config, ctx) => {
    for (const field of ["oscPort", "discoveryPort", "meterTcpPort", "meterUdpPort"] as const) {
      const value = config[field];
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be an integer between 1 and 65535 (got ${value}).` });
      }
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

export function wingConfigJsonSchema(): object {
  // No name argument: with a name, zod-to-json-schema wraps the schema in a
  // $ref/definitions indirection instead of returning a flat object schema
  // with `properties` at the top level, which is what the dashboard's
  // schema-driven form (and getConfigSchema()'s contract) expects to walk
  // directly.
  return zodToJsonSchema(WingConfigSchema);
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
  });
}
