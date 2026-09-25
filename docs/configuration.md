# Configuration

There are two places settings live, and the relationship between them is the one thing worth
reading before anything else.

- **`data/config.json`** — the server's own state file. It is the source of truth.
- **Environment variables** — mostly *seeds* for that file, used once and then ignored.

## The trap: environment variables are not overrides

For the console settings and for the auth token, an environment variable is read **only when the
config file has nothing to say**. Once a value is in `data/config.json`, that value wins forever
and the environment variable is ignored.

```
WING_HOST=192.168.1.50  →  first boot  →  written to data/config.json
WING_HOST=192.168.1.99  →  every boot after that  →  ignored
```

This is deliberate: the dashboard's Config tab has to be able to change the console's address, and
a restart must not silently undo what you set there. But it does mean that **editing `.env` after
the first run appears to do nothing**, which is worth an hour of anyone's time the first time it
happens.

Which rule applies where:

| Setting | Behaviour |
| --- | --- |
| `WING_*` (console address, ports, OSC mirror) | Seeds `plugins.wing` on first boot only. `defaultWingConfigFromEnv()` runs only when the store is empty. |
| `MCP_AUTH_TOKEN`, `PUBLIC_URL` | Persisted the first time they are used; ignored once a value is stored. |
| `MCP_*` hardening (`MCP_ALLOWED_ORIGINS`, `MCP_RATE_LIMIT_MAX`, …) | **Re-read on every boot.** Never persisted. A stored `server.security` block wins if present. |
| `MCP_HTTP_ENABLED`, `MCP_STDIO_ENABLED` | **Re-read on every boot, and the reverse of the row above: the environment/flag wins over a stored `server.transports` block**, not the other way round. See [`server.transports`](#servertransports). |
| `PORT`, `MCP_CONFIG_PATH`, `MCP_DASHBOARD_DIST`, `WING_PRESETS_DIR`, `WING_MIC_CALIBRATIONS_DIR` | Read from the environment every boot; never stored. |

The hardening block and the transports block are both deliberate exceptions to the "file wins"
rule at the top of this page, in opposite directions. Hardening describes where the server is
*deployed*, not a preference someone picked once — honouring a stale origin allowlist because an
older value had reached disk is precisely the failure worth avoiding, so the environment is
re-read every boot but a stored block still wins over it. Transports are the other way round:
which ones a given launch serves is a property of *that invocation* — `wing-mcp-server --stdio` on
the command line is a client asking for stdio right now, and a line in a config file must not
silently override that.

The startup banner tells you what is actually in force:

```
wing-mcp-server listening on port 8787
Hardening: origin checks, rate limit 30/60s, token hidden from logs
```

## What `data/config.json` looks like

```json
{
  "version": 1,
  "server": {
    "authToken": "…",
    "publicUrl": "https://wing.example.com",
    "transports": { "http": true, "stdio": false },
    "security": {
      "allowedOrigins": ["https://wing.example.com"],
      "allowedHosts": ["wing.example.com"],
      "bindHost": "127.0.0.1",
      "rateLimit": { "max": 30, "windowMs": 60000 },
      "trustProxy": 1,
      "quietToken": true
    },
    "tools": {
      "profile": "core",
      "enable": ["wing_meter_stats"],
      "disable": ["lighting"]
    },
    "oauthClients": { "…": {} },
    "passkeys": {}
  },
  "plugins": {
    "wing": {
      "host": "192.168.1.50",
      "oscPort": 2223,
      "discoveryPort": 2222,
      "meterTcpPort": 2222,
      "meterUdpPort": 14135,
      "warmCacheOnConnect": true,
      "oscMirrorEnabled": false,
      "oscMirrorHost": "",
      "oscMirrorPort": 0,
      "showMode": false,
      "boxMap": {}
    }
  }
}
```

### `server`

| Key | Default | Notes |
| --- | --- | --- |
| `authToken` | generated | 192 bits of randomness on first boot if you do not supply one. This is the master credential. |
| `publicUrl` | `http://localhost:<PORT>` | The OAuth issuer **and** the WebAuthn relying-party origin. See [remote-access.md](remote-access.md). |
| `oauthClients` | `{}` | Dynamically-registered MCP clients, kept so a restart does not disconnect them. Contains client secrets. |
| `passkeys` | absent | Registered passkeys and the web sessions they opened. Session tokens are stored hashed, not in the clear. |
| `security` | absent | See below. Absent means none of it is applied. |
| `transports` | absent | See [`server.transports`](#servertransports) below. Nothing in this server writes it — absent, or editing it by hand, is the only way it is ever set. |
| `tools` | absent | See below. Absent means every tool is advertised — today's behaviour. |

### `server.security`

Every field is optional, and **absent means the server behaves exactly as it did before this block
existed**. Nothing here is imposed on a LAN install, because a wrong origin allowlist locks you out
of your own console.

| Key | Env | Effect when absent |
| --- | --- | --- |
| `allowedOrigins` | `MCP_ALLOWED_ORIGINS` (comma-separated) | No `Origin` check on `/mcp`. |
| `allowedHosts` | `MCP_ALLOWED_HOSTS` | No `Host` check on `/mcp`. |
| `bindHost` | `MCP_BIND_HOST` | Listens on every interface. **Leave it unset under Docker** — binding `127.0.0.1` inside a container makes the server unreachable from the host. |
| `rateLimit` | `MCP_RATE_LIMIT_MAX`, `MCP_RATE_LIMIT_WINDOW_MS` | No limit on failed authentication. Only failures are counted, so a working dashboard is never throttled. |
| `trustProxy` | `MCP_TRUST_PROXY` | `req.ip` is the socket address. Required with `rateLimit` behind a proxy — see [remote-access.md](remote-access.md). |
| `quietToken` | `MCP_QUIET_TOKEN` | The startup banner prints the dashboard URL with the token in it. |

Two hardening measures are **not** configurable, because neither can lock anyone out: the server
always refuses to be framed (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), and it always
writes `data/config.json` as `0600` inside a `0700` directory.

### `server.transports`

Which transports this server answers MCP on. Both fields are plain booleans, and each is resolved
on its own — a stored `{"stdio": true}` does not also decide `http`, so it can never silently
override a `--no-http` given alongside it on the command line.

| Key | Env | Default |
| --- | --- | --- |
| `http` | `MCP_HTTP_ENABLED` | `true` — the dashboard, the REST API and `/mcp`. |
| `stdio` | `MCP_STDIO_ENABLED` | `false` — MCP over stdin/stdout, for a client that spawns this process itself. |

Unlike every other block on this page, **the environment wins over this one**, not the reverse —
see the table in [The trap](#the-trap-environment-variables-are-not-overrides) above. Nothing in
this server ever writes `server.transports`: there is no dashboard control and no first-boot seed
for it, only the `--stdio`/`--no-http` flags (or their env vars) for a single launch, and hand-
editing this file for a standing default. Both transports resolving to `false` — env, file, and
defaults all agreeing on nothing — refuses to start, with a message naming both flags.

### `server.tools`

Every tool the server registers is sent to any connected MCP client on every `tools/list` —
descriptions, parameter schemas and all. On a full install that is **~102 KiB, roughly 26,000
tokens**, before a client has called anything. This block lets you cut that down to what a given
deployment actually needs, without touching what's registered — nothing here changes what a tool
*does*, only whether it's advertised and callable at all. **Absent means every tool is exposed**,
exactly as before this block existed.

The easiest way to change it is the dashboard's **Tools** page, which shows the same numbers this
section describes and writes this block for you. To edit by hand:

```json
"tools": {
  "profile": "core",
  "enable": ["wing_meter_stats"],
  "disable": ["lighting"]
}
```

- `profile` picks a named, plugin-declared starting point. The WING plugin ships four: `all`
  (every group — the default), `core` (the families a live show actually touches day to day —
  channels, buses, DCAs, scenes, sends, fades, names, history/undo/status, the generic escape hatch —
  48 tools instead of 134), `safe` (every tool that only reads — no fader move, scene recall or any other write is
  possible — for a client you don't want touching the console at all), and `none` (nothing, as a
  blank slate for `enable`). `safe` is computed from each tool's own read/write nature rather than
  picking whole groups, since almost every group mixes a read tool with the write it pairs with.
  An unrecognized profile id is reported (see `unknown` below) and treated as `all` — fail open,
  the same way a malformed `security` block falls back to the environment instead of taking the
  config file down.
- `enable` / `disable` are lists where **each entry is either a group id or an exact tool name** —
  the two never collide, since every tool name starts with `wing_` and no group id does. They
  override the profile, group-level entries first, then tool-level ones override those; `disable`
  wins over `enable` at the same level. There is **no wildcard** — a group or tool added later is
  unaffected by an existing `enable`/`disable` list, on purpose, so upgrading never silently hides
  (or exposes) something new.
- A name that matches neither a known group nor a known tool is never an error: it's ignored and
  reported back under `unknown` in the dashboard and in `GET`/`PUT /api/tools`'s response, in case
  it's a typo or a tool renamed by an upgrade.
- The group ids and tool names themselves aren't hand-documented here, because that list would
  drift the moment a tool is added or renamed — the dashboard's Tools page and `GET /api/tools`
  are the authoritative, always-current list, each with its measured byte and token cost.

| Env | Effect when absent |
| --- | --- |
| `MCP_TOOL_PROFILE` | No profile override — `all` unless a persisted block says otherwise. |
| `MCP_TOOLS_ENABLE`, `MCP_TOOLS_DISABLE` (comma-separated) | No overrides. |

Same rule as the hardening block above: these are **re-read on every boot, never persisted**, and
a stored `server.tools` block wins over them outright rather than merging with them.

Hiding a tool hides it from `tools/list` **and** refuses `tools/call` for it — a client that still
tries gets a clear "disabled" result, not a silent failure. It has no effect whatsoever on the
dashboard or the `/api/plugins/*` routes, so there is no way to lock yourself out of your own
console by hiding too much. Changes reach every connected MCP client immediately, via a single
`notifications/tools/list_changed` per session; a client that ignores that notification picks up
the change the next time it connects, since every new session is built from the same persisted
choice.

### `plugins.wing`

Seeded from `WING_*` on first boot, editable from the dashboard's Config tab afterwards.

| Key | Env | Default | Notes |
| --- | --- | --- | --- |
| `host` | `WING_HOST` | `""` | Empty is valid: the server boots and simply does not connect until you set it. |
| `oscPort` | `WING_OSC_PORT` | `2223` | OSC control, UDP. |
| `discoveryPort` | `WING_DISCOVERY_PORT` | `2222` | `WING?` broadcast, UDP. |
| `meterTcpPort` | `WING_METER_TCP_PORT` | `2222` | Metering subscription, TCP. |
| `meterUdpPort` | `WING_METER_UDP_PORT` | `14135` | Where the console pushes meter frames. Announced to the console by number, so under Docker the host and container sides must match. |
| `warmCacheOnConnect` | — | `true` | Pre-reads console state on connect. |
| `oscMirrorEnabled` / `oscMirrorHost` / `oscMirrorPort` | `WING_OSC_MIRROR_*` | off | Forwards every OSC message and meter packet verbatim to another host. |
| `showMode` | `WING_SHOW_MODE` | `false` | Refuses any audible write — from any tool: faders, mutes, sends, patch, processing, scene recall... anything but name, color, icon, LED, tags, `clink` — unless the call passes `confirm: true`. For running a show. |
| `boxMap` | — | `{}` | Which stage box sits on which port range, e.g. `{"A": [{"range": [9, 16], "device": "DL8-2", "model": "Midas DL8"}]}`. Labels patch listings and exports ("AES50-A 11 = DL8-2 port 3"). Set it with the `wing_set_box_map` tool; not shown in the Config tab form. |

All four port fields are validated as integers in 1–65535; enabling the mirror requires a host and
a valid port.

## Secrets

`data/config.json` holds the master auth token, the client secret of every registered OAuth client,
and the passkey state. Anyone who can read it can drive the console.

The server creates it `0600` in a `0700` directory, with the mode applied at creation rather than
afterwards, so the contents are never briefly world-readable. A file written by an older version is
tightened on load. Check it:

```bash
stat -c %a data/config.json    # 600
```

Presets and mic calibrations (`data/presets/`, `data/mic-calibrations/`) contain no credentials and
are left at the usual permissions.

## Changing a persisted value

Because the file wins over the environment, changing `WING_HOST`, `MCP_AUTH_TOKEN` or `PUBLIC_URL`
after the first run means changing the file — or, for the console settings, using the dashboard,
which is the intended route.

To edit by hand:

```bash
# stop the server first: it writes the whole file atomically, so a concurrent edit is lost
systemctl --user stop wing-mcp-server     # or: docker compose stop
$EDITOR data/config.json
systemctl --user start wing-mcp-server
```

To rotate the auth token, delete `server.authToken` and restart: a new one is generated and
printed. Every client holding the old token, and every OAuth client that completed the flow, will
need the new one — the OAuth flow hands out this same token, and there is no separate revocation.

To start over completely, stop the server and delete `data/config.json`. You lose the token, the
registered OAuth clients and any passkeys; presets and calibrations are separate files and survive.

## If the file is corrupt

On startup, a `data/config.json` that is not valid JSON, or whose shape is wrong, is **renamed to
`config.json.corrupt-<timestamp>` and replaced with defaults**.

The server keeps running, which is the point — but note what that costs you: a new auth token is
generated, so **every client's stored credential stops working**, registered OAuth clients are
forgotten, and passkeys are gone. If clients suddenly cannot authenticate after a restart, look for
a `.corrupt-` file next to the config before looking anywhere else.

A malformed `server.security` or `server.tools` block is handled more gently: it is reported on
stderr and skipped, falling back to the environment, rather than taking the whole file down with
it.

## Where the files live

| | Default | Env |
| --- | --- | --- |
| Config | `./data/config.json` | `MCP_CONFIG_PATH` |
| Presets | `./data/presets` | `WING_PRESETS_DIR` |
| Mic calibrations | `./data/mic-calibrations` | `WING_MIC_CALIBRATIONS_DIR` |

These are **relative to the working directory**, not to the install location. Running the server
from a different directory gives you a different, empty config — under systemd, set
`WorkingDirectory=` or use absolute paths. The Docker image uses `/app/data` throughout, which is
the declared volume.
