// StdioServerTransport (the SDK) attaches only 'data' and 'error' listeners to stdin — it never
// notices EOF, so relying on the SDK alone leaves a process that outlives the client that spawned
// it (nothing else would end it: the OSC renewal and meter keepalive intervals are not unref'd).
// This is the test that pins the EOF wiring StdioEndpoint adds on top, in memory rather than over a
// real child process so the assertion is direct: write a framed request in, read a framed response
// out, close stdin, and check the disconnect callback actually fired.

import { expect } from "chai";
import type { Router } from "express";
import { PassThrough } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioEndpoint } from "../../src/core/stdio-endpoint.js";
import type { McpPlugin, PluginHealth } from "../../src/core/plugin.js";

class FakePlugin implements McpPlugin {
  readonly id = "fake";
  readonly name = "Fake Plugin";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getHealth(): Promise<PluginHealth> {
    return { status: "HEALTHY", detail: {} };
  }
  getInstructions(): string {
    return "Fake plugin guidance.";
  }
  registerTools(server: McpServer): void {
    server.registerTool(
      "echo",
      { description: "Echoes the provided message back", inputSchema: { message: z.string() } },
      async ({ message }) => ({ content: [{ type: "text", text: message }] }),
    );
  }
  getConfigSchema(): object {
    return { type: "object" };
  }
  getConfig(): unknown {
    return {};
  }
  async setConfig(): Promise<void> {}
  registerHttpRoutes(_router: Router): void {}
}

function writeFramed(stream: PassThrough, message: unknown): void {
  stream.write(JSON.stringify(message) + "\n");
}

/** Reads one newline-delimited JSON-RPC message off a stream, however many chunks it arrives in. */
function readOneMessage(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const newlineAt = buffer.indexOf("\n");
      if (newlineAt === -1) return;
      stream.off("data", onData);
      stream.off("error", onError);
      resolve(JSON.parse(buffer.slice(0, newlineAt)));
    };
    const onError = (err: Error): void => reject(err);
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

describe("StdioEndpoint", () => {
  it("answers initialize and tools/list over the injected streams, carrying the plugin's instructions", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    let disconnected = false;

    const endpoint = new StdioEndpoint({
      plugins: [new FakePlugin()],
      onClientDisconnect: () => {
        disconnected = true;
      },
      stdin: clientToServer,
      stdout: serverToClient,
    });
    await endpoint.start();

    writeFramed(clientToServer, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    const initResponse = await readOneMessage(serverToClient);
    const initResult = initResponse.result as { instructions?: string; serverInfo: { name: string } };
    expect(initResult.serverInfo.name).to.equal("wing-mcp-server");
    expect(initResult.instructions).to.equal("Fake plugin guidance.");

    writeFramed(clientToServer, { jsonrpc: "2.0", method: "notifications/initialized" });
    writeFramed(clientToServer, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResponse = await readOneMessage(serverToClient);
    const tools = (toolsResponse.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).to.deep.equal(["echo"]);

    expect(disconnected, "must not fire while the client is still connected").to.equal(false);

    clientToServer.end();
    // 'end' is asynchronous; give the endpoint's listener a turn to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(disconnected, "must fire once stdin reaches EOF, which the SDK's own transport ignores").to.equal(true);

    await endpoint.stop();
  });

  it("does not report a disconnect for a shutdown it performed itself", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    let disconnectCount = 0;

    const endpoint = new StdioEndpoint({
      plugins: [new FakePlugin()],
      onClientDisconnect: () => {
        disconnectCount += 1;
      },
      stdin: clientToServer,
      stdout: serverToClient,
    });
    await endpoint.start();

    await endpoint.stop();
    // stop() is expected to end the underlying stdin listeners' relevance, but does not itself end
    // the (test-owned) stream — closing it afterwards must not retroactively count as a disconnect.
    clientToServer.end();
    await new Promise((resolve) => setImmediate(resolve));

    expect(disconnectCount).to.equal(0);
  });

  it("stop() is safe to call more than once", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const endpoint = new StdioEndpoint({
      plugins: [new FakePlugin()],
      onClientDisconnect: () => {},
      stdin: clientToServer,
      stdout: serverToClient,
    });
    await endpoint.start();

    await Promise.all([endpoint.stop(), endpoint.stop()]);
  });
});
