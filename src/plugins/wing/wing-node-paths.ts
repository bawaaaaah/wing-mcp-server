import { WingValueError } from "./wing-errors.js";

export const CHANNEL_COUNT = 40;
export const AUX_COUNT = 8;
export const BUS_COUNT = 16;
export const MAIN_COUNT = 4;
export const MATRIX_COUNT = 8;
export const DCA_COUNT = 16;
export const MUTEGROUP_COUNT = 8;
export const FX_COUNT = 16;

/**
 * Fader travel in dB, as the parameter catalog defines it for every `fdr` leaf
 * (wing-param-catalog.ts: channel/bus/main/matrix and DCA all share -144..10, where -144 is the
 * console's "-oo"). Kept here so the tool schemas can advertise the same bounds the console
 * enforces, rather than restating them in prose only.
 */
export const FADER_DB_MIN = -144;
export const FADER_DB_MAX = 10;

function requireRange(n: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new WingValueError(`${label} index out of range: ${n} (expected ${min}..${max})`);
  }
}

function withSuffix(base: string, suffix?: string): string {
  return suffix ? `${base}/${suffix}` : base;
}

export function channelPath(n: number, suffix?: string): string {
  requireRange(n, 1, CHANNEL_COUNT, "channel");
  return withSuffix(`/ch/${n}`, suffix);
}

export function auxPath(n: number, suffix?: string): string {
  requireRange(n, 1, AUX_COUNT, "aux");
  return withSuffix(`/aux/${n}`, suffix);
}

export function busPath(n: number, suffix?: string): string {
  requireRange(n, 1, BUS_COUNT, "bus");
  return withSuffix(`/bus/${n}`, suffix);
}

export function mainPath(n: number, suffix?: string): string {
  requireRange(n, 1, MAIN_COUNT, "main");
  return withSuffix(`/main/${n}`, suffix);
}

export function matrixPath(n: number, suffix?: string): string {
  requireRange(n, 1, MATRIX_COUNT, "matrix");
  return withSuffix(`/mtx/${n}`, suffix);
}

export function dcaPath(n: number, suffix?: string): string {
  requireRange(n, 1, DCA_COUNT, "dca");
  return withSuffix(`/dca/${n}`, suffix);
}

export function mutegroupPath(n: number, suffix?: string): string {
  requireRange(n, 1, MUTEGROUP_COUNT, "mutegroup");
  return withSuffix(`/mgrp/${n}`, suffix);
}

export function fxPath(n: number, suffix?: string): string {
  requireRange(n, 1, FX_COUNT, "fx");
  return withSuffix(`/fx/${n}`, suffix);
}

/**
 * The plan groups bus/main/matrix under a single discriminated tool family
 * ("type": "bus" | "main" | "mtx") since they share almost the same node
 * shape (fader/mute/pan/EQ/dyn). This resolves that discriminant to the
 * right path builder.
 */
export function resolveBusMainMatrixPath(
  type: "bus" | "main" | "mtx",
  index: number,
  suffix?: string
): string {
  switch (type) {
    case "bus":
      return busPath(index, suffix);
    case "main":
      return mainPath(index, suffix);
    case "mtx":
      return matrixPath(index, suffix);
    default: {
      const exhaustive: never = type;
      throw new WingValueError(`Unknown bus/main/matrix type: ${String(exhaustive)}`);
    }
  }
}

/**
 * The full set of "strip" object types a preset can be captured from/restored to. Spelled out
 * (e.g. "matrix" rather than "mtx") to match the already-public discriminant used by
 * wing_get_group_membership/wing_set_group_membership (tools/groups.ts) rather than the internal
 * "mtx" abbreviation used by resolveBusMainMatrixPath()/wing_set_send — the two conventions already
 * disagree elsewhere in this codebase, so this picks the more explicit, LLM-facing one.
 */
export const STRIP_TYPES = ["channel", "aux", "bus", "main", "matrix", "dca", "mutegroup"] as const;
export type StripType = (typeof STRIP_TYPES)[number];

export const STRIP_TYPE_COUNTS: Record<StripType, number> = {
  channel: CHANNEL_COUNT,
  aux: AUX_COUNT,
  bus: BUS_COUNT,
  main: MAIN_COUNT,
  matrix: MATRIX_COUNT,
  dca: DCA_COUNT,
  mutegroup: MUTEGROUP_COUNT,
};

/** Resolves any of the seven strip types to its node path — the generalized sibling of resolveBusMainMatrixPath(). */
export function resolveStripPath(type: StripType, index: number, suffix?: string): string {
  switch (type) {
    case "channel":
      return channelPath(index, suffix);
    case "aux":
      return auxPath(index, suffix);
    case "bus":
      return busPath(index, suffix);
    case "main":
      return mainPath(index, suffix);
    case "matrix":
      return matrixPath(index, suffix);
    case "dca":
      return dcaPath(index, suffix);
    case "mutegroup":
      return mutegroupPath(index, suffix);
    default: {
      const exhaustive: never = type;
      throw new WingValueError(`Unknown strip type: ${String(exhaustive)}`);
    }
  }
}

/** Path for a channel's send to a bus, e.g. channelPath(3, "send/5/lvl"). */
export function sendToBusPath(channel: number, busIndex: number, suffix?: string): string {
  requireRange(busIndex, 1, BUS_COUNT, "bus");
  return channelPath(channel, withSuffix(`send/${busIndex}`, suffix));
}

/** Path for a channel's send to a matrix, e.g. channelPath(3, "send/MX2/lvl"). */
export function sendToMatrixPath(channel: number, mtxIndex: number, suffix?: string): string {
  requireRange(mtxIndex, 1, MATRIX_COUNT, "matrix");
  return channelPath(channel, withSuffix(`send/MX${mtxIndex}`, suffix));
}

/** Path for a channel's send to a main, e.g. channelPath(3, "main/1/lvl"). */
export function sendToMainPath(channel: number, mainIndex: number, suffix?: string): string {
  requireRange(mainIndex, 1, MAIN_COUNT, "main");
  return channelPath(channel, withSuffix(`main/${mainIndex}`, suffix));
}

/**
 * Aux sends — verified against real hardware to share the exact same node shape as a channel's
 * sends (on/lvl/pon/mode/plink/pan for bus/matrix, on/lvl/pre for main).
 */
export function sendToAuxBusPath(aux: number, busIndex: number, suffix?: string): string {
  requireRange(busIndex, 1, BUS_COUNT, "bus");
  return auxPath(aux, withSuffix(`send/${busIndex}`, suffix));
}

export function sendToAuxMatrixPath(aux: number, mtxIndex: number, suffix?: string): string {
  requireRange(mtxIndex, 1, MATRIX_COUNT, "matrix");
  return auxPath(aux, withSuffix(`send/MX${mtxIndex}`, suffix));
}

export function sendToAuxMainPath(aux: number, mainIndex: number, suffix?: string): string {
  requireRange(mainIndex, 1, MAIN_COUNT, "main");
  return auxPath(aux, withSuffix(`main/${mainIndex}`, suffix));
}

/**
 * Bus → bus/matrix/main internal routing — verified against real hardware to exist as regular
 * send nodes (bus.md's send/1..16, send/MX1..8, main/1..4). A bus's send to itself is a real node
 * too, but comes back with a reduced {on,lvl,pre} shape (no mode/pon/plink/pan) and is ignored by
 * the console's signal path — callers should skip index === bus.
 */
export function sendBusToBusPath(bus: number, targetBus: number, suffix?: string): string {
  requireRange(targetBus, 1, BUS_COUNT, "bus");
  return busPath(bus, withSuffix(`send/${targetBus}`, suffix));
}

export function sendBusToMatrixPath(bus: number, mtxIndex: number, suffix?: string): string {
  requireRange(mtxIndex, 1, MATRIX_COUNT, "matrix");
  return busPath(bus, withSuffix(`send/MX${mtxIndex}`, suffix));
}

export function sendBusToMainPath(bus: number, mainIndex: number, suffix?: string): string {
  requireRange(mainIndex, 1, MAIN_COUNT, "main");
  return busPath(bus, withSuffix(`main/${mainIndex}`, suffix));
}

/**
 * Main → matrix internal routing — verified against real hardware: main.md only has send/MX1..8,
 * no send to other mains or to buses.
 */
export function sendMainToMatrixPath(main: number, mtxIndex: number, suffix?: string): string {
  requireRange(mtxIndex, 1, MATRIX_COUNT, "matrix");
  return mainPath(main, withSuffix(`send/MX${mtxIndex}`, suffix));
}

/**
 * Physical I/O node paths — verified against real hardware (`/io/in/<GROUP>/<n>`,
 * `/io/out/<GROUP>/<n>`). Group names (LCL, AUX, A, B, C, SC, USB, CRD, MOD, PLAY, AES, USR, OSC,
 * ...) and their per-group channel counts vary by console model and are discovered live from the
 * console itself (`GET /io/in`, `GET /io/out`), not hardcoded here — so unlike the fixed-count
 * builders above, these deliberately don't range-check the index: an out-of-range index simply
 * gets a VALUE ERROR ack or a timeout from the console, same as any other invalid write.
 */
export function ioInPath(group: string, index: number, suffix?: string): string {
  return withSuffix(`/io/in/${group}/${index}`, suffix);
}

export function ioOutPath(group: string, index: number, suffix?: string): string {
  return withSuffix(`/io/out/${group}/${index}`, suffix);
}
