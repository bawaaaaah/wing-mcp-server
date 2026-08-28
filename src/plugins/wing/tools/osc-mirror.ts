import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { configureOscMirror, getOscMirrorStatus } from "../wing-osc-mirror.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

function formatStatus(status: ReturnType<typeof getOscMirrorStatus>): string {
  if (!status.enabled) {
    return "OSC mirror is OFF";
  }
  const errorSuffix = status.lastError ? `, last error: ${status.lastError}` : "";
  return `OSC mirror ON -> ${status.host}:${status.port} (${status.messagesSent} messages, ${status.bytesSent} bytes sent${errorSuffix})`;
}

export function registerOscMirrorTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_osc_mirror_status",
    {
      title: "Wing: Get raw OSC mirror status",
      description:
        "Reads the raw OSC/meter mirror's config (enabled, target host:port) and lifetime counters " +
        "(messages sent, bytes sent, last send error). When enabled, the server re-sends every raw OSC " +
        "message it receives from the console, and every raw meter UDP packet, byte-for-byte to this " +
        "target — letting a second app observe live console traffic without its own connection to the " +
        "console. One-directional (console -> mirror target only): nothing this server sends TO the " +
        "console is mirrored. Does not read anything from the console itself.",
      inputSchema: {},
    },
    () =>
      wrapWingTool(async () => {
        const status = getOscMirrorStatus(ctx);
        return { content: [textResult(formatStatus(status))], structuredContent: { ...status } };
      }),
  );

  server.registerTool(
    "wing_set_osc_mirror",
    {
      title: "Wing: Configure raw OSC mirror",
      description:
        "Enables or disables the raw OSC/meter mirror, and/or changes its target — any subset of the " +
        "three, merged onto the current config (so changing just `port` while already enabled keeps the " +
        "existing host). Enabling requires a non-empty `host` and a valid `port` (1..65535) to already be " +
        "set or given in the same call. Disabling releases the mirror's own outbound UDP socket.",
      inputSchema: {
        enabled: z.boolean().optional(),
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
      },
    },
    (opts) =>
      wrapWingTool(async () => {
        const status = configureOscMirror(ctx, opts);
        return { content: [textResult(formatStatus(status))], structuredContent: { ...status } };
      }),
  );
}
