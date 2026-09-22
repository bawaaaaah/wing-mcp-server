// Which transports a `wing-mcp-server` process serves is a property of *this* invocation, not of
// the deployment — the opposite of `server.security`. These tests pin that inverted precedence
// (environment wins over a persisted block), and — the case that would have hidden a bug in the
// first version of this resolver — that it is resolved key by key rather than block by block, so a
// persisted `{"stdio": true}` cannot make `--no-http` silently ignored.

import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import {
  assertAtLeastOneTransport,
  describeTransportConfig,
  NoTransportEnabledError,
  resolveTransportConfig,
} from "../../src/core/transport-config.js";

const TRANSPORT_ENV_VARS = ["MCP_HTTP_ENABLED", "MCP_STDIO_ENABLED"] as const;

describe("resolveTransportConfig", () => {
  let dir: string;
  let filePath: string;
  let saved: Record<string, string | undefined>;
  let errors: unknown[][];
  let restoreConsoleError: () => void;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-transports-"));
    filePath = path.join(dir, "config.json");
    saved = Object.fromEntries(TRANSPORT_ENV_VARS.map((name) => [name, process.env[name]]));
    for (const name of TRANSPORT_ENV_VARS) delete process.env[name];

    errors = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    restoreConsoleError = () => {
      console.error = original;
    };
  });

  afterEach(() => {
    restoreConsoleError();
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

  it("defaults to HTTP on, stdio off, with nothing configured anywhere", async () => {
    expect(resolveTransportConfig(await store())).to.deep.equal({ http: true, stdio: false });
  });

  it("reads the environment when nothing is persisted", async () => {
    process.env.MCP_STDIO_ENABLED = "1";
    process.env.MCP_HTTP_ENABLED = "0";
    expect(resolveTransportConfig(await store())).to.deep.equal({ http: false, stdio: true });
  });

  it("reads a persisted block when the environment says nothing", async () => {
    // Nothing in this server writes server.transports (see ConfigStore.getServerTransports), so
    // this stands in for hand-editing config.json — the supported way to change the default.
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, server: { transports: { stdio: true } }, plugins: {} }));
    const configStore = await store();
    expect(resolveTransportConfig(configStore)).to.deep.equal({ http: true, stdio: true });
  });

  it("resolves key by key: the environment overrides only the key it sets, not the whole block", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, server: { transports: { stdio: true } }, plugins: {} }),
    );
    process.env.MCP_HTTP_ENABLED = "0";
    const configStore = await store();

    // A block-wins resolver (mirroring resolveSecurityConfig) would return http: true here, because
    // the persisted block exists at all — silently dropping --no-http.
    expect(resolveTransportConfig(configStore)).to.deep.equal({ http: false, stdio: true });
  });

  it("falls back to the environment when the persisted block is malformed, rather than throwing", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, server: { transports: { stdio: "yes please" } }, plugins: {} }),
    );
    process.env.MCP_STDIO_ENABLED = "1";
    const configStore = await store();

    expect(resolveTransportConfig(configStore)).to.deep.equal({ http: true, stdio: true });
    expect(errors.length).to.be.greaterThan(0);
  });

  it("ignores an unparseable environment value instead of guessing", async () => {
    process.env.MCP_STDIO_ENABLED = "maybe";
    expect(resolveTransportConfig(await store())).to.deep.equal({ http: true, stdio: false });
    expect(errors.some((args) => String(args[0]).includes("MCP_STDIO_ENABLED"))).to.equal(true);
  });

  it("describes which transports are active", () => {
    expect(describeTransportConfig({ http: true, stdio: false })).to.equal("HTTP (/mcp)");
    expect(describeTransportConfig({ http: true, stdio: true })).to.equal("HTTP (/mcp) + stdio");
    expect(describeTransportConfig({ http: false, stdio: true })).to.equal("stdio");
    expect(describeTransportConfig({ http: false, stdio: false })).to.equal("none");
  });

  it("refuses a configuration where nothing would be served", () => {
    expect(() => assertAtLeastOneTransport({ http: false, stdio: false })).to.throw(NoTransportEnabledError);
    expect(() => assertAtLeastOneTransport({ http: true, stdio: false })).not.to.throw();
    expect(() => assertAtLeastOneTransport({ http: false, stdio: true })).not.to.throw();
  });
});
