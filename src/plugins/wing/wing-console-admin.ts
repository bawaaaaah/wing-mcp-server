import type { WingPluginContext } from "./wing-plugin.js";

const GLOBALS_NODE = "/$ctl/$globals";

export interface WingAck {
  status: string;
  ok: boolean;
  raw: string;
}

export interface SaveToFlashResult {
  ack: WingAck;
}

/**
 * Triggers an immediate save of console data to flash (`$savenow`). The protocol reference
 * explicitly warns this must never be called in a program loop — repeated writes wear the flash
 * storage — so this issues exactly one bulkSet per call, with no retry on failure.
 */
export async function saveToFlash(ctx: WingPluginContext): Promise<SaveToFlashResult> {
  const ack = await ctx.client.bulkSet(GLOBALS_NODE, { $savenow: 1 });
  return { ack };
}

export interface AutoSaveConfig {
  /** true = console autosaves on every change (the default); false = only `saveToFlash()` persists. */
  enabled: boolean;
}

function asOn(value: string | number | undefined): boolean {
  return value !== undefined && Number(value) === 1;
}

/** Reads the console's autosave switch. Wire field is `$noautosave` (inverted sense). */
export async function getAutoSaveConfig(ctx: WingPluginContext): Promise<AutoSaveConfig> {
  const result = await ctx.client.get(`${GLOBALS_NODE}/$noautosave`);
  const noAutoSave = result.kind === "leaf" ? asOn(result.value) : false;
  return { enabled: !noAutoSave };
}

export interface SetAutoSaveResult extends AutoSaveConfig {
  ack: WingAck;
}

/** Sets the console's autosave switch. `enabled: false` stops the console from persisting every change on its own — `saveToFlash()` becomes the only way to write to flash. */
export async function setAutoSaveConfig(ctx: WingPluginContext, enabled: boolean): Promise<SetAutoSaveResult> {
  const ack = await ctx.client.bulkSet(GLOBALS_NODE, { $noautosave: enabled ? 0 : 1 });
  return { enabled, ack };
}
