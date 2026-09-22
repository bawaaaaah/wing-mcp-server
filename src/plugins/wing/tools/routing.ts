import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WingValueError } from "../wing-errors.js";
import {
  AUX_COUNT,
  BUS_COUNT,
  CHANNEL_COUNT,
  MAIN_COUNT,
  MATRIX_COUNT,
  sendBusToBusPath,
  sendBusToMainPath,
  sendBusToMatrixPath,
  sendMainToMatrixPath,
  sendToAuxBusPath,
  sendToAuxMainPath,
  sendToAuxMatrixPath,
  sendToBusPath,
  sendToMainPath,
  sendToMatrixPath,
} from "../wing-node-paths.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const SEND_SOURCES = ["channel", "aux", "bus", "main"] as const;
type SendSource = (typeof SEND_SOURCES)[number];

const SEND_DESTINATIONS = ["bus", "mtx", "main"] as const;
type SendDestination = (typeof SEND_DESTINATIONS)[number];

const SOURCE_MAX_INDEX: Record<SendSource, number> = {
  channel: CHANNEL_COUNT,
  aux: AUX_COUNT,
  bus: BUS_COUNT,
  main: MAIN_COUNT,
};

const DESTINATION_MAX_INDEX: Record<SendDestination, number> = {
  bus: BUS_COUNT,
  mtx: MATRIX_COUNT,
  main: MAIN_COUNT,
};

/**
 * Which destinations are actually reachable from a given source — verified against real hardware
 * node listings, not assumed symmetric: a channel/aux/bus can send to a bus, a matrix, or a main,
 * but a main only ever has send/MX1..8 (no send-to-main, no send-to-bus at all).
 */
const SOURCE_ALLOWED_DESTINATIONS: Record<SendSource, readonly SendDestination[]> = {
  channel: SEND_DESTINATIONS,
  aux: SEND_DESTINATIONS,
  bus: SEND_DESTINATIONS,
  main: ["mtx"],
};

const setSendInputSchema = z
  .object({
    source: z.enum(SEND_SOURCES),
    sourceIndex: z.number().int().min(1),
    destination: z.enum(SEND_DESTINATIONS),
    destinationIndex: z.number().int().min(1),
    on: z.boolean().optional(),
    levelDb: z.number().optional(),
    pan: z.number().optional(),
  })
  .refine((data) => data.on !== undefined || data.levelDb !== undefined || data.pan !== undefined, {
    message: "At least one of on, levelDb, or pan must be provided",
  });

const getSendInputSchema = z.object({
  source: z.enum(SEND_SOURCES),
  sourceIndex: z.number().int().min(1),
  destination: z.enum(SEND_DESTINATIONS),
  destinationIndex: z.number().int().min(1),
});

/** Resolves + range-checks a send (source -> destination) in one place, shared by get/set. */
function resolveSendPath(
  source: SendSource,
  sourceIndex: number,
  destination: SendDestination,
  destinationIndex: number,
  suffix?: string,
): string {
  const sourceMax = SOURCE_MAX_INDEX[source];
  if (!Number.isInteger(sourceIndex) || sourceIndex < 1 || sourceIndex > sourceMax) {
    throw new WingValueError(`${source} index out of range: ${sourceIndex} (expected 1..${sourceMax})`);
  }
  if (!SOURCE_ALLOWED_DESTINATIONS[source].includes(destination)) {
    throw new WingValueError(
      `${source} has no send to ${destination} — only ${SOURCE_ALLOWED_DESTINATIONS[source].join(", ")} available`,
    );
  }
  const destMax = DESTINATION_MAX_INDEX[destination];
  if (!Number.isInteger(destinationIndex) || destinationIndex < 1 || destinationIndex > destMax) {
    throw new WingValueError(`${destination} send index out of range: ${destinationIndex} (expected 1..${destMax})`);
  }
  if (source === "bus" && destination === "bus" && sourceIndex === destinationIndex) {
    throw new WingValueError("A bus cannot send to itself");
  }

  if (source === "channel") {
    if (destination === "bus") return sendToBusPath(sourceIndex, destinationIndex, suffix);
    if (destination === "mtx") return sendToMatrixPath(sourceIndex, destinationIndex, suffix);
    return sendToMainPath(sourceIndex, destinationIndex, suffix);
  }
  if (source === "aux") {
    if (destination === "bus") return sendToAuxBusPath(sourceIndex, destinationIndex, suffix);
    if (destination === "mtx") return sendToAuxMatrixPath(sourceIndex, destinationIndex, suffix);
    return sendToAuxMainPath(sourceIndex, destinationIndex, suffix);
  }
  if (source === "bus") {
    if (destination === "bus") return sendBusToBusPath(sourceIndex, destinationIndex, suffix);
    if (destination === "mtx") return sendBusToMatrixPath(sourceIndex, destinationIndex, suffix);
    return sendBusToMainPath(sourceIndex, destinationIndex, suffix);
  }
  // source === "main": SOURCE_ALLOWED_DESTINATIONS already restricted this to "mtx" above.
  return sendMainToMatrixPath(sourceIndex, destinationIndex, suffix);
}

export function registerRoutingTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_set_send",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set send",
      description:
        "Sets a channel/aux/bus/main's send to a bus, matrix, or main (on/off, level in dB, and/or pan) in one " +
        "atomic ACK'd bulk-set. At least one of on, levelDb, or pan must be provided. Not every source reaches " +
        "every destination on real hardware: a main only sends to a matrix (no send-to-main, no send-to-bus), " +
        "and a bus cannot send to itself.",
      inputSchema: setSendInputSchema,
    },
    ({ source, sourceIndex, destination, destinationIndex, on, levelDb, pan }) =>
      wrapWingTool(async () => {
        const basePath = resolveSendPath(source, sourceIndex, destination, destinationIndex);
        const assignments: Record<string, number | string> = {};
        if (on !== undefined) assignments.on = on ? 1 : 0;
        if (levelDb !== undefined) assignments.lvl = levelDb;
        if (pan !== undefined) assignments.pan = pan;
        const ack = await ctx.client.bulkSet(basePath, assignments);
        return {
          content: [
            textResult(
              `${source} ${sourceIndex} send to ${destination} ${destinationIndex} updated ` +
                `(${Object.keys(assignments).join(", ")}): ${ack.status}`,
            ),
          ],
          structuredContent: { source, sourceIndex, destination, destinationIndex, ...assignments, ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_get_send",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get send",
      description: "Reads a channel/aux/bus/main's send to a bus, matrix, or main (on, level in dB, pan).",
      inputSchema: getSendInputSchema,
    },
    ({ source, sourceIndex, destination, destinationIndex }) =>
      wrapWingTool(async () => {
        const basePath = resolveSendPath(source, sourceIndex, destination, destinationIndex);
        const dump = await ctx.client.dump(basePath);
        const summary = {
          source,
          sourceIndex,
          destination,
          destinationIndex,
          on: Number(dump.on) === 1,
          levelDb: dump.lvl !== undefined ? Number(dump.lvl) : NaN,
          pan: dump.pan !== undefined ? Number(dump.pan) : NaN,
        };
        return {
          content: [
            textResult(
              `${source} ${sourceIndex} send to ${destination} ${destinationIndex}: ${summary.on ? "on" : "off"}, ` +
                `${summary.levelDb} dB, pan ${summary.pan}`,
            ),
          ],
          structuredContent: summary,
        };
      }),
  );
}
