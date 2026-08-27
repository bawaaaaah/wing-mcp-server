import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getInsertStatus,
  INSERT_FX_OPTIONS,
  INSERT_SLOTS,
  INSERT_STRIP_TYPES,
  POST_INSERT_MODES,
  setInsert,
  type InsertFx,
  type InsertSlot,
  type InsertStripType,
  type PostInsertMode,
} from "../wing-insert.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerInsertTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_insert",
    {
      title: "Wing: Get insert status",
      description:
        "Reads a channel/aux/bus/main/matrix strip's pre- or post-processing insert point — whether it's " +
        'on, which FX engine slot ("NONE" or FX1..FX16) is patched into it, and for post-insert only, the ' +
        "routing mode (FX/AUTO_X/AUTO_Y) and wet/dry mix in dB. Aux strips have no post-insert stage.",
      inputSchema: {
        type: z.enum(INSERT_STRIP_TYPES as [InsertStripType, ...InsertStripType[]]),
        index: z.number().int().min(1),
        slot: z.enum(INSERT_SLOTS as [InsertSlot, ...InsertSlot[]]),
      },
    },
    ({ type, index, slot }) =>
      wrapWingTool(async () => {
        const status = await getInsertStatus(ctx, { type, index, slot });
        const text =
          `${type} ${index} ${slot}-insert: ${status.on ? "on" : "off"}, fx=${status.fx}` +
          `${status.mode ? `, mode=${status.mode}` : ""}${status.w !== undefined ? `, w=${status.w}dB` : ""}` +
          `${status.status ? `, status=${status.status}` : ""}`;
        return { content: [textResult(text)], structuredContent: { ...status } };
      }),
  );

  server.registerTool(
    "wing_set_insert",
    {
      title: "Wing: Set insert",
      description:
        "Turns a channel/aux/bus/main/matrix strip's pre- or post-processing insert on/off and/or patches " +
        'an FX engine slot ("NONE" or FX1..FX16) into it. `mode` (FX/AUTO_X/AUTO_Y) and `w` (wet/dry mix, ' +
        "-12..12dB) only apply to post-insert — pre-insert has no such fields. Aux strips have no " +
        "post-insert stage; rejected with a clear error rather than silently failing.",
      inputSchema: {
        type: z.enum(INSERT_STRIP_TYPES as [InsertStripType, ...InsertStripType[]]),
        index: z.number().int().min(1),
        slot: z.enum(INSERT_SLOTS as [InsertSlot, ...InsertSlot[]]),
        on: z.boolean().optional(),
        fx: z.enum(INSERT_FX_OPTIONS as unknown as [InsertFx, ...InsertFx[]]).optional(),
        mode: z.enum(POST_INSERT_MODES as unknown as [PostInsertMode, ...PostInsertMode[]]).optional(),
        w: z.number().min(-12).max(12).optional(),
      },
    },
    ({ type, index, slot, on, fx, mode, w }) =>
      wrapWingTool(async () => {
        const result = await setInsert(ctx, { type, index, slot, on, fx, mode, w });
        const text = `${type} ${index} ${slot}-insert updated: ${result.ack.status}`;
        return { content: [textResult(text)], structuredContent: { ...result } };
      }),
  );
}
