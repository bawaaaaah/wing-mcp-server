// Nothing bounded the MCP session map: a client that vanishes without sending DELETE /mcp — a
// closed laptop, a killed process, a dropped tunnel — left its transport *and* its per-session
// McpServer resident for the life of the process. And an unknown session id answered 400, which
// reads as "your request was malformed"; it is the 404 that tells a client its session is gone and
// it should initialize a new one.

import { expect } from "chai";
import type { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/core/config-store.js";
import { EventBus } from "../../src/core/event-bus.js";
import { McpGatewayServer } from "../../src/core/mcp-gateway-server.js";
import type { McpPlugin, PluginHealth } from "../../src/core/plugin.js";

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

const AUTH_TOKEN = "session-lifecycle-token";

interface SessionInternals {
  transports: Map<string, { lastSeenAt: number; toolHandles: Map<string, unknown> }>;
  sweepIdleSessions: () => void;
}

describe("MCP session lifecycle", () => {
  let dir: string;
  let server: McpGatewayServer;
  let baseUrl: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-session-"));
    const configStore = new ConfigStore({ filePath: path.join(dir, "config.json") });
    await configStore.load();
    server = new McpGatewayServer([new InertPlugin()], {
      port: 0,
      authToken: AUTH_TOKEN,
      configStore,
      eventBus: new EventBus(),
    });
    await server.init();
    baseUrl = "http://127.0.0.1:" + (server.port as number);
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const headers = (sessionId?: string): Record<string, string> => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer " + AUTH_TOKEN,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });

  async function openSession(): Promise<string> {
    const res = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "session-test", version: "0" },
        },
      }),
    });
    expect(res.status).to.equal(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId, "initialize must hand back a session id").to.be.a("string");
    return sessionId as string;
  }

  it("answers 404 for a session id the server does not know", async () => {
    const res = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: headers("11111111-2222-3333-4444-555555555555"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(res.status).to.equal(404);
  });

  it("answers 404 on GET and DELETE for an unknown session too", async () => {
    const unknown = headers("11111111-2222-3333-4444-555555555555");
    expect((await fetch(baseUrl + "/mcp", { method: "GET", headers: unknown })).status).to.equal(404);
    expect((await fetch(baseUrl + "/mcp", { method: "DELETE", headers: unknown })).status).to.equal(404);
  });

  it("still answers 400 when no session id is supplied at all", async () => {
    // Genuinely a malformed request rather than a stale session, so it keeps its 400.
    const res = await fetch(baseUrl + "/mcp", { method: "GET", headers: headers() });
    expect(res.status).to.equal(400);
  });

  it("keeps a session usable while it is in use", async () => {
    const sessionId = await openSession();
    const internals = server as unknown as SessionInternals;
    expect(internals.transports.has(sessionId)).to.equal(true);

    internals.sweepIdleSessions();
    expect(internals.transports.has(sessionId), "a fresh session must survive a sweep").to.equal(true);
  });

  it("sweeps a session whose client went away without saying goodbye", async () => {
    const sessionId = await openSession();
    const internals = server as unknown as SessionInternals;

    // The idle window is a module constant rather than an option, so the entry is backdated
    // instead of the test waiting half an hour.
    const entry = internals.transports.get(sessionId);
    expect(entry).to.not.equal(undefined);
    (entry as { lastSeenAt: number }).lastSeenAt = Date.now() - 31 * 60 * 1000;

    internals.sweepIdleSessions();

    expect(internals.transports.has(sessionId), "the transport and its McpServer must be released").to.equal(false);

    // And the client is told to start over rather than left guessing.
    const res = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: headers(sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    });
    expect(res.status).to.equal(404);
  });

  it("releases a session's tool handles along with everything else when it is swept", async () => {
    // Regression guard against reintroducing a global handle registry: the handles a session's
    // tools were captured into must live only in that session's own map entry, so a sweep that
    // deletes the entry is the whole story — nothing else needs to be told to forget them.
    const sessionId = await openSession();
    const internals = server as unknown as SessionInternals;
    const entry = internals.transports.get(sessionId);
    expect(entry?.toolHandles).to.be.instanceOf(Map);

    (entry as { lastSeenAt: number }).lastSeenAt = Date.now() - 31 * 60 * 1000;
    internals.sweepIdleSessions();

    expect(internals.transports.has(sessionId)).to.equal(false);
  });
});
