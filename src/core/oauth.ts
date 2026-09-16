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
import type { ConfigStore } from "./config-store.js";
import { PasskeyError, type PasskeyService } from "./passkeys.js";

// Recomputed on every verifyAccessToken() call, so in practice this never actually elapses as long
// as the token keeps getting used — there's no real token lifecycle here, since the "access token"
// handed out by this OAuth server IS the same static server token used for direct Bearer auth.
const ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

// /register and /authorize are reachable pre-auth by OAuth-flow design, so an abandoned flow (closed
// tab, a client that re-registers instead of caching its client_id) must not grow these maps forever
// on a server meant to stay up for weeks. `pending`/`codes` represent a short in-flight OAuth step —
// standard practice is a few minutes, not indefinite — and are both lazily checked on lookup AND
// actively swept, since an abandoned entry is by definition never looked up again. `clients` has no
// natural expiry (a legitimate client may reconnect after days), so it's bounded by size instead,
// evicting the oldest registration once the cap is hit.
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const CLIENTS_STORE_MAX_SIZE = 1000;

// Persisted via `configStore` (when given) so a client that already completed dynamic registration
// (e.g. claude.ai's remote MCP connector) isn't forgotten on the next process restart — without
// this, the static auth token itself survives (see resolveAuthToken()) but the client_id claude.ai
// cached does not, so its next /authorize or /token call gets InvalidClientError and the connector
// shows as fully disconnected, forcing the user to redo the whole connect/approve flow for no reason
// other than the server having restarted.
class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly configStore?: ConfigStore) {
    if (configStore) {
      for (const [clientId, client] of Object.entries(configStore.getOAuthClients())) {
        this.clients.set(clientId, client as OAuthClientInformationFull);
      }
    }
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  // The register handler (SDK) already fills in client_id/client_id_issued_at before calling this.
  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (this.clients.size >= CLIENTS_STORE_MAX_SIZE) {
      // Map preserves insertion order — the first key is the oldest registration.
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }
    this.clients.set(client.client_id, client);
    await this.configStore?.setOAuthClients(Object.fromEntries(this.clients));
    return client;
  }
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
  createdAt: number;
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
  readonly clientsStore: InMemoryClientsStore;

  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly authToken: string,
    configStore?: ConfigStore,
  ) {
    this.clientsStore = new InMemoryClientsStore(configStore);
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Stops the background sweep — call on shutdown. */
  close(): void {
    clearInterval(this.sweepTimer);
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    }
    for (const [code, entry] of this.codes) {
      if (now - entry.createdAt > CODE_TTL_MS) this.codes.delete(code);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = crypto.randomUUID();
    this.pending.set(requestId, { client, params, createdAt: Date.now() });
    res.redirect(302, "/oauth/approve?request_id=" + encodeURIComponent(requestId));
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const issued = this.codes.get(authorizationCode);
    if (!issued || issued.clientId !== client.client_id || Date.now() - issued.createdAt > CODE_TTL_MS) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return issued.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const issued = this.codes.get(authorizationCode);
    if (!issued || issued.clientId !== client.client_id || Date.now() - issued.createdAt > CODE_TTL_MS) {
      throw new InvalidGrantError("Invalid authorization code");
    }
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
    const pending = this.pending.get(requestId);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) return undefined;
    return pending;
  }

  // Turns a pending authorization into a one-time code and returns the client's redirect_uri to send
  // the browser to, exactly like OAuthServerProvider.authorize() would have done directly had it not
  // needed an interim page to collect the token (or a passkey) first.
  approve(requestId: string): string | undefined {
    const pending = this.resolvePending(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);

    const code = crypto.randomUUID();
    this.codes.set(code, { clientId: pending.client.client_id, params: pending.params, createdAt: Date.now() });

    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
    return target.href;
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

// Inline rather than bundled: this page is served by the server itself, outside the dashboard SPA.
// It only has to turn the JSON options from /api/auth/passkeys/login/options into what
// navigator.credentials.get() takes (base64url strings -> ArrayBuffers) and back again.
const PASSKEY_APPROVAL_SCRIPT = `(() => {
  const section = document.getElementById("passkey");
  if (!section || !window.PublicKeyCredential) return;
  section.hidden = false;
  const button = document.getElementById("passkey-button");
  const errorEl = document.getElementById("passkey-error");
  const toBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
  const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const readError = async (res, fallback) => { try { return (await res.json()).error || fallback; } catch { return fallback; } };
  button.addEventListener("click", async () => {
    button.disabled = true;
    errorEl.textContent = "";
    try {
      const optionsRes = await fetch("/api/auth/passkeys/login/options", { method: "POST" });
      if (!optionsRes.ok) throw new Error(await readError(optionsRes, "Passkey indisponible."));
      const options = await optionsRes.json();
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: toBuf(options.challenge),
          rpId: options.rpId,
          timeout: options.timeout,
          userVerification: options.userVerification,
          allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
        },
      });
      const r = credential.response;
      const verifyRes = await fetch("/oauth/approve/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: section.dataset.requestId,
          response: {
            id: credential.id,
            rawId: toB64u(credential.rawId),
            type: credential.type,
            clientExtensionResults: credential.getClientExtensionResults(),
            authenticatorAttachment: credential.authenticatorAttachment || undefined,
            response: {
              clientDataJSON: toB64u(r.clientDataJSON),
              authenticatorData: toB64u(r.authenticatorData),
              signature: toB64u(r.signature),
              userHandle: r.userHandle ? toB64u(r.userHandle) : undefined,
            },
          },
        }),
      });
      if (!verifyRes.ok) throw new Error(await readError(verifyRes, "Passkey refusée."));
      window.location.href = (await verifyRes.json()).redirectTo;
    } catch (err) {
      errorEl.textContent = err && err.name === "NotAllowedError" ? "Passkey annulée ou refusée." : String((err && err.message) || err);
      button.disabled = false;
    }
  });
})();`;

function renderApprovalPage(opts: {
  requestId: string;
  clientName: string;
  error?: string;
  passkeysAvailable?: boolean;
}): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Autoriser l'accès</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 10vh auto; padding: 0 1.5rem; color: #1a1a1a; }
  input { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; margin: .5rem 0; }
  button { width: 100%; padding: .6rem; font-size: 1rem; background: #111; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .error { color: #b00020; font-size: .9rem; }
  .separator { text-align: center; color: #666; font-size: .9rem; margin: 1.25rem 0 .5rem; }
</style>
</head>
<body>
  <h2>Autoriser l'accès</h2>
  <p><strong>${escapeHtml(opts.clientName)}</strong> demande à se connecter à ce serveur Wing MCP.</p>
  ${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
  ${
    opts.passkeysAvailable
      ? `<div id="passkey" data-request-id="${escapeHtml(opts.requestId)}" hidden>
    <button type="button" id="passkey-button">Autoriser avec une passkey</button>
    <p class="error" id="passkey-error" role="alert"></p>
    <p class="separator">ou avec le token du serveur</p>
  </div>`
      : ""
  }
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
    <input type="password" name="token" placeholder="Token d'accès du serveur" autofocus required>
    <button type="submit">Autoriser</button>
  </form>
  ${opts.passkeysAvailable ? `<script>${PASSKEY_APPROVAL_SCRIPT}</script>` : ""}
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
// directly as a Bearer header. `configStore` (when given) persists dynamic client registrations so
// they survive a server restart — see InMemoryClientsStore above. `passkeys` (when given) adds a
// passkey button to the approval page, as an alternative to typing the token there.
export function createOAuthIntegration(
  authToken: string,
  publicUrl: URL,
  configStore?: ConfigStore,
  passkeys?: PasskeyService,
): OAuthIntegration {
  const provider = new WingOAuthProvider(authToken, configStore);
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

  const passkeysAvailable = (): boolean => passkeys?.hasPasskeys() ?? false;

  router.get("/oauth/approve", (req, res) => {
    const requestId = typeof req.query.request_id === "string" ? req.query.request_id : undefined;
    const pending = requestId ? provider.resolvePending(requestId) : undefined;
    if (!requestId || !pending) {
      res.status(400).send("Invalid or expired authorization request.");
      return;
    }
    res.status(200).type("html").send(
      renderApprovalPage({
        requestId,
        clientName: pending.client.client_name ?? pending.client.client_id,
        passkeysAvailable: passkeysAvailable(),
      }),
    );
  });

  // The passkey counterpart of the token form below. Answers JSON with the redirect target rather
  // than a 302, since it's called from the page's script (a fetch() would just follow the redirect).
  router.post("/oauth/approve/passkey", express.json(), async (req, res, next) => {
    const requestId = typeof req.body?.request_id === "string" ? req.body.request_id : undefined;
    if (!requestId || !provider.resolvePending(requestId)) {
      res.status(400).json({ error: "Demande d'autorisation invalide ou expirée." });
      return;
    }
    const rp = passkeys?.relyingPartyFor(req);
    if (!passkeys || !rp) {
      res.status(400).json({ error: "Les passkeys ne sont pas disponibles depuis cette adresse." });
      return;
    }
    try {
      await passkeys.authenticate(rp, req.body.response);
    } catch (err) {
      if (err instanceof PasskeyError) {
        res.status(401).json({ error: "Passkey refusée : " + err.message });
        return;
      }
      next(err);
      return;
    }
    const redirectTo = provider.approve(requestId);
    if (!redirectTo) {
      res.status(400).json({ error: "Demande d'autorisation invalide ou expirée." });
      return;
    }
    res.status(200).json({ redirectTo });
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
          passkeysAvailable: passkeysAvailable(),
        }),
      );
      return;
    }
    const redirectTo = provider.approve(requestId);
    if (!redirectTo) {
      res.status(400).send("Invalid or expired authorization request.");
      return;
    }
    res.redirect(302, redirectTo);
  });

  return { provider, router, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) };
}
