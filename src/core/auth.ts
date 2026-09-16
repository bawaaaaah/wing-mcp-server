import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler } from "express";
import type { ConfigStore } from "./config-store.js";
import { HttpError } from "./http-errors.js";

// Resolves the server's auth token, persisting it on first use so it survives
// restarts: an existing persisted token wins, then MCP_AUTH_TOKEN from the
// environment, then a freshly generated random token.
export async function resolveAuthToken(configStore: ConfigStore): Promise<string> {
  const existing = configStore.getServerAuthToken();
  if (existing) return existing;

  const fromEnv = process.env.MCP_AUTH_TOKEN;
  if (fromEnv) {
    await configStore.setServerAuthToken(fromEnv);
    return fromEnv;
  }

  const generated = crypto.randomBytes(24).toString("base64url");
  await configStore.setServerAuthToken(generated);
  return generated;
}

// Resolves the server's externally-reachable base URL (used as the OAuth issuer — see
// core/oauth.ts): an existing persisted URL wins, then PUBLIC_URL from the environment
// (persisted on first use so it survives restarts even if the env var is later unset), then a
// localhost fallback derived from the listen port. That fallback is intentionally never
// persisted — it must keep tracking `port` if that changes, unlike a real public URL or a
// generated auth token, which need to stay stable.
export async function resolvePublicUrl(configStore: ConfigStore, port: number): Promise<URL> {
  const existing = configStore.getServerPublicUrl();
  if (existing) return new URL(existing);

  const fromEnv = process.env.PUBLIC_URL;
  if (fromEnv) {
    await configStore.setServerPublicUrl(fromEnv);
    return new URL(fromEnv);
  }

  return new URL("http://localhost:" + port);
}

export interface RequireAuthOptions {
  /** Accepts a `?ticket=` query param (see SseTicketStore below) in place of the Authorization
   * header — the only sanctioned way to authenticate a request that can't set custom headers
   * (EventSource). Never accepts the real long-lived token via query param/URL. */
  allowQueryTicket?: boolean;
}

export interface AuthMiddleware {
  requireAuth(opts?: RequireAuthOptions): RequestHandler;
  isAuthorized(req: Request, opts?: RequireAuthOptions): boolean;
  /** Mints a short-lived, single-use ticket a caller can exchange (once) for the same access an
   * Authorization header would give, via `?ticket=` on a route built with `allowQueryTicket`. */
  issueSseTicket(): string;
}

// Constant-time comparison against the server's auth token, shared by the direct Bearer-token
// middleware below and the OAuth provider (core/oauth.ts), which hands out this same token as its
// access_token — the two are just two different ways of presenting the same secret.
export function tokensMatch(candidate: string | undefined, token: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const tokenBuffer = Buffer.from(token, "utf8");
  if (candidateBuffer.length !== tokenBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, tokenBuffer);
}

// EventSource can't set custom headers, so the browser client has no way to authenticate an SSE
// connection with the real bearer token except by putting it in the URL — which lands in server/
// proxy access logs and browser history. Instead it exchanges the real token (via a normal header-
// authenticated request) for one of these: a random, single-use, seconds-scale-lived ticket that's
// only ever good for opening one EventSource connection. Swept both lazily (on every consume/issue)
// and there's nothing long-lived to leak even if a ticket does end up somewhere it shouldn't.
const SSE_TICKET_TTL_MS = 30 * 1000;

class SseTicketStore {
  private readonly tickets = new Map<string, number>();

  issue(): string {
    this.sweep();
    const ticket = crypto.randomBytes(24).toString("base64url");
    this.tickets.set(ticket, Date.now() + SSE_TICKET_TTL_MS);
    return ticket;
  }

  /** Single-use: the ticket is removed whether or not it was valid. */
  consume(ticket: string): boolean {
    const expiresAt = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return expiresAt !== undefined && Date.now() <= expiresAt;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ticket, expiresAt] of this.tickets) {
      if (now > expiresAt) this.tickets.delete(ticket);
    }
  }
}

export interface AuthMiddlewareOptions {
  /** Extra bearer credentials accepted alongside the static token — the dashboard web sessions a
   * passkey login opens (core/passkeys.ts). Never consulted for /mcp, which only takes the static token. */
  isValidSessionToken?: (candidate: string) => boolean;
}

export function createAuthMiddleware(token: string, middlewareOpts: AuthMiddlewareOptions = {}): AuthMiddleware {
  const ticketStore = new SseTicketStore();

  function authorized(req: Request, opts?: RequireAuthOptions): boolean {
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      const candidate = header.slice("Bearer ".length);
      if (tokensMatch(candidate, token)) return true;
      if (middlewareOpts.isValidSessionToken?.(candidate)) return true;
    }
    if (opts?.allowQueryTicket) {
      const ticket = req.query.ticket;
      if (typeof ticket === "string" && ticketStore.consume(ticket)) return true;
    }
    return false;
  }

  return {
    isAuthorized(req: Request, opts?: RequireAuthOptions): boolean {
      return authorized(req, opts);
    },
    requireAuth(opts?: RequireAuthOptions): RequestHandler {
      return (req: Request, _res, next: NextFunction) => {
        if (authorized(req, opts)) {
          next();
          return;
        }
        next(new HttpError(401, "Unauthorized"));
      };
    },
    issueSseTicket(): string {
      return ticketStore.issue();
    },
  };
}
