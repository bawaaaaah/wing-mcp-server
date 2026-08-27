import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getGlobalAltSwitch,
  getInputPatch,
  INPUT_PATCH_STRIP_TYPES,
  INPUT_SLOTS,
  setAltSourceActive,
  setGlobalAltSwitch,
  setInputConnection,
  type InputPatchStripType,
  type InputSlot,
} from "../wing-input-patch.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

function formatSource(source: { group: string; index: number } | null): string {
  return source ? `${source.group}${source.index}` : "unrouted";
}

export function registerInputPatchTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_input_patch",
    {
      title: "Wing: Get input patch",
      description:
        "Reads a channel/aux's physical input patch — both the Main and Alt source (physical source group " +
        '+ 1-based index within that group, or "unrouted"/null if OFF), and which of the two is currently ' +
        "active. Channel/aux only — other strip types have no physical input.",
      inputSchema: {
        type: z.enum(INPUT_PATCH_STRIP_TYPES as [InputPatchStripType, ...InputPatchStripType[]]),
        index: z.number().int().min(1),
      },
    },
    ({ type, index }) =>
      wrapWingTool(async () => {
        const status = await getInputPatch(ctx, { type, index });
        const text =
          `${type} ${index}: main=${formatSource(status.main)}, alt=${formatSource(status.alt)}, ` +
          `active=${status.altActive ? "alt" : "main"}`;
        return { content: [textResult(text)], structuredContent: { ...status } };
      }),
  );

  server.registerTool(
    "wing_set_input_connection",
    {
      title: "Wing: Set input connection",
      description:
        "Patches a channel/aux's Main or Alt physical input to a given source group + 1-based index within " +
        'that group (e.g. group "A", index 3 for AES50-A port 3). Group names vary by console model — the ' +
        "console rejects an invalid one rather than this tool validating a fixed list. This only patches " +
        "the connection; use wing_set_alt_source_active to switch which of Main/Alt is actually live.",
      inputSchema: {
        type: z.enum(INPUT_PATCH_STRIP_TYPES as [InputPatchStripType, ...InputPatchStripType[]]),
        index: z.number().int().min(1),
        slot: z.enum(INPUT_SLOTS as [InputSlot, ...InputSlot[]]),
        grp: z.string().min(1),
        in: z.number().int().min(1),
      },
    },
    ({ type, index, slot, grp, in: inputIndex }) =>
      wrapWingTool(async () => {
        const result = await setInputConnection(ctx, { type, index, slot, grp, in: inputIndex });
        const text = `${type} ${index} ${slot} input patched to ${grp}${inputIndex}: ${result.ack.status}`;
        return { content: [textResult(text)], structuredContent: { ...result } };
      }),
  );

  server.registerTool(
    "wing_set_alt_source_active",
    {
      title: "Wing: Switch Main/Alt source",
      description:
        "Switches a channel/aux between its Main and Alt physical input source (the per-strip Main/Alt " +
        "selector, independent of the console-wide Alt switch). active: true selects Alt, false selects Main. " +
        "This only has any effect while the console-wide Alt switch (wing_set_global_alt_switch) is on. " +
        'Verified live: Main→Alt reliably sticks, but Alt→Main did NOT take effect on this firmware once a ' +
        "strip had already been switched to Alt (the console acks the write OK without applying it) — if a " +
        "strip won't revert, turn the console-wide Alt switch off instead, which forces Main behavior " +
        "everywhere regardless of any strip's stored selection.",
      inputSchema: {
        type: z.enum(INPUT_PATCH_STRIP_TYPES as [InputPatchStripType, ...InputPatchStripType[]]),
        index: z.number().int().min(1),
        active: z.boolean(),
      },
    },
    ({ type, index, active }) =>
      wrapWingTool(async () => {
        const result = await setAltSourceActive(ctx, { type, index, active });
        const text = `${type} ${index} source switched to ${active ? "alt" : "main"}: ${result.ack.status}`;
        return { content: [textResult(text)], structuredContent: { ...result } };
      }),
  );

  server.registerTool(
    "wing_get_global_alt_switch",
    {
      title: "Wing: Get global Alt switch",
      description:
        "Reads the console-wide Alt switch state (/io/altsw) and its auto-override flag (/io/autoaltovr) — " +
        "independent of any single channel/aux's own Main/Alt selector.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const status = await getGlobalAltSwitch(ctx);
        return {
          content: [textResult(`global alt switch: ${status.on ? "on" : "off"}, auto-override: ${status.autoOverride ? "on" : "off"}`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_global_alt_switch",
    {
      title: "Wing: Set global Alt switch",
      description:
        "Sets the console-wide Alt switch (on) and/or its auto-override flag (autoOverride). Verified live: " +
        "this is a master override — while on: false, every strip behaves as Main regardless of its own " +
        "in/set/altsrc selection (even one already set to Alt), and any per-strip Alt selection made while " +
        "off stays stored but dormant until this is turned back on. Pass at least one of the two.",
      inputSchema: {
        on: z.boolean().optional(),
        autoOverride: z.boolean().optional(),
      },
    },
    ({ on, autoOverride }) =>
      wrapWingTool(async () => {
        const result = await setGlobalAltSwitch(ctx, { on, autoOverride });
        return {
          content: [textResult(`global alt switch updated: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
