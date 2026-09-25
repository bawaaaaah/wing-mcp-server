import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AuthMiddleware } from "./auth.js";
import { createAuthMiddleware } from "./auth.js";
import type { ConfigStore } from "./config-store.js";
import type { EventBus } from "./event-bus.js";
import { createHealthRoute, createStatusRoute } from "./health.js";
import { errorHandler, HttpError } from "./http-errors.js";
import { buildInstructions, createMcpServer, type CreatedMcpServer } from "./mcp-server-factory.js";
import type { OAuthIntegration } from "./oauth.js";
import { createOAuthIntegration } from "./oauth.js";
import { createPasskeyRouter, PasskeyService } from "./passkeys.js";
import type { McpPlugin } from "./plugin.js";
import { createRateLimit } from "./rate-limit.js";
import { describeSecurityConfig, type SecurityConfig } from "./security-config.js";
import { createSseRoute } from "./sse.js";
import type { PluginToolCatalogue } from "./tool-catalogue.js";
import { describeToolVisibility, ToolVisibilitySchema, type ToolVisibility } from "./tool-visibility.js";
import { ToolVisibilityController } from "./tool-visibility-controller.js";

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
  /**
   * False when something else owns the plugins' lifecycle — McpRuntime does, whenever they are
   * shared with the stdio endpoint. Default true, which is this gateway started on its own.
   */
  managePlugins?: boolean;
  /** False when something else owns SIGINT/SIGTERM for the whole process. Default true. */
  manageSignals?: boolean;
  /**
   * Which tools are hidden. Shared with the stdio endpoint when both transports run (McpRuntime
   * owns it then), so one `server.tools` choice — and one live change from the Tools page — covers
   * both. Default: a controller of this gateway's own.
   */
  toolVisibility?: ToolVisibilityController;
  /**
   * Where the startup banner goes. Default `console.log`. A stdio transport needs it on stderr,
   * because stdout there carries newline-delimited JSON-RPC and nothing else.
   */
  log?: (line: string) => void;
}

/**
 * A live MCP session plus when it was last used. The timestamp exists because nothing else bounds
 * this map: a client that goes away without sending `DELETE /mcp` — a closed laptop, a killed
 * process, a dropped tunnel — leaves its transport *and* its per-session McpServer (every registered
 * tool's closures, plus the resources) resident for as long as the process lives. The
 * OAuth code in this same repo already bounds exactly this class of map; the MCP one never did.
 */
interface McpSessionEntry {
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
  /** This session's own McpServer — needed to send a single tools/list_changed after a live PUT. */
  mcpServer: McpServer;
  /** Lives and dies with this entry, nowhere else — see applyToolVisibilityToLiveSessions(). */
  toolHandles: Map<string, RegisteredTool>;
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

  private readonly toolVisibility: ToolVisibilityController;

  private httpServer: HttpServer | undefined;
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped: () => void = () => undefined;
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
    this.toolVisibility = opts.toolVisibility ?? new ToolVisibilityController(plugins, opts.configStore);
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
    if (this.opts.managePlugins ?? true) {
      for (const plugin of this.plugins) {
        try {
          await plugin.start();
        } catch (err) {
          console.error("Plugin " + plugin.id + " failed to start:", err);
        }
      }
    }

    // Before anything that registers a session: a session's tool visibility is decided at
    // registration time, so the catalogue that gives disabledGroups/disabledTools meaning must
    // exist before the very first createMcpServer() call.
    await this.toolVisibility.load();

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

    this.mountMcpRoutes(app, () =>
      createMcpServer(this.plugins, {
        extraInstructions: this.toolVisibility.instructionsAddendum(),
        isToolHidden: (name) => this.toolVisibility.isHidden(name),
      }),
    );
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

    // Assigned only once the socket is actually bound, so stop() never closes a server that never
    // listened.
    this.httpServer = await this.listen(app);

    this.sessionSweepTimer = setInterval(() => this.sweepIdleSessions(), SESSION_SWEEP_INTERVAL_MS);
    // Never the reason the process stays alive.
    this.sessionSweepTimer.unref?.();

    this.printStartupBanner();
    if (this.opts.manageSignals ?? true) {
      this.registerSignalHandlers();
    }
  }

  /**
   * Binds the HTTP server and, unlike the bare `app.listen(port, cb)` this replaces, actually
   * reports a failure. With no 'error' listener a listen failure surfaced as an uncaughtException,
   * which runServer()'s handler logged as "server continuing" while this promise never settled — so
   * `wing-mcp-server` on an occupied port was a silent zombie: no dashboard, no /mcp, still holding
   * the console's OSC connection, and still alive because the OSC renewal interval is not unref'd.
   *
   * Rejecting rather than handling it here is what lets McpRuntime carry on with stdio alone when
   * that transport is up, and keep failing loudly when it is not.
   */
  private listen(app: Express): Promise<HttpServer> {
    const bindHost = this.opts.security?.bindHost;
    return new Promise<HttpServer>((resolve, reject) => {
      // Unset means every interface, which is what a container needs: binding 127.0.0.1 inside one
      // makes the server unreachable from the host and breaks published ports entirely.
      const server = bindHost ? app.listen(this.opts.port, bindHost) : app.listen(this.opts.port);
      const onError = (err: Error): void => {
        // A no-op when the bind itself failed (there is no handle to release), which is the case
        // this exists for.
        server.close();
        reject(err);
      };
      server.once("error", onError);
      server.once("listening", () => {
        server.off("error", onError);
        // A socket-level failure long after the bind must not disappear into a promise that has
        // already settled.
        server.on("error", (err) => {
          console.error("HTTP server error:", err);
        });
        resolve(server);
      });
    });
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

  /**
   * Pushes the current visibility to every open HTTP session. A session being created right now
   * never reaches here — createMcpServer's `isToolHidden` covers it, and a disconnected McpServer
   * never sends the notification anyway. This is only for sessions that were already open when a
   * `PUT /api/tools` changed the answer; the stdio session subscribes to the controller itself.
   */
  private applyToolVisibilityToLiveSessions(): number {
    let affectedSessions = 0;
    // Snapshot first: sweepIdleSessions/evictOldestSessionIfFull can mutate this.transports, and
    // this loop must not observe that half-way through.
    for (const entry of [...this.transports.values()]) {
      if (!this.toolVisibility.applyTo(entry.toolHandles)) continue;
      affectedSessions += 1;
      if (entry.mcpServer.isConnected()) {
        // McpServer.sendToolListChanged() does not await the underlying send, so a write failure
        // on a half-dead transport would otherwise become an unhandled rejection.
        void entry.mcpServer.server.sendToolListChanged().catch((err: unknown) => {
          console.warn("Failed to notify an MCP session that its tool list changed:", err);
        });
      }
    }
    return affectedSessions;
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
    const log = this.opts.log ?? ((line: string) => console.log(line));
    const address = this.httpServer?.address();
    const port = typeof address === "object" && address !== null ? address.port : this.opts.port;
    log("wing-mcp-server listening on port " + port);
    log("Hardening: " + describeSecurityConfig(this.opts.security ?? {}));
    const totalTools = this.toolVisibility.getCatalogues().reduce((sum, catalogue) => sum + catalogue.tools.length, 0);
    if (totalTools > 0) {
      log("Tools: " + describeToolVisibility(totalTools, totalTools - this.toolVisibility.hiddenCount));
    }
    if (this.opts.security?.quietToken === false) {
      // Explicit opt-in only (see SecurityConfigSchema.quietToken): a log is the wrong home for the
      // master token, so this is never the default.
      log("Dashboard: http://localhost:" + port + "/#token=" + this.opts.authToken);
    } else {
      // The token still has to be reachable, just not from the log: under Docker the banner would
      // otherwise sit in `docker logs` for the life of the container, in the journal under
      // systemd, and in a desktop client's MCP logs under stdio.
      log("Dashboard: http://localhost:" + port + "/");
      log(
        "Auth token: not logged — print it with `wing-mcp-server --print-token`, or read server.authToken in " +
          this.opts.configStore.filePath,
      );
    }
    log(
      "MCP endpoint: " +
        new URL("/mcp", this.publicUrl).href +
        " (send the auth token as a Bearer header, or let an OAuth-capable client discover the flow automatically)",
    );
  }

  private mountMcpRoutes(app: Express, newSessionServer: () => CreatedMcpServer): void {
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
          // Created before the transport: onsessioninitialized fires from inside
          // transport.handleRequest() below, so the session's handles must already exist by then.
          const session = newSessionServer();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (initializedSessionId) => {
              this.evictOldestSessionIfFull();
              this.transports.set(initializedSessionId, {
                transport,
                lastSeenAt: Date.now(),
                mcpServer: session.mcpServer,
                toolHandles: session.toolHandles,
              });
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
          await session.mcpServer.connect(transport);
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

  /**
   * The full answer to `GET /api/tools`, and what a `PUT` echoes back. Merges every plugin's
   * catalogue (today, only the WING plugin has one) so the dashboard sees one flat list rather
   * than a table per plugin — group ids only need to be unique within a plugin, not globally.
   */
  private buildToolsResponse(): {
    groups: {
      id: string;
      label: string;
      description: string;
      category?: string;
      toolCount: number;
      enabledCount: number;
      bytes: number;
      enabledBytes: number;
    }[];
    tools: { name: string; title?: string; summary?: string; group: string; bytes: number; readOnly: boolean; enabled: boolean }[];
    profiles: PluginToolCatalogue["profiles"];
    totals: {
      tools: number;
      enabledTools: number;
      bytes: number;
      enabledBytes: number;
      instructionsBytes: number;
      approxTokens: number;
      approxEnabledTokens: number;
    };
    visibility: ToolVisibility;
    unknown: string[];
  } {
    const groups: ReturnType<McpGatewayServer["buildToolsResponse"]>["groups"] = [];
    const tools: ReturnType<McpGatewayServer["buildToolsResponse"]>["tools"] = [];
    const profiles: PluginToolCatalogue["profiles"] = [];

    for (const catalogue of this.toolVisibility.getCatalogues()) {
      profiles.push(...catalogue.profiles);
      for (const group of catalogue.groups) {
        const inGroup = catalogue.tools.filter((tool) => tool.group === group.id);
        const enabledInGroup = inGroup.filter((tool) => !this.toolVisibility.isHidden(tool.name));
        groups.push({
          ...group,
          toolCount: inGroup.length,
          enabledCount: enabledInGroup.length,
          bytes: inGroup.reduce((sum, tool) => sum + tool.bytes, 0),
          enabledBytes: enabledInGroup.reduce((sum, tool) => sum + tool.bytes, 0),
        });
      }
      for (const tool of catalogue.tools) {
        tools.push({ ...tool, enabled: !this.toolVisibility.isHidden(tool.name) });
      }
    }

    const bytes = tools.reduce((sum, tool) => sum + tool.bytes, 0);
    const enabledBytes = tools.filter((tool) => tool.enabled).reduce((sum, tool) => sum + tool.bytes, 0);
    const addendum = this.toolVisibility.instructionsAddendum();
    const base = buildInstructions(this.plugins);
    const fullInstructions = addendum ? [base, addendum].filter(Boolean).join("\n\n") : base;
    const instructionsBytes = Buffer.byteLength(fullInstructions ?? "");
    // 4 bytes/token is the same rough-and-ready estimate used everywhere else this server counts
    // tokens (see the catalogue byte measurement above it descends from) — good enough to compare
    // profiles against each other, not a claim about any specific tokenizer.
    const approxTokens = (n: number) => Math.round(n / 4);

    return {
      groups,
      tools,
      profiles,
      totals: {
        tools: tools.length,
        enabledTools: tools.filter((tool) => tool.enabled).length,
        bytes,
        enabledBytes,
        instructionsBytes,
        approxTokens: approxTokens(bytes),
        approxEnabledTokens: approxTokens(enabledBytes),
      },
      visibility: this.toolVisibility.getVisibility(),
      unknown: this.toolVisibility.getUnknown(),
    };
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

    // The dashboard's Tools page and GET/PUT /api/tools below. Unknown group/tool ids in the
    // *request body* are tolerated the same way a hand-edited config.json is (reported under
    // `unknown`, never rejected) — a tool renamed by an upgrade must not turn a routine save into
    // a 400. Only the JSON *shape* is validated here; ToolVisibilitySchema.
    app.get("/api/tools", requireAuth, (_req: Request, res: Response) => {
      res.status(200).json(this.buildToolsResponse());
    });

    app.put("/api/tools", requireAuth, express.json(), async (req: Request, res: Response, next: NextFunction) => {
      const parsed = ToolVisibilitySchema.safeParse(req.body);
      if (!parsed.success) {
        next(new HttpError(400, parsed.error.message));
        return;
      }
      // Unlike an unknown group or tool name (tolerated, see above), an unknown profile is refused
      // here: it would silently fall back to read-only tools, and nothing the dashboard sends can
      // legitimately name one. A hand-edited file still gets the fallback, and a warning at boot.
      if (parsed.data.profile !== undefined && !this.toolVisibility.isKnownProfile(parsed.data.profile.trim())) {
        next(new HttpError(400, `Unknown tool profile: ${parsed.data.profile}`));
        return;
      }
      let otherSessions: number;
      try {
        otherSessions = await this.toolVisibility.update(parsed.data);
      } catch (err) {
        next(new HttpError(500, err instanceof Error ? err.message : String(err)));
        return;
      }
      const liveSessions = this.applyToolVisibilityToLiveSessions() + otherSessions;
      res.status(200).json({ ...this.buildToolsResponse(), liveSessions });
    });

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

    // `kind` tells the dashboard which credential it holds, so the Connect page can build its
    // snippets from the token it already has (static) or say where to get one (passkey session).
    // There is deliberately no endpoint that hands the master token to a passkey session: that would
    // make a stolen session cookie worth exactly as much as the token it was meant to replace.
    app.get("/api/auth/verify", requireAuth, (req: Request, res: Response) => {
      res.status(200).json({ ok: true, kind: this.auth.authKind(req) ?? "session" });
    });

    // Every OAuth client that ever completed registration, with how many live grants it holds —
    // and the one way to cut a single client off without rotating the master token.
    app.get("/api/auth/oauth-clients", requireAuth, (_req: Request, res: Response) => {
      res.status(200).json({ clients: this.oauth.provider.listClients() });
    });

    app.delete("/api/auth/oauth-clients/:id", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
      const id = getPluginIdParam(req);
      try {
        if (!(await this.oauth.provider.revokeClient(id))) {
          next(new HttpError(404, "Unknown OAuth client: " + id));
          return;
        }
      } catch (err) {
        next(new HttpError(500, err instanceof Error ? err.message : String(err)));
        return;
      }
      res.status(204).end();
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

    if (this.opts.managePlugins ?? true) {
      await Promise.allSettled(this.plugins.map((plugin) => plugin.stop()));
    }

    this.resolveStopped();
  }

  async waitUntilStop(): Promise<void> {
    return this.stoppedPromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}
