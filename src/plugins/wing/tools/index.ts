import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { registerBusMainMatrixTools } from "./bus-main-matrix.js";
import { registerChannelTools } from "./channel.js";
import { registerDcaMutegroupTools } from "./dca-mutegroup.js";
import { registerFadeTools } from "./fade.js";
import { registerGenericTools } from "./generic.js";
import { registerMeterStatsTools } from "./meter-stats.js";
import { registerNameListTools } from "./names.js";
import { registerRoutingTools } from "./routing.js";
import { registerRtaTools } from "./rta.js";
import { registerSceneTools } from "./scenes.js";

/** Registers the whole WING MCP tool surface (generic escape hatch + convenience families) on `server`. */
export function registerWingTools(server: McpServer, ctx: WingPluginContext): void {
  registerGenericTools(server, ctx);
  registerChannelTools(server, ctx);
  registerBusMainMatrixTools(server, ctx);
  registerDcaMutegroupTools(server, ctx);
  registerRoutingTools(server, ctx);
  registerSceneTools(server, ctx);
  registerNameListTools(server, ctx);
  registerFadeTools(server, ctx);
  registerRtaTools(server, ctx);
  registerMeterStatsTools(server, ctx);
}
