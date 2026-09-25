import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WingValueError } from "../wing-errors.js";
import { BUS_COUNT, MAIN_COUNT, MATRIX_COUNT, resolveBusMainMatrixPath } from "../wing-node-paths.js";
import { flattenIdentity, readStripIdentity, type StripKind } from "../wing-identity.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { parseDumpNumber } from "../wing-value-codec.js";
import { describeWriteResult, writeAssignments } from "../wing-write.js";
import { faderDbSchema, textResult, wrapWingTool } from "./generic.js";

const BUS_MAIN_MATRIX_TYPES = ["bus", "main", "mtx"] as const;
type BusMainMatrixType = (typeof BUS_MAIN_MATRIX_TYPES)[number];

const STRIP_KIND_OF: Record<BusMainMatrixType, StripKind> = { bus: "bus", main: "main", mtx: "mtx" };

const TYPE_MAX_INDEX: Record<BusMainMatrixType, number> = {
  bus: BUS_COUNT,
  main: MAIN_COUNT,
  mtx: MATRIX_COUNT,
};

/**
 * Defensive re-check of the index bound for the given `type` before we ever
 * build a path from it. `resolveBusMainMatrixPath` -> `busPath`/`mainPath`/
 * `matrixPath` already validates this too, but doing it here first gives a
 * clearer, type-specific error message (and matches the plan's explicit
 * request to bound-check per type before resolving the path).
 */
function validateTypeIndex(type: BusMainMatrixType, index: number): void {
  const max = TYPE_MAX_INDEX[type];
  if (!Number.isInteger(index) || index < 1 || index > max) {
    throw new WingValueError(`${type} index out of range: ${index} (expected 1..${max})`);
  }
}

const typeAndIndexSchema = {
  type: z.enum(BUS_MAIN_MATRIX_TYPES),
  // The real maximum depends on `type` and is enforced by validateTypeIndex() at call time. A
  // discriminated union would put it in the schema proper, but it would also turn every one of
  // these tools' inputs into an anyOf; spelling the bounds out here keeps the shape flat while
  // still telling a caller what it needs before it gets rejected.
  index: z
    .number()
    .int()
    .min(1)
    .describe(`1-${BUS_COUNT} for bus, 1-${MAIN_COUNT} for main, 1-${MATRIX_COUNT} for mtx.`),
};

export function registerBusMainMatrixTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_bus_get_fader",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get bus/main/matrix fader",
      description: "Reads a bus, main, or matrix channel's fader level in dB.",
      inputSchema: typeAndIndexSchema,
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        validateTypeIndex(type, index);
        const result = await ctx.client.get(resolveBusMainMatrixPath(type, index, "fdr"));
        const db = result.kind === "leaf" ? Number(result.value) : NaN;
        return {
          content: [textResult(`${type} ${index} fader: ${db} dB`)],
          structuredContent: { type, index, db },
        };
      }),
  );

  server.registerTool(
    "wing_bus_set_fader",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set bus/main/matrix fader",
      description:
        "Sets a bus, main, or matrix channel's fader level in dB (-144..10, -144 = -oo) via an ACK'd bulk-set.",
      inputSchema: { ...typeAndIndexSchema, db: faderDbSchema },
    },
    ({ type, index, db }) =>
      wrapWingTool(async () => {
        validateTypeIndex(type, index);
        const ack = await ctx.client.bulkSet(resolveBusMainMatrixPath(type, index), { fdr: db });
        return {
          content: [textResult(`${type} ${index} fader set to ${db} dB: ${ack.status}`)],
          structuredContent: { type, index, db, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_bus_get_mute",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get bus/main/matrix mute",
      description: "Reads whether a bus, main, or matrix channel is muted.",
      inputSchema: typeAndIndexSchema,
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        validateTypeIndex(type, index);
        const result = await ctx.client.get(resolveBusMainMatrixPath(type, index, "mute"));
        const muted = result.kind === "leaf" && Number(result.value) === 1;
        return {
          content: [textResult(`${type} ${index} is ${muted ? "muted" : "unmuted"}`)],
          structuredContent: { type, index, muted },
        };
      }),
  );

  server.registerTool(
    "wing_bus_set_mute",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set bus/main/matrix mute",
      description: "Sets a bus, main, or matrix channel's mute state via an ACK'd bulk-set.",
      inputSchema: { ...typeAndIndexSchema, muted: z.boolean() },
    },
    ({ type, index, muted }) =>
      wrapWingTool(async () => {
        validateTypeIndex(type, index);
        const ack = await ctx.client.bulkSet(resolveBusMainMatrixPath(type, index), { mute: muted ? 1 : 0 });
        return {
          content: [textResult(`${type} ${index} mute set to ${muted}: ${ack.status}`)],
          structuredContent: { type, index, muted, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_bus_get_summary",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get bus/main/matrix summary",
      description:
        "Dumps a bus, main, or matrix channel's key parameters (name, fader dB, mute, pan, mono) in one " +
        "request. `name` is the effective name shown on the surface; `ownName`/`effectiveName` and the same " +
        "for col/icon are broken out. `busmono` is true when the strip is summed to mono (see wing_bus_set_mono).",
      inputSchema: typeAndIndexSchema,
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        validateTypeIndex(type, index);
        const dump = await ctx.client.dump(resolveBusMainMatrixPath(type, index));
        const identity = flattenIdentity(await readStripIdentity(ctx, STRIP_KIND_OF[type], index, dump));
        const summary = {
          type,
          index,
          name: identity.effectiveName,
          db: dump.fdr !== undefined ? (parseDumpNumber(dump.fdr) ?? NaN) : NaN,
          muted: Number(dump.mute) === 1,
          pan: dump.pan !== undefined ? (parseDumpNumber(dump.pan) ?? NaN) : NaN,
          busmono: dump.busmono === undefined ? null : Number(dump.busmono) === 1,
          ownName: identity.ownName,
          effectiveName: identity.effectiveName,
          ownCol: identity.ownCol,
          effectiveCol: identity.effectiveCol,
          effectiveColorName: identity.effectiveColorName,
          ownIcon: identity.ownIcon,
          effectiveIcon: identity.effectiveIcon,
          effectiveIconName: identity.effectiveIconName,
        };
        return {
          content: [
            textResult(
              `${type} ${index}: "${summary.name}", ${summary.db} dB, ` +
                `${summary.muted ? "muted" : "unmuted"}, pan ${summary.pan}${summary.busmono ? ", mono" : ""}`,
            ),
          ],
          structuredContent: summary,
        };
      }),
  );

  server.registerTool(
    "wing_bus_set_mono",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set bus/main/matrix mono",
      description:
        "Switches a bus, main, or matrix between stereo and summed-to-mono (`busmono`). Audible: a mono " +
        "monitor mix or sub feed changes immediately. Read back and journaled (wing_undo).",
      inputSchema: {
        ...typeAndIndexSchema,
        mono: z.boolean(),
        dryRun: z.boolean().optional(),
        confirm: z.boolean().optional().describe("Required when show mode is on."),
      },
    },
    ({ type, index, mono, dryRun, confirm }) =>
      wrapWingTool(async () => {
        validateTypeIndex(type, index);
        const result = await writeAssignments(ctx, resolveBusMainMatrixPath(type, index), { busmono: mono ? 1 : 0 }, { dryRun, confirm });
        return {
          content: [textResult(`${type} ${index} ${mono ? "mono" : "stereo"}: ${describeWriteResult(result)}`)],
          structuredContent: { type, index, mono, ...result },
          isError: result.ok ? undefined : true,
        };
      }),
  );
}
