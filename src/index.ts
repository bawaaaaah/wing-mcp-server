import { resolveAuthToken, resolvePublicUrl } from "./core/auth.js";
import { ConfigStore } from "./core/config-store.js";
import { getEnvInt, getEnvString } from "./core/env.js";
import { EventBus } from "./core/event-bus.js";
import { McpGatewayServer } from "./core/mcp-gateway-server.js";
import { McpRuntime } from "./core/mcp-runtime.js";
import type { McpPlugin } from "./core/plugin.js";
import { resolveSecurityConfig } from "./core/security-config.js";
import { ToolVisibilityController } from "./core/tool-visibility-controller.js";
import { assertAtLeastOneTransport, NoTransportEnabledError, resolveTransportConfig } from "./core/transport-config.js";
import { WingPlugin } from "./plugins/wing/wing-plugin.js";

/** Where the persisted state lives — shared by the server and `--print-token`, so they never disagree. */
function configPathFromEnv(): string {
  return getEnvString("MCP_CONFIG_PATH", "./data/config.json");
}

/**
 * The auth token this install uses, generated and persisted first when there is none yet — exactly
 * what the server does on boot, so running this before the first start is fine. Backs
 * `wing-mcp-server --print-token`, the sanctioned way to see the token: the startup banner never
 * prints it (see SecurityConfigSchema.quietToken).
 */
export async function readAuthToken(): Promise<string> {
  const configStore = new ConfigStore({ filePath: configPathFromEnv() });
  await configStore.load();
  return resolveAuthToken(configStore);
}

export async function bootstrap(): Promise<McpRuntime> {
  const configStore = new ConfigStore({ filePath: configPathFromEnv() });
  await configStore.load();

  const transports = resolveTransportConfig(configStore);
  assertAtLeastOneTransport(transports);

  const eventBus = new EventBus();

  const plugins: McpPlugin[] = [new WingPlugin(configStore.scoped("wing"), eventBus)];
  // One instance for both transports: `server.tools` must mean the same thing over stdio as over
  // HTTP, and a live change from the dashboard must reach a stdio session too.
  const toolVisibility = new ToolVisibilityController(plugins, configStore);

  // Resolved unconditionally, even for a stdio-only run: `--stdio --no-http` is normally pointed at
  // an install whose config.json already exists (so nothing is written here), and on a fresh
  // install it means the *next* plain `wing-mcp-server` gets a stable token instead of a surprise
  // one. Making first-boot persistence depend on which flags happened to be present on the first
  // boot would be one more rule in a doc table (configuration.md) that already catches everyone.
  const authToken = await resolveAuthToken(configStore);
  const port = getEnvInt("PORT", 8787);
  const publicUrl = await resolvePublicUrl(configStore, port);

  // Empty means "work it out from the module path" (../../web/dist), which is right for both a
  // repo checkout and an installed npm package. It only needs setting when the dashboard bundle
  // lives somewhere else — a container that mounts it, or a packaging layout that splits the two.
  const dashboardDist = getEnvString("MCP_DASHBOARD_DIST", "");

  // Only when HTTP is being served: with it off there is no reason to build a PasskeyService or an
  // OAuth integration (with its own sweep interval) for a web server that never starts.
  const gateway = transports.http
    ? new McpGatewayServer(plugins, {
        port,
        authToken,
        configStore,
        eventBus,
        publicUrl,
        dashboardDistPath: dashboardDist || undefined,
        security: resolveSecurityConfig(configStore),
        // McpRuntime owns the plugins and the process's signal handlers so they can be shared with
        // the stdio endpoint; this gateway only ever manages the HTTP transport itself.
        managePlugins: false,
        manageSignals: false,
        toolVisibility,
      })
    : undefined;

  const runtime = new McpRuntime({ plugins, transports, gateway, toolVisibility });
  await runtime.start();
  return runtime;
}

/**
 * Boots the runtime and blocks until it stops. Shared by the two ways the server gets started:
 * `node dist/index.js` (the container's CMD) and the `wing-mcp-server` CLI (cli.ts).
 */
export async function runServer(): Promise<void> {
  // Without these, one unhandled rejection anywhere in the process (a plugin, a route handler, a
  // timer callback) takes the entire gateway down — including the OSC control connection that has
  // nothing to do with the failure. Log and keep running instead.
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (server continuing):", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection (server continuing):", reason);
  });

  let runtime: McpRuntime;
  try {
    runtime = await bootstrap();
  } catch (err) {
    if (err instanceof NoTransportEnabledError) {
      console.error("wing-mcp-server: " + err.message);
      process.exit(2);
    }
    throw err;
  }
  await runtime.waitUntilStop();
}

if (import.meta.url === "file://" + process.argv[1]) {
  await runServer();
}
