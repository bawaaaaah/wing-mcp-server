import type { Readable, Writable } from "node:stream";
import process from "node:process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server-factory.js";
import type { McpPlugin } from "./plugin.js";
import type { ToolVisibilityController } from "./tool-visibility-controller.js";

export interface StdioEndpointOptions {
  plugins: readonly McpPlugin[];
  /**
   * Called at most once, when the client that owns this process goes away — stdin EOF, or the
   * transport closing for any other reason. Not called for a shutdown this endpoint started itself.
   */
  onClientDisconnect: () => void;
  /**
   * Which tools to hide — the same controller the HTTP gateway uses, so `server.tools` (the `safe`
   * profile included) applies to a stdio client exactly as to an HTTP one, and a change made on the
   * dashboard's Tools page reaches this session live. Absent means every tool is exposed.
   */
  toolVisibility?: ToolVisibilityController;
  /**
   * Default `process.stdin`/`process.stdout`. Injectable because the SDK's transport takes them as
   * constructor arguments, which is what makes the EOF wiring below testable in-process.
   */
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Sends everything that would have gone to stdout to stderr instead, for the life of the process.
 *
 * On a stdio transport, stdout carries newline-delimited JSON-RPC and nothing else: one stray line
 * lands in the client's read buffer, fails to parse, and — if it had no trailing newline — corrupts
 * the *next* real message too. This server's own banner is already routed through
 * `McpGatewayServerOptions.log`, so this is the guard for everything else: `osc`, `express`,
 * `@simplewebauthn/server`, a future plugin, any transitive dependency that decides to log. A
 * redirect rather than a silencer, so nothing is actually lost.
 *
 * Deliberately leaves `process.stdout.write` alone — that is how the transport itself replies.
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.dir = toStderr;
}

/**
 * Serves MCP over stdin/stdout, for the case where the client spawns this process itself
 * (`npx @bawaaaaah/wing-mcp-server --stdio`) rather than connecting to it over HTTP.
 *
 * Shares the plugins — and so the console's single OSC connection — with the HTTP gateway when both
 * transports are enabled. Owns neither the plugins' lifecycle nor the process's; McpRuntime does.
 */
export class StdioEndpoint {
  private readonly opts: StdioEndpointOptions;
  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private mcpServer: McpServer | undefined;
  private unsubscribeVisibility: (() => void) | undefined;
  private stopping: Promise<void> | undefined;
  private notifiedDisconnect = false;

  constructor(opts: StdioEndpointOptions) {
    this.opts = opts;
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
  }

  async start(): Promise<void> {
    const visibility = this.opts.toolVisibility;
    if (visibility) await visibility.load();
    const { mcpServer, toolHandles } = createMcpServer(
      this.opts.plugins,
      visibility
        ? { extraInstructions: visibility.instructionsAddendum(), isToolHidden: (name) => visibility.isHidden(name) }
        : {},
    );
    this.mcpServer = mcpServer;
    this.unsubscribeVisibility = visibility?.onChange(() => {
      if (!visibility.applyTo(toolHandles)) return false;
      if (mcpServer.isConnected()) {
        // Not awaited by the SDK either; a write failure on a closing pipe must not become an
        // unhandled rejection.
        void mcpServer.server.sendToolListChanged().catch((err: unknown) => {
          console.warn("Failed to notify the stdio session that its tool list changed:", err);
        });
      }
      return true;
    });

    // On the Server rather than on the transport: `Protocol.connect()` assigns
    // `transport.onclose` itself, and while it happens to chain a handler that was already there,
    // its own docstring says it replaces one — not a behaviour to build on. `Server` sets only
    // `oninitialized` for itself, so these two are free.
    mcpServer.server.onclose = () => this.notifyDisconnect();
    mcpServer.server.onerror = (err) => {
      console.error("MCP stdio transport error:", err);
    };

    await mcpServer.connect(new StdioServerTransport(this.stdin, this.stdout));

    // The SDK's StdioServerTransport attaches only 'data' and 'error' to stdin — it never notices
    // EOF, so `onclose` alone would not fire when the client exits. Without this the process
    // outlives every client that ever spawned it (the OSC renewal and meter keepalive intervals are
    // not unref'd, so nothing else would end it), each survivor still holding the console's
    // subscription and, with HTTP enabled, the port the next spawn needs.
    this.stdin.once("end", this.onStdinClosed);
    this.stdin.once("close", this.onStdinClosed);
  }

  private readonly onStdinClosed = (): void => {
    this.notifyDisconnect();
  };

  private notifyDisconnect(): void {
    if (this.notifiedDisconnect) return;
    this.notifiedDisconnect = true;
    this.opts.onClientDisconnect();
  }

  /**
   * Memoised: `stop()` is reachable from the runtime's own shutdown *and* from the disconnect it
   * triggers, and closing the server fires `onclose` — so this would otherwise re-enter itself.
   */
  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    // Suppresses the callback for a close we are performing ourselves: the client has not gone
    // anywhere, we are the ones leaving.
    this.notifiedDisconnect = true;
    this.stdin.off("end", this.onStdinClosed);
    this.stdin.off("close", this.onStdinClosed);
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = undefined;

    const mcpServer = this.mcpServer;
    this.mcpServer = undefined;
    if (!mcpServer) return;
    try {
      await mcpServer.close();
    } catch (err) {
      console.error("Error closing the MCP stdio transport:", err);
    }
  }
}
