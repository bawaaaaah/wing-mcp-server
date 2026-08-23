import { resolveAuthToken, resolvePublicUrl } from "./core/auth.js";
import { ConfigStore } from "./core/config-store.js";
import { getEnvInt, getEnvString } from "./core/env.js";
import { EventBus } from "./core/event-bus.js";
import { McpGatewayServer } from "./core/mcp-gateway-server.js";
import type { McpPlugin } from "./core/plugin.js";
import { WingPlugin } from "./plugins/wing/wing-plugin.js";

export async function bootstrap(): Promise<McpGatewayServer> {
  const configStore = new ConfigStore({ filePath: getEnvString("MCP_CONFIG_PATH", "./data/config.json") });
  await configStore.load();

  const eventBus = new EventBus();

  const plugins: McpPlugin[] = [new WingPlugin(configStore.scoped("wing"), eventBus)];

  const authToken = await resolveAuthToken(configStore);
  const port = getEnvInt("PORT", 8787);
  const publicUrl = await resolvePublicUrl(configStore, port);

  const server = new McpGatewayServer(plugins, {
    port,
    authToken,
    configStore,
    eventBus,
    publicUrl,
  });

  await server.init();
  return server;
}

if (import.meta.url === "file://" + process.argv[1]) {
  // Without these, one unhandled rejection anywhere in the process (a plugin, a route handler, a
  // timer callback) takes the entire gateway down — including the OSC control connection that has
  // nothing to do with the failure. Log and keep running instead.
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (server continuing):", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection (server continuing):", reason);
  });

  const server = await bootstrap();
  await server.waitUntilStop();
}
