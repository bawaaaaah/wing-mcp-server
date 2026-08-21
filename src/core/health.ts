import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, RequestHandler } from "express";
import type { AuthMiddleware } from "./auth.js";
import type { McpPlugin, PluginHealth } from "./plugin.js";

export type AggregateStatus = "HEALTHY" | "DEGRADED" | "ERROR";

const STATUS_RANK: Record<AggregateStatus, number> = {
  HEALTHY: 0,
  DEGRADED: 1,
  ERROR: 2,
};

export async function aggregateHealth(
  plugins: McpPlugin[],
): Promise<{ status: AggregateStatus; plugins: Record<string, PluginHealth> }> {
  const settled = await Promise.allSettled(plugins.map((plugin) => plugin.getHealth()));

  const pluginHealth: Record<string, PluginHealth> = {};
  let worst: AggregateStatus = "HEALTHY";

  plugins.forEach((plugin, index) => {
    const outcome = settled[index];
    const health: PluginHealth =
      outcome.status === "fulfilled" ? outcome.value : { status: "ERROR", errorMessage: String(outcome.reason) };
    pluginHealth[plugin.id] = health;
    if (STATUS_RANK[health.status] > STATUS_RANK[worst]) {
      worst = health.status;
    }
  });

  return { status: worst, plugins: pluginHealth };
}

let cachedVersion: string | undefined;

export function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch (err) {
    console.error("Failed to read package.json for version:", err);
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

// GET /health - always 200. Anonymous callers get just the aggregate status;
// callers presenting a valid bearer token additionally get per-plugin detail.
export function createHealthRoute(plugins: McpPlugin[], auth: AuthMiddleware): RequestHandler {
  return async (req: Request, res) => {
    const aggregate = await aggregateHealth(plugins);
    const body: Record<string, unknown> = {
      status: aggregate.status,
      timestamp: new Date().toISOString(),
    };
    if (auth.isAuthorized(req)) {
      body.plugins = aggregate.plugins;
    }
    res.status(200).json(body);
  };
}

// GET /api/status - always behind requireAuth().
export function createStatusRoute(plugins: McpPlugin[], startedAt: number): RequestHandler {
  const version = getPackageVersion();
  return async (_req, res) => {
    const aggregate = await aggregateHealth(plugins);
    res.status(200).json({
      server: {
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        version,
        startedAt: new Date(startedAt).toISOString(),
        nodeVersion: process.version,
      },
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        health: aggregate.plugins[plugin.id],
      })),
    });
  };
}
