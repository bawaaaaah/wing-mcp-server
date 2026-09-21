// End-to-end counterpart to security-config.test.ts: proves the block actually reaches the running
// server, and — the part that matters most — that a server with no block configured behaves
// exactly as it did before any of this existed.

import { expect } from "chai";
import type { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import { EventBus } from "../../src/core/event-bus.js";
import { McpGatewayServer } from "../../src/core/mcp-gateway-server.js";
import type { McpPlugin, PluginHealth } from "../../src/core/plugin.js";
import type { SecurityConfig } from "../../src/core/security-config.js";

class InertPlugin implements McpPlugin {
  readonly id = "inert";
  readonly name = "Inert Plugin";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getHealth(): Promise<PluginHealth> {
    return { status: "HEALTHY", detail: {} };
  }
  registerTools(): void {}
  getConfigSchema(): object {
    return { type: "object" };
  }
  getConfig(): unknown {
    return {};
  }
  async setConfig(): Promise<void> {}
  registerHttpRoutes(_router: Router): void {}
}

const AUTH_TOKEN = "hardening-test-token";

interface Harness {
  baseUrl: string;
  stop: () => Promise<void>;
}

async function startServer(security?: SecurityConfig): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-hardening-"));
  const configStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
  await configStore.load();
  const server = new McpGatewayServer([new InertPlugin()], {
    port: 0,
    authToken: AUTH_TOKEN,
    configStore,
    eventBus: new EventBus(),
    ...(security ? { security } : {}),
  });
  await server.init();
  return {
    baseUrl: "http://127.0.0.1:" + (server.port as number),
    stop: async () => {
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal, valid MCP initialize request — enough to reach the transport's own checks. */
function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hardening-test", version: "0" },
    },
  });
}

function mcpHeaders(origin?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer " + AUTH_TOKEN,
    ...(origin ? { Origin: origin } : {}),
  };
}

describe("security hardening, end to end", () => {
  describe("with no security block configured", () => {
    let harness: Harness;
    before(async () => {
      harness = await startServer();
    });
    after(async () => harness.stop());

    it("accepts an MCP session from any origin, exactly as before", async () => {
      const res = await fetch(harness.baseUrl + "/mcp", {
        method: "POST",
        headers: mcpHeaders("https://someone-elses-site.example"),
        body: initializeBody(),
      });
      expect(res.status).to.equal(200);
    });

    it("never answers 429, however many times authentication fails", async () => {
      for (let i = 0; i < 40; i += 1) {
        const res = await fetch(harness.baseUrl + "/api/status", { headers: { Authorization: "Bearer wrong" } });
        expect(res.status, `attempt ${i}`).to.equal(401);
      }
    });
  });

  describe("with an origin allowlist", () => {
    let harness: Harness;
    before(async () => {
      harness = await startServer({ allowedOrigins: ["https://wing.example.com"] });
    });
    after(async () => harness.stop());

    it("rejects an MCP request from an origin that is not on the list", async () => {
      const res = await fetch(harness.baseUrl + "/mcp", {
        method: "POST",
        headers: mcpHeaders("https://someone-elses-site.example"),
        body: initializeBody(),
      });
      expect(res.status).to.equal(403);
    });

    it("still accepts the allowed origin", async () => {
      const res = await fetch(harness.baseUrl + "/mcp", {
        method: "POST",
        headers: mcpHeaders("https://wing.example.com"),
        body: initializeBody(),
      });
      expect(res.status).to.equal(200);
    });
  });

  describe("with a rate limit", () => {
    let harness: Harness;
    before(async () => {
      harness = await startServer({ rateLimit: { max: 5, windowMs: 60_000 } });
    });
    after(async () => harness.stop());

    it("stops answering failed authentication attempts once the budget is spent", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const res = await fetch(harness.baseUrl + "/api/status", { headers: { Authorization: "Bearer wrong" } });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5), "the first attempts are answered normally").to.deep.equal([401, 401, 401, 401, 401]);
      expect(statuses.slice(5), "the rest are refused outright").to.deep.equal([429, 429, 429]);
    });

  });

  describe("with a rate limit, on a client that has not failed", () => {
    let harness: Harness;
    before(async () => {
      // A server of its own: once an address exhausts its budget it is locked out for the rest of
      // the window, requests that would have succeeded included. That is what a lockout means, and
      // it is why the budget counts failures only — so ordinary traffic never approaches it.
      harness = await startServer({ rateLimit: { max: 5, windowMs: 60_000 } });
    });
    after(async () => harness.stop());

    it("never charges a request that does not fail authentication", async () => {
      // Far more than the budget: a dashboard polling meters mid-show must not be cut off.
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(harness.baseUrl + "/health");
        expect(res.status, `request ${i}`).to.equal(200);
      }
    });
  });

  describe("behind a reverse proxy", () => {
    let harness: Harness;
    before(async () => {
      harness = await startServer({ rateLimit: { max: 3, windowMs: 60_000 }, trustProxy: 1 });
    });
    after(async () => harness.stop());

    it("meters each forwarded client separately rather than lumping them behind the proxy", async () => {
      const attempt = (clientIp: string): Promise<number> =>
        fetch(harness.baseUrl + "/api/status", {
          headers: { Authorization: "Bearer wrong", "X-Forwarded-For": clientIp },
        }).then((res) => res.status);

      for (let i = 0; i < 3; i += 1) {
        expect(await attempt("198.51.100.7")).to.equal(401);
      }
      expect(await attempt("198.51.100.7"), "the offending client is locked out").to.equal(429);
      // Without trust proxy every client here would look like the same socket address, so this
      // second one would already be locked out by the first one's attempts.
      expect(await attempt("198.51.100.8"), "an unrelated client is unaffected").to.equal(401);
    });
  });
});
