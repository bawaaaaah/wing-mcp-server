[![M8ven Score](https://m8ven.ai/badge/mcp/bawaaaaah-wing-mcp-server-1gvqqb)](https://m8ven.ai/mcp/bawaaaaah-wing-mcp-server-1gvqqb)
# wing-mcp-server

An MCP server and web dashboard for the **Behringer WING** digital mixing console.

It speaks the WING's own OSC control protocol and its binary metering stream, and exposes the desk
to an MCP client (Claude Desktop, claude.ai, any MCP-capable assistant) as 116 typed tools — plus a
React dashboard for driving the same functionality by hand.

## What it does

- **Mixing** — faders, mutes, pan, sends, main assigns, DCAs and mute groups across channels, auxes,
  buses, mains and matrices.
- **Processing** — EQ, gate and dynamics, including the per-model controls of the console's
  compressor and gate emulations.
- **Automatic setup** — auto-gain, auto-compress and auto-gate that drive the desk's real controls
  from live meter readings, and a pink-noise **auto-EQ** for matrix/bus/main strips with
  measurement-mic calibration files.
- **Presets and scenes** — save, load and delete presets over any part of the node tree; scene and
  library access.
- **Console features** — input patching, inserts, processing order, solo/monitor, talkback, scribble
  strips, bus lighting, GPIO, USB player, RTA and metering, OSC mirroring.
- **Auth** — a static bearer token, an OAuth authorization-code flow for remote MCP clients, and
  WebAuthn passkeys for the dashboard.

## Requirements

Node >= 22, and a WING (or WING Rack / WING Compact) reachable on the network.

## Install

Two ready-made ways to run it, both published from this repository:

| | |
| --- | --- |
| **Docker** — `ghcr.io/bawaaaaah/wing-mcp-server`, amd64 and arm64 | [docs/install-docker.md](docs/install-docker.md) |
| **npm** — `@bawaaaaah/wing-mcp-server` on GitHub Packages, ships a `wing-mcp-server` binary | [docs/install-npm.md](docs/install-npm.md) |

The shortest version of each:

```bash
docker run -d -p 8787:8787 -p 14135:14135/udp -v wing-mcp-data:/app/data \
  -e WING_HOST=192.168.1.50 ghcr.io/bawaaaaah/wing-mcp-server:latest
```

```bash
npm install -g @bawaaaaah/wing-mcp-server   # needs a GitHub Packages token, see the guide
wing-mcp-server --wing-host 192.168.1.50
```

Either way the dashboard is served on `PORT` (8787 by default), the MCP endpoint is at `/mcp`, and
the startup banner prints the URL with the auth token in it. HTTP is on by default; add `--stdio`
to also serve MCP over stdin/stdout for a client that spawns the process itself, or `--no-http` to
turn the dashboard off entirely. Both guides cover configuration, persistence, reverse proxies and
connecting an MCP client, with worked examples.

[docs/configuration.md](docs/configuration.md) is the reference for `data/config.json` and how it
relates to the environment variables — including the one thing that catches everyone, which is that
`WING_HOST` and friends only seed that file on the **first** boot and are ignored afterwards.

## Connecting an MCP client

Two ways in, depending on where this server runs relative to your client — pick one and skip the
other.

### Remote, over HTTP

The usual case: the console stays on its own network, your assistant usually is not on it. The
server speaks MCP over **Streamable HTTP** at `/mcp`, authenticated either with the bearer token
from the startup banner or, for clients that only support OAuth (most "web AI" connectors), a full
OAuth 2.1 authorization-code flow it runs automatically. Works with Claude, OpenAI, Mistral, Grok,
Qwen or anything else that speaks remote MCP.

```bash
claude mcp add --transport http wing http://192.168.1.10:8787/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

Every other client's exact steps differ — the dashboard's own **Connect** page (`/connect`, once
the server is running) generates a ready-to-paste snippet with your real token filled in for
Claude Code, Claude Desktop, claude.ai, Witsy, Hermes, MCP Inspector and raw `curl`.

### Local, over stdio

When the client and the console are reachable from the same machine, skip the network entirely:
the client spawns `wing-mcp-server` itself and talks to it over stdin/stdout, the way most local
MCP servers work — no endpoint URL or token to copy. HTTP stays on by default even here, so the
dashboard is still reachable for as long as that session runs; add `--no-http` for a stdio-only
process.

```json
{
  "mcpServers": {
    "wing": {
      "command": "npx",
      "args": ["-y", "@bawaaaaah/wing-mcp-server", "--stdio", "--no-http", "--config", "/abs/path/to/config.json"]
    }
  }
}
```

Two things worth doing up front: pass an **absolute `--config`** (the working directory is the
client's, not yours, so the default `./data/config.json` can land somewhere unexpected or
unwritable), and know that closing the client ends the process — a stdio server's lifetime is its
client's session, by design. See [Connecting an MCP client](docs/install-npm.md#connecting-an-mcp-client)
in the npm guide for the full picture, GitHub Packages auth for the `npx`, and bridging a server
running elsewhere for a client that only speaks stdio.

### Exposing it to the internet

For the remote/HTTP case above, when the client isn't even on your LAN: a reverse proxy on your own
domain, or a tunnel:

```bash
npx tunnelmole 8787          # prints an HTTPS URL; ngrok and Cloudflare Tunnel work the same way
```

[docs/remote-access.md](docs/remote-access.md) covers the options and, more importantly, the two
things that bite: a tunnel URL that changes on every restart permanently invalidates registered
passkeys (a passkey is bound to its origin by the authenticator, not by this server), and public
exposure needs the hardening block switched on — the token is guessable from anywhere otherwise,
and what it grants is the whole console.

The full tool surface is ~26,000 tokens on every `tools/list`, some of it on clients that reconnect
often. The dashboard's **Tools** page (and [docs/configuration.md](docs/configuration.md#servertools))
lets you turn off whole families — the `core` profile alone cuts that to ~7,300.

## From source

```bash
npm install
cp .env.sample .env      # set WING_HOST to your console's IP
npm run dev              # server + dashboard, with hot reload
```

Or a production build:

```bash
npm run build
npm start
```

## Tests

```bash
npm test
```

Mocha, run against an in-process mock console — no hardware needed.

CI runs the typecheck, the suite and a build on Node 22 and 24 for every push and pull request, and
builds the Docker image (without publishing it) on feature branches and pull requests, so a broken
Dockerfile is caught before it reaches `main`.

## Releasing

Merging to `main` releases itself: once CI is green for that commit, `auto-tag.yml` tags it
`vX.Y.Z` (bumping the patch past whatever was last published), and that tag runs the full suite
again, publishes the npm package to GitHub Packages, and pushes a multi-architecture image to
GHCR tagged `<version>`, `<major>.<minor>`, `<major>` and `latest`. Every merge is a release; there
is no separate step.

For a deliberate minor or major bump, do it before merging — the auto-tag only ever adds a patch,
never a minor or major, and never republishes a version that's already tagged:

```bash
npm version minor        # or major — writes package.json's version; commit it, then merge
```

Pushes to `main` also publish a moving `edge` image tag immediately, ahead of the versioned one.

## Protocol notes

`docs/wing-protocol/` holds notes on the WING's OSC node tree, metering, value encoding and error
codes, written while building this. Much of it was verified directly against a real console, and the
node-tree pages under `05-node-tree/` are generated from the parameter catalog
(`npm run docs:gen:wing`) — edit the catalog, not those files.

Some source comments cite `docs/WING_Remote-Protocols-3.1-03.pdf` by page. That is Music Tribe's own
protocol manual and is **not** redistributed here; download it from Behringer's WING product page if
you want those references to resolve locally.

## Status

A personal project, built and tested against a single WING. Expect rough edges on any model or
firmware it has never met.

## Licence

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it; just keep the copyright notice.

The one thing that licence does not cover is `docs/WING_Remote-Protocols-3.1-03.pdf`, Music Tribe's
own protocol manual. It is not redistributed here and is not mine to license — get it from
Behringer's WING product page.
