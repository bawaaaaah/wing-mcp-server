import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AuthMiddleware } from "./auth.js";
import { createAuthMiddleware } from "./auth.js";
import type { ConfigStore } from "./config-store.js";
import type { EventBus } from "./event-bus.js";
import { createHealthRoute, createStatusRoute, getPackageVersion } from "./health.js";
import { errorHandler, HttpError } from "./http-errors.js";
import type { OAuthIntegration } from "./oauth.js";
import { createOAuthIntegration } from "./oauth.js";
import type { McpPlugin } from "./plugin.js";
import { createSseRoute } from "./sse.js";

export interface McpGatewayServerOptions {
  port: number;
  authToken: string;
  configStore: ConfigStore;
  eventBus: EventBus;
  dashboardDistPath?: string;
  // The server's externally-reachable base URL, used as the OAuth issuer and to build discovery
  // metadata. Defaults to http://localhost:<port>, which is fine for local/LAN use but must be set
  // to a real public HTTPS URL (behind a reverse proxy or tunnel) for remote "web AI" OAuth clients
  // to be able to complete the authorization flow.
  publicUrl?: URL;
}

function getSessionId(req: Request): string | undefined {
  const header = req.headers["mcp-session-id"];
  return Array.isArray(header) ? header[0] : header;
}

function getPluginIdParam(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

// The main HTTP/MCP gateway: hosts the Streamable HTTP MCP transport, the
// plugin management/config/SSE REST API, and the compiled dashboard SPA.
export class McpGatewayServer {
  private readonly plugins: McpPlugin[];
  private readonly opts: McpGatewayServerOptions;
  private readonly auth: AuthMiddleware;
  private readonly publicUrl: URL;
  private readonly oauth: OAuthIntegration;
  private readonly startedAt = Date.now();
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();

  private httpServer: HttpServer | undefined;
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped: () => void = () => {};
  private signalHandlersRegistered = false;
  private readonly onSignal = () => {
    void this.stop().then(() => process.exit(0));
  };

  constructor(plugins: McpPlugin[], opts: McpGatewayServerOptions) {
    this.plugins = plugins;
    this.opts = opts;
    this.auth = createAuthMiddleware(opts.authToken);
    this.publicUrl = opts.publicUrl ?? new URL("http://localhost:" + opts.port);
    this.oauth = createOAuthIntegration(opts.authToken, this.publicUrl);
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  // The actual bound port once init() has resolved. Useful when constructed
  // with port 0 (bind to any free port), e.g. in tests.
  get port(): number | undefined {
    const address = this.httpServer?.address();
    return typeof address === "object" && address !== null ? address.port : undefined;
  }

  async init(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.start();
      } catch (err) {
        console.error("Plugin " + plugin.id + " failed to start:", err);
      }
    }

    const app = express();

    this.mountMcpRoutes(app, () => this.createMcpServer());
    // Core routes must be registered before the per-plugin router mount: Express matches routes in
    // registration order, and mountPluginHttpRoutes mounts each plugin's router with app.use(),
    // which — as a prefix mount — matches every sub-path under "/api/plugins/<id>/", including
    // "/api/plugins/<id>/events" and "/api/plugins/<id>/config". If that mount were registered
    // first, its blanket header-only requireAuth() would intercept those requests before the core
    // routes below (which correctly allow "/events" to authenticate via query param, since a
    // browser EventSource cannot send custom headers) ever got a chance to run — verified against a
    // real browser: the Meters tab's EventSource always failed 401 until this was fixed.
    this.mountCoreRoutes(app);
    // Must also be registered before mountDashboard: its catch-all only skips "/api" and "/mcp", so
    // the OAuth endpoints ("/authorize", "/token", "/register", "/.well-known/...", "/oauth/approve")
    // would otherwise fall through to the dashboard's index.html fallback.
    app.use(this.oauth.router);
    this.mountPluginHttpRoutes(app);
    this.mountDashboard(app);

    app.use(errorHandler());

    await new Promise<void>((resolve) => {
      this.httpServer = app.listen(this.opts.port, () => resolve());
    });

    this.printStartupBanner();
    this.registerSignalHandlers();
  }

  private printStartupBanner(): void {
    const address = this.httpServer?.address();
    const port = typeof address === "object" && address !== null ? address.port : this.opts.port;
    const dashboardUrl = "http://localhost:" + port + "/#token=" + this.opts.authToken;
    console.log("wing-mcp-server listening on port " + port);
    console.log("Dashboard: " + dashboardUrl);
    console.log(
      "MCP endpoint: " +
        new URL("/mcp", this.publicUrl).href +
        " (paste the token above directly, or let an OAuth-capable client discover the flow automatically)",
    );
  }

  /**
   * A fresh McpServer per session — verified against real hardware (Hermes, and a regression test
   * against a real StreamableHTTPClientTransport) that the SDK's Server.connect() only ever allows
   * ONE transport per Server instance for its entire lifetime: reusing a single shared McpServer
   * across sessions worked for the very first session a freshly-started gateway ever received, then
   * threw "Already connected to a transport" on every session after that (including simple
   * reconnects), which any real client — Hermes included — saw as the server refusing to connect at
   * all. Registering tools per-session is cheap enough that there's no reason to fight the SDK's
   * one-transport-per-Server design instead of just following it.
   */
  private createMcpServer(): McpServer {
    const mcpServer = new McpServer({ name: "wing-mcp-server", version: getPackageVersion() });
    for (const plugin of this.plugins) {
      plugin.registerTools(mcpServer);
    }
    return mcpServer;
  }

  private mountMcpRoutes(app: Express, createMcpServer: () => McpServer): void {
    // Bearer-token check backed by the OAuth provider's verifyAccessToken, which is itself just a
    // comparison against the same static token as this.auth — so a token pasted directly still
    // works exactly as before. Using the SDK's own middleware here (instead of this.auth) is what
    // adds the WWW-Authenticate: resource_metadata header OAuth-only clients need to discover the
    // authorization server on their first, unauthenticated request to /mcp.
    const requireAuth = requireBearerAuth({
      verifier: this.oauth.provider,
      resourceMetadataUrl: this.oauth.resourceMetadataUrl,
    });

    const mcpPostHandler = async (req: Request, res: Response): Promise<void> => {
      const sessionId = getSessionId(req);
      try {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && this.transports.has(sessionId)) {
          transport = this.transports.get(sessionId) as StreamableHTTPServerTransport;
        } else if (!sessionId && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (initializedSessionId) => {
              this.transports.set(initializedSessionId, transport);
            },
          });
          transport.onclose = () => {
            const closedSessionId = transport.sessionId;
            if (closedSessionId) this.transports.delete(closedSessionId);
          };
          await createMcpServer().connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        } else {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("Error handling MCP request:", err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    };

    const mcpSessionHandler = async (req: Request, res: Response): Promise<void> => {
      const sessionId = getSessionId(req);
      const transport = sessionId ? this.transports.get(sessionId) : undefined;
      if (!transport) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await transport.handleRequest(req, res);
    };

    app.post("/mcp", requireAuth, express.json(), mcpPostHandler);
    app.get("/mcp", requireAuth, mcpSessionHandler);
    app.delete("/mcp", requireAuth, mcpSessionHandler);
  }

  private mountPluginHttpRoutes(app: Express): void {
    for (const plugin of this.plugins) {
      if (!plugin.registerHttpRoutes) continue;
      const router = express.Router();
      plugin.registerHttpRoutes(router);
      app.use("/api/plugins/" + plugin.id, this.auth.requireAuth(), router);
    }
  }

  private findPlugin(id: string): McpPlugin | undefined {
    return this.plugins.find((plugin) => plugin.id === id);
  }

  private mountCoreRoutes(app: Express): void {
    const requireAuth = this.auth.requireAuth();
    const requireAuthQuery = this.auth.requireAuth({ allowQueryParam: true });

    app.get("/health", createHealthRoute(this.plugins, this.auth));
    app.get("/api/status", requireAuth, createStatusRoute(this.plugins, this.startedAt));

    app.get("/api/plugins", requireAuth, async (_req: Request, res: Response) => {
      const list = await Promise.all(
        this.plugins.map(async (plugin) => ({
          id: plugin.id,
          name: plugin.name,
          health: await plugin.getHealth().catch((err: unknown) => ({
            status: "ERROR" as const,
            errorMessage: String(err),
          })),
        })),
      );
      res.status(200).json(list);
    });

    app.get("/api/plugins/:id/config", requireAuth, (req: Request, res: Response, next: NextFunction) => {
      const id = getPluginIdParam(req);
      const plugin = this.findPlugin(id);
      if (!plugin) {
        next(new HttpError(404, "Unknown plugin: " + id));
        return;
      }
      res.status(200).json({ schema: plugin.getConfigSchema(), config: plugin.getConfig() });
    });

    app.put(
      "/api/plugins/:id/config",
      requireAuth,
      express.json(),
      async (req: Request, res: Response, next: NextFunction) => {
        const id = getPluginIdParam(req);
        const plugin = this.findPlugin(id);
        if (!plugin) {
          next(new HttpError(404, "Unknown plugin: " + id));
          return;
        }
        try {
          await plugin.setConfig(req.body);
          res.status(200).json({ config: plugin.getConfig() });
        } catch (err) {
          next(new HttpError(400, err instanceof Error ? err.message : String(err)));
        }
      },
    );

    app.get(
      "/api/plugins/:id/events",
      requireAuthQuery,
      (req: Request, res: Response, next: NextFunction) => {
        const id = getPluginIdParam(req);
        const plugin = this.findPlugin(id);
        if (!plugin) {
          next(new HttpError(404, "Unknown plugin: " + id));
          return;
        }
        createSseRoute(this.opts.eventBus, { pluginId: plugin.id })(req, res, next);
      },
    );

    app.get("/api/events", requireAuthQuery, createSseRoute(this.opts.eventBus));

    app.get("/api/auth/verify", requireAuth, (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });
  }

  private mountDashboard(app: Express): void {
    const dashboardDistPath =
      this.opts.dashboardDistPath ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

    app.use(express.static(dashboardDistPath));

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET") {
        next();
        return;
      }
      if (req.path.startsWith("/api") || req.path.startsWith("/mcp")) {
        next();
        return;
      }
      res.sendFile(path.join(dashboardDistPath, "index.html"));
    });
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

  async stop(): Promise<void> {
    this.unregisterSignalHandlers();

    if (this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // server.close()'s callback only fires once every existing connection has ended — but the
        // SSE routes (/api/plugins/:id/events, /api/events) are long-lived by design, so a single
        // dashboard tab left open would otherwise make a graceful shutdown hang indefinitely.
        // Force-close everything (including those streams) right away instead of waiting for them.
        server.closeAllConnections();
      });
      this.httpServer = undefined;
    }

    for (const transport of this.transports.values()) {
      try {
        await transport.close();
      } catch (err) {
        console.error("Error closing MCP transport:", err);
      }
    }
    this.transports.clear();

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
