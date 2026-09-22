import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getTalkbackStatus,
  setTalkbackAssign,
  setTalkbackDestination,
  setTalkbackSource,
  TALKBACK_ASSIGN_VALUES,
  TALKBACK_DESTINATION_TYPES,
  TALKBACK_MODE_VALUES,
  TALKBACK_SOURCES,
  type TalkbackAssign,
  type TalkbackDestinationType,
  type TalkbackMode,
  type TalkbackSource,
} from "../wing-talkback.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const sourceSchema = z.enum(TALKBACK_SOURCES as unknown as [TalkbackSource, ...TalkbackSource[]]);

export function registerTalkbackTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_talkback",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get talkback status",
      description:
        "Reads the full talkback config: global assign mode (which channel/aux the two talk sources feed, " +
        "or OFF), the read-only talk level, and per-source (A/B) on/off, trigger mode (AUTO/PUSH/LATCH), " +
        "monitor/bus dim amounts, and which buses/matrices/mains each source is currently assigned to.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const status = await getTalkbackStatus(ctx);
        return {
          content: [
            textResult(
              `Talkback assign=${status.assign}, level=${status.levelDb}dB. A: ${status.a.on ? "on" : "off"}/${status.a.mode}. B: ${status.b.on ? "on" : "off"}/${status.b.mode}.`,
            ),
          ],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_talkback_assign",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set talkback assignment",
      description: "Sets the global talkback assignment mode: OFF, CH40 (channel 40), or AUX8 (aux 8).",
      inputSchema: {
        assign: z.enum(TALKBACK_ASSIGN_VALUES as unknown as [TalkbackAssign, ...TalkbackAssign[]]),
      },
    },
    ({ assign }) =>
      wrapWingTool(async () => {
        const result = await setTalkbackAssign(ctx, assign);
        return {
          content: [textResult(`Talkback assign set to ${assign}: ${result.ack.status}`)],
          structuredContent: { assign, ...result },
        };
      }),
  );

  server.registerTool(
    "wing_set_talkback_source",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set talkback source",
      description:
        "Sets one talk source's (A or B) on/off, trigger mode (AUTO/PUSH/LATCH), monitor dim, bus dim, " +
        "and/or individual Bus/Main send flag — any subset of the five.",
      inputSchema: {
        source: sourceSchema,
        on: z.boolean().optional(),
        mode: z.enum(TALKBACK_MODE_VALUES as unknown as [TalkbackMode, ...TalkbackMode[]]).optional(),
        mondim: z.number().int().min(0).max(40).optional(),
        busdim: z.number().min(0).max(40).optional(),
        indiv: z.boolean().optional(),
      },
    },
    ({ source, on, mode, mondim, busdim, indiv }) =>
      wrapWingTool(async () => {
        const result = await setTalkbackSource(ctx, { source, on, mode, mondim, busdim, indiv });
        return {
          content: [textResult(`Talkback source ${source} updated: ${result.ack.status}`)],
          structuredContent: { source, ...result },
        };
      }),
  );

  server.registerTool(
    "wing_set_talkback_destination",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set talkback destination assignment",
      description: "Turns one talk source's (A or B) assignment to a single bus/matrix/main destination on or off.",
      inputSchema: {
        source: sourceSchema,
        type: z.enum(TALKBACK_DESTINATION_TYPES as unknown as [TalkbackDestinationType, ...TalkbackDestinationType[]]),
        index: z.number().int().min(1),
        on: z.boolean(),
      },
    },
    ({ source, type, index, on }) =>
      wrapWingTool(async () => {
        const result = await setTalkbackDestination(ctx, { source, type, index, on });
        return {
          content: [textResult(`Talkback source ${source} -> ${type} ${index} set to ${on ? "on" : "off"}: ${result.ack.status}`)],
          structuredContent: { source, type, index, on, ...result },
        };
      }),
  );
}
