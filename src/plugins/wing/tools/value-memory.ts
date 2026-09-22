import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adjustValueByDelta, restoreValue, storeValue, undoLastAdjust } from "../wing-value-memory.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const pathSchema = z.string().regex(/^\//, "path must start with /");

export function registerValueMemoryTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_store_value",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: Store a value checkpoint",
      description:
        "Reads any WING OSC leaf's current value and remembers it as a checkpoint for that path, for later " +
        "recall with wing_restore_value. Overwrites any previous checkpoint for the same path.",
      inputSchema: { path: pathSchema },
    },
    ({ path }) =>
      wrapWingTool(async () => {
        const result = await storeValue(ctx, path);
        return {
          content: [textResult(`Stored ${path} = ${result.value}`)],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_restore_value",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Restore a stored value",
      description: "Writes back whatever value was last remembered for this path via wing_store_value.",
      inputSchema: { path: pathSchema },
    },
    ({ path }) =>
      wrapWingTool(async () => {
        const result = await restoreValue(ctx, path);
        return {
          content: [textResult(`Restored ${path} = ${result.value}: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_adjust_value_by_delta",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: Adjust a numeric value by a delta",
      description:
        "Nudges a numeric WING OSC leaf by `delta` (positive or negative), clamped to the console's own " +
        "reported valid range for that node when available. Remembers the pre-adjust value so " +
        "wing_undo_last_adjust can revert exactly this one step.",
      inputSchema: { path: pathSchema, delta: z.number() },
    },
    ({ path, delta }) =>
      wrapWingTool(async () => {
        const result = await adjustValueByDelta(ctx, path, delta);
        return {
          content: [
            textResult(
              `${path}: ${result.oldValue} -> ${result.newValue}${result.clamped ? " (clamped)" : ""}: ${result.ack.status}`,
            ),
          ],
          structuredContent: { ...result },
        };
      }),
  );

  server.registerTool(
    "wing_undo_last_adjust",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      title: "Wing: Undo the last delta adjustment",
      description: "Reverts the single most recent wing_adjust_value_by_delta call for this path.",
      inputSchema: { path: pathSchema },
    },
    ({ path }) =>
      wrapWingTool(async () => {
        const result = await undoLastAdjust(ctx, path);
        return {
          content: [textResult(`Undid last adjust on ${path}, restored ${result.value}: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
