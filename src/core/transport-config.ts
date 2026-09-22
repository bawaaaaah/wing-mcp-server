import { z } from "zod";
import type { ConfigStore } from "./config-store.js";

/**
 * Which transports this process serves MCP over.
 *
 * Both are plain booleans rather than `{ enabled: boolean }` blocks. `server.security` nests
 * because `rateLimit` carries two related numbers; neither transport here has a second field to
 * gain — HTTP's port and interface already live in `PORT` and `server.security.bindHost`, and stdio
 * has nothing to configure at all. If one ever does,
 * `z.union([z.boolean(), z.object({ enabled: z.boolean() })])` widens this without invalidating a
 * file written today.
 */
export const TransportConfigSchema = z.object({
  http: z.boolean().optional(),
  stdio: z.boolean().optional(),
});

export type TransportConfig = z.infer<typeof TransportConfigSchema>;

export interface ResolvedTransports {
  readonly http: boolean;
  readonly stdio: boolean;
}

/**
 * Both transports off, which would leave the process holding an OSC connection and answering
 * nothing. Carries its own type so the entry points can print the message and exit 2 (the
 * convention in cli.ts's `fail()`) instead of dumping a stack trace at the operator.
 */
export class NoTransportEnabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTransportEnabledError";
  }
}

/**
 * Deliberately not `getEnvBool`: that helper returns its default both for an unset variable and
 * for an unparseable one, so it cannot distinguish "absent" (defer to the config file) from
 * "explicitly false" — and `MCP_STDIO_ENABLED=maybe` would silently enable stdio. Here an unusable
 * value is reported and then ignored, rather than guessed at.
 */
function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  console.error("Ignoring " + name + "=" + raw + ": expected one of 1/true/yes/0/false/no.");
  return undefined;
}

function persistedTransports(configStore: ConfigStore): TransportConfig | undefined {
  const persisted = configStore.getServerTransports();
  if (persisted === undefined) return undefined;
  const parsed = TransportConfigSchema.safeParse(persisted);
  if (parsed.success) return parsed.data;
  console.error("Ignoring the persisted server.transports block, which failed validation:", parsed.error.message);
  return undefined;
}

/**
 * Resolves which transports to serve: the environment (which is where cli.ts's `--stdio` and
 * `--no-http` land) wins, then a persisted `server.transports` block, then the defaults — HTTP on,
 * stdio off, i.e. exactly what this server did before stdio existed.
 *
 * Two deliberate differences from `resolveSecurityConfig`, both the opposite of what it does:
 *
 * - **The environment wins, not the file.** Which transports an invocation serves is a property of
 *   that invocation, not of the deployment: `wing-mcp-server --stdio --no-http` is being launched
 *   by a client right now, and a line in a config file must not override what the command line
 *   just asked for. The hardening block is the other way round because the dashboard writes it and
 *   a stale origin allowlist must not be silently ignored.
 * - **Resolved key by key, not block by block.** A persisted `{ "stdio": true }` must not also
 *   decide HTTP, or `--no-http` alongside it would be dropped without a word.
 *
 * Nothing is written from here, and nothing else writes `server.transports` either — see
 * ConfigStore.getServerTransports() for why there is no setter.
 */
export function resolveTransportConfig(configStore: ConfigStore): ResolvedTransports {
  const http = envFlag("MCP_HTTP_ENABLED");
  const stdio = envFlag("MCP_STDIO_ENABLED");
  const persisted = persistedTransports(configStore);
  return {
    http: http ?? persisted?.http ?? true,
    stdio: stdio ?? persisted?.stdio ?? false,
  };
}

/** One line for the startup banner, so which transports are live is never a guess. */
export function describeTransportConfig(transports: ResolvedTransports): string {
  const active: string[] = [];
  if (transports.http) active.push("HTTP (/mcp)");
  if (transports.stdio) active.push("stdio");
  return active.length > 0 ? active.join(" + ") : "none";
}

export function assertAtLeastOneTransport(transports: ResolvedTransports): void {
  if (transports.http || transports.stdio) return;
  throw new NoTransportEnabledError(
    "every MCP transport is disabled, so this server would answer nothing. Drop --no-http (or set " +
      "MCP_HTTP_ENABLED=1) to serve the dashboard and /mcp, or add --stdio (MCP_STDIO_ENABLED=1) " +
      "to serve MCP over stdin/stdout.",
  );
}
