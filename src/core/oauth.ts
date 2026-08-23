import crypto from "node:crypto";
import type { Response } from "express";
import express from "express";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { tokensMatch } from "./auth.js";

// Recomputed on every verifyAccessToken() call, so in practice this never actually elapses as long
// as the token keeps getting used — there's no real token lifecycle here, since the "access token"
// handed out by this OAuth server IS the same static server token used for direct Bearer auth.
const ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  // The register handler (SDK) already fills in client_id/client_id_issued_at before calling this.
  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    this.clients.set(client.client_id, client);
    return client;
  }
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
}

/**
 * A minimal OAuth 2.1 authorization server that wraps the gateway's single static auth token
 * instead of managing its own token lifecycle. Completing the OAuth dance (entering the token on
 * the approval page below) simply hands the client that same static token back as its
 * access_token, so it keeps working with the existing direct Bearer-token check unchanged — this
 * exists only to satisfy clients (most remote "web AI" MCP connectors) that require an OAuth flow
 * and refuse to let a user paste a token directly.
 */
export class WingOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();

  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();

  constructor(private readonly authToken: string) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = crypto.randomUUID();
    this.pending.set(requestId, { client, params });
    res.redirect(302, "/oauth/approve?request_id=" + encodeURIComponent(requestId));
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const issued = this.codes.get(authorizationCode);
    if (!issued || issued.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return issued.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const issued = this.codes.get(authorizationCode);
    if (!issued || issued.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    this.codes.delete(authorizationCode);
    return {
      access_token: this.authToken,
      token_type: "bearer",
      scope: (issued.params.scopes ?? []).join(" "),
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError("Refresh tokens are not issued; the access token does not expire");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!tokensMatch(token, this.authToken)) throw new InvalidTokenError("Invalid token");
    return {
      token,
      clientId: "static-token",
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  resolvePending(requestId: string): PendingAuthorization | undefined {
    return this.pending.get(requestId);
  }

  // Turns a pending authorization into a one-time code and redirects to the client's redirect_uri,
  // exactly like OAuthServerProvider.authorize() would have done directly had it not needed an
  // interim page to collect the token first.
  approve(requestId: string, res: Response): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);

    const code = crypto.randomUUID();
    this.codes.set(code, { clientId: pending.client.client_id, params: pending.params });

    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
    res.redirect(302, target.href);
    return true;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderApprovalPage(opts: { requestId: string; clientName: string; error?: string }): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Autoriser l'accès</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 10vh auto; padding: 0 1.5rem; color: #1a1a1a; }
  input { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; margin: .5rem 0; }
  button { width: 100%; padding: .6rem; font-size: 1rem; background: #111; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  .error { color: #b00020; font-size: .9rem; }
</style>
</head>
<body>
  <h2>Autoriser l'accès</h2>
  <p><strong>${escapeHtml(opts.clientName)}</strong> demande à se connecter à ce serveur Wing MCP.</p>
  ${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
    <input type="password" name="token" placeholder="Token d'accès du serveur" autofocus required>
    <button type="submit">Autoriser</button>
  </form>
</body>
</html>`;
}

export interface OAuthIntegration {
  provider: WingOAuthProvider;
  router: express.Router;
  // For the WWW-Authenticate: Bearer resource_metadata="..." header on 401s from /mcp, so
  // OAuth-only clients can discover this authorization server on their first (unauthenticated) hit.
  resourceMetadataUrl: string;
}

// Wires up a full (if minimal) OAuth 2.1 authorization server on top of the existing static auth
// token, so MCP clients that only support OAuth can connect alongside clients that use the token
// directly as a Bearer header.
export function createOAuthIntegration(authToken: string, publicUrl: URL): OAuthIntegration {
  const provider = new WingOAuthProvider(authToken);
  const resourceServerUrl = new URL("/mcp", publicUrl);

  const router = express.Router();
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(publicUrl.origin),
      resourceServerUrl,
      resourceName: "Wing MCP Server",
    }),
  );

  router.get("/oauth/approve", (req, res) => {
    const requestId = typeof req.query.request_id === "string" ? req.query.request_id : undefined;
    const pending = requestId ? provider.resolvePending(requestId) : undefined;
    if (!requestId || !pending) {
      res.status(400).send("Invalid or expired authorization request.");
      return;
    }
    res.status(200).type("html").send(
      renderApprovalPage({ requestId, clientName: pending.client.client_name ?? pending.client.client_id }),
    );
  });

  router.post("/oauth/approve", express.urlencoded({ extended: false }), (req, res) => {
    const requestId = typeof req.body.request_id === "string" ? req.body.request_id : undefined;
    const token = typeof req.body.token === "string" ? req.body.token : undefined;
    const pending = requestId ? provider.resolvePending(requestId) : undefined;
    if (!requestId || !pending) {
      res.status(400).send("Invalid or expired authorization request.");
      return;
    }
    if (!tokensMatch(token, authToken)) {
      res.status(401).type("html").send(
        renderApprovalPage({
          requestId,
          clientName: pending.client.client_name ?? pending.client.client_id,
          error: "Token invalide.",
        }),
      );
      return;
    }
    provider.approve(requestId, res);
  });

  return { provider, router, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) };
}
