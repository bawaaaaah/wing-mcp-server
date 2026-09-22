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

## Connecting an AI client

Two ways in, depending on where this server runs relative to your client.

**Remote, over HTTP** — the usual case: the console stays on its own network, your assistant
usually is not on it. The server speaks MCP over Streamable HTTP at `/mcp` and accepts either a
bearer token or a full OAuth 2.1 authorization-code flow (PKCE, dynamic client registration), so
any client that supports a remote MCP server can drive the desk once it can reach the URL —
whether that is Claude, OpenAI, Mistral, Grok, Qwen or anything else. Support differs per product
and moves fast, so check your client's own docs for how it adds one.

**Local, over stdio** — when the client and the console are reachable from the same machine, a
desktop client can spawn the server itself instead: `npx @bawaaaaah/wing-mcp-server --stdio
--no-http`. See [Connecting an MCP client](docs/install-npm.md#connecting-an-mcp-client) in the npm
guide for the client config and the one thing worth knowing going in — the server's lifetime
becomes that client's session.

Getting it reachable is a reverse proxy on your own domain, or a tunnel:

```bash
npx tunnelmole 8787          # prints an HTTPS URL; ngrok and Cloudflare Tunnel work the same way
```

[docs/remote-access.md](docs/remote-access.md) covers the options and, more importantly, the two
things that bite: a tunnel URL that changes on every restart permanently invalidates registered
passkeys (a passkey is bound to its origin by the authenticator, not by this server), and public
exposure needs the hardening block switched on — the token is guessable from anywhere otherwise,
and what it grants is the whole console.

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

Pushing a `v*.*.*` tag runs the full suite, publishes the npm package to GitHub Packages and pushes
a multi-architecture image to GHCR tagged `<version>`, `<major>.<minor>`, `<major>` and `latest`:

```bash
npm version patch        # writes package.json and creates the tag
git push --follow-tags
```

Pushes to `main` publish a moving `edge` image tag and nothing else.

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
