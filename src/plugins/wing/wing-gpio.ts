import { WingValueError } from "./wing-errors.js";
import type { WingBulkSetResult } from "./wing-osc-client.js";
import type { WingPluginContext } from "./wing-plugin.js";

/**
 * Hardware GPIO node (`/$ctl/gpio/1..4`): each of the console's 4 GPIOs has a mode (toggle or
 * momentary, normally-open or normally-closed), a read-only electrical state, and a writable
 * `gpstate` used to drive it as an output. Verified against `docs/WING_Remote-Protocols-3.1-03.pdf` —
 * only `$state` is marked `[RO]`; `gpstate` has no such marker and is writable.
 */

export const GPIO_COUNT = 4;

export const GPIO_MODE_VALUES = ["TGLNO", "TGLNC", "INNO", "INNC", "OUTNO", "OUTNC"] as const;
export type GpioMode = (typeof GPIO_MODE_VALUES)[number];

function requireGpioIndex(index: number): void {
  if (!Number.isInteger(index) || index < 1 || index > GPIO_COUNT) {
    throw new WingValueError(`index must be an integer between 1 and ${GPIO_COUNT} (got ${index}).`);
  }
}

function asString(value: string | number | undefined, fallback = ""): string {
  return value === undefined ? fallback : String(value);
}

function asNumber(value: string | number | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export interface GpioStatus {
  index: number;
  mode: GpioMode | string;
  state: boolean;
  gpstate: boolean;
}

/** Reads one GPIO's mode, read-only electrical state, and output drive state. */
export async function getGpioStatus(ctx: WingPluginContext, index: number): Promise<GpioStatus> {
  requireGpioIndex(index);
  const flat = await ctx.client.dump(`/$ctl/gpio/${index}`);
  return {
    index,
    mode: asString(flat.mode, "TGLNO"),
    state: asNumber(flat.$state) === 1,
    gpstate: asNumber(flat.gpstate) === 1,
  };
}

/** Reads all 4 GPIOs' status. */
export async function getAllGpioStatus(ctx: WingPluginContext): Promise<GpioStatus[]> {
  return Promise.all(Array.from({ length: GPIO_COUNT }, (_, i) => getGpioStatus(ctx, i + 1)));
}

export interface GpioAck {
  ack: WingBulkSetResult;
}

export interface SetGpioModeOptions {
  index: number;
  mode: GpioMode;
}

/** Sets one GPIO's mode (toggle/momentary, normally-open/normally-closed). */
export async function setGpioMode(ctx: WingPluginContext, opts: SetGpioModeOptions): Promise<GpioAck> {
  const { index, mode } = opts;
  requireGpioIndex(index);
  if (!(GPIO_MODE_VALUES as readonly string[]).includes(mode)) {
    throw new WingValueError(`mode must be one of ${GPIO_MODE_VALUES.join(", ")} (got ${mode}).`);
  }
  const ack = await ctx.client.bulkSet(`/$ctl/gpio/${index}`, { mode });
  return { ack };
}

export interface SetGpioStateOptions {
  index: number;
  on: boolean;
}

/** Drives one GPIO's output state (only meaningful when its mode is OUTNO/OUTNC). */
export async function setGpioState(ctx: WingPluginContext, opts: SetGpioStateOptions): Promise<GpioAck> {
  const { index, on } = opts;
  requireGpioIndex(index);
  const ack = await ctx.client.bulkSet(`/$ctl/gpio/${index}`, { gpstate: on ? 1 : 0 });
  return { ack };
}
