// Request-parsing helpers shared by several route modules. None of them touches the console.
// Part of the dashboard's REST API — see ./index.ts for how the modules are mounted.

import type { Request } from "express";
import { AUX_COUNT, CHANNEL_COUNT, resolveBusMainMatrixPath } from "../wing-node-paths.js";

/** Number formatting helper for values pulled out of a `dump()` flat map. */
export function asNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function auxIndexOrNull(req: Request): number | null {
  const n = Number(req.params.index);
  return Number.isInteger(n) && n >= 1 && n <= AUX_COUNT ? n : null;
}

/**
 * Physical I/O group name, as returned live by `GET /io/in` / `GET /io/out` (LCL, AUX, A, B, C,
 * SC, USB, CRD, MOD, PLAY, AES, USR, OSC, or a "$"-prefixed internal tap group). Validated against
 * a permissive charset rather than a hardcoded list, since group availability varies by console
 * model — an unknown group simply gets a timeout/VALUE ERROR from the console itself.
 */
export function ioGroupOrNull(req: Request): string | null {
  const group = req.params.group;
  return typeof group === "string" && /^\$?[A-Za-z0-9]+$/.test(group) ? group : null;
}

export function ioIndexOrNull(req: Request): number | null {
  const n = Number(req.params.index);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function channelIndexOrNull(req: Request): number | null {
  const n = Number(req.params.index);
  return Number.isInteger(n) && n >= 1 && n <= CHANNEL_COUNT ? n : null;
}

export function stripPathOrNull(req: Request, suffix: string): string | null {
  const type = req.params.type;
  if (type !== "bus" && type !== "main" && type !== "mtx") {
    return null;
  }
  const n = Number(req.params.index);
  if (!Number.isInteger(n)) {
    return null;
  }
  try {
    return resolveBusMainMatrixPath(type, n, suffix);
  } catch {
    return null;
  }
}
