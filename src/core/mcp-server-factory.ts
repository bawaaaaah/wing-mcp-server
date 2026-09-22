import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPackageVersion } from "./health.js";
import type { McpPlugin } from "./plugin.js";
import { recordRegisteredTools } from "./tool-recorder.js";

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

export interface CreatedMcpServer {
  mcpServer: McpServer;
  /** Every tool this server registered, by name — a caller's window into per-tool state, e.g. to toggle visibility later. */
  toolHandles: Map<string, RegisteredTool>;
}

export interface CreateMcpServerOptions {
  /** Appended to `buildInstructions()`'s own text — e.g. a note that some tools are hidden here. */
  extraInstructions?: string;
  /** A tool this returns `true` for is registered already disabled — see `tool-recorder.ts`. */
  isToolHidden?: (name: string) => boolean;
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
export function createMcpServer(plugins: readonly McpPlugin[], opts: CreateMcpServerOptions = {}): CreatedMcpServer {
  const base = buildInstructions(plugins);
  const instructions = opts.extraInstructions ? [base, opts.extraInstructions].filter(Boolean).join("\n\n") : base;
  const mcpServer = new McpServer(
    { name: "wing-mcp-server", version: getPackageVersion() },
    instructions ? { instructions } : undefined,
  );

  const toolHandles = new Map<string, RegisteredTool>();
  const recordingServer = recordRegisteredTools(mcpServer, (name, tool) => toolHandles.set(name, tool));
  for (const plugin of plugins) {
    plugin.registerTools(recordingServer);
  }

  if (opts.isToolHidden) {
    // Register-then-disable, not skip-registering: an McpServer that never calls registerTool at
    // all never advertises the `tools` capability, and `tools/list` then answers "Method not
    // found" instead of an empty list — a difference well-behaved clients treat very differently.
    // Free regardless of which caller this is, since nothing is connected to a transport yet.
    for (const [name, tool] of toolHandles) {
      if (opts.isToolHidden(name)) tool.enabled = false;
    }
  }

  return { mcpServer, toolHandles };
}
