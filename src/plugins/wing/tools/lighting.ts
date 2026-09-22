import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLightingStatus, LIGHTING_ZONE_RANGES, LIGHTING_ZONES, setLighting } from "../wing-lighting.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const zoneSchemas = Object.fromEntries(
  LIGHTING_ZONES.map((zone) => [zone, z.number().int().min(LIGHTING_ZONE_RANGES[zone].min).max(LIGHTING_ZONE_RANGES[zone].max).optional()]),
) as Record<(typeof LIGHTING_ZONES)[number], z.ZodOptional<z.ZodNumber>>;

export function registerLightingTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_lighting",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get console lighting",
      description:
        "Reads the current intensity (0-100) of all 11 console lighting/backlight zones: buttons, " +
        "LEDs, meters, scribble-light color LEDs, channel LCDs and their contrast, channel strip " +
        "backlight, main touchscreen, under-console glow, patch panel, and lamp socket.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const status = await getLightingStatus(ctx);
        const summary = LIGHTING_ZONES.map((zone) => `${zone}=${status[zone]}`).join(", ");
        return {
          content: [textResult(`Lighting: ${summary}`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_lighting",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set console lighting",
      description:
        "Sets any subset of the console's 11 lighting/backlight zones (0-100 each; leds, chlcds, " +
        "chedit, and main have a firmware floor of 5 and can't be switched fully off) in a single call.",
      inputSchema: zoneSchemas,
    },
    (opts) =>
      wrapWingTool(async () => {
        const result = await setLighting(ctx, opts);
        const applied = LIGHTING_ZONES.filter((zone) => opts[zone] !== undefined)
          .map((zone) => `${zone}=${opts[zone]}`)
          .join(", ");
        return {
          content: [textResult(`Lighting updated (${applied}): ${result.ack.status}`)],
          structuredContent: { ...opts, ...result },
        };
      }),
  );
}
