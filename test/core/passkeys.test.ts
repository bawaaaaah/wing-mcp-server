import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { expect } from "chai";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import { EventBus } from "../../src/core/event-bus.js";
import { McpGatewayServer } from "../../src/core/mcp-gateway-server.js";
import { SoftAuthenticator } from "./soft-authenticator.js";

const authToken = "passkey-test-token";
const publicOrigin = "https://wing.example.com";

interface CallOpts {
  method?: string;
  token?: string;
  origin?: string;
  body?: unknown;
}

describe("Passkey authentication", () => {
  let dir: string;
  let configPath: string;
  let server: McpGatewayServer;
  let baseUrl: string;
  let localOrigin: string;

  async function startServer(): Promise<McpGatewayServer> {
    const configStore = new ConfigStore({ filePath: configPath });
    await configStore.load();
    const instance = new McpGatewayServer([], {
      port: 0,
      authToken,
      configStore,
      eventBus: new EventBus(),
      publicUrl: new URL(publicOrigin),
    });
    await instance.init();
    return instance;
  }

  function call(url: string, opts: CallOpts = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = "Bearer " + opts.token;
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(url.startsWith("http") ? url : baseUrl + url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
  }

  async function register(authenticator: SoftAuthenticator, origin = localOrigin, name = "Test passkey"): Promise<Response> {
    const optionsRes = await call("/api/auth/passkeys/register/options", { method: "POST", token: authToken, origin });
    expect(optionsRes.status).to.equal(200);
    const options = (await optionsRes.json()) as PublicKeyCredentialCreationOptionsJSON;
    return call("/api/auth/passkeys/register/verify", {
      token: authToken,
      origin,
      body: { name, response: authenticator.create(options, origin) },
    });
  }

  async function loginOptions(origin = localOrigin): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const res = await call("/api/auth/passkeys/login/options", { method: "POST", origin });
    expect(res.status).to.equal(200);
    return (await res.json()) as PublicKeyCredentialRequestOptionsJSON;
  }

  async function login(authenticator: SoftAuthenticator, origin = localOrigin): Promise<string> {
    const options = await loginOptions(origin);
    const res = await call("/api/auth/passkeys/login/verify", {
      origin,
      body: { response: authenticator.get(options, origin) },
    });
    expect(res.status).to.equal(200);
    const { token } = (await res.json()) as { token: string };
    return token;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-passkey-test-"));
    configPath = path.join(dir, "config.json");
    server = await startServer();
    baseUrl = "http://127.0.0.1:" + (server.port as number);
    localOrigin = "http://localhost:" + (server.port as number);
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports passkeys unavailable, and refuses login options, until one is registered", async () => {
    const status = await call("/api/auth/passkeys/status");
    expect(await status.json()).to.deep.equal({ available: false });
    expect(await (await call("/oauth/approve?request_id=nope")).text()).to.not.include("passkey-button");

    const options = await call("/api/auth/passkeys/login/options", { method: "POST", origin: localOrigin });
    expect(options.status).to.equal(400);
  });

  it("requires being signed in to register or list passkeys", async () => {
    expect((await call("/api/auth/passkeys/register/options", { method: "POST", origin: localOrigin })).status).to.equal(401);
    expect((await call("/api/auth/passkeys", { origin: localOrigin })).status).to.equal(401);
  });

  it("registers a passkey, then signs in with it to a session accepted by the dashboard API but not by /mcp", async () => {
    const authenticator = new SoftAuthenticator();
    const registerRes = await register(authenticator);
    expect(registerRes.status).to.equal(201);
    expect(await registerRes.json()).to.include({ id: authenticator.id, name: "Test passkey", rpId: "localhost" });

    const status = await call("/api/auth/passkeys/status");
    expect(await status.json()).to.deep.equal({ available: true });

    const sessionToken = await login(authenticator);
    expect(sessionToken).to.not.equal(authToken);

    expect((await call("/api/auth/verify", { token: sessionToken })).status).to.equal(200);
    expect((await call("/api/plugins", { token: sessionToken })).status).to.equal(200);
    expect((await call("/mcp", { token: sessionToken })).status).to.equal(401);

    const serverTokenRes = await call("/api/auth/server-token", { token: sessionToken });
    expect(await serverTokenRes.json()).to.deep.equal({ token: authToken });

    const listRes = await call("/api/auth/passkeys", { token: sessionToken, origin: localOrigin });
    const list = (await listRes.json()) as { passkeys: Array<{ id: string; lastUsedAt?: string }> };
    expect(list.passkeys).to.have.length(1);
    expect(list.passkeys[0].lastUsedAt).to.be.a("string");
  });

  it("works on the configured public HTTPS origin, and refuses origins it doesn't recognize (e.g. a LAN IP)", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await register(authenticator, publicOrigin)).status).to.equal(201);
    expect(await login(authenticator, publicOrigin)).to.be.a("string");

    const lanRes = await call("/api/auth/passkeys/register/options", {
      method: "POST",
      token: authToken,
      origin: "http://192.168.1.10:8787",
    });
    expect(lanRes.status).to.equal(400);
    const plainHttpPublicRes = await call("/api/auth/passkeys/login/options", {
      method: "POST",
      origin: "http://wing.example.com",
    });
    expect(plainHttpPublicRes.status).to.equal(400);
  });

  it("refuses to replay an assertion (challenges are single-use)", async () => {
    const authenticator = new SoftAuthenticator();
    await register(authenticator);
    const options = await loginOptions();
    const response = authenticator.get(options, localOrigin);

    expect((await call("/api/auth/passkeys/login/verify", { origin: localOrigin, body: { response } })).status).to.equal(200);
    expect((await call("/api/auth/passkeys/login/verify", { origin: localOrigin, body: { response } })).status).to.equal(400);
  });

  it("refuses an assertion signed for another origin, an unregistered passkey, or one without user verification", async () => {
    const authenticator = new SoftAuthenticator();
    await register(authenticator);

    const phished = authenticator.get(await loginOptions(), "https://evil.example.com");
    expect((await call("/api/auth/passkeys/login/verify", { origin: localOrigin, body: { response: phished } })).status).to.equal(400);

    const strangerRes = await call("/api/auth/passkeys/login/verify", {
      origin: localOrigin,
      body: { response: new SoftAuthenticator().get(await loginOptions(), localOrigin) },
    });
    expect(strangerRes.status).to.equal(400);

    const noUv = new SoftAuthenticator({ userVerified: false });
    expect((await register(noUv)).status).to.equal(400);
  });

  it("won't accept a registration challenge as a login challenge", async () => {
    const authenticator = new SoftAuthenticator();
    await register(authenticator);
    const registrationOptionsRes = await call("/api/auth/passkeys/register/options", {
      method: "POST",
      token: authToken,
      origin: localOrigin,
    });
    const registrationOptions = (await registrationOptionsRes.json()) as PublicKeyCredentialCreationOptionsJSON;
    const response = authenticator.get({ challenge: registrationOptions.challenge, rpId: "localhost" }, localOrigin);
    expect((await call("/api/auth/passkeys/login/verify", { origin: localOrigin, body: { response } })).status).to.equal(400);
  });

  it("revokes the session on logout, and every session of a passkey when that passkey is deleted", async () => {
    const authenticator = new SoftAuthenticator();
    await register(authenticator);

    const loggedOut = await login(authenticator);
    expect((await call("/api/auth/logout", { method: "POST", token: loggedOut })).status).to.equal(204);
    expect((await call("/api/auth/verify", { token: loggedOut })).status).to.equal(401);

    const first = await login(authenticator);
    const second = await login(authenticator);
    const deleteRes = await call("/api/auth/passkeys/" + encodeURIComponent(authenticator.id), {
      method: "DELETE",
      token: authToken,
    });
    expect(deleteRes.status).to.equal(204);
    expect((await call("/api/auth/verify", { token: first })).status).to.equal(401);
    expect((await call("/api/auth/verify", { token: second })).status).to.equal(401);
    // Signing out with the static token itself revokes nothing — it must keep working.
    expect((await call("/api/auth/logout", { method: "POST", token: authToken })).status).to.equal(204);
    expect((await call("/api/auth/verify", { token: authToken })).status).to.equal(200);
  });

  it("keeps registered passkeys and open sessions across a restart, without storing session tokens in clear", async () => {
    const authenticator = new SoftAuthenticator();
    await register(authenticator);
    const sessionToken = await login(authenticator);
    expect(fs.readFileSync(configPath, "utf8")).to.not.include(sessionToken);

    await server.stop();
    server = await startServer();
    baseUrl = "http://127.0.0.1:" + (server.port as number);

    expect((await call("/api/auth/verify", { token: sessionToken })).status).to.equal(200);
    // The port changed with the restart, but passkeys are bound to the hostname, not the port.
    localOrigin = "http://localhost:" + (server.port as number);
    expect(await login(authenticator)).to.be.a("string");
  });

  it("approves a pending OAuth authorization with a passkey instead of the token", async () => {
    const authenticator = new SoftAuthenticator();
    await register(authenticator);

    const registerRes = await call("/register", {
      body: { redirect_uris: ["http://127.0.0.1:9/callback"], token_endpoint_auth_method: "none" },
    });
    const client = (await registerRes.json()) as { client_id: string };
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const authorizeUrl = new URL(baseUrl + "/authorize");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:9/callback");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", crypto.createHash("sha256").update(codeVerifier).digest("base64url"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "abc");
    const authorizeRes = await call(authorizeUrl.href);
    const approvePageUrl = new URL(authorizeRes.headers.get("location") as string, baseUrl);
    const requestId = approvePageUrl.searchParams.get("request_id") as string;

    const page = await (await call(approvePageUrl.href)).text();
    expect(page).to.include('id="passkey-button"');

    const rejected = await call("/oauth/approve/passkey", {
      origin: localOrigin,
      body: { request_id: requestId, response: new SoftAuthenticator().get(await loginOptions(), localOrigin) },
    });
    expect(rejected.status).to.equal(401);

    const approveRes = await call("/oauth/approve/passkey", {
      origin: localOrigin,
      body: { request_id: requestId, response: authenticator.get(await loginOptions(), localOrigin) },
    });
    expect(approveRes.status).to.equal(200);
    const redirectTo = new URL(((await approveRes.json()) as { redirectTo: string }).redirectTo);
    expect(redirectTo.searchParams.get("state")).to.equal("abc");

    const tokenRes = await fetch(baseUrl + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: redirectTo.searchParams.get("code") as string,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:9/callback",
      }).toString(),
    });
    expect(tokenRes.status).to.equal(200);
    expect(((await tokenRes.json()) as { access_token: string }).access_token).to.equal(authToken);
  });
});
