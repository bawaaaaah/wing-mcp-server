import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAutoSaveConfig, saveToFlash, setAutoSaveConfig } from "../wing-console-admin.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerSaveFlashTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_save_to_flash",
    {
      title: "Wing: Save console data to flash now",
      description:
        "Immediately persists the console's current state to flash storage, bypassing the normal autosave " +
        "timing. WARNING: the protocol reference explicitly says this must never be called repeatedly/in a " +
        "loop — each call is a real flash write and repeated writes wear the storage over time. Call this at " +
        "most once per meaningful change, never on a timer or retry loop.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const result = await saveToFlash(ctx);
        return {
          content: [textResult(`Console data saved to flash: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_get_autosave_config",
    {
      title: "Wing: Get autosave switch",
      description:
        "Reads whether the console automatically persists changes to flash as they happen (the default) " +
        "or only when wing_save_to_flash is called explicitly.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const config = await getAutoSaveConfig(ctx);
        return {
          content: [textResult(`Autosave is ${config.enabled ? "on" : "off"}`)],
          structuredContent: { ...config },
        };
      }),
  );

  server.registerTool(
    "wing_set_autosave_config",
    {
      title: "Wing: Set autosave switch",
      description:
        "Turns the console's autosave-on-change behavior on or off. Turning it off means only " +
        "wing_save_to_flash writes to flash — use with care, changes made afterward are lost on power loss " +
        "until a save is triggered.",
      inputSchema: {
        enabled: z.boolean(),
      },
    },
    ({ enabled }) =>
      wrapWingTool(async () => {
        const result = await setAutoSaveConfig(ctx, enabled);
        return {
          content: [textResult(`Autosave turned ${enabled ? "on" : "off"}: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
