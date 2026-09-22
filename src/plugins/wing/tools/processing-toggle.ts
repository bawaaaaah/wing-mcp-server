import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getProcessingBlockOn,
  PROCESSING_BLOCKS,
  PROCESSING_TOGGLE_TYPES,
  setProcessingBlockOn,
  type ProcessingBlock,
  type ProcessingToggleType,
} from "../wing-processing-toggle.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerProcessingToggleTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_processing_block",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get EQ/Gate/Dyn on-off",
      description:
        "Reads whether a channel/aux/bus/main/matrix strip's EQ, Gate, or Dynamics (compressor) processing " +
        'block is currently on or off. The "gate" block only exists on channel strips — aux/bus/main/matrix ' +
        'only have "eq"/"dyn"; requesting block: "gate" on one of those is rejected with a clear error.',
      inputSchema: {
        type: z.enum(PROCESSING_TOGGLE_TYPES as [ProcessingToggleType, ...ProcessingToggleType[]]),
        index: z.number().int().min(1),
        block: z.enum(PROCESSING_BLOCKS as [ProcessingBlock, ...ProcessingBlock[]]),
      },
    },
    ({ type, index, block }) =>
      wrapWingTool(async () => {
        const status = await getProcessingBlockOn(ctx, { type, index, block });
        return {
          content: [textResult(`${type} ${index} ${block}: ${status.on ? "on" : "off"}`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_processing_block",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set EQ/Gate/Dyn on-off",
      description:
        "Turns a channel/aux/bus/main/matrix strip's EQ, Gate, or Dynamics (compressor) processing block on " +
        'or off. The "gate" block only exists on channel strips — aux/bus/main/matrix only have "eq"/"dyn"; ' +
        'requesting block: "gate" on one of those is rejected with a clear error rather than silently failing.',
      inputSchema: {
        type: z.enum(PROCESSING_TOGGLE_TYPES as [ProcessingToggleType, ...ProcessingToggleType[]]),
        index: z.number().int().min(1),
        block: z.enum(PROCESSING_BLOCKS as [ProcessingBlock, ...ProcessingBlock[]]),
        on: z.boolean(),
      },
    },
    ({ type, index, block, on }) =>
      wrapWingTool(async () => {
        const result = await setProcessingBlockOn(ctx, { type, index, block, on });
        return {
          content: [textResult(`${type} ${index} ${block} turned ${on ? "on" : "off"}: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
