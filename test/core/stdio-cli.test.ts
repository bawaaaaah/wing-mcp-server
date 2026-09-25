// End-to-end coverage for `wing-mcp-server --stdio`, driving the real `src/cli.ts` as a child
// process the way a desktop MCP client would (`command`/`args`, not a URL). Three things only an
// out-of-process test can pin: that stdout carries nothing but well-formed JSON-RPC for the SDK's
// own client to parse, that HTTP genuinely comes up alongside stdio in the same process, and that a
// listen failure on the HTTP side does not take the stdio session down with it.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect } from "chai";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "src/cli.ts");
// An absolute path, not the bare "tsx" specifier: `--import` resolves a bare specifier relative to
// the *child's* cwd, which is a mkdtemp outside the repo below (see the comment on `dir`) precisely
// so it has no node_modules of its own to find "tsx" in.
const tsxLoader = path.join(repoRoot, "node_modules/tsx/dist/loader.mjs");

describe("wing-mcp-server --stdio (spawned CLI)", () => {
  let dir: string;

  beforeEach(() => {
    // A fresh mkdtemp for both MCP_CONFIG_PATH and cwd: cli.ts auto-loads "./.env" when present
    // (cli.ts:101), and spawning from the repo checkout would pick up a developer's own .env — a
    // real WING_HOST there would make the child try to reach an actual console.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wing-mcp-stdio-cli-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function transport(extraEnv: Record<string, string>, stderr: "pipe" | "ignore" = "pipe"): StdioClientTransport {
    return new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxLoader, cliPath, "--stdio", "--no-http"],
      // StdioClientTransport does not inherit the parent's environment — only
      // getDefaultEnvironment()'s short allowlist — so MCP_CONFIG_PATH must be passed explicitly or
      // this would write into the repo's real ./data/config.json.
      env: { ...getDefaultEnvironment(), MCP_CONFIG_PATH: path.join(dir, "config.json"), ...extraEnv },
      cwd: dir,
      stderr,
    });
  }

  it("serves the wing tools over stdio, with stdout carrying nothing but JSON-RPC", async () => {
    const clientTransport = transport({});
    const client = new Client({ name: "test-client", version: "0" });

    let transportError: unknown;
    // A stray non-JSON-RPC line on stdout lands in the client's read buffer and fails to parse
    // there — this is the assertion that catches it, since the child's stdout cannot be read
    // separately from what the transport itself consumes.
    client.onerror = (err) => {
      transportError = err;
    };

    await client.connect(clientTransport);
    try {
      expect(client.getInstructions()).to.be.a("string").and.not.empty;

      const { tools } = await client.listTools();
      expect(tools.length).to.equal(134);
      expect(tools.some((tool) => tool.name === "wing_get")).to.equal(true);

      expect(transportError, "the client's transport must never have reported a parse error").to.be.undefined;
    } finally {
      await client.close();
    }
  });

  it("applies server.tools over stdio too: the safe profile leaves no write tool", async () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ version: 1, server: { tools: { profile: "safe" } }, plugins: {} }),
    );
    const client = new Client({ name: "test-client", version: "0" });
    await client.connect(transport({}));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).to.include("wing_get");
      expect(names).to.not.include("wing_set");
      expect(names).to.not.include("wing_scene_recall");
      expect(names.length).to.be.lessThan(134);
    } finally {
      await client.close();
    }
  });

  it("still serves HTTP alongside stdio when only --stdio is given", async function () {
    this.timeout(15_000);
    const clientTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxLoader, cliPath, "--stdio"],
      env: { ...getDefaultEnvironment(), MCP_CONFIG_PATH: path.join(dir, "config.json"), PORT: "0" },
      cwd: dir,
      stderr: "pipe",
    });
    const client = new Client({ name: "test-client", version: "0" });
    await client.connect(clientTransport);
    try {
      await client.listTools();

      const stderrChunks: Buffer[] = [];
      const stderrStream = clientTransport.stderr;
      expect(stderrStream, "stderr must have been piped").not.to.equal(null);
      stderrStream!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      // The banner is written once, synchronously within init(); give it a moment to arrive.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      const portMatch = /listening on port (\d+)/.exec(stderrText);
      expect(portMatch, "startup banner should report the bound port:\n" + stderrText).not.to.equal(null);

      const port = Number(portMatch![1]);
      const health = await new Promise<{ statusCode: number | undefined }>((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
          res.resume();
          resolve({ statusCode: res.statusCode });
        });
        req.on("error", reject);
      });
      expect(health.statusCode).to.equal(200);
    } finally {
      await client.close();
    }
  });

  it("keeps the stdio session alive when the HTTP port is already taken", async function () {
    this.timeout(15_000);
    const busyServer = http.createServer((_req, res) => res.end("occupied"));
    const busyPort = await new Promise<number>((resolve) => {
      busyServer.listen(0, "127.0.0.1", () => {
        const address = busyServer.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    try {
      const clientTransport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", tsxLoader, cliPath, "--stdio"],
        env: {
          ...getDefaultEnvironment(),
          MCP_CONFIG_PATH: path.join(dir, "config.json"),
          PORT: String(busyPort),
        },
        cwd: dir,
        stderr: "pipe",
      });
      const client = new Client({ name: "test-client", version: "0" });
      await client.connect(clientTransport);
      try {
        const { tools } = await client.listTools();
        expect(tools.length).to.equal(134);

        const stderrChunks: Buffer[] = [];
        clientTransport.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(Buffer.concat(stderrChunks).toString("utf8")).to.include("EADDRINUSE");
      } finally {
        await client.close();
      }
    } finally {
      await new Promise((resolve) => busyServer.close(resolve));
    }
  });
});
