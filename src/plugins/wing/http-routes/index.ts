// The dashboard's REST API for the WING plugin, mounted by the gateway under /api/plugins/wing
// (behind its bearer-token check). Each module owns one area of the console; they are registered in
// the order the routes used to appear in the single file they came from. Only routes inside one
// module overlap (a literal segment next to a parameter, e.g. /talkback/assign and
// /talkback/:source), so the order between modules does not change what matches.

import type { Router } from "express";
import type { WingPluginContext } from "../wing-plugin.js";
import { registerAutoEqRoutes } from "./auto-eq.js";
import { registerAutomationRoutes } from "./automation.js";
import { registerConsoleRoutes } from "./console.js";
import { registerIoRoutes } from "./io.js";
import { registerMediaRoutes } from "./media.js";
import { registerMixerRoutes } from "./mixer.js";
import { registerMonitoringRoutes } from "./monitoring.js";
import { registerOverviewRoutes } from "./overview.js";
import { registerParamPanelsRoutes } from "./param-panels.js";
import { registerProcessingRoutes } from "./processing.js";
import { registerScenesPresetsRoutes } from "./scenes-presets.js";
import { registerWritesRoutes } from "./writes.js";

export function registerWingHttpRoutes(router: Router, ctx: WingPluginContext): void {
  registerOverviewRoutes(router, ctx);
  registerMediaRoutes(router, ctx);
  registerMixerRoutes(router, ctx);
  registerParamPanelsRoutes(router, ctx);
  registerProcessingRoutes(router, ctx);
  registerIoRoutes(router, ctx);
  registerAutomationRoutes(router, ctx);
  registerAutoEqRoutes(router, ctx);
  registerConsoleRoutes(router, ctx);
  registerMonitoringRoutes(router, ctx);
  registerWritesRoutes(router, ctx);
  registerScenesPresetsRoutes(router, ctx);
}
