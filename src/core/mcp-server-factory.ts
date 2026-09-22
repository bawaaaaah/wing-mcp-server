import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPackageVersion } from "./health.js";
import type { McpPlugin } from "./plugin.js";

/**
 * Composed from whatever the plugins choose to say. Without this, `initialize` returns no
 * instructions at all — which on a server exposing 116 tools leaves a model to infer the whole
 * shape of the surface from tool names, including the deliberate split between a generic escape
 * hatch and the typed convenience families.
 */
export function buildInstructions(plugins: readonly McpPlugin[]): string | undefined {
  const parts = plugins
    .map((plugin) => plugin.getInstructions?.()?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * The MCP server itself, with every plugin's tools and resources registered on it. Knows nothing
 * about how a client reached it, which is what lets the HTTP gateway and the stdio endpoint share
 * one definition of the tool surface.
 *
 * **One instance per transport, never reused.** Verified against real hardware (Hermes, and a
 * regression test against a real StreamableHTTPClientTransport) that the SDK's `Server.connect()`
 * only ever allows ONE transport per `Server` instance for its entire lifetime: reusing a single
 * shared McpServer across HTTP sessions worked for the very first session a freshly-started gateway
 * ever received, then threw "Already connected to a transport" on every session after that
 * (including simple reconnects), which any real client — Hermes included — saw as the server
 * refusing to connect at all. Registering tools per transport is cheap enough that there's no
 * reason to fight the SDK's one-transport-per-Server design instead of just following it.
 */
export function createMcpServer(plugins: readonly McpPlugin[]): McpServer {
  const instructions = buildInstructions(plugins);
  const mcpServer = new McpServer(
    { name: "wing-mcp-server", version: getPackageVersion() },
    instructions ? { instructions } : undefined,
  );
  for (const plugin of plugins) {
    plugin.registerTools(mcpServer);
  }
  return mcpServer;
}
