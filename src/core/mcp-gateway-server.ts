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
import { createPasskeyRouter, PasskeyService } from "./passkeys.js";
import type { McpPlugin } from "./plugin.js";
import { createRateLimit } from "./rate-limit.js";
import { describeSecurityConfig, type SecurityConfig } from "./security-config.js";
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
  // Opt-in hardening (core/security-config.ts). Absent, or absent fields within it, means the
  // behaviour this server has always had — nothing here is imposed on a LAN install.
  security?: SecurityConfig;
}

/**
 * A live MCP session plus when it was last used. The timestamp exists because nothing else bounds
 * this map: a client that goes away without sending `DELETE /mcp` — a closed laptop, a killed
 * process, a dropped tunnel — leaves its transport *and* its per-session McpServer (116 registered
 * tools' worth of closures, plus the resources) resident for as long as the process lives. The
 * OAuth code in this same repo already bounds exactly this class of map; the MCP one never did.
 */
interface McpSessionEntry {
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

/** How long a session may go untouched before it is swept. */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Hard ceiling, so a burst of initializes cannot outrun the sweep. */
const MAX_SESSIONS = 200;

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
  private readonly passkeys: PasskeyService;
  private readonly oauth: OAuthIntegration;
  private readonly startedAt = Date.now();
  private readonly transports = new Map<string, McpSessionEntry>();
  private sessionSweepTimer: NodeJS.Timeout | null = null;

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
    this.publicUrl = opts.publicUrl ?? new URL("http://localhost:" + opts.port);
    this.passkeys = new PasskeyService(opts.configStore, this.publicUrl);
    this.auth = createAuthMiddleware(opts.authToken, {
      isValidSessionToken: (candidate) => this.passkeys.isValidSession(candidate),
    });
    this.oauth = createOAuthIntegration(opts.authToken, this.publicUrl, opts.configStore, this.passkeys);
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

    // Nothing this server serves has any business being embedded in someone else's page, and one
    // page in particular must never be: /oauth/approve grants a client access with a single click
    // (or one passkey touch), shows only the client's self-chosen name, and hands back the master
    // auth token. Framed and overlaid, that is a one-click account takeover. Applied app-wide
    // rather than on that route alone because the exception would be the surprising part, and
    // because the OAuth router mounts on this same app.
    app.use((_req, res, next) => {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      next();
    });

    // Only failed authentication is charged, which is why this can sit in front of everything:
    // it bounds online guessing of the bearer token without metering a working dashboard's meter
    // polling or fader drags. Absent from the config means no limit, as before.
    const rateLimit = this.opts.security?.rateLimit;
    const trustProxy = this.opts.security?.trustProxy;
    if (trustProxy !== undefined) {
      app.set("trust proxy", trustProxy);
    } else if (rateLimit) {
      // Worth saying out loud rather than failing quietly at 3am: behind a proxy without this,
      // every client looks like the proxy, so they all share one bucket and one attacker locks
      // out the operator too.
      console.warn(
        "Hardening: rateLimit is set but trustProxy is not. If this server sits behind a reverse " +
          "proxy or tunnel, set trustProxy (see docs/configuration.md) or the limit will apply to " +
          "all clients collectively rather than per client.",
      );
    }
    if (rateLimit) {
      app.use(
        createRateLimit({
          windowMs: rateLimit.windowMs,
          max: rateLimit.max,
          countResponse: (res) => res.statusCode === 401 || res.statusCode === 403,
        }),
      );
    }

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
      const bindHost = this.opts.security?.bindHost;
      // Unset means every interface, which is what a container needs: binding 127.0.0.1 inside one
      // makes the server unreachable from the host and breaks published ports entirely.
      this.httpServer = bindHost
        ? app.listen(this.opts.port, bindHost, () => resolve())
        : app.listen(this.opts.port, () => resolve());
    });

    this.sessionSweepTimer = setInterval(() => this.sweepIdleSessions(), SESSION_SWEEP_INTERVAL_MS);
    // Never the reason the process stays alive.
    this.sessionSweepTimer.unref?.();

    this.printStartupBanner();
    this.registerSignalHandlers();
  }

  /**
   * Closing the transport fires its `onclose`, which removes the entry — so this both releases the
   * session and lets the per-session McpServer be collected.
   */
  private closeSession(sessionId: string, entry: McpSessionEntry, reason: string): void {
    console.warn(`Closing MCP session ${sessionId} (${reason})`);
    try {
      void entry.transport.close();
    } catch (err) {
      console.error(`Failed to close MCP session ${sessionId}:`, err);
    }
    this.transports.delete(sessionId);
  }

  private sweepIdleSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const [sessionId, entry] of this.transports) {
      if (entry.lastSeenAt <= cutoff) {
        this.closeSession(sessionId, entry, "idle");
      }
    }
  }

  /**
   * The sweep runs on a timer, so a fast enough burst of initializes could still outgrow the map
   * between two passes. Evicting the least recently used one keeps that bounded; it is a last
   * resort, not the normal path.
   */
  private evictOldestSessionIfFull(): void {
    if (this.transports.size < MAX_SESSIONS) {
      return;
    }
    let oldestId: string | undefined;
    let oldestSeenAt = Infinity;
    for (const [sessionId, entry] of this.transports) {
      if (entry.lastSeenAt < oldestSeenAt) {
        oldestSeenAt = entry.lastSeenAt;
        oldestId = sessionId;
      }
    }
    const oldest = oldestId === undefined ? undefined : this.transports.get(oldestId);
    if (oldestId !== undefined && oldest) {
      this.closeSession(oldestId, oldest, `session cap of ${MAX_SESSIONS} reached`);
    }
  }

  private dnsRebindingOptions(): {
    enableDnsRebindingProtection?: boolean;
    allowedOrigins?: string[];
    allowedHosts?: string[];
  } {
    const { allowedOrigins, allowedHosts } = this.opts.security ?? {};
    if (!allowedOrigins?.length && !allowedHosts?.length) {
      return {};
    }
    return {
      enableDnsRebindingProtection: true,
      ...(allowedOrigins?.length ? { allowedOrigins } : {}),
      ...(allowedHosts?.length ? { allowedHosts } : {}),
    };
  }

  private printStartupBanner(): void {
    const address = this.httpServer?.address();
    const port = typeof address === "object" && address !== null ? address.port : this.opts.port;
    console.log("wing-mcp-server listening on port " + port);
    console.log("Hardening: " + describeSecurityConfig(this.opts.security ?? {}));
    if (this.opts.security?.quietToken) {
      // The token still has to be reachable, just not from the log: under Docker the banner would
      // otherwise sit in `docker logs` for the life of the container, and in the journal under
      // systemd.
      console.log("Dashboard: http://localhost:" + port + "/ (token withheld from the log; see data/config.json)");
    } else {
      console.log("Dashboard: http://localhost:" + port + "/#token=" + this.opts.authToken);
    }
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

        const existing = sessionId ? this.transports.get(sessionId) : undefined;
        if (existing) {
          existing.lastSeenAt = Date.now();
          transport = existing.transport;
        } else if (sessionId) {
          // 404, not 400: it is the 404 that tells a client its session is gone and it should
          // initialize a new one. A 400 reads as "your request was malformed", which it was not.
          res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          });
          return;
        } else if (isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (initializedSessionId) => {
              this.evictOldestSessionIfFull();
              this.transports.set(initializedSessionId, { transport, lastSeenAt: Date.now() });
            },
            // The SDK defaults this to false; the MCP spec asks local HTTP servers to validate
            // Origin. Switched on only once an allowlist exists, because enabling it with an empty
            // one would reject every request — the one failure mode worse than not checking.
            ...this.dnsRebindingOptions(),
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
      const entry = sessionId ? this.transports.get(sessionId) : undefined;
      if (!entry) {
        // Missing is a client error; known-but-gone is a 404, for the same reason as above.
        res.status(sessionId ? 404 : 400).send(sessionId ? "Session not found" : "Missing session ID");
        return;
      }
      entry.lastSeenAt = Date.now();
      await entry.transport.handleRequest(req, res);
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
    const requireAuthQuery = this.auth.requireAuth({ allowQueryTicket: true });

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

    // A browser signed in with a passkey holds a web session token, not the static token MCP clients
    // need — the Connect page fetches the real one from here to build its copy-paste snippets. Any
    // signed-in dashboard user is already a full administrator, so this doesn't widen access.
    app.get("/api/auth/server-token", requireAuth, (_req: Request, res: Response) => {
      res.status(200).json({ token: this.opts.authToken });
    });

    app.use(createPasskeyRouter(this.passkeys, this.auth));

    // Exchanges the real bearer token (header-authenticated, like every other route here) for a
    // short-lived, single-use ticket the browser can put in an EventSource URL instead — see
    // core/auth.ts's SseTicketStore for why the real token itself never appears in a URL.
    app.post("/api/auth/sse-ticket", requireAuth, (_req: Request, res: Response) => {
      res.status(200).json({ ticket: this.auth.issueSseTicket() });
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
    this.oauth.provider.close();
    if (this.sessionSweepTimer) {
      clearInterval(this.sessionSweepTimer);
      this.sessionSweepTimer = null;
    }

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

    for (const { transport } of this.transports.values()) {
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
