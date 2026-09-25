// The master auth token drives the whole console, so it is never written to a log unless the
// operator explicitly asks for it (`server.security.quietToken: false`). `--print-token` is the
// sanctioned way to read it instead.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConfigStore } from "../../src/core/config-store.js";
import { EventBus } from "../../src/core/event-bus.js";
import { McpGatewayServer } from "../../src/core/mcp-gateway-server.js";
import type { McpPlugin } from "../../src/core/plugin.js";
import { describeSecurityConfig, resolveSecurityConfig, type SecurityConfig } from "../../src/core/security-config.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "src/cli.ts");
const tsxLoader = path.join(repoRoot, "node_modules/tsx/dist/loader.mjs");

const plugin: McpPlugin = {
  id: "fake",
  name: "Fake",
  start: async () => undefined,
  stop: async () => undefined,
  getHealth: async () => ({ status: "HEALTHY" }),
  registerTools: (_server: McpServer) => undefined,
  getConfigSchema: () => ({}),
  getConfig: () => ({}),
  setConfig: async () => undefined,
};

describe("auth token visibility", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-token-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function bannerFor(security: SecurityConfig | undefined): Promise<string> {
    const configStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await configStore.load();
    const lines: string[] = [];
    const gateway = new McpGatewayServer([plugin], {
      port: 0,
      authToken: "super-secret-master-token",
      configStore,
      eventBus: new EventBus(),
      security,
      manageSignals: false,
      log: (line) => lines.push(line),
    });
    await gateway.init();
    await gateway.stop();
    return lines.join("\n");
  }

  it("keeps the token out of the startup banner by default, and says how to get it", async () => {
    const banner = await bannerFor(undefined);
    expect(banner).to.not.include("super-secret-master-token");
    expect(banner).to.include("--print-token");
    expect(banner).to.include(path.join(dir, "config.json"));
  });

  it("keeps it out with a security block that says nothing about quietToken", async () => {
    expect(await bannerFor({ rateLimit: { max: 5, windowMs: 60_000 } })).to.not.include("super-secret-master-token");
  });

  it("prints it only on an explicit quietToken: false, and flags that in the hardening line", async () => {
    const banner = await bannerFor({ quietToken: false });
    expect(banner).to.include("#token=super-secret-master-token");
    expect(describeSecurityConfig({ quietToken: false })).to.include("PRINTED");
  });

  it("treats an unparseable MCP_QUIET_TOKEN as quiet, never as a request to print", async () => {
    const previous = process.env.MCP_QUIET_TOKEN;
    process.env.MCP_QUIET_TOKEN = "maybe";
    try {
      const configStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
      await configStore.load();
      expect(resolveSecurityConfig(configStore).quietToken).to.equal(true);
    } finally {
      if (previous === undefined) delete process.env.MCP_QUIET_TOKEN;
      else process.env.MCP_QUIET_TOKEN = previous;
    }
  });

  describe("wing-mcp-server --print-token", () => {
    async function printToken(env: Record<string, string> = {}): Promise<string> {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", tsxLoader, cliPath, "--print-token", "--config", path.join(dir, "config.json")],
        // cwd outside the repo, so cli.ts never auto-loads a developer's ./.env.
        { cwd: dir, env: { PATH: process.env.PATH ?? "", ...env } },
      );
      return stdout;
    }

    it("generates, persists (0600) and prints a token on a fresh install, then prints the same one again", async () => {
      const first = await printToken();
      expect(first).to.match(/^[A-Za-z0-9_-]{32}\n$/);
      expect(await printToken()).to.equal(first);
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
      expect(persisted.server.authToken + "\n").to.equal(first);
      if (process.platform !== "win32") {
        expect(fs.statSync(path.join(dir, "config.json")).mode & 0o777).to.equal(0o600);
      }
    });

    it("prints the MCP_AUTH_TOKEN a fresh install would adopt", async () => {
      expect(await printToken({ MCP_AUTH_TOKEN: "from-the-environment" })).to.equal("from-the-environment\n");
    });
  });
});
