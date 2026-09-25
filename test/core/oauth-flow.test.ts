import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect } from "chai";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import { EventBus } from "../../src/core/event-bus.js";
import { McpGatewayServer } from "../../src/core/mcp-gateway-server.js";

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
}

function pkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

describe("OAuth authorization flow (alongside direct Bearer-token auth)", () => {
  let dir: string;
  let server: McpGatewayServer;
  let baseUrl: string;
  const authToken = "oauth-test-token";

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-oauth-test-"));
    const configStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await configStore.load();
    const eventBus = new EventBus();

    server = new McpGatewayServer([], {
      port: 0,
      authToken,
      configStore,
      eventBus,
    });
    await server.init();
    baseUrl = "http://127.0.0.1:" + (server.port as number);
  });

  after(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("advertises OAuth discovery metadata", async () => {
    const res = await fetch(baseUrl + "/.well-known/oauth-authorization-server");
    expect(res.status).to.equal(200);
    const metadata = (await res.json()) as Record<string, string>;
    expect(metadata.authorization_endpoint).to.include("/authorize");
    expect(metadata.token_endpoint).to.include("/token");
    expect(metadata.registration_endpoint).to.include("/register");
  });

  it("returns a WWW-Authenticate resource_metadata hint on an unauthenticated /mcp request", async () => {
    const res = await fetch(baseUrl + "/mcp");
    expect(res.status).to.equal(401);
    expect(res.headers.get("www-authenticate")).to.include("resource_metadata=");
  });

  it("completes dynamic registration, authorize+approve, and token exchange, yielding tokens of the client's own", async () => {
    const registerRes = await fetch(baseUrl + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:9/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registerRes.status).to.equal(201);
    const client = (await registerRes.json()) as RegisteredClient;
    expect(client.client_id).to.be.a("string");

    const { codeVerifier, codeChallenge } = pkcePair();
    const authorizeUrl = new URL(baseUrl + "/authorize");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", client.redirect_uris[0]);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "xyz");

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorizeRes.status).to.equal(302);
    const approveLocation = authorizeRes.headers.get("location") as string;
    expect(approveLocation).to.include("/oauth/approve?request_id=");

    const approvePageUrl = new URL(approveLocation, baseUrl);
    const approveGetRes = await fetch(approvePageUrl);
    expect(approveGetRes.status).to.equal(200);
    expect(await approveGetRes.text()).to.include('name="request_id"');

    const requestId = approvePageUrl.searchParams.get("request_id") as string;

    const wrongTokenRes = await fetch(new URL("/oauth/approve", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, token: "not-the-token" }).toString(),
    });
    expect(wrongTokenRes.status).to.equal(401);

    const approvePostRes = await fetch(new URL("/oauth/approve", baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, token: authToken }).toString(),
    });
    expect(approvePostRes.status).to.equal(302);
    const callbackLocation = new URL(approvePostRes.headers.get("location") as string);
    expect(callbackLocation.origin + callbackLocation.pathname).to.equal(client.redirect_uris[0]);
    expect(callbackLocation.searchParams.get("state")).to.equal("xyz");
    const code = callbackLocation.searchParams.get("code") as string;
    expect(code).to.be.a("string");

    const tokenRes = await fetch(baseUrl + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
      }).toString(),
    });
    expect(tokenRes.status).to.equal(200);
    const tokens = (await tokenRes.json()) as { access_token: string; token_type: string; refresh_token: string; expires_in: number };
    // Never the master token: a client that completed the flow once must not hold the secret the
    // dashboard and every other client share.
    expect(tokens.access_token).to.not.equal(authToken);
    expect(tokens.access_token).to.match(/^wmcp_at_/);
    expect(tokens.refresh_token).to.match(/^wmcp_rt_/);
    expect(tokens.expires_in).to.be.greaterThan(0);

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + tokens.access_token } },
    });
    const client_ = new Client({ name: "oauth-test-client", version: "1.0.0" });
    await client_.connect(transport);
    await client_.close();
  });

  it("refuses to be framed, and names the redirect target the authorization would be sent to", async () => {
    // The approval page grants a client the master auth token on one click (or one passkey touch),
    // and identifies the client only by the name it chose for itself at registration. Framed and
    // overlaid on a bait page, that is a one-click takeover; and even unframed, a user had no way
    // to see where the grant was actually going.
    const redirectUri = "http://127.0.0.1:9/somewhere-else";
    const registerRes = await fetch(baseUrl + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Totally Legitimate Client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await registerRes.json()) as RegisteredClient;

    const { codeChallenge } = pkcePair();
    const authorizeUrl = new URL(baseUrl + "/authorize");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const approvePageUrl = new URL(authorizeRes.headers.get("location") as string, baseUrl);
    const approveGetRes = await fetch(approvePageUrl);
    const html = await approveGetRes.text();

    expect(approveGetRes.headers.get("x-frame-options")).to.equal("DENY");
    expect(approveGetRes.headers.get("content-security-policy")).to.include("frame-ancestors 'none'");
    expect(html, "the approval page must show where the grant is going").to.include(redirectUri);
  });

  it("sets the frame-protection headers on every response, not just the approval page", async () => {
    const res = await fetch(baseUrl + "/.well-known/oauth-authorization-server");
    expect(res.headers.get("x-frame-options")).to.equal("DENY");
    expect(res.headers.get("content-security-policy")).to.include("frame-ancestors 'none'");
  });

  it("still recognizes a client registered before a restart, via a fresh server instance backed by the same config file", async () => {
    const registerRes = await fetch(baseUrl + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:9/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await registerRes.json()) as RegisteredClient;

    // Simulate a process restart: a brand-new ConfigStore/McpGatewayServer reading the same
    // config.json on disk, rather than reusing the outer describe's in-memory instances. Without
    // persisting registered clients (see InMemoryClientsStore in core/oauth.ts), this fresh
    // provider's client registry would be empty and /authorize below would 400 with an unknown
    // client_id — exactly the symptom that forces a user to redo the whole connect/approve dance
    // for no reason other than the server having restarted.
    const restartedConfigStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await restartedConfigStore.load();
    const restartedServer = new McpGatewayServer([], {
      port: 0,
      authToken,
      configStore: restartedConfigStore,
      eventBus: new EventBus(),
    });
    await restartedServer.init();
    try {
      const restartedBaseUrl = "http://127.0.0.1:" + (restartedServer.port as number);
      const { codeChallenge } = pkcePair();
      const authorizeUrl = new URL(restartedBaseUrl + "/authorize");
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", client.redirect_uris[0]);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
      expect(authorizeRes.status).to.equal(302);
      expect(authorizeRes.headers.get("location")).to.include("/oauth/approve?request_id=");
    } finally {
      await restartedServer.stop();
    }
  });

  it("does not consume the pending authorization on a wrong-token attempt, so a later correct submission still succeeds", async () => {
    const registerRes = await fetch(baseUrl + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:9/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await registerRes.json()) as RegisteredClient;
    const { codeChallenge } = pkcePair();

    const authorizeUrl = new URL(baseUrl + "/authorize");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", client.redirect_uris[0]);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const approvePageUrl = new URL(authorizeRes.headers.get("location") as string, baseUrl);
    const requestId = approvePageUrl.searchParams.get("request_id") as string;

    await fetch(new URL("/oauth/approve", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, token: "still-wrong" }).toString(),
    });

    const approvePostRes = await fetch(new URL("/oauth/approve", baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, token: authToken }).toString(),
    });
    expect(approvePostRes.status).to.equal(302);
  });

  /** Registers a client and runs the whole flow to a token response, approving with the master token. */
  async function obtainTokens(redirectUri = "http://127.0.0.1:9/callback"): Promise<{
    clientId: string;
    tokens: { access_token: string; refresh_token: string };
  }> {
    const registerRes = await fetch(baseUrl + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Helper Client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    });
    const client = (await registerRes.json()) as RegisteredClient;
    const { codeVerifier, codeChallenge } = pkcePair();
    const authorizeUrl = new URL(baseUrl + "/authorize");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const requestId = new URL(authorizeRes.headers.get("location") as string, baseUrl).searchParams.get("request_id") as string;
    const approveRes = await fetch(new URL("/oauth/approve", baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, token: authToken }).toString(),
    });
    const code = new URL(approveRes.headers.get("location") as string).searchParams.get("code") as string;
    const tokenRes = await fetch(baseUrl + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: redirectUri,
      }).toString(),
    });
    expect(tokenRes.status).to.equal(200);
    return { clientId: client.client_id, tokens: (await tokenRes.json()) as { access_token: string; refresh_token: string } };
  }

  async function mcpStatus(bearer: string): Promise<number> {
    const res = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
      }),
    });
    await res.body?.cancel();
    return res.status;
  }

  async function refresh(clientId: string, refreshToken: string): Promise<Response> {
    return fetch(baseUrl + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString(),
    });
  }

  it("tells the dashboard it holds the master token when it signed in with it", async () => {
    const res = await fetch(baseUrl + "/api/auth/verify", { headers: { Authorization: "Bearer " + authToken } });
    expect(await res.json()).to.deep.equal({ ok: true, kind: "static" });
  });

  it("keeps an OAuth access token to /mcp: it does not open the dashboard or its REST API", async () => {
    const { tokens } = await obtainTokens();
    expect(await mcpStatus(tokens.access_token)).to.equal(200);
    const statusRes = await fetch(baseUrl + "/api/status", { headers: { Authorization: "Bearer " + tokens.access_token } });
    expect(statusRes.status).to.equal(401);
  });

  it("rotates refresh tokens: a refresh issues a new pair and spends the old refresh and access tokens", async () => {
    const { clientId, tokens } = await obtainTokens();
    const refreshed = await refresh(clientId, tokens.refresh_token);
    expect(refreshed.status).to.equal(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.access_token).to.not.equal(tokens.access_token);
    expect(await mcpStatus(next.access_token)).to.equal(200);
    expect(await mcpStatus(tokens.access_token)).to.equal(401);
    expect((await refresh(clientId, tokens.refresh_token)).status).to.equal(400);
  });

  it("revokes one client from the dashboard API without touching another, or the master token", async () => {
    const first = await obtainTokens();
    const second = await obtainTokens();
    const list = await fetch(baseUrl + "/api/auth/oauth-clients", { headers: { Authorization: "Bearer " + authToken } });
    const { clients } = (await list.json()) as { clients: { clientId: string; activeGrants: number }[] };
    expect(clients.find((c) => c.clientId === first.clientId)?.activeGrants).to.equal(1);
    expect(JSON.stringify(clients)).to.not.include(first.tokens.access_token);

    const del = await fetch(baseUrl + "/api/auth/oauth-clients/" + encodeURIComponent(first.clientId), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + authToken },
    });
    expect(del.status).to.equal(204);
    expect(await mcpStatus(first.tokens.access_token)).to.equal(401);
    expect((await refresh(first.clientId, first.tokens.refresh_token)).status).to.not.equal(200);
    expect(await mcpStatus(second.tokens.access_token)).to.equal(200);
    expect(await mcpStatus(authToken)).to.equal(200);
  });

  it("revokes a grant through RFC 7009 /revoke", async () => {
    const { clientId, tokens } = await obtainTokens();
    const res = await fetch(baseUrl + "/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }).toString(),
    });
    expect(res.status).to.equal(200);
    expect(await mcpStatus(tokens.access_token)).to.equal(401);
  });

  it("refuses a code exchanged with a different redirect_uri than it was issued for", async () => {
    const redirectUris = ["http://127.0.0.1:9/one", "http://127.0.0.1:9/two"];
    const registerRes = await fetch(baseUrl + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
    });
    const client = (await registerRes.json()) as RegisteredClient;
    const { codeVerifier, codeChallenge } = pkcePair();
    const authorizeUrl = new URL(baseUrl + "/authorize");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUris[0]);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const requestId = new URL(authorizeRes.headers.get("location") as string, baseUrl).searchParams.get("request_id") as string;
    const approveRes = await fetch(new URL("/oauth/approve", baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, token: authToken }).toString(),
    });
    const code = new URL(approveRes.headers.get("location") as string).searchParams.get("code") as string;
    const tokenRes = await fetch(baseUrl + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: redirectUris[1],
      }).toString(),
    });
    expect(tokenRes.status).to.equal(400);
  });

  it("stores issued tokens hashed, and keeps them valid across a restart", async () => {
    const { tokens } = await obtainTokens();
    const onDisk = fs.readFileSync(path.join(dir, "config.json"), "utf8");
    expect(onDisk).to.not.include(tokens.access_token);
    expect(onDisk).to.not.include(tokens.refresh_token);

    const restartedConfigStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await restartedConfigStore.load();
    const restarted = new McpGatewayServer([], { port: 0, authToken, configStore: restartedConfigStore, eventBus: new EventBus() });
    await restarted.init();
    try {
      const res = await fetch("http://127.0.0.1:" + (restarted.port as number) + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokens.access_token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
        }),
      });
      await res.body?.cancel();
      expect(res.status).to.equal(200);
    } finally {
      await restarted.stop();
    }
  });
});
