import { WingValueError } from "./wing-errors.js";
import type { WingPluginContext } from "./wing-plugin.js";

/** AES50 link ports, per the protocol reference's `/$stat/{A,B,C}` status nodes. */
export const AES_PORTS = ["A", "B", "C"] as const;
export type AesPort = (typeof AES_PORTS)[number];

function requireAesPort(port: string): asserts port is AesPort {
  if (!(AES_PORTS as readonly string[]).includes(port)) {
    throw new WingValueError(`Unknown AES50 port "${port}" — expected one of: ${AES_PORTS.join(", ")}.`);
  }
}

export interface AesPortStatus {
  port: AesPort;
  /** "-" (nothing connected), "OK", "ERR", or "UPD" (firmware mismatch/updating) — per the protocol reference. */
  state: string;
  device: string;
  errorsCorrected: number;
  errorsUncorrected: number;
  /** Name of the console connected on this port, empty if none. */
  remoteName: string;
}

export interface StageConnectStatus {
  status: string;
  devices: string;
  upstreamCount: number;
  downstreamCount: number;
}

export interface AesLinkStatus {
  ports: AesPortStatus[];
  stageConnect: StageConnectStatus;
}

function flatString(flat: Record<string, string | number>, key: string): string {
  return key in flat ? String(flat[key]) : "";
}

function flatNumber(flat: Record<string, string | number>, key: string): number {
  return key in flat ? Number(flat[key]) : 0;
}

/**
 * Reads AES50 A/B/C link status plus StageConnect status via a single `dump("/$stat")` call.
 * `dump()`'s flat-assignment parser is known to mis-key entries (a stray leading ".") on nodes with
 * enough nested sub-sections — verified live elsewhere for a channel's many nested groups (see
 * `getTags()` in http-routes.ts) — but `/$stat` itself is shallow (three flat A/B/C branches, no
 * further nesting within them, plus a dozen root-level leaves) and was verified live against real
 * hardware to dump with clean "A.stat"/"sc_upcnt"/etc. keys, no mis-keying. An earlier version of
 * this function issued 15 individual `get()` calls instead to sidestep that risk entirely, but that
 * was verified live to occasionally time out (502) when the console's single-request OSC queue was
 * also busy with other tab traffic (e.g. the Mixer tab's own polling) — a single `dump()` call is
 * both simpler and more reliable under load. Safe to call when a port has nothing connected —
 * `state` simply reads "-", it doesn't reject or throw.
 */
export async function getAesLinkStatus(ctx: WingPluginContext): Promise<AesLinkStatus> {
  const flat = await ctx.client.dump("/$stat");
  const ports = AES_PORTS.map((port) => ({
    port,
    state: flatString(flat, `${port}.stat`),
    device: flatString(flat, `${port}.dev`),
    errorsCorrected: flatNumber(flat, `${port}.errorsc`),
    errorsUncorrected: flatNumber(flat, `${port}.errorsu`),
    remoteName: flatString(flat, `rmt_${port.toLowerCase()}`),
  }));
  const stageConnect: StageConnectStatus = {
    status: flatString(flat, "sc_stat"),
    devices: flatString(flat, "sc_devices"),
    upstreamCount: flatNumber(flat, "sc_upcnt"),
    downstreamCount: flatNumber(flat, "sc_dncnt"),
  };
  return { ports, stageConnect };
}

export interface ClearAesErrorsResult {
  port: AesPort;
  ack: { status: string; ok: boolean; raw: string };
}

/** Resets the corrected/uncorrected error counters for one AES50 port. */
export async function clearAesErrors(ctx: WingPluginContext, port: string): Promise<ClearAesErrorsResult> {
  requireAesPort(port);
  const ack = await ctx.client.bulkSet(`/$stat/${port}`, { clrerr: 1 });
  return { port, ack };
}
