import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getEnvInt, getEnvString } from "../../core/env.js";

export const WingConfigSchema = z.object({
  // Empty string means "not configured yet" — the plugin must boot successfully either way
  // (the whole point of the dashboard's Config tab is to let the user set this *after* the
  // server is already running), and simply skip connecting until a real host is set.
  host: z.string(),
  oscPort: z.number().int().default(2223),
  discoveryPort: z.number().int().default(2222),
  meterTcpPort: z.number().int().default(2222),
  meterUdpPort: z.number().int().default(14135),
  warmCacheOnConnect: z.boolean().default(true),
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
  });
}
