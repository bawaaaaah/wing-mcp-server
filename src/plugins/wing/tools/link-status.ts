import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AES_PORTS, clearAesErrors, getAesLinkStatus, type AesPort } from "../wing-link-status.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerLinkStatusTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_link_status",
    {
      title: "Wing: Get AES50/StageConnect link status",
      description:
        "Reads the console's AES50 A/B/C link status (state, connected device, corrected/uncorrected error " +
        "counts, remote console name) plus StageConnect status (state, devices, upstream/downstream device " +
        'count). Read-only, safe to call even when a port has nothing connected (its state simply reads "-").',
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const status = await getAesLinkStatus(ctx);
        const portsText = status.ports
          .map((p) => `${p.port}=${p.state}${p.device ? ` (${p.device})` : ""} [corr=${p.errorsCorrected} unc=${p.errorsUncorrected}]`)
          .join(", ");
        const text =
          `AES50: ${portsText} — StageConnect: ${status.stageConnect.status} ` +
          `(up=${status.stageConnect.upstreamCount}, down=${status.stageConnect.downstreamCount})`;
        return { content: [textResult(text)], structuredContent: { ...status } };
      }),
  );

  server.registerTool(
    "wing_clear_link_errors",
    {
      title: "Wing: Clear AES50 link errors",
      description: "Resets the corrected/uncorrected error counters for one AES50 port (A, B, or C).",
      inputSchema: {
        port: z.enum(AES_PORTS as unknown as [AesPort, ...AesPort[]]),
      },
    },
    ({ port }) =>
      wrapWingTool(async () => {
        const result = await clearAesErrors(ctx, port);
        return {
          content: [textResult(`AES50 port ${result.port} error counters reset: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
