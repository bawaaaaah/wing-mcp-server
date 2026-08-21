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
  getConfigSchema(): object;
  getConfig(): unknown;
  setConfig(config: unknown): Promise<void>;
  registerHttpRoutes?(router: Router): void;
}
