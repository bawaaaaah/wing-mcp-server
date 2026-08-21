import { resolveAuthToken } from "./core/auth.js";
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

  const server = new McpGatewayServer(plugins, {
    port: getEnvInt("PORT", 8787),
    authToken,
    configStore,
    eventBus,
  });

  await server.init();
  return server;
}

if (import.meta.url === "file://" + process.argv[1]) {
  const server = await bootstrap();
  await server.waitUntilStop();
}
