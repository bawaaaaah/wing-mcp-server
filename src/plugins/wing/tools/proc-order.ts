import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GEDI_PERMUTATIONS, getProcOrder, setProcOrder, type ProcOrder } from "../wing-proc-order.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerProcOrderTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_channel_get_proc",
    {
      title: "Wing: Get channel processing order",
      description:
        "Reads a channel's Gate/EQ/Dynamics/Insert processing order — one of the 24 permutations of the " +
        'letters G/E/D/I, e.g. "GEDI" (the default) or "EDGI". The letter order IS the signal-flow order ' +
        "on the console (left to right = first to last): G = Gate, E = Equalisation (EQ), D = Dynamics " +
        "(compressor), I = Insert. E.g. \"EDGI\" processes EQ, then Dynamics, then Gate, then Insert. " +
        "Channel-exclusive — aux/bus/main/matrix strips have no reorderable processing chain.",
      inputSchema: {
        channel: z.number().int().min(1),
      },
    },
    ({ channel }) =>
      wrapWingTool(async () => {
        const status = await getProcOrder(ctx, channel);
        return {
          content: [textResult(`channel ${channel} processing order: ${status.order}`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_channel_set_proc",
    {
      title: "Wing: Set channel processing order",
      description:
        "Sets a channel's Gate/EQ/Dynamics/Insert processing order to one of the 24 valid permutations of " +
        'the letters G/E/D/I, e.g. "GEDI" (the default) or "EDGI" — one letter each, no repeats. The letter ' +
        "order IS the signal-flow order on the console (left to right = first to last): G = Gate, " +
        "E = Equalisation (EQ), D = Dynamics (compressor), I = Insert. E.g. \"EDGI\" processes EQ, then " +
        "Dynamics, then Gate, then Insert. Channel-exclusive — aux/bus/main/matrix strips have no " +
        "reorderable processing chain.",
      inputSchema: {
        channel: z.number().int().min(1),
        order: z.enum(GEDI_PERMUTATIONS as unknown as [ProcOrder, ...ProcOrder[]]),
      },
    },
    ({ channel, order }) =>
      wrapWingTool(async () => {
        const result = await setProcOrder(ctx, channel, order);
        return {
          content: [textResult(`channel ${channel} processing order set to ${order}: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
