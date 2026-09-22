import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DELAY_MODES, DELAY_STRIP_TYPES, getDelay, setDelay, type DelayMode, type DelayStripType } from "../wing-delay.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerDelayTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_delay",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get delay line",
      description:
        "Reads a channel/aux/bus/main/matrix strip's delay line: on/off, unit (M=meters, FT=feet, " +
        "MS=milliseconds, SMP=samples), and the delay amount in that unit. Channel/aux delay is on the input " +
        "stage; bus/main/matrix delay is on the output — different OSC nodes under the hood, same tool.",
      inputSchema: {
        type: z.enum(DELAY_STRIP_TYPES as [DelayStripType, ...DelayStripType[]]),
        index: z.number().int().min(1),
      },
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        const status = await getDelay(ctx, type, index);
        return {
          content: [textResult(`${type} ${index} delay: ${status.on ? "on" : "off"}, ${status.value} ${status.mode}`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_delay",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set delay line",
      description:
        "Turns a channel/aux/bus/main/matrix strip's delay line on/off and/or sets its unit and amount — any " +
        "subset of the three. `value`'s valid range depends on `mode`: 0..150 for M(eters), 0.5..500 for " +
        "FT(feet)/MS(milliseconds), 16..500 for SMP(samples) — the console rejects an out-of-range value via " +
        "the returned ack rather than this tool clamping it client-side.",
      inputSchema: {
        type: z.enum(DELAY_STRIP_TYPES as [DelayStripType, ...DelayStripType[]]),
        index: z.number().int().min(1),
        on: z.boolean().optional(),
        mode: z.enum(DELAY_MODES as unknown as [DelayMode, ...DelayMode[]]).optional(),
        value: z.number().optional(),
      },
    },
    ({ type, index, on, mode, value }) =>
      wrapWingTool(async () => {
        const result = await setDelay(ctx, { type, index, on, mode, value });
        return {
          content: [textResult(`${type} ${index} delay updated: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
