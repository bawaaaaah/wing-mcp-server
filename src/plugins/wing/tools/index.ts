import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { registerAutoCompressTools } from "./auto-compress.js";
import { registerAutoGainTools } from "./autogain.js";
import { registerAutoGateTools } from "./auto-gate.js";
import { registerBusMainMatrixTools } from "./bus-main-matrix.js";
import { registerChannelTools } from "./channel.js";
import { registerDcaMutegroupTools } from "./dca-mutegroup.js";
import { registerDynamicsStatusTools } from "./dynamics-status.js";
import { registerFadeTools } from "./fade.js";
import { registerGenericTools } from "./generic.js";
import { registerGroupTools } from "./groups.js";
import { registerMeterStatsTools } from "./meter-stats.js";
import { registerNameListTools } from "./names.js";
import { registerPresetTools } from "./presets.js";
import { registerRoutingTools } from "./routing.js";
import { registerRtaTools } from "./rta.js";
import { registerSceneTools } from "./scenes.js";

/** Registers the whole WING MCP tool surface (generic escape hatch + convenience families) on `server`. */
export function registerWingTools(server: McpServer, ctx: WingPluginContext): void {
  registerGenericTools(server, ctx);
  registerChannelTools(server, ctx);
  registerBusMainMatrixTools(server, ctx);
  registerDcaMutegroupTools(server, ctx);
  registerGroupTools(server, ctx);
  registerRoutingTools(server, ctx);
  registerSceneTools(server, ctx);
  registerNameListTools(server, ctx);
  registerPresetTools(server, ctx);
  registerFadeTools(server, ctx);
  registerRtaTools(server, ctx);
  registerMeterStatsTools(server, ctx);
  registerAutoGainTools(server, ctx);
  registerDynamicsStatusTools(server, ctx);
  registerAutoCompressTools(server, ctx);
  registerAutoGateTools(server, ctx);
}
