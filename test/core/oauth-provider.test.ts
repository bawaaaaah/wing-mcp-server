// WingOAuthProvider on its own, without the HTTP layer: the registration cap, refresh rotation's
// single write, the RFC 8707 resource check, and loading persisted clients.

import { InvalidTargetError, InvalidTokenError, TooManyRequestsError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { expect } from "chai";
import type { Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import { WingOAuthProvider } from "../../src/core/oauth.js";

const AUTH_TOKEN = "provider-test-master-token";
const RESOURCE = new URL("https://wing.example.com/mcp");
const REDIRECT = "http://127.0.0.1:9/callback";

function clientInfo(id: string): OAuthClientInformationFull {
  return { client_id: id, client_id_issued_at: 1, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };
}

function fakeResponse(): Response & { redirectedTo?: string } {
  const res = {
    redirectedTo: undefined as string | undefined,
    redirect(_status: number, url: string) {
      res.redirectedTo = url;
    },
  };
  return res as unknown as Response & { redirectedTo?: string };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("WingOAuthProvider", () => {
  let dir: string;
  let store: ConfigStore;
  let provider: WingOAuthProvider;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-oauth-provider-"));
    store = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await store.load();
    provider = new WingOAuthProvider(AUTH_TOKEN, store, RESOURCE);
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 1000 clients written to disk one by one would be slow and prove nothing more. */
  function useInMemoryProvider(): void {
    provider.close();
    provider = new WingOAuthProvider(AUTH_TOKEN, undefined, RESOURCE);
  }

  /** authorize → approve → code → tokens, as the HTTP flow does. */
  async function grant(client: OAuthClientInformationFull, params: Partial<AuthorizationParams> = {}) {
    const res = fakeResponse();
    await provider.authorize(client, { codeChallenge: "c", redirectUri: REDIRECT, ...params }, res);
    const requestId = new URL(res.redirectedTo as string, "http://x").searchParams.get("request_id") as string;
    const code = new URL(provider.approve(requestId) as string).searchParams.get("code") as string;
    return provider.exchangeAuthorizationCode(client, code);
  }

  it("at the client cap, evicts the least recently used client without a live grant — never one that has one", async () => {
    useInMemoryProvider();
    const approved = await provider.clientsStore.registerClient(clientInfo("approved"));
    const tokens = await grant(approved);
    for (let i = 1; i < 1000; i++) await provider.clientsStore.registerClient(clientInfo("idle-" + i));
    // idle-1 was used recently, so idle-2 is now the least recently used idle client.
    provider.clientsStore.getClient("idle-1");

    await provider.clientsStore.registerClient(clientInfo("newcomer"));
    expect(provider.clientsStore.getClient("approved")).to.not.equal(undefined);
    expect(provider.clientsStore.getClient("idle-1")).to.not.equal(undefined);
    expect(provider.clientsStore.getClient("idle-2")).to.equal(undefined);
    expect((await provider.verifyAccessToken(tokens.access_token)).clientId).to.equal("approved");
  });

  it("refuses to register when every client at the cap holds a live grant", async () => {
    useInMemoryProvider();
    for (let i = 0; i < 1000; i++) {
      const client = await provider.clientsStore.registerClient(clientInfo("busy-" + i));
      await grant(client);
    }
    const err = await rejection(provider.clientsStore.registerClient(clientInfo("one-too-many")));
    expect(err).to.be.instanceOf(TooManyRequestsError);
    expect(provider.clientsStore.getClient("busy-0")).to.not.equal(undefined);
    expect(provider.clientsStore.getClient("one-too-many")).to.equal(undefined);
  });

  it("rotates a refresh token with a single write of the token set", async () => {
    const client = await provider.clientsStore.registerClient(clientInfo("refresher"));
    const first = await grant(client);
    let writes = 0;
    const original = store.setOAuthTokens.bind(store);
    store.setOAuthTokens = async (tokens: unknown) => {
      writes += 1;
      return original(tokens);
    };
    const second = await provider.exchangeRefreshToken(client, first.refresh_token as string);
    expect(writes).to.equal(1);
    expect(second.access_token).to.not.equal(first.access_token);
    expect(await rejection(provider.verifyAccessToken(first.access_token))).to.be.instanceOf(InvalidTokenError);
    expect((await provider.verifyAccessToken(second.access_token)).clientId).to.equal("refresher");
  });

  it("refuses an authorization for another resource, and accepts its own /mcp (or none)", async () => {
    const client = await provider.clientsStore.registerClient(clientInfo("resourceful"));
    const err = await rejection(
      provider.authorize(client, { codeChallenge: "c", redirectUri: REDIRECT, resource: new URL("https://evil.example.com/mcp") }, fakeResponse()),
    );
    expect(err).to.be.instanceOf(InvalidTargetError);
    const own = await grant(client, { resource: RESOURCE });
    expect((await provider.verifyAccessToken(own.access_token)).resource?.href).to.equal(RESOURCE.href);
    expect(await grant(client)).to.have.property("access_token");
  });

  it("does not accept a persisted token bound to another resource", async () => {
    const other = new WingOAuthProvider(AUTH_TOKEN, store, new URL("https://other.example.com/mcp"));
    try {
      await other.clientsStore.registerClient(clientInfo("elsewhere"));
      const res = fakeResponse();
      await other.authorize(clientInfo("elsewhere"), { codeChallenge: "c", redirectUri: REDIRECT, resource: new URL("https://other.example.com/mcp") }, res);
      const requestId = new URL(res.redirectedTo as string, "http://x").searchParams.get("request_id") as string;
      const code = new URL(other.approve(requestId) as string).searchParams.get("code") as string;
      const tokens = await other.exchangeAuthorizationCode(clientInfo("elsewhere"), code);

      const reloaded = new WingOAuthProvider(AUTH_TOKEN, store, RESOURCE);
      try {
        expect(await rejection(reloaded.verifyAccessToken(tokens.access_token))).to.be.instanceOf(InvalidTokenError);
      } finally {
        reloaded.close();
      }
    } finally {
      other.close();
    }
  });

  it("skips malformed persisted clients instead of trusting them", async () => {
    await store.setOAuthClients({
      good: clientInfo("good"),
      mismatched: clientInfo("someone-else"),
      broken: { client_id: "broken", redirect_uris: "not-an-array" },
    });
    const originalError = console.error;
    console.error = () => undefined;
    let reloaded: WingOAuthProvider;
    try {
      reloaded = new WingOAuthProvider(AUTH_TOKEN, store, RESOURCE);
    } finally {
      console.error = originalError;
    }
    try {
      expect(reloaded.clientsStore.list().map((client) => client.client_id)).to.deep.equal(["good"]);
    } finally {
      reloaded.close();
    }
  });
});
