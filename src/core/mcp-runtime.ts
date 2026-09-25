import process from "node:process";
import { McpGatewayServer } from "./mcp-gateway-server.js";
import type { McpPlugin } from "./plugin.js";
import { redirectConsoleToStderr, StdioEndpoint } from "./stdio-endpoint.js";
import type { ToolVisibilityController } from "./tool-visibility-controller.js";
import { describeTransportConfig, type ResolvedTransports } from "./transport-config.js";

export interface McpRuntimeOptions {
  plugins: McpPlugin[];
  transports: ResolvedTransports;
  /** Constructed by bootstrap() only when `transports.http` — absent means HTTP is not being served. */
  gateway?: McpGatewayServer;
  /** Shared with the gateway, so both transports hide the same tools. Absent: stdio exposes all. */
  toolVisibility?: ToolVisibilityController;
}

/**
 * Owns everything a `wing-mcp-server` process needs regardless of which transports it serves:
 * starting and stopping the plugins (so the console's single OSC connection is shared rather than
 * duplicated when both transports run), the process's SIGINT/SIGTERM handling, and the decision of
 * what to do when the HTTP listen fails while stdio is still up.
 *
 * `McpGatewayServer` stays exactly what its name says — the HTTP gateway — rather than growing
 * nullable auth/OAuth/passkey fields to express "no web server was started". When HTTP is off there
 * is simply no `McpGatewayServer` instance at all.
 */
export class McpRuntime {
  private readonly plugins: McpPlugin[];
  private readonly transports: ResolvedTransports;
  private readonly toolVisibility: ToolVisibilityController | undefined;
  private gateway: McpGatewayServer | undefined;
  private stdioEndpoint: StdioEndpoint | undefined;
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped: () => void = () => {};
  private stopping: Promise<void> | undefined;
  private signalHandlersRegistered = false;
  private readonly onSignal = () => {
    void this.stop().then(() => this.exitAfterFlush());
  };

  constructor(opts: McpRuntimeOptions) {
    this.plugins = opts.plugins;
    this.transports = opts.transports;
    this.gateway = opts.gateway;
    this.toolVisibility = opts.toolVisibility;
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  /** The gateway's bound port, once started — undefined when HTTP is disabled or not yet bound. */
  get httpPort(): number | undefined {
    return this.gateway?.port;
  }

  async start(): Promise<void> {
    if (this.transports.stdio) {
      // Before anything else can log a stray line: stdout must carry nothing but this stdio
      // session's JSON-RPC for the rest of the process's life.
      redirectConsoleToStderr();
    }
    console.error("wing-mcp-server transports: " + describeTransportConfig(this.transports));

    for (const plugin of this.plugins) {
      try {
        await plugin.start();
      } catch (err) {
        console.error("Plugin " + plugin.id + " failed to start:", err);
      }
    }

    // Started before the HTTP listen: a client that spawned this process over stdio is waiting on
    // `initialize`, and plugin startup (the OSC connect, and up to ~3s of cache warm-up) already
    // spent whatever latency there was to spend. No reason to make it wait on the dashboard too.
    if (this.transports.stdio) {
      const endpoint = new StdioEndpoint({
        plugins: this.plugins,
        toolVisibility: this.toolVisibility,
        onClientDisconnect: () => {
          void this.stop().then(() => this.exitAfterFlush());
        },
      });
      await endpoint.start();
      this.stdioEndpoint = endpoint;
    }

    if (this.gateway) {
      try {
        await this.gateway.init();
      } catch (err) {
        if (!this.transports.stdio) {
          throw err;
        }
        // A client spawning this process over stdio must not lose its session because the
        // dashboard's port was already taken by another instance, or any other listen failure
        // (EACCES on a privileged port, EADDRNOTAVAIL on a bad bindHost) — refusing stdio too would
        // be the worse of the two failures.
        const detail = err instanceof Error ? err.message : String(err);
        const hint =
          err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? " Another instance is probably already serving the dashboard on this port."
            : "";
        console.error("HTTP transport unavailable (" + detail + "); continuing with stdio only." + hint);
        await this.gateway.stop().catch(() => undefined);
        this.gateway = undefined;
      }
    }

    this.registerSignalHandlers();
  }

  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
  }

  private unregisterSignalHandlers(): void {
    if (!this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = false;
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
  }

  /**
   * Flushes stdout before exiting: `process.exit()` truncates a pending write when stdout is a
   * pipe, which — on the way out of a stdio session — would be the final JSON-RPC response the
   * client is waiting to read.
   */
  private exitAfterFlush(): void {
    process.stdout.write("", () => process.exit(0));
  }

  /**
   * Memoised: reachable from a signal, from the stdio client disconnecting, and from a caller (a
   * test, or `runServer()`'s own cleanup) — none of which should run `WingPlugin.stop()` or
   * `oauth.provider.close()` more than once.
   */
  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.unregisterSignalHandlers();

    if (this.stdioEndpoint) {
      await this.stdioEndpoint.stop();
    }
    if (this.gateway) {
      await this.gateway.stop();
    }

    await Promise.allSettled(this.plugins.map((plugin) => plugin.stop()));

    this.resolveStopped();
  }

  async waitUntilStop(): Promise<void> {
    return this.stoppedPromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}
