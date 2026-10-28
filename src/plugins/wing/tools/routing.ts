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
import { parseDumpNumber } from "../wing-value-codec.js";
import { describeWriteResult, writeAssignments } from "../wing-write.js";
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

/**
 * A channel/aux send's tap, read live off a WING Rack (fw 3.1.1, 2026-10-28). WING Edit labels them
 * TAP / POST / GROUP: PRE is TAP, i.e. the channel's own tap point (`/ch/n/ptap`, "pretap (to sends)"
 * in the protocol reference), not a fixed pre-fader point.
 */
const SEND_MODES = ["PRE", "POST", "GRP"] as const;

/**
 * A channel/aux send's LINK PAN (`plink` 0/1/2), as WING Edit names it. Verified live on a WING Rack
 * (fw 3.1.1, 2026-10-28): ON and REV make the console rewrite the send's pan to the channel's pan or
 * its inverse, and while either is on it ignores a pan write — acks it OK and keeps the linked pan.
 */
const PAN_LINKS = ["OFF", "ON", "REV"] as const;

/**
 * The two shapes a send node comes in — read live off a WING Rack (fw 3.1.1, 2026-10-28), and not
 * what the protocol reference suggests:
 * - "tap": a channel or aux sending to a bus or a matrix — {on, lvl, pon, mode, plink, pan};
 * - "pre": every other send (channel/aux -> main, bus -> bus/matrix/main, main -> matrix) — just
 *   {on, lvl, pre}: no pan, no mode, a plain pre-fader flag.
 *
 * A field the node lacks has to be refused before anything is sent: the console answers a bulk-set
 * naming one (`pan` on a send to a main) with NODE NOT FOUND, but only after storing the keys that
 * came before it.
 */
type SendShape = "tap" | "pre";

type SendField = "on" | "levelDb" | "pon" | "mode" | "plink" | "pan" | "pre";

/**
 * The tool fields each shape takes, in the order they are written, with the node key behind each.
 * `plink` comes before `pan` so that unlinking and panning in one call works.
 */
const SHAPE_FIELDS: Record<SendShape, readonly SendField[]> = {
  tap: ["on", "levelDb", "pon", "mode", "plink", "pan"],
  pre: ["on", "levelDb", "pre"],
};

const FIELD_KEYS: Record<SendField, string> = {
  on: "on",
  levelDb: "lvl",
  pon: "pon",
  mode: "mode",
  plink: "plink",
  pan: "pan",
  pre: "pre",
};

/** A `plink` value as read from the console (a number, or possibly its display name) -> 0/1/2. */
function panLinkIndex(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const named = (PAN_LINKS as readonly string[]).indexOf(value.trim().toUpperCase());
  return named >= 0 ? named : parseDumpNumber(value);
}

async function readLeafValue(ctx: WingPluginContext, path: string): Promise<number | string | null> {
  try {
    const result = await ctx.client.get(path);
    return result.kind === "leaf" ? result.value : null;
  } catch {
    return null;
  }
}

function sendShape(source: SendSource, destination: SendDestination): SendShape {
  return (source === "channel" || source === "aux") && destination !== "main" ? "tap" : "pre";
}

/**
 * A raw shape, not a ZodObject, and deliberately so.
 *
 * This was `z.object({...}).refine(...)`, which wraps the object in a ZodEffects — and the SDK
 * does not unwrap that when it builds the advertised JSON Schema. The result was not "the
 * refinement is dropped": `wing_set_send` advertised `{"type":"object","properties":{}}`, i.e. a
 * seven-parameter tool that told callers it took none. `wing_get_send`, a plain ZodObject right
 * beside it, was fine, which is why this went unnoticed.
 *
 * The at-least-one rule the refinement carried now lives in the handler, where it can produce a
 * message, and on the fields themselves via .describe(), where a caller can read it in the schema.
 */
const AT_LEAST_ONE = "At least one of on, levelDb, pan, mode, pon, plink or pre must be given.";
const TAP_ONLY = "Only a channel/aux send to a bus or matrix has it.";
const PRE_ONLY = "Only a channel/aux send to a main, a bus's sends and a main's sends to a matrix have it.";

const setSendInputShape = {
  source: z.enum(SEND_SOURCES),
  sourceIndex: z.number().int().min(1),
  destination: z.enum(SEND_DESTINATIONS),
  destinationIndex: z.number().int().min(1),
  on: z.boolean().optional().describe(AT_LEAST_ONE),
  levelDb: z.number().optional().describe(`-144..10 dB; the console clamps beyond that. ${AT_LEAST_ONE}`),
  pan: z
    .number()
    .optional()
    .describe(`-100..100. Refused while LINK PAN is ON/REV (see plink). ${TAP_ONLY} ${AT_LEAST_ONE}`),
  mode: z
    .enum(SEND_MODES)
    .optional()
    .describe(
      "Where the send taps the channel. PRE is WING Edit's TAP: the channel's own tap point (its ptap " +
        `setting), not necessarily pre-fader. POST is post-fader; GRP is WING Edit's GROUP. ${TAP_ONLY} ${AT_LEAST_ONE}`,
    ),
  pon: z
    .boolean()
    .optional()
    .describe(`WING Edit's IGNORE CHANNEL MUTE ("pre always on" in the protocol reference). ${TAP_ONLY} ${AT_LEAST_ONE}`),
  plink: z
    .enum(PAN_LINKS)
    .optional()
    .describe(
      "WING Edit's LINK PAN. ON makes the send's pan follow the channel's pan, REV its inverse; the console " +
        "rewrites the pan at once (the result reports it) and ignores pan writes until it is OFF again. Give " +
        `plink: "OFF" with a pan to unlink and pan in one call. ${TAP_ONLY} ${AT_LEAST_ONE}`,
    ),
  pre: z
    .boolean()
    .optional()
    .describe(
      `true = PRE (pre-fader), false = POST, as WING Edit shows the send. ${PRE_ONLY} ${AT_LEAST_ONE}`,
    ),
  confirm: z.boolean().optional().describe("Required while the server's show mode is on: this write is audible."),
};

const getSendInputShape = {
  source: z.enum(SEND_SOURCES),
  sourceIndex: z.number().int().min(1),
  destination: z.enum(SEND_DESTINATIONS),
  destinationIndex: z.number().int().min(1),
};

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
        "Sets a channel/aux/bus/main's send to a bus, matrix, or main in one ACK'd bulk-set, then reads every " +
        "field back (`results` gives previous/sent/stored/match per field; journaled, so wing_undo reverts it). " +
        "Sends come in two shapes: a channel/aux send to a bus or matrix has on, levelDb, pan, mode (PRE = " +
        "WING Edit's TAP, the channel's tap point; POST; GRP = GROUP), pon (IGNORE CHANNEL MUTE) and plink " +
        "(LINK PAN OFF/ON/REV; pan is refused while it is ON/REV, as the console would ignore it); every " +
        "other send — channel/aux to a main, a bus's sends, a main's sends — has only on, levelDb and pre (a " +
        "pre/post switch). A field the send does not have is refused before anything is written. " +
        "At least one field must be given. Not every source reaches every destination on real hardware: a " +
        "main only sends to a matrix (no send-to-main, no send-to-bus), and a bus cannot send to itself.",
      inputSchema: setSendInputShape,
    },
    ({ source, sourceIndex, destination, destinationIndex, on, levelDb, pan, mode, pon, plink, pre, confirm }) =>
      wrapWingTool(async () => {
        const fields: Record<SendField, boolean | number | string | undefined> = { on, levelDb, pon, mode, plink, pan, pre };
        const given = (Object.keys(fields) as SendField[]).filter((field) => fields[field] !== undefined);
        if (given.length === 0) {
          throw new WingValueError(AT_LEAST_ONE);
        }
        const basePath = resolveSendPath(source, sourceIndex, destination, destinationIndex);
        const label = `${source} ${sourceIndex} send to ${destination} ${destinationIndex}`;
        const allowed = SHAPE_FIELDS[sendShape(source, destination)];
        const missing = given.filter((field) => !allowed.includes(field));
        if (missing.length > 0) {
          throw new WingValueError(
            `${label} has no ${missing.join(" or ")}: its node is {${allowed.map((field) => FIELD_KEYS[field]).join(", ")}}, ` +
              `so only ${allowed.join(", ")} can be set. Nothing was written.`,
          );
        }
        if (pan !== undefined) {
          // The console would ack a pan write on a linked send and keep the linked pan.
          const link = plink !== undefined ? PAN_LINKS.indexOf(plink) : panLinkIndex(await readLeafValue(ctx, `${basePath}/plink`));
          if (link !== null && link !== 0) {
            throw new WingValueError(
              `${label} has LINK PAN ${PAN_LINKS[link] ?? link}: its pan follows the channel's pan` +
                `${link === 2 ? " (inverted)" : ""} and the console ignores a pan write. ` +
                `${plink === undefined ? 'Pass plink: "OFF" with the pan to unlink it first. ' : ""}Nothing was written.`,
            );
          }
        }
        const assignments: Record<string, number | string> = {};
        for (const field of allowed) {
          const value = fields[field];
          if (value === undefined) continue;
          assignments[FIELD_KEYS[field]] =
            field === "plink" ? PAN_LINKS.indexOf(value as (typeof PAN_LINKS)[number]) : typeof value === "boolean" ? (value ? 1 : 0) : value;
        }
        const result = await writeAssignments(ctx, basePath, assignments, { confirm });
        // Linking rewrites the pan on the console's side; say what it is now.
        const linkedPanRaw = result.ok && plink !== undefined && plink !== "OFF" ? await readLeafValue(ctx, `${basePath}/pan`) : null;
        const linkedPan = linkedPanRaw === null ? undefined : parseDumpNumber(linkedPanRaw);
        const linkedText = linkedPan === undefined ? "" : `\npan now follows the channel${plink === "REV" ? " (inverted)" : ""}: ${linkedPan ?? linkedPanRaw}`;
        return {
          content: [textResult(`${label}: ${describeWriteResult(result)}${linkedText}`)],
          structuredContent: {
            source,
            sourceIndex,
            destination,
            destinationIndex,
            ...result,
            ...(linkedPan === undefined ? {} : { linkedPan }),
          },
          isError: result.ok ? undefined : true,
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
      description:
        "Reads a channel/aux/bus/main's send to a bus, matrix, or main: on, level in dB, and pan, mode, pon and plink " +
        "for a channel/aux send to a bus or matrix, or pre for every other send, which has no pan.",
      inputSchema: getSendInputShape,
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
          pan: dump.pan !== undefined ? (parseDumpNumber(dump.pan) ?? NaN) : NaN,
          ...(sendShape(source, destination) === "tap"
            ? {
                mode: dump.mode !== undefined ? String(dump.mode) : null,
                pon: Number(dump.pon) === 1,
                plink: PAN_LINKS[panLinkIndex(dump.plink) ?? -1] ?? null,
              }
            : { pre: Number(dump.pre) === 1 }),
        };
        const linkText = "plink" in summary && summary.plink && summary.plink !== "OFF" ? ` (linked ${summary.plink})` : "";
        const shapeText = "pre" in summary ? (summary.pre ? "PRE" : "POST") : `pan ${summary.pan}${linkText}, ${summary.mode ?? "?"}`;
        return {
          content: [
            textResult(
              `${source} ${sourceIndex} send to ${destination} ${destinationIndex}: ${summary.on ? "on" : "off"}, ` +
                `${summary.levelDb} dB, ${shapeText}`,
            ),
          ],
          structuredContent: summary,
        };
      }),
  );
}
