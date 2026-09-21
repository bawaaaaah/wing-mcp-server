// The hardening block is opt-in by design: with nothing configured the server must behave exactly
// as it did before it existed, because a misconfigured origin allowlist locks an operator out of
// their own console. These tests pin both halves of that contract — inert when absent, applied
// when present — and the precedence rule, which deliberately differs from the auth token's.

import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import { createRateLimit } from "../../src/core/rate-limit.js";
import { describeSecurityConfig, resolveSecurityConfig } from "../../src/core/security-config.js";

const SECURITY_ENV_VARS = [
  "MCP_ALLOWED_ORIGINS",
  "MCP_ALLOWED_HOSTS",
  "MCP_BIND_HOST",
  "MCP_RATE_LIMIT_MAX",
  "MCP_RATE_LIMIT_WINDOW_MS",
  "MCP_QUIET_TOKEN",
] as const;

describe("resolveSecurityConfig", () => {
  let dir: string;
  let filePath: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-security-"));
    filePath = path.join(dir, "config.json");
    saved = Object.fromEntries(SECURITY_ENV_VARS.map((name) => [name, process.env[name]]));
    for (const name of SECURITY_ENV_VARS) delete process.env[name];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function store(): Promise<ConfigStore> {
    const configStore = new ConfigStore({ filePath });
    await configStore.load();
    return configStore;
  }

  it("is empty when nothing is configured anywhere", async () => {
    expect(resolveSecurityConfig(await store())).to.deep.equal({});
  });

  it("reads the environment when no block is persisted", async () => {
    process.env.MCP_ALLOWED_ORIGINS = "https://wing.example.com, https://alt.example.com";
    process.env.MCP_RATE_LIMIT_MAX = "10";
    process.env.MCP_BIND_HOST = "127.0.0.1";

    const config = resolveSecurityConfig(await store());
    expect(config.allowedOrigins).to.deep.equal(["https://wing.example.com", "https://alt.example.com"]);
    expect(config.rateLimit).to.deep.equal({ max: 10, windowMs: 60_000 });
    expect(config.bindHost).to.equal("127.0.0.1");
    expect(config.quietToken).to.be.undefined;
  });

  it("lets a persisted block win over the environment", async () => {
    process.env.MCP_ALLOWED_ORIGINS = "https://from-env.example.com";
    const configStore = await store();
    await configStore.setServerSecurity({ allowedOrigins: ["https://from-config.example.com"] });

    expect(resolveSecurityConfig(configStore).allowedOrigins).to.deep.equal(["https://from-config.example.com"]);
  });

  it("keeps reading the environment on every boot rather than persisting it once", async () => {
    // Unlike resolveAuthToken/resolvePublicUrl, which write their env value to disk on first use
    // and ignore it forever after. Silently honouring a stale allowlist because an older value was
    // persisted is the failure mode worth avoiding here.
    process.env.MCP_ALLOWED_ORIGINS = "https://first.example.com";
    const first = await store();
    expect(resolveSecurityConfig(first).allowedOrigins).to.deep.equal(["https://first.example.com"]);

    process.env.MCP_ALLOWED_ORIGINS = "https://second.example.com";
    const second = await store();
    expect(resolveSecurityConfig(second).allowedOrigins).to.deep.equal(["https://second.example.com"]);
    expect(second.getServerSecurity(), "nothing should have been written to the config file").to.be.undefined;
  });

  it("falls back to the environment when a persisted block is malformed, rather than throwing", async () => {
    process.env.MCP_BIND_HOST = "127.0.0.1";
    const configStore = await store();
    await configStore.setServerSecurity({ allowedOrigins: "not-an-array", rateLimit: 17 });

    expect(resolveSecurityConfig(configStore).bindHost).to.equal("127.0.0.1");
  });

  it("describes what is actually switched on", () => {
    expect(describeSecurityConfig({})).to.include("none");
    expect(describeSecurityConfig({ allowedOrigins: ["https://x"], rateLimit: { max: 5, windowMs: 60_000 } }))
      .to.include("origin checks")
      .and.to.include("rate limit 5/60s");
  });
});

describe("createRateLimit", () => {
  interface FakeRes {
    statusCode: number;
    headers: Record<string, string>;
    finish(): void;
  }

  function run(handler: ReturnType<typeof createRateLimit>, statusCode: number): { blocked: boolean; res: FakeRes } {
    const listeners: Array<() => void> = [];
    let blocked = false;
    const res = {
      statusCode,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      status(code: number) {
        this.statusCode = code;
        blocked = true;
        return this;
      },
      json() {
        return this;
      },
      once(_event: string, listener: () => void) {
        listeners.push(listener);
        return this;
      },
      finish() {
        for (const listener of listeners) listener();
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler({ ip: "203.0.113.1", socket: {} } as any, res as any, () => undefined);
    if (!blocked) res.finish();
    return { blocked, res: res as unknown as FakeRes };
  }

  it("does not charge successful requests, however many there are", () => {
    const handler = createRateLimit({
      windowMs: 60_000,
      max: 3,
      countResponse: (res) => res.statusCode === 401,
    });
    for (let i = 0; i < 50; i += 1) {
      expect(run(handler, 200).blocked, `request ${i} was blocked`).to.equal(false);
    }
  });

  it("blocks once the failed attempts run out, and says when to retry", () => {
    const handler = createRateLimit({
      windowMs: 60_000,
      max: 3,
      countResponse: (res) => res.statusCode === 401,
    });
    for (let i = 0; i < 3; i += 1) {
      expect(run(handler, 401).blocked).to.equal(false);
    }
    const fourth = run(handler, 401);
    expect(fourth.blocked).to.equal(true);
    expect(fourth.res.statusCode).to.equal(429);
    expect(fourth.res.headers["retry-after"]).to.be.a("string");
  });

  it("lets the window expire", async () => {
    const handler = createRateLimit({ windowMs: 40, max: 1, countResponse: () => true });
    expect(run(handler, 200).blocked).to.equal(false);
    expect(run(handler, 200).blocked).to.equal(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(run(handler, 200).blocked).to.equal(false);
  });
});
