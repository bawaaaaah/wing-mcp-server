// Ad-hoc probe of the console's RTA configuration through a running server's MCP endpoint: lists
// the /cfg/rta branch with wing_get, then describes it with its live values with wing_describe.
// Handy when working out which RTA source/tap the console reports, without opening the dashboard.
//
// Run via `npm run probe:rta` (wired up in package.json as `tsx scripts/probe-rta-source.ts`),
// against a server that is already running.
//
// Nothing is defaulted, on purpose: a checkout's ./data/config.json and port 8787 are usually the
// production server driving a real console, and this script must never reach it by accident.
//
//   MCP_URL          required — the server's /mcp endpoint, e.g. http://127.0.0.1:18787/mcp
//   MCP_AUTH_TOKEN   the bearer token, or
//   MCP_CONFIG_PATH  that server's config file, whose `server.authToken` is used instead
//
// The config file is only read, never written: this script does not go through ConfigStore, whose
// load() renames a file it can't parse and would generate a token if none existed. The token is
// never printed.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { promises as fs } from "node:fs";

async function readAuthTokenFromConfig(filePath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read ${filePath} (${(err as NodeJS.ErrnoException).code ?? String(err)}). ` +
        "Start the server once so it writes its config, or point MCP_CONFIG_PATH at the one it uses.",
    );
  }
  const config = JSON.parse(raw) as { server?: { authToken?: unknown } };
  const persisted = config.server?.authToken;
  if (typeof persisted !== "string" || persisted === "") {
    throw new Error(`${filePath} has no server.authToken yet — start the server once so it generates one.`);
  }
  return persisted;
}

function usage(problem: string): never {
  console.error(
    `${problem}\n` +
      "Usage: MCP_URL=http://127.0.0.1:<port>/mcp (MCP_AUTH_TOKEN=<token> | MCP_CONFIG_PATH=<config.json>) " +
      "npm run probe:rta",
  );
  process.exit(2);
}

const mcpUrl = process.env.MCP_URL;
if (!mcpUrl) usage("MCP_URL is required (there is no default, so the production server is never probed by accident).");
const endpoint = new URL(mcpUrl);
const envToken = process.env.MCP_AUTH_TOKEN;
const configPath = process.env.MCP_CONFIG_PATH;
let token: string;
if (envToken) token = envToken;
else if (configPath) token = await readAuthTokenFromConfig(configPath);
else usage("Set MCP_AUTH_TOKEN, or MCP_CONFIG_PATH to the config file of the server behind MCP_URL.");

const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "probe-rta-source", version: "1.0.0" });
await client.connect(transport);

/** structuredContent when the tool returned some, its text otherwise — an error has only text. */
function show(result: Awaited<ReturnType<Client["callTool"]>>): void {
  if (result.structuredContent !== undefined && !result.isError) {
    console.log(JSON.stringify(result.structuredContent, null, 2));
    return;
  }
  const content = (result.content ?? []) as { type: string; text?: string }[];
  const text = content.map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join("\n");
  console.log(result.isError ? `error: ${text}` : text);
  if (result.isError) process.exitCode = 1;
}

try {
  console.log("--- wing_get /cfg/rta (branch listing) ---");
  show(await client.callTool({ name: "wing_get", arguments: { path: "/cfg/rta" } }));

  console.log("--- wing_describe /cfg/rta with values ---");
  show(await client.callTool({ name: "wing_describe", arguments: { path: "/cfg/rta", includeValues: true } }));
} finally {
  await client.close();
}
