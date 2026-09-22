#!/usr/bin/env node
// The `wing-mcp-server` binary published with the npm package.
//
// The server itself is configured entirely through environment variables (see .env.sample). This
// wrapper adds the two things an installed-from-npm process needs that a repo checkout gets for
// free: somewhere to read a .env file from, and a handful of flags for the settings people
// actually pass ad hoc. Flags win over the real environment, which wins over any --env file —
// process.loadEnvFile() never overwrites a variable that is already set, and the flags are applied
// after it runs.
//
// The flag is --env and not --env-file because Node claims "--env-file" for itself: it strips the
// option (and its value) out of argv wherever it appears, even after the script path, loads the
// file itself, and exits with code 9 if the file is missing. parseArgs would therefore never see
// it.
//
// There is deliberately no --token flag: MCP_AUTH_TOKEN would then show up in `ps` output for
// every user on the machine. Pass it in the environment or in an env file instead.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getPackageVersion } from "./core/health.js";
import { runServer } from "./index.js";

const USAGE = `wing-mcp-server — MCP server and web dashboard for the Behringer WING

Usage
  wing-mcp-server [options]

Options
  -h, --help              Show this help and exit.
  -v, --version           Print the version and exit.
      --env <path>        Read environment variables from <path> (repeatable). Defaults to ./.env
                          when that file exists. Variables already set in the environment win.
      --port <port>       HTTP port for the dashboard, REST API and /mcp endpoint (PORT).
      --wing-host <host>  IP or hostname of the console, used on first boot only (WING_HOST).
      --config <path>     Where to persist server state (MCP_CONFIG_PATH).
      --public-url <url>  Externally-reachable base URL, the OAuth issuer for remote MCP
                          clients (PUBLIC_URL).
      --stdio             Also serve MCP over stdin/stdout, for a client that spawns this
                          process itself (MCP_STDIO_ENABLED). Off by default.
      --no-http           Turn off the dashboard, the REST API and /mcp (MCP_HTTP_ENABLED=0).
                          On by default, including alongside --stdio.

Environment
  Every setting has an environment variable; the flags above are shorthand for the common ones.
  See the sample file shipped with this package, or
  https://github.com/bawaaaaah/wing-mcp-server/blob/main/docs/install-npm.md

Notes
  --stdio does not turn HTTP off — the dashboard and /mcp stay up unless --no-http is also
  given. There is no --http or --no-stdio: stdio defaults off and nothing persists it, so
  MCP_STDIO_ENABLED=0 already covers the only way it could be on.

  Under a desktop client, pass an absolute --config: the working directory is the client's,
  not yours, and "./data/config.json" resolving somewhere unexpected (or unwritable) is the
  most common way a first launch fails.

  MCP_AUTH_TOKEN has no flag on purpose — a token on the command line is visible to every
  process on the machine. Set it in the environment or an env file.

  --env, not --env-file: Node keeps "--env-file" for itself and handles it before this process
  starts. It works, but the file is then loaded by Node and a missing one is Node's error.

  The first boot writes a config file (MCP_CONFIG_PATH, ./data/config.json by default) and from
  then on that file — not the environment — is the source of truth for the console settings.
`;

function fail(message: string): never {
  console.error("wing-mcp-server: " + message);
  console.error("Try 'wing-mcp-server --help'.");
  process.exit(2);
}

function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        env: { type: "string", multiple: true },
        port: { type: "string" },
        "wing-host": { type: "string" },
        config: { type: "string" },
        "public-url": { type: "string" },
        stdio: { type: "boolean" },
        "no-http": { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (values.version) {
    process.stdout.write(getPackageVersion() + "\n");
    process.exit(0);
  }

  // An explicit --env that isn't there is a typo worth stopping for; a missing ./.env is just the
  // normal case for a container or a systemd unit that passes everything in the environment.
  const envFiles = values.env ?? [];
  if (envFiles.length > 0) {
    for (const file of envFiles) {
      if (!fs.existsSync(file)) fail("env file not found: " + file);
      process.loadEnvFile(file);
    }
  } else if (fs.existsSync(path.resolve(process.cwd(), ".env"))) {
    process.loadEnvFile(path.resolve(process.cwd(), ".env"));
  }

  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
      fail("--port must be an integer between 1 and 65535 (got " + values.port + ")");
    }
    process.env.PORT = values.port;
  }
  if (values["wing-host"] !== undefined) process.env.WING_HOST = values["wing-host"];
  if (values.config !== undefined) process.env.MCP_CONFIG_PATH = values.config;
  if (values["public-url"] !== undefined) {
    try {
      new URL(values["public-url"]);
    } catch {
      fail("--public-url must be an absolute URL (got " + values["public-url"] + ")");
    }
    process.env.PUBLIC_URL = values["public-url"];
  }
  // Only set when the flag is actually present, so an unset flag never clobbers a variable the
  // caller deliberately set in the environment.
  if (values.stdio) process.env.MCP_STDIO_ENABLED = "1";
  if (values["no-http"]) process.env.MCP_HTTP_ENABLED = "0";

  return runServer();
}

await main();
