import { WingValueError } from "./wing-errors.js";
import type { WingBulkSetResult } from "./wing-osc-client.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Console lighting node (`/$ctl/cfg/lights`): 11 independent backlight/intensity zones, each an
 * integer percentage. Verified against `docs/WING_Remote-Protocols-3.1-03.pdf` — most zones accept
 * 0..100, but `leds`, `chlcds`, `chedit`, and `main` have a firmware-enforced floor of 5 (they can't
 * be switched fully off). No field in this node is marked `[RO]`.
 */

export const LIGHTING_ZONE_RANGES = {
  btns: { min: 0, max: 100 },
  leds: { min: 5, max: 100 },
  meters: { min: 0, max: 100 },
  rgbleds: { min: 0, max: 100 },
  chlcds: { min: 5, max: 100 },
  chlcdctr: { min: 0, max: 100 },
  chedit: { min: 5, max: 100 },
  main: { min: 5, max: 100 },
  glow: { min: 0, max: 100 },
  patch: { min: 0, max: 100 },
  lamp: { min: 0, max: 100 },
} as const;

export const LIGHTING_ZONES = Object.keys(LIGHTING_ZONE_RANGES) as LightingZone[];
export type LightingZone = keyof typeof LIGHTING_ZONE_RANGES;

export type LightingStatus = Record<LightingZone, number>;

function asNumber(value: string | number | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Reads the current intensity of all 11 lighting zones. */
export async function getLightingStatus(ctx: WingPluginContext): Promise<LightingStatus> {
  const flat = await ctx.client.dump("/$ctl/cfg/lights");
  const status = {} as LightingStatus;
  for (const zone of LIGHTING_ZONES) {
    status[zone] = asNumber(flat[zone]);
  }
  return status;
}

export interface LightingAck {
  ack: WingBulkSetResult;
}

export type SetLightingOptions = Partial<Record<LightingZone, number>>;

/** Sets any subset of the 11 lighting zones' intensities in a single bulk-set call. */
export async function setLighting(ctx: WingPluginContext, opts: SetLightingOptions): Promise<LightingAck> {
  const entries = Object.entries(opts).filter(([, value]) => value !== undefined) as [LightingZone, number][];
  if (entries.length === 0) {
    throw new WingValueError(`At least one lighting zone must be provided (${LIGHTING_ZONES.join(", ")}).`);
  }
  const assignments: Record<string, number> = {};
  for (const [zone, value] of entries) {
    const range = LIGHTING_ZONE_RANGES[zone];
    if (!range) {
      throw new WingValueError(`Unknown lighting zone: ${zone} (expected one of ${LIGHTING_ZONES.join(", ")}).`);
    }
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      throw new WingValueError(`${zone} must be an integer between ${range.min} and ${range.max} (got ${value}).`);
    }
    assignments[zone] = value;
  }
  const ack = await ctx.client.bulkSet("/$ctl/cfg/lights", assignments);
  return { ack };
}
