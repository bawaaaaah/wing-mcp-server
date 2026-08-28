import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COLOR_DESCRIPTION, ICON_DESCRIPTION } from "../wing-param-catalog.js";
import { getScribble, SCRIBBLE_STRIP_TYPES, setScribble, type ScribbleStripType } from "../wing-scribble.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerScribbleTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_scribble",
    {
      title: "Wing: Get scribble strip identity",
      description:
        "Reads a channel/aux/bus/main/matrix/DCA strip's scribble light (on/off), color, and icon in one call. " +
        `Not available on mutegroup strips (no scribble light/color/icon field exists there). Color palette: ${COLOR_DESCRIPTION}.`,
      inputSchema: {
        type: z.enum(SCRIBBLE_STRIP_TYPES as [ScribbleStripType, ...ScribbleStripType[]]),
        index: z.number().int().min(1),
      },
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        const status = await getScribble(ctx, type, index);
        const colorText = status.colorName ? `${status.col} (${status.colorName})` : String(status.col);
        const iconText = status.iconName ? `${status.icon} (${status.iconName})` : String(status.icon);
        return {
          content: [textResult(`${type} ${index} scribble: led=${status.led}, col=${colorText}, icon=${iconText}`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_scribble",
    {
      title: "Wing: Set scribble strip identity",
      description:
        "Sets a channel/aux/bus/main/matrix/DCA strip's scribble light (on/off), color, and/or icon in a single " +
        `validated call — any subset of the three. Color palette: ${COLOR_DESCRIPTION}. Icon set: ${ICON_DESCRIPTION}.`,
      inputSchema: {
        type: z.enum(SCRIBBLE_STRIP_TYPES as [ScribbleStripType, ...ScribbleStripType[]]),
        index: z.number().int().min(1),
        led: z.number().int().min(0).max(1).optional(),
        col: z.number().int().min(1).max(18).optional(),
        icon: z.number().int().min(0).max(999).optional(),
      },
    },
    ({ type, index, led, col, icon }) =>
      wrapWingTool(async () => {
        const result = await setScribble(ctx, { type, index, led, col, icon });
        return {
          content: [textResult(`${type} ${index} scribble updated: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
