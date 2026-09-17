# Running the server from npm

The package publishes to **GitHub Packages** as `@bawaaaaah/wing-mcp-server`. It ships the compiled
server, the compiled dashboard and a `wing-mcp-server` binary — nothing is built on your machine at
install time.

Prefer a container? See [install-docker.md](./install-docker.md).

- [Requirements](#requirements)
- [Authenticating to GitHub Packages](#authenticating-to-github-packages)
- [Installing](#installing)
- [First run](#first-run)
- [Configuration](#configuration)
- [Example configurations](#example-configurations)
- [Connecting an MCP client](#connecting-an-mcp-client)
- [Updating and removing](#updating-and-removing)
- [Troubleshooting](#troubleshooting)

## Requirements

- Node.js **22 or newer** (`node --version`).
- A WING, WING Rack or WING Compact reachable over the network.

## Authenticating to GitHub Packages

Unlike npmjs.com, the GitHub Packages npm registry requires a token for **reads as well as
writes**. Create a [personal access token](https://github.com/settings/tokens) (classic) with the
`read:packages` scope, then tell npm to use it for this scope only:

```ini
# ~/.npmrc
@bawaaaaah:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_your_token_here
```

Scoping the registry line to `@bawaaaaah:` matters — a bare `registry=` would send *every* package
you install to GitHub Packages, where most of them do not exist.

To keep the token out of the file, npm expands environment variables in `.npmrc`:

```ini
# ~/.npmrc
@bawaaaaah:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Verify it works:

```bash
npm view @bawaaaaah/wing-mcp-server version
```

## Installing

Globally, which puts `wing-mcp-server` on your `PATH`:

```bash
npm install -g @bawaaaaah/wing-mcp-server
```

Or without installing anything permanently:

```bash
npx @bawaaaaah/wing-mcp-server --help
```

Or pinned inside a directory of your own, which is the tidiest option for a machine that runs it as
a service — the version is then recorded in a lockfile you control:

```bash
mkdir -p ~/wing-mcp && cd ~/wing-mcp
npm init -y
npm install @bawaaaaah/wing-mcp-server
npx wing-mcp-server
```

## First run

```bash
wing-mcp-server
```

```
wing-mcp-server listening on port 8787
Dashboard: http://localhost:8787/#token=Xq7…
MCP endpoint: http://localhost:8787/mcp (paste the token above directly, or let an OAuth-capable
client discover the flow automatically)
```

If you did not set `MCP_AUTH_TOKEN`, the server generates one on first boot and saves it, so the URL
it prints keeps working across restarts. Open the dashboard link, go to **Wing → Config** and set
the console's IP address — or set `WING_HOST` up front, as below.

The server starts even with no console configured and reports `status: ERROR` on `/health` until it
has one. That is deliberate: the dashboard is how you configure it.

## Configuration

Everything is configured through environment variables. A few have shorthand flags:

```
wing-mcp-server [options]

  -h, --help              Show help and exit.
  -v, --version           Print the version and exit.
      --env <path>        Read variables from <path> (repeatable). Defaults to ./.env if present.
      --port <port>       PORT
      --wing-host <host>  WING_HOST
      --config <path>     MCP_CONFIG_PATH
      --public-url <url>  PUBLIC_URL
```

**Precedence**, highest first: command-line flag → real environment variable → `--env` file. A
variable already set in the environment is never overwritten by an env file.

There is no `--token` flag on purpose: a secret passed on the command line shows up in `ps` output
for every user on the machine. Use `MCP_AUTH_TOKEN` in the environment or an env file.

> The flag is `--env`, not `--env-file`. Node reserves `--env-file` for itself and consumes it
> before the process starts, so it never reaches the CLI's own parser.

### Variables

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | Port for the dashboard, the REST API and `/mcp`. |
| `MCP_AUTH_TOKEN` | generated | Bearer token for every authenticated route. Persisted on first use. |
| `MCP_CONFIG_PATH` | `./data/config.json` | Where server state is persisted (token, public URL, console settings, passkeys). |
| `MCP_DASHBOARD_DIST` | *(auto)* | Where the compiled dashboard lives. Leave unset — it is found relative to the installed package. |
| `PUBLIC_URL` | `http://localhost:$PORT` | Externally-reachable base URL. Also the OAuth issuer. Persisted on first use. |
| `WING_HOST` | *(empty)* | Console IP or hostname. |
| `WING_OSC_PORT` | `2223` | OSC control port on the console. |
| `WING_DISCOVERY_PORT` | `2222` | UDP port used to broadcast for consoles. |
| `WING_METER_TCP_PORT` | `2222` | Console port the metering stream is requested on. |
| `WING_METER_UDP_PORT` | `14135` | **Local** port the console pushes meter frames to. |
| `WING_PRESETS_DIR` | `./data/presets` | Saved node-tree presets. |
| `WING_MIC_CALIBRATIONS_DIR` | `./data/mic-calibrations` | Measurement-mic calibration curves used by auto-EQ. |
| `WING_OSC_MIRROR_ENABLED` | `false` | Mirror raw OSC traffic to a second host. |
| `WING_OSC_MIRROR_HOST` | *(empty)* | Mirror target host. Required when the mirror is on. |
| `WING_OSC_MIRROR_PORT` | *(empty)* | Mirror target port. Required when the mirror is on. |

### Where the console settings actually come from

The `WING_*` variables **seed `config.json` on the very first boot only**. After that the config
file is the source of truth and the dashboard's *Wing → Config* tab is how you change things —
editing the environment will appear to do nothing. Delete `config.json` (or point
`MCP_CONFIG_PATH` somewhere new) to start over.

`MCP_AUTH_TOKEN` and `PUBLIC_URL` behave the same way: whatever was persisted first wins.

### Paths are relative to the working directory

`./data/...` means "relative to wherever you ran the command from", not to the installed package.
Run the server from a stable directory, or set absolute paths. This is the single most common
surprise with a global install.

## Example configurations

### Minimal — a laptop on the same LAN as the console

```ini
# ~/wing-mcp/.env
WING_HOST=192.168.1.50
MCP_AUTH_TOKEN=pick-a-long-random-string
```

```bash
cd ~/wing-mcp && wing-mcp-server
```

### A fixed install with absolute paths

```ini
# /etc/wing-mcp/wing-mcp.env
PORT=8787
MCP_AUTH_TOKEN=pick-a-long-random-string
MCP_CONFIG_PATH=/var/lib/wing-mcp/config.json
WING_PRESETS_DIR=/var/lib/wing-mcp/presets
WING_MIC_CALIBRATIONS_DIR=/var/lib/wing-mcp/mic-calibrations

WING_HOST=192.168.1.50
WING_METER_UDP_PORT=14135
```

```bash
wing-mcp-server --env /etc/wing-mcp/wing-mcp.env
```

### Reachable from the internet, for a remote MCP client

Put a reverse proxy in front with a real certificate and tell the server its public name, otherwise
the OAuth metadata it advertises will point at `localhost` and no remote client can finish the flow.

```ini
# /etc/wing-mcp/wing-mcp.env
PORT=8787
PUBLIC_URL=https://wing.example.com
MCP_CONFIG_PATH=/var/lib/wing-mcp/config.json
WING_HOST=192.168.1.50
```

`PUBLIC_URL` is persisted on first use, so changing the hostname later means editing
`config.json` (or removing it), not just the environment.

### With the OSC mirror on, for a second control system

```ini
WING_HOST=192.168.1.50
WING_OSC_MIRROR_ENABLED=true
WING_OSC_MIRROR_HOST=192.168.1.77
WING_OSC_MIRROR_PORT=9000
```

### systemd unit

```ini
# /etc/systemd/system/wing-mcp.service
[Unit]
Description=wing-mcp-server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wing
Group=wing
WorkingDirectory=/var/lib/wing-mcp
EnvironmentFile=/etc/wing-mcp/wing-mcp.env
ExecStart=/usr/bin/wing-mcp-server
Restart=on-failure
RestartSec=5

# The server only ever writes under its data directory.
StateDirectory=wing-mcp
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/var/lib/wing-mcp

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/wing-mcp wing
sudo install -d -o wing -g wing /var/lib/wing-mcp
sudo chmod 640 /etc/wing-mcp/wing-mcp.env && sudo chown root:wing /etc/wing-mcp/wing-mcp.env
sudo systemctl enable --now wing-mcp
journalctl -u wing-mcp -f
```

`ExecStart` needs the real path — `command -v wing-mcp-server`. With a directory-local install it is
`/var/lib/wing-mcp/node_modules/.bin/wing-mcp-server`.

### launchd (macOS)

```xml
<!-- ~/Library/LaunchAgents/com.example.wing-mcp.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.wing-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/wing-mcp-server</string>
    <string>--env</string>
    <string>/Users/you/wing-mcp/.env</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/wing-mcp</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/wing-mcp/server.log</string>
  <key>StandardErrorPath</key><string>/Users/you/wing-mcp/server.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.example.wing-mcp.plist
```

## Connecting an MCP client

The server speaks **Streamable HTTP** at `/mcp` — not stdio. Authenticate either by presenting the
bearer token directly, or by letting an OAuth-capable client discover the authorization flow.

### Claude Code

```bash
claude mcp add --transport http wing http://192.168.1.10:8787/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

### A client that only speaks stdio

Bridge it with `mcp-remote`:

```json
{
  "mcpServers": {
    "wing": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://192.168.1.10:8787/mcp",
        "--header", "Authorization: Bearer ${WING_MCP_TOKEN}"
      ],
      "env": { "WING_MCP_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

### A remote connector over the internet

Point the client at `https://wing.example.com/mcp` and let it run the OAuth flow. This needs
`PUBLIC_URL` set to that same HTTPS origin — see the reverse-proxy example above.

## Updating and removing

```bash
npm update -g @bawaaaaah/wing-mcp-server     # or: npm install -g @bawaaaaah/wing-mcp-server@0.2.0
npm uninstall -g @bawaaaaah/wing-mcp-server
```

Your data directory is untouched by either. Removing it (`config.json`, `presets/`,
`mic-calibrations/`) is what resets the server, including its auth token and registered passkeys.

## Troubleshooting

**`npm ERR! 401 Unauthorized` on install** — the `read:packages` token is missing, expired, or the
`@bawaaaaah:registry` line is not in the `.npmrc` npm is reading. `npm config get @bawaaaaah:registry`
tells you which value is in effect.

**`Unsupported engine`** — Node is older than 22.

**`EADDRINUSE`** — something else holds `PORT`, or a previous instance is still running.

**401 on `/mcp` or the dashboard** — the token in the URL fragment is stale. The live one is in
`config.json` under the server's auth token, and the startup banner prints it.

**The console never connects** — check `WING_HOST` in the dashboard rather than in your environment
(it only seeds the first boot), and confirm the desk answers on `WING_OSC_PORT`.

**Meters stay flat but control works** — meter frames arrive as UDP on `WING_METER_UDP_PORT`
(14135). A host firewall blocking inbound UDP on that port is the usual cause.

**No consoles found by discovery** — discovery is a UDP broadcast to `255.255.255.255:2222`. It
does not cross subnets or VPNs, and many Wi-Fi networks drop it. Set the IP by hand instead.
