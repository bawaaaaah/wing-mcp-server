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

## Setup

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

The dashboard is served on `PORT` (8787 by default); the MCP endpoint is at `/mcp`.

## Tests

```bash
npm test
```

Mocha, run against an in-process mock console — no hardware needed.

## Protocol notes

`docs/wing-protocol/` holds notes on the WING's OSC node tree, metering, value encoding and error
codes, written while building this. Much of it was verified directly against a real console, and the
node-tree pages under `05-node-tree/` are generated from the parameter catalog
(`npm run docs:gen:wing`) — edit the catalog, not those files.

Some source comments cite `docs/WING_Remote-Protocols-3.1-03.pdf` by page. That is Music Tribe's own
protocol manual and is **not** redistributed here; download it from Behringer's WING product page if
you want those references to resolve locally.

## Status

A personal project, built and tested against a single WING. No licence has been chosen yet, so
default copyright applies — please ask before reusing.
