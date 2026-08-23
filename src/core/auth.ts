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
  allowQueryParam?: boolean;
}

export interface AuthMiddleware {
  requireAuth(opts?: RequireAuthOptions): RequestHandler;
  isAuthorized(req: Request, opts?: RequireAuthOptions): boolean;
}

function extractCandidate(req: Request, opts?: RequireAuthOptions): string | undefined {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  if (opts?.allowQueryParam) {
    const queryToken = req.query.token;
    if (typeof queryToken === "string") return queryToken;
  }
  return undefined;
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

export function createAuthMiddleware(token: string): AuthMiddleware {
  function matches(candidate: string | undefined): boolean {
    return tokensMatch(candidate, token);
  }

  return {
    isAuthorized(req: Request, opts?: RequireAuthOptions): boolean {
      return matches(extractCandidate(req, opts));
    },
    requireAuth(opts?: RequireAuthOptions): RequestHandler {
      return (req: Request, _res, next: NextFunction) => {
        if (matches(extractCandidate(req, opts))) {
          next();
          return;
        }
        next(new HttpError(401, "Unauthorized"));
      };
    },
  };
}
