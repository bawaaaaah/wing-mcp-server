import { expect } from "chai";
import express from "express";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createAuthMiddleware, resolveAuthToken, resolvePublicUrl } from "../../src/core/auth.js";
import { ConfigStore } from "../../src/core/config-store.js";
import { errorHandler } from "../../src/core/http-errors.js";

describe("createAuthMiddleware", () => {
  const token = "s3cr3t-test-token";
  const auth = createAuthMiddleware(token);
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.get("/protected", auth.requireAuth(), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use(errorHandler());

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = "http://127.0.0.1:" + port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 401 when no Authorization header is present", async () => {
    const res = await fetch(baseUrl + "/protected");
    expect(res.status).to.equal(401);
  });

  it("returns 200 with the correct bearer token", async () => {
    const res = await fetch(baseUrl + "/protected", {
      headers: { Authorization: "Bearer " + token },
    });
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({ ok: true });
  });

  it("returns 401 with an incorrect bearer token", async () => {
    const res = await fetch(baseUrl + "/protected", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).to.equal(401);
  });

  it("never accepts a stream ticket on an HTTP route", async () => {
    const ticket = auth.issueStreamTicket(token);
    const res = await fetch(baseUrl + "/protected?ticket=" + encodeURIComponent(ticket));
    expect(res.status).to.equal(401);
  });

  it("hands a stream ticket's credential back exactly once", () => {
    const ticket = auth.issueStreamTicket(token);
    expect(auth.consumeStreamTicket(ticket)).to.equal(token);
    expect(auth.consumeStreamTicket(ticket)).to.equal(undefined);
    expect(auth.consumeStreamTicket("made-up")).to.equal(undefined);
  });

  it("tells a valid credential from an invalid one", () => {
    expect(auth.isValidCredential(token)).to.equal(true);
    expect(auth.isValidCredential(token + "x")).to.equal(false);
  });
});

describe("resolveAuthToken / resolvePublicUrl (persisted > env > generated precedence)", () => {
  let dir: string;
  let filePath: string;
  let originalAuthTokenEnv: string | undefined;
  let originalPublicUrlEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-auth-test-"));
    filePath = path.join(dir, "config.json");
    originalAuthTokenEnv = process.env.MCP_AUTH_TOKEN;
    originalPublicUrlEnv = process.env.PUBLIC_URL;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalAuthTokenEnv === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = originalAuthTokenEnv;
    if (originalPublicUrlEnv === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalPublicUrlEnv;
  });

  it("resolveAuthToken: an already-persisted token wins over MCP_AUTH_TOKEN", async () => {
    const store = new ConfigStore({ filePath });
    await store.load();
    await store.setServerAuthToken("persisted-token");
    process.env.MCP_AUTH_TOKEN = "env-token";

    expect(await resolveAuthToken(store)).to.equal("persisted-token");
    expect(store.getServerAuthToken()).to.equal("persisted-token");
  });

  it("resolveAuthToken: falls back to MCP_AUTH_TOKEN when nothing is persisted, and persists it", async () => {
    delete process.env.MCP_AUTH_TOKEN;
    const store = new ConfigStore({ filePath });
    await store.load();
    process.env.MCP_AUTH_TOKEN = "env-token";

    expect(await resolveAuthToken(store)).to.equal("env-token");
    expect(store.getServerAuthToken()).to.equal("env-token");

    // Reload from disk to prove it was actually persisted, not just cached in memory.
    const reloaded = new ConfigStore({ filePath });
    await reloaded.load();
    expect(reloaded.getServerAuthToken()).to.equal("env-token");
  });

  it("resolveAuthToken: generates and persists a random token when neither persisted nor env is set", async () => {
    delete process.env.MCP_AUTH_TOKEN;
    const store = new ConfigStore({ filePath });
    await store.load();

    const generated = await resolveAuthToken(store);
    expect(generated).to.be.a("string").with.length.greaterThan(0);
    expect(store.getServerAuthToken()).to.equal(generated);

    // Calling again on the same (now-persisted) store must return the SAME token, not a new one.
    expect(await resolveAuthToken(store)).to.equal(generated);
  });

  it("resolvePublicUrl: an already-persisted URL wins over PUBLIC_URL", async () => {
    const store = new ConfigStore({ filePath });
    await store.load();
    await store.setServerPublicUrl("https://persisted.example.com");
    process.env.PUBLIC_URL = "https://env.example.com";

    const url = await resolvePublicUrl(store, 8787);
    expect(url.href).to.equal("https://persisted.example.com/");
  });

  it("resolvePublicUrl: falls back to PUBLIC_URL when nothing is persisted, and persists it", async () => {
    delete process.env.PUBLIC_URL;
    const store = new ConfigStore({ filePath });
    await store.load();
    process.env.PUBLIC_URL = "https://env.example.com";

    const url = await resolvePublicUrl(store, 8787);
    expect(url.href).to.equal("https://env.example.com/");
    expect(store.getServerPublicUrl()).to.equal("https://env.example.com");
  });

  it("resolvePublicUrl: falls back to http://localhost:<port> without persisting it (keeps tracking `port` if it changes)", async () => {
    delete process.env.PUBLIC_URL;
    const store = new ConfigStore({ filePath });
    await store.load();

    const first = await resolvePublicUrl(store, 8787);
    expect(first.href).to.equal("http://localhost:8787/");
    expect(store.getServerPublicUrl()).to.be.undefined;

    const second = await resolvePublicUrl(store, 9999);
    expect(second.href).to.equal("http://localhost:9999/");
  });
});
