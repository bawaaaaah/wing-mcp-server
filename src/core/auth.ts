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

/** Which credential authenticated a request: the master token, or a passkey web session. */
export type AuthKind = "static" | "session";

export interface AuthMiddleware {
  requireAuth(): RequestHandler;
  isAuthorized(req: Request): boolean;
  /** The credential in the Authorization header, if it is a valid one. Never consults tickets. */
  authKind(req: Request): AuthKind | undefined;
  /** Mints a short-lived, single-use ticket a caller can exchange (once), when opening a WebSocket,
   * for the same access the given credential gives. `credential` is the bearer value the minting
   * request authenticated with. */
  issueStreamTicket(credential: string): string;
  /** Spends a ticket; returns the credential that minted it, or undefined if it is unknown/expired. */
  consumeStreamTicket(ticket: string): string | undefined;
  /** The bearer value from an Authorization header, whether or not it is valid. */
  bearerOf(req: Pick<Request, "headers">): string | undefined;
  /** Whether a bearer value (static token or live passkey session) is valid right now. */
  isValidCredential(candidate: string): boolean;
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

// The browser's WebSocket cannot set custom headers, so the dashboard has no way to authenticate a
// WebSocket with the real bearer token except by putting it in the URL — which
// lands in server/proxy access logs and browser history. Instead it exchanges the real token (via a
// normal header-authenticated request) for one of these: a random, single-use, seconds-scale-lived
// ticket that's only ever good for opening one WebSocket. Swept lazily (on every issue), and there's
// nothing long-lived to leak even if a ticket does end up somewhere it shouldn't.
//
// A ticket remembers the credential that minted it. The WebSocket hub keeps it for the life of the
// connection — in this process only, it never goes back over the wire — to re-check it on every
// heartbeat (a passkey session revoked or expired closes the socket) and to authenticate the
// requests it replays through the REST routes on the client's behalf.
const STREAM_TICKET_TTL_MS = 30 * 1000;

class StreamTicketStore {
  private readonly tickets = new Map<string, { expiresAt: number; credential: string }>();

  issue(credential: string): string {
    this.sweep();
    const ticket = crypto.randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { expiresAt: Date.now() + STREAM_TICKET_TTL_MS, credential });
    return ticket;
  }

  /** Single-use: the ticket is removed whether or not it was valid. */
  consume(ticket: string): string | undefined {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return entry !== undefined && Date.now() <= entry.expiresAt ? entry.credential : undefined;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (now > entry.expiresAt) this.tickets.delete(ticket);
    }
  }
}

export interface AuthMiddlewareOptions {
  /** Extra bearer credentials accepted alongside the static token — the dashboard web sessions a
   * passkey login opens (core/passkeys.ts). Never consulted for /mcp, which only takes the static token. */
  isValidSessionToken?: (candidate: string) => boolean;
}

export function createAuthMiddleware(token: string, middlewareOpts: AuthMiddlewareOptions = {}): AuthMiddleware {
  const ticketStore = new StreamTicketStore();

  function bearerOf(req: Pick<Request, "headers">): string | undefined {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return undefined;
    return header.slice("Bearer ".length);
  }

  function credentialKind(candidate: string | undefined): AuthKind | undefined {
    if (!candidate) return undefined;
    if (tokensMatch(candidate, token)) return "static";
    if (middlewareOpts.isValidSessionToken?.(candidate)) return "session";
    return undefined;
  }

  function kindOf(req: Request): AuthKind | undefined {
    return credentialKind(bearerOf(req));
  }

  function authorized(req: Request): boolean {
    return kindOf(req) !== undefined;
  }

  return {
    isAuthorized(req: Request): boolean {
      return authorized(req);
    },
    authKind: kindOf,
    requireAuth(): RequestHandler {
      return (req: Request, _res, next: NextFunction) => {
        if (authorized(req)) {
          next();
          return;
        }
        next(new HttpError(401, "Unauthorized"));
      };
    },
    issueStreamTicket(credential: string): string {
      return ticketStore.issue(credential);
    },
    consumeStreamTicket(ticket: string): string | undefined {
      return ticketStore.consume(ticket);
    },
    bearerOf,
    isValidCredential(candidate: string): boolean {
      return credentialKind(candidate) !== undefined;
    },
  };
}
