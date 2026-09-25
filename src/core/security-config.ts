import { z } from "zod";
import type { ConfigStore } from "./config-store.js";
import { getEnvBool, getEnvInt } from "./env.js";

/**
 * Opt-in hardening for a server that is reachable from somewhere other than the machine it runs
 * on. Every field is optional and every one of them is inert when absent: with no `security` block
 * at all the server behaves exactly as it did before this existed. That is deliberate — a
 * misconfigured origin allowlist locks the operator out of their own console, so none of this is
 * imposed on a LAN install that never asked for it.
 *
 * The exceptions, which are not configurable, are the ones that cannot lock anyone out: frame
 * protection (see mcp-gateway-server.ts) and the 0600 mode on the config file (config-store.ts).
 */
export const SecurityConfigSchema = z.object({
  /**
   * Origins allowed to reach /mcp. Enables the SDK transport's DNS-rebinding protection, which is
   * off by default and which the MCP spec asks local HTTP servers to turn on. Absent or empty
   * means no Origin check at all.
   */
  allowedOrigins: z.array(z.string().min(1)).optional(),
  /** Host header values allowed to reach /mcp. Same switch as above. */
  allowedHosts: z.array(z.string().min(1)).optional(),
  /**
   * Interface to listen on. Absent means every interface, which is what a container needs — under
   * Docker, binding 127.0.0.1 inside the container makes the server unreachable from the host and
   * breaks the published-port setup entirely. Set it to 127.0.0.1 for an npm install that is
   * fronted by a reverse proxy on the same machine.
   */
  bindHost: z.string().min(1).optional(),
  /**
   * Fixed-window limit per client IP on the authentication-bearing routes. Absent means no limit,
   * which on a publicly reachable server leaves the bearer token open to unlimited online guessing
   * — harmless against the 192-bit generated default, much less so against a hand-picked one.
   */
  rateLimit: z
    .object({
      windowMs: z.number().int().min(1000).default(60_000),
      max: z.number().int().min(1).default(60),
    })
    .optional(),
  /**
   * Express's `trust proxy` setting. Required whenever the server sits behind a reverse proxy or
   * tunnel *and* `rateLimit` is set: without it `req.ip` is the proxy's address for every client,
   * so all of them share one bucket and a single attacker exhausting it locks out everybody —
   * turning the limiter into the denial of service it was meant to prevent.
   *
   * Takes the number of proxy hops to trust (1 for a single nginx/Caddy/tunnel in front), or true
   * to trust the whole X-Forwarded-For chain. Prefer the number: `true` lets any client forge its
   * own apparent address and sidestep the limit entirely.
   */
  trustProxy: z.union([z.number().int().min(1), z.boolean()]).optional(),
  /**
   * Whether the startup banner leaves the auth token out. Absent means true: the banner never
   * prints the master token unless this is explicitly `false`. Under Docker a printed token sits in
   * `docker logs` for the life of the container, under systemd in the journal, and under a desktop
   * client's stdio launch in that client's MCP log files — none of which are the place for the one
   * secret that drives the console. `wing-mcp-server --print-token` shows it on demand instead.
   */
  quietToken: z.boolean().optional(),
});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function fromEnv(): SecurityConfig | undefined {
  const allowedOrigins = splitList(process.env.MCP_ALLOWED_ORIGINS);
  const allowedHosts = splitList(process.env.MCP_ALLOWED_HOSTS);
  const bindHost = process.env.MCP_BIND_HOST?.trim() || undefined;
  const trustProxyRaw = process.env.MCP_TRUST_PROXY?.trim();
  const trustProxy =
    trustProxyRaw === undefined || trustProxyRaw === ""
      ? undefined
      : /^\d+$/.test(trustProxyRaw)
        ? Number.parseInt(trustProxyRaw, 10)
        : getEnvBool("MCP_TRUST_PROXY", false);
  const quietTokenSet = process.env.MCP_QUIET_TOKEN !== undefined && process.env.MCP_QUIET_TOKEN !== "";
  const rateLimitMax = process.env.MCP_RATE_LIMIT_MAX;
  const rateLimit =
    rateLimitMax !== undefined && rateLimitMax !== ""
      ? { max: getEnvInt("MCP_RATE_LIMIT_MAX", 60), windowMs: getEnvInt("MCP_RATE_LIMIT_WINDOW_MS", 60_000) }
      : undefined;

  const config: SecurityConfig = {
    ...(allowedOrigins ? { allowedOrigins } : {}),
    ...(allowedHosts ? { allowedHosts } : {}),
    ...(bindHost ? { bindHost } : {}),
    ...(trustProxy !== undefined && trustProxy !== false ? { trustProxy } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(quietTokenSet ? { quietToken: getEnvBool("MCP_QUIET_TOKEN", true) } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Resolves the effective hardening settings: a persisted `server.security` block wins outright,
 * otherwise the environment is read.
 *
 * Note the difference from `resolveAuthToken`/`resolvePublicUrl`, which persist their environment
 * value on first use and ignore it forever after. That would be wrong here. These are properties
 * of where the server is deployed, not preferences someone picked once, so an operator editing
 * MCP_ALLOWED_ORIGINS in a compose file must see it take effect — silently ignoring a changed
 * security setting because an older value was written to disk is exactly the failure mode worth
 * avoiding. Nothing is written to the config file from here; the dashboard remains the only thing
 * that persists a block, and once it has, that block is authoritative.
 */
export function resolveSecurityConfig(configStore: ConfigStore): SecurityConfig {
  const persisted = configStore.getServerSecurity();
  if (persisted !== undefined) {
    const parsed = SecurityConfigSchema.safeParse(persisted);
    if (parsed.success) return parsed.data;
    console.error("Ignoring the persisted server.security block, which failed validation:", parsed.error.message);
  }
  return fromEnv() ?? {};
}

/** One line for the startup banner, so what is and is not switched on is never a guess. */
export function describeSecurityConfig(config: SecurityConfig): string {
  const active: string[] = [];
  if (config.allowedOrigins?.length || config.allowedHosts?.length) active.push("origin checks");
  if (config.rateLimit) active.push(`rate limit ${config.rateLimit.max}/${Math.round(config.rateLimit.windowMs / 1000)}s`);
  if (config.bindHost) active.push(`bound to ${config.bindHost}`);
  if (config.quietToken === false) active.push("token PRINTED in the banner (quietToken: false)");
  return active.length > 0 ? active.join(", ") : "none (see docs/configuration.md)";
}
