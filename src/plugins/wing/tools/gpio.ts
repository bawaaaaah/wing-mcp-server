import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getAllGpioStatus,
  getGpioStatus,
  GPIO_COUNT,
  GPIO_MODE_VALUES,
  setGpioMode,
  setGpioState,
  type GpioMode,
} from "../wing-gpio.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

const indexSchema = z.number().int().min(1).max(GPIO_COUNT);

export function registerGpioTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_gpio",
    {
      title: "Wing: Get GPIO status",
      description:
        `Reads the status of one of the console's ${GPIO_COUNT} hardware GPIOs, or all of them if no index ` +
        "is given: its mode (TGLNO/TGLNC toggle, INNO/INNC input, OUTNO/OUTNC output), the read-only " +
        "electrical state, and the writable output drive state (gpstate).",
      inputSchema: { index: indexSchema.optional() },
    },
    ({ index }) =>
      wrapWingTool(async () => {
        const status = index === undefined ? await getAllGpioStatus(ctx) : await getGpioStatus(ctx, index);
        const summary = Array.isArray(status)
          ? status.map((g) => `#${g.index} ${g.mode} state=${g.state ? 1 : 0} gpstate=${g.gpstate ? 1 : 0}`).join("; ")
          : `#${status.index} ${status.mode} state=${status.state ? 1 : 0} gpstate=${status.gpstate ? 1 : 0}`;
        return {
          content: [textResult(`GPIO status: ${summary}`)],
          structuredContent: Array.isArray(status) ? { gpios: status } : { ...status },
        };
      }),
  );

  server.registerTool(
    "wing_set_gpio_mode",
    {
      title: "Wing: Set GPIO mode",
      description:
        "Sets one hardware GPIO's mode: TGLNO/TGLNC (toggle, normally-open/closed) or INNO/INNC (momentary " +
        "input, normally-open/closed) for reading an external switch, or OUTNO/OUTNC (output, normally-open/closed) " +
        "for driving a relay via gpstate.",
      inputSchema: {
        index: indexSchema,
        mode: z.enum(GPIO_MODE_VALUES as unknown as [GpioMode, ...GpioMode[]]),
      },
    },
    ({ index, mode }) =>
      wrapWingTool(async () => {
        const result = await setGpioMode(ctx, { index, mode });
        return {
          content: [textResult(`GPIO ${index} mode set to ${mode}: ${result.ack.status}`)],
          structuredContent: { index, mode, ...result },
        };
      }),
  );

  server.registerTool(
    "wing_set_gpio_state",
    {
      title: "Wing: Set GPIO output state",
      description: "Drives one hardware GPIO's output state on or off (gpstate) — only meaningful in OUTNO/OUTNC mode.",
      inputSchema: { index: indexSchema, on: z.boolean() },
    },
    ({ index, on }) =>
      wrapWingTool(async () => {
        const result = await setGpioState(ctx, { index, on });
        return {
          content: [textResult(`GPIO ${index} gpstate set to ${on ? 1 : 0}: ${result.ack.status}`)],
          structuredContent: { index, on, ...result },
        };
      }),
  );
}
