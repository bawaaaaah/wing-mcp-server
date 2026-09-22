import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";

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
}
