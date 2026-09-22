import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCurrentScene, getSceneList, recallScene, stepScene } from "../wing-scenes.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerSceneTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_scene_list",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: List scenes",
      description:
        "Lists the scenes in the console's currently open show, with array position matching the " +
        "index used by wing_scene_recall. Verified against real hardware: describe() on the leaf " +
        "'/$ctl/lib/$scenes' never replies, but describing the parent branch '/$ctl/lib' does, and " +
        "its reply's inline enum for the $scenes field is the actual scene list in order.",
    },
    () =>
      wrapWingTool(async () => {
        const scenes = await getSceneList(ctx);
        return {
          content: [textResult(`${scenes.length} scene(s) found`)],
          structuredContent: { scenes },
        };
      }),
  );

  server.registerTool(
    "wing_scene_get_current",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get current scene",
      description: "Reads the currently active scene's index, name, show name, and tag id.",
    },
    () =>
      wrapWingTool(async () => {
        const current = await getCurrentScene(ctx);
        return {
          content: [
            textResult(
              `Current scene: #${current.index} "${current.name}" (show: ${current.show}, tag: ${current.tagId})`,
            ),
          ],
          structuredContent: { ...current },
        };
      }),
  );

  server.registerTool(
    "wing_scene_recall",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Recall scene",
      description:
        "Recalls a scene by list index or by numeric tag. Set byTag=true to recall by tag (#1..#16384) " +
        "instead of list index. A show must already be open on the console.",
      inputSchema: {
        target: z.union([z.number().int(), z.string()]),
        byTag: z.boolean().optional(),
      },
    },
    ({ target, byTag }) =>
      wrapWingTool(async () => {
        const ack = await recallScene(ctx, target, Boolean(byTag));
        return {
          content: [textResult(`Scene recall (${byTag ? "tag" : "index"} ${target}): ${ack.status}`)],
          structuredContent: { target, byTag: Boolean(byTag), ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_scene_next",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: Next scene",
      description: "Advances to the next scene in the currently open show.",
    },
    () =>
      wrapWingTool(async () => {
        const ack = await stepScene(ctx, "next");
        return {
          content: [textResult(`Scene NEXT: ${ack.status}`)],
          structuredContent: { ...ack },
        };
      }),
  );

  server.registerTool(
    "wing_scene_prev",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: Previous scene",
      description: "Goes back to the previous scene in the currently open show.",
    },
    () =>
      wrapWingTool(async () => {
        const ack = await stepScene(ctx, "prev");
        return {
          content: [textResult(`Scene PREV: ${ack.status}`)],
          structuredContent: { ...ack },
        };
      }),
  );
}
