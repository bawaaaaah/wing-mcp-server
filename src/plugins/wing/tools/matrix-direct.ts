import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMatrixDirectInput, MATRIX_DIR_IN_VALUES, setMatrixDirectInput, type MatrixDirIn } from "../wing-matrix-direct.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerMatrixDirectTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_matrix_direct_input",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Get matrix Direct Input",
      description:
        "Reads a matrix's Direct Input sub-mixer: on/off, level (dB), invert, and source (OFF, AES, or a " +
        "monitor phones/speaker/bus feed). This taps a signal directly into the matrix, ahead of its normal " +
        "bus/main sends.",
      inputSchema: {
        index: z.number().int().min(1),
      },
    },
    ({ index }) =>
      wrapWingTool(async () => {
        const status = await getMatrixDirectInput(ctx, index);
        return {
          content: [textResult(`Matrix ${index} direct input: ${status.on ? "on" : "off"}, ${status.input} @ ${status.levelDb}dB${status.invert ? ", inverted" : ""}`)],
          structuredContent: { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_matrix_direct_input",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      title: "Wing: Set matrix Direct Input",
      description:
        "Turns a matrix's Direct Input sub-mixer on/off and/or sets its level, invert, and/or source — any " +
        "subset of the four.",
      inputSchema: {
        index: z.number().int().min(1),
        on: z.boolean().optional(),
        levelDb: z.number().min(-144).max(10).optional(),
        invert: z.boolean().optional(),
        input: z.enum(MATRIX_DIR_IN_VALUES as unknown as [MatrixDirIn, ...MatrixDirIn[]]).optional(),
      },
    },
    ({ index, on, levelDb, invert, input }) =>
      wrapWingTool(async () => {
        const result = await setMatrixDirectInput(ctx, { index, on, levelDb, invert, input });
        return {
          content: [textResult(`Matrix ${index} direct input updated: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
