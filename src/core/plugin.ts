import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import type { PluginToolCatalogue } from "./tool-catalogue.js";

export interface PluginHealth {
  status: "HEALTHY" | "DEGRADED" | "ERROR";
  detail?: Record<string, unknown>;
  errorMessage?: string;
}

export interface McpPlugin {
  readonly id: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getHealth(): Promise<PluginHealth>;
  registerTools(server: McpServer): void;
  /**
   * Guidance returned to the client in `initialize`, telling a model how this plugin's tools are
   * meant to be used before it has called any of them. Optional, and composed with the other
   * plugins' by the gateway — the gateway itself knows nothing about any particular console.
   */
  getInstructions?(): string;
  getConfigSchema(): object;
  getConfig(): unknown;
  setConfig(config: unknown): Promise<void>;
  registerHttpRoutes?(router: Router): void;
  /**
   * Static description of this plugin's tool surface, for the dashboard's tool-visibility page
   * and for `GET /api/tools`. Must not touch a device or a live connection — it describes what
   * the code registers, not the state of any console — so the gateway can build it once at boot
   * and reuse it for every session. A plugin that omits this still gets per-tool toggling; its
   * tools are reported under the synthetic "other" group with no named profiles.
   */
  getToolCatalogue?(): Promise<PluginToolCatalogue>;
}
