import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RTA_SOURCE_TYPES, type RtaSourceType } from "../wing-rta-source.js";
import { getSelectedStrip, setSelectedStrip } from "../wing-selected-strip.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerSelectedStripTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_selected_strip",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get the selected channel strip",
      description:
        "Reads which channel/aux/bus/main/matrix strip is currently selected on the console's home screen " +
        "(/$ctl/$stat/selidx). `strip` is null if the raw index doesn't decode to a known strip (e.g. nothing " +
        "selected); `rawIndex` is always included so nothing is lost even then.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const result = await getSelectedStrip(ctx);
        return {
          content: [
            textResult(
              result.strip
                ? `Selected strip: ${result.strip.type} ${result.strip.index} (raw index ${result.rawIndex})`
                : `Selected strip: raw index ${result.rawIndex} (does not decode to a known strip)`,
            ),
          ],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_set_selected_strip",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Select a channel strip",
      description:
        "Selects a channel/aux/bus/main/matrix strip on the console's home screen, as if the user had tapped " +
        "it. `type` + `index` identify the strip.",
      inputSchema: {
        type: z.enum(RTA_SOURCE_TYPES as [RtaSourceType, ...RtaSourceType[]]),
        index: z.number().int(),
      },
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        const result = await setSelectedStrip(ctx, { type, index });
        return {
          content: [textResult(`Selected ${type} ${index} (raw index ${result.writtenIndex}): ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
