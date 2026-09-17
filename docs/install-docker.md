# Running the server in Docker

Images are published to the **GitHub Container Registry** as
`ghcr.io/bawaaaaah/wing-mcp-server`, for `linux/amd64` and `linux/arm64` (so a Raspberry Pi 4/5 on
the stage network works as well as a server).

Prefer running it directly on the host? See [install-npm.md](./install-npm.md).

- [Tags](#tags)
- [Networking: read this first](#networking-read-this-first)
- [Quick start](#quick-start)
- [Docker Compose](#docker-compose)
- [Configuration](#configuration)
- [Persistent data](#persistent-data)
- [Example configurations](#example-configurations)
- [Connecting an MCP client](#connecting-an-mcp-client)
- [Operating the container](#operating-the-container)
- [Building the image yourself](#building-the-image-yourself)
- [Troubleshooting](#troubleshooting)

## Tags

| Tag | What it points at |
| --- | --- |
| `latest` | The most recent release. |
| `0.1.0`, `0.1`, `0` | A specific release and its moving minor/major aliases. |
| `edge` | The tip of `main`. Unreleased. |
| `sha-abc1234` | One exact commit. |

Pin a version for anything you care about; `latest` and `edge` move under you.

```bash
docker pull ghcr.io/bawaaaaah/wing-mcp-server:latest
```

A GHCR package is **private when it is first created**, even from a public repository. After the
very first release, open
[the package settings](https://github.com/users/bawaaaaah/packages/container/wing-mcp-server/settings)
and set the visibility to public — otherwise everyone pulling it, including you on another machine,
needs to log in first:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

The token is a [personal access token](https://github.com/settings/tokens) with `read:packages`.

## Networking: read this first

This server does not just make outbound connections to the console — the console pushes data
*back*, and one feature relies on broadcast. That makes the network mode the most consequential
choice you make here.

| Flow | Socket | Direction | Publish it? |
| --- | --- | --- | --- |
| Dashboard, REST API, `/mcp` | binds `8787/tcp` | inbound | **Yes** |
| Metering stream | binds `14135/udp` | console → server | **Yes** |
| Metering subscription | connects to console `2222/tcp` | outbound | No |
| OSC control | sends to console `2223/udp` from an ephemeral source port | outbound | No |
| Console discovery | broadcasts to `255.255.255.255:2222/udp` | outbound | No — and see below |
| OSC mirror (off by default) | sends to whatever target you configure | outbound | No |

The outbound flows need nothing published. The console answers on the source port of the request it
received, so the NAT mapping created by the outgoing packet carries the reply back — and that
mapping never gets a chance to expire, because the OSC client renews its subscription every 4
seconds and heartbeats every 7, both well inside the 30-second conntrack UDP timeout.

Two consequences are worth spelling out.

**Discovery cannot work on a bridge network**, whatever you publish: a broadcast does not leave the
bridge. Use host networking, or set the console's IP by hand — which on a fixed install you would
do anyway.

**The metering port is announced to the console by number**, over the TCP subscription. The console
then sends its frames to that number at the address it saw the TCP connection come from. So the
host side and the container side of the mapping have to be the *same number* — `-p
15000:14135/udp` would tell the console to send to 14135 while the host listens on 15000, and the
meters would simply never arrive. Change `WING_METER_UDP_PORT` and both sides together, as in the
example further down.

### Choosing a mode

| | NAT (published ports) | Host network |
| --- | --- | --- |
| Works on | everywhere Docker runs | Linux only |
| Console discovery | **no** | yes |
| Port isolation from the host | yes | none — `PORT` competes with every other host service |
| Console sees the server as | the host's address, shared by every container on it | the host's address |
| Setup | publish two ports, symmetric UDP | nothing to map |

**Use host networking on a dedicated Linux box.** It is simpler and it is the only way discovery
works. **Use NAT everywhere else**, and set the console's IP by hand — which on a fixed install you
would do anyway.

**Docker Desktop on macOS and Windows** runs containers inside a VM, so neither broadcast discovery
nor inbound UDP from the console works reliably, and `network_mode: host` does not give you the
Mac's or PC's network either. On those platforms, prefer the [npm install](./install-npm.md).

### What NAT actually costs you

Worth knowing before you spend an evening on it, roughly in order of how likely you are to hit it:

1. **Discovery stops working, silently.** The "find consoles on the network" button returns an
   empty list rather than an error, because zero replies to a broadcast is a legitimate outcome
   (quite common on Wi-Fi). Nothing you publish changes this: the broadcast never leaves the
   bridge. Type the IP in.

2. **An asymmetric metering mapping loses every frame, silently.** The server tells the console
   which UDP port to send to, by number, over the TCP subscription. `-p 15000:14135/udp` therefore
   announces 14135 while the host listens on 15000. Control still works perfectly, so it looks
   like a metering bug rather than a mapping one. Keep both sides identical.

3. **The console sees the Docker host, not the container.** Every WING client on that host is
   indistinguishable from the desk's point of view — the same source address in its connection
   list, and the same address for any console-side filtering. The console's connection budget is
   small (the manufacturer's own spec says 24 in one place and 16 in another; this project assumes
   16), so several containers on one host eat into it without being individually identifiable.

4. **The OSC reply path is a NAT mapping, not a connection.** UDP carries no state of its own, so
   replies only come back while the host's conntrack entry survives. Here it always does, but note
   *why*: the console itself drops a subscription that goes quiet for 10 seconds, so the client
   renews every 4s and heartbeats every 7s to satisfy the console — and keeping the NAT mapping
   inside its 30s timeout is a side effect of that, not something anyone designed for. The
   practical consequence is that on a busy host a full conntrack table
   (`nf_conntrack: table full, dropping packet` in `dmesg`) silently drops console traffic that a
   host-mode container would never have lost.

5. **Meter frames take an extra hop.** They arrive at a high rate and every one crosses the NAT
   path instead of landing directly on the interface. On a normal LAN this is not something you
   will see; it is a reason not to choose NAT for a machine that is already saturated.

6. **The published UDP port is open on every host interface.** `-p 14135:14135/udp` binds
   `0.0.0.0`. Scope it if the host has a leg on an untrusted network: `-p 192.168.1.10:14135:14135/udp`.

What NAT buys you in exchange is real: isolation, portability, and the ability to run the dashboard
on a host port that is already taken by something else.

## Quick start

```bash
docker run -d --name wing-mcp \
  -p 8787:8787 \
  -p 14135:14135/udp \
  -v wing-mcp-data:/app/data \
  -e WING_HOST=192.168.1.50 \
  -e MCP_AUTH_TOKEN=pick-a-long-random-string \
  --restart unless-stopped \
  ghcr.io/bawaaaaah/wing-mcp-server:latest
```

Then open `http://<docker-host>:8787/#token=pick-a-long-random-string`.

If you leave `MCP_AUTH_TOKEN` out, one is generated on first boot and printed:

```bash
docker logs wing-mcp
```

```
wing-mcp-server listening on port 8787
Dashboard: http://localhost:8787/#token=Xq7…
MCP endpoint: http://localhost:8787/mcp (paste the token above directly, or let an OAuth-capable
client discover the flow automatically)
```

Replace `localhost` in that URL with the Docker host's address.

## Docker Compose

Save this as `compose.yaml`. It pulls the published image, so there is nothing to build, and it
carries **both network modes as profiles** so you pick one at `up` time instead of editing the
file:

```yaml
x-wing-mcp-server: &wing-mcp-server
  image: ghcr.io/bawaaaaah/wing-mcp-server:0.1.0
  container_name: wing-mcp
  environment:
    WING_HOST: "192.168.1.50"
    MCP_AUTH_TOKEN: "pick-a-long-random-string"
  volumes:
    - wing-mcp-data:/app/data
  restart: unless-stopped

services:
  # Published ports on a user-defined bridge. Portable; no console discovery.
  wing-mcp-server:
    <<: *wing-mcp-server
    profiles: [nat]
    ports:
      - "8787:8787"
      # Announced to the console by number — both sides must be the same.
      - "14135:14135/udp"

  # The host's own network stack. Linux only; console discovery works.
  wing-mcp-server-host:
    <<: *wing-mcp-server
    profiles: [host]
    network_mode: host

volumes:
  wing-mcp-data:
```

```bash
docker compose --profile nat  up -d      # or --profile host
docker compose logs -f
```

Both services set `container_name: wing-mcp`, so `docker logs wing-mcp` works either way. They are
mutually exclusive, so the shared name can never collide.

**A profile is mandatory.** Both services carry one, which means a bare `docker compose up` selects
nothing and exits without starting anything and without an error. Either pass `--profile` every
time, or set a default in the project's `.env`:

```ini
# .env, next to compose.yaml
COMPOSE_PROFILES=nat
```

`--profile` on the command line overrides that variable rather than adding to it, so with the
default above `docker compose --profile host up -d` still starts host mode alone.

Neither service declares a healthcheck: the image ships one that reads `PORT` from the environment,
so it follows whichever mode is active instead of being pinned to one of them.

The repository's own `docker-compose.yaml` is a different thing — it **builds** the image from a
checkout — but it is laid out the same way, with the same two profiles.

## Configuration

The image is configured entirely through environment variables. The full table lives in
[install-npm.md](./install-npm.md#variables); what differs inside the container is only the
defaults, which are already pointed at the data volume:

| Variable | Value baked into the image |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `8787` |
| `MCP_CONFIG_PATH` | `/app/data/config.json` |
| `WING_PRESETS_DIR` | `/app/data/presets` |
| `WING_MIC_CALIBRATIONS_DIR` | `/app/data/mic-calibrations` |
| `MCP_DASHBOARD_DIST` | `/app/web/dist` |

Leave those alone unless you are mounting things elsewhere. The ones you will actually set are
`WING_HOST`, `MCP_AUTH_TOKEN` and — if the server is reachable from outside your LAN — `PUBLIC_URL`.

Remember that `WING_*` variables **seed the config file on first boot only**. After that, the
dashboard's *Wing → Config* tab is the way to change them; editing the environment and restarting
will look like it did nothing. Delete the volume to start clean.

### Using an env file

```bash
docker run -d --name wing-mcp \
  -p 8787:8787 -p 14135:14135/udp \
  -v wing-mcp-data:/app/data \
  --env-file ./wing.env \
  ghcr.io/bawaaaaah/wing-mcp-server:latest
```

```yaml
    env_file:
      - path: wing.env
        required: false
```

Docker's `--env-file` is a plain `KEY=value` list: no quoting, no `export`, no variable expansion.

## Persistent data

Everything mutable lives under `/app/data`, which the image declares as a volume:

```
/app/data/config.json          server token, public URL, console settings, registered passkeys
/app/data/presets/             saved node-tree presets
/app/data/mic-calibrations/    measurement-mic calibration curves for auto-EQ
```

Lose it and you lose your auth token, your passkeys and your presets. Back it up:

```bash
docker run --rm -v wing-mcp-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/wing-mcp-data.tar.gz -C /data .
```

A bind mount works too, but the container runs as the unprivileged `node` user (uid 1000), so the
host directory has to be writable by it:

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
docker run ... -v "$PWD/data:/app/data" ...
```

## Example configurations

### Moving the dashboard to another host port

The two modes want opposite things here, which is the one place the choice leaks into your config.

Under **NAT**, the container always listens on 8787 — remap it on the way out and leave `PORT`
alone:

```yaml
    ports:
      - "9090:8787"
      - "14135:14135/udp"
```

Under **host networking** there is no mapping to hide behind, so `PORT` is the port the dashboard
actually listens on:

```yaml
    environment:
      PORT: "9090"
```

`network_mode: host` ignores a `ports:` block entirely — Docker warns and carries on — so setting
both is not a way to hedge.

### Moving the metering port

If 14135 is taken, change it on both sides and in the container:

```yaml
    ports:
      - "8787:8787"
      - "15000:15000/udp"
    environment:
      WING_METER_UDP_PORT: "15000"
```

### Behind a reverse proxy, with OAuth for remote MCP clients

`PUBLIC_URL` must be the externally-visible HTTPS origin, or the OAuth metadata the server
advertises points at `localhost` and no remote client can complete the flow.

```yaml
services:
  wing-mcp-server:
    image: ghcr.io/bawaaaaah/wing-mcp-server:0.1.0
    expose:
      - "8787"
    ports:
      - "14135:14135/udp"
    environment:
      PUBLIC_URL: "https://wing.example.com"
      WING_HOST: "192.168.1.50"
    volumes:
      - wing-mcp-data:/app/data
    restart: unless-stopped
    networks: [web, default]

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
    restart: unless-stopped
    networks: [web]

volumes:
  wing-mcp-data:
  caddy-data:

networks:
  web:
```

```caddyfile
# Caddyfile
wing.example.com {
	reverse_proxy wing-mcp-server:8787
}
```

Caddy gets the certificate on its own. The dashboard uses server-sent events, which need response
buffering off — Caddy does the right thing by default; nginx needs
`proxy_buffering off;` and `proxy_read_timeout` raised on the proxied location.

`PUBLIC_URL` is also the WebAuthn relying-party origin, so passkeys registered against one hostname
stop working if you change it.

### Traefik labels, if that is your setup

```yaml
    labels:
      traefik.enable: "true"
      traefik.http.routers.wing.rule: "Host(`wing.example.com`)"
      traefik.http.routers.wing.entrypoints: "websecure"
      traefik.http.routers.wing.tls.certresolver: "le"
      traefik.http.services.wing.loadbalancer.server.port: "8787"
```

### Read-only root filesystem

The server writes only under `/app/data`, so the rest can be sealed:

```yaml
    read_only: true
    tmpfs:
      - /tmp
    volumes:
      - wing-mcp-data:/app/data
    security_opt:
      - no-new-privileges:true
```

## Connecting an MCP client

The MCP endpoint is `http://<docker-host>:8787/mcp`, Streamable HTTP. Everything in
[install-npm.md](./install-npm.md#connecting-an-mcp-client) applies unchanged — only the host in
the URL differs.

```bash
claude mcp add --transport http wing http://192.168.1.10:8787/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

## Operating the container

```bash
docker logs -f wing-mcp                                   # follow the logs
docker inspect --format '{{.State.Health.Status}}' wing-mcp   # healthcheck verdict
curl -s http://localhost:8787/health                      # aggregate status, no auth needed
docker compose --profile nat pull && docker compose --profile nat up -d   # update in place
```

The image has a built-in healthcheck that polls `/health` every 30s. It reports the HTTP layer
only: `/health` answers 200 even when no console is configured, and the JSON body carries the real
state (`HEALTHY`, `DEGRADED` or `ERROR`). A container marked healthy therefore means "the server is
up", not "the console is connected" — for that, read the body, or `/api/status` with a bearer
token for per-plugin detail.

## Building the image yourself

```bash
git clone https://github.com/bawaaaaah/wing-mcp-server.git
cd wing-mcp-server
docker build -t wing-mcp-server:local .
```

Or, from the repository's development compose file, which builds and runs in one step:

```bash
cp .env.sample .env      # set WING_HOST
docker compose --profile nat up -d --build     # or --profile host, on Linux
```

The Dockerfile is a three-stage build: `deps` resolves the production dependency tree, `builder`
compiles the TypeScript server and the Vite dashboard, and `runtime` copies just those outputs onto
a clean `node:24-alpine` base running as the unprivileged `node` user. The dashboard's React
dependencies are build-time only and never reach the runtime image.

Pick another Node base with a build argument:

```bash
docker build --build-arg NODE_VERSION=22-alpine -t wing-mcp-server:node22 .
```

Multi-architecture, the way CI does it:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t wing-mcp-server:local .
```

## Troubleshooting

**`docker compose up` prints nothing and starts nothing** — no profile is active. Both services in
the compose file carry one, by design, so that choosing a network mode is deliberate. Pass
`--profile nat` or `--profile host`, or set `COMPOSE_PROFILES` in the project's `.env`.
`docker compose --profile nat config --services` should print exactly one service name.

**The dashboard is unreachable from another machine** — you published to `127.0.0.1` (`-p
127.0.0.1:8787:8787`) or a host firewall is in the way. `docker port wing-mcp` shows what is
actually bound.

**Control works but meters stay flat** — the console cannot reach `14135/udp` on the container.
Confirm the port is published as UDP (`-p 14135:14135/udp`, not `-p 14135:14135`), that host and
container sides are the same number, and that nothing on the host firewall drops inbound UDP.

**Console discovery finds nothing** — expected on a bridge network: the broadcast cannot leave it.
Use `network_mode: host`, or set the IP by hand.

**Permission denied writing to `/app/data`** — a bind-mounted host directory not owned by uid 1000.
`sudo chown -R 1000:1000 ./data`.

**Settings changed in the environment have no effect** — `WING_*` variables only seed the first
boot. Change them in the dashboard, or `docker compose --profile nat down -v` to discard the
volume and reseed.

**Remote MCP clients cannot complete OAuth** — `PUBLIC_URL` is unset or does not match the origin
the client is actually reaching. It is persisted on first use, so fixing the environment alone is
not enough: edit `config.json` in the volume, or start from a fresh one.

**`denied` or `unauthorized` on `docker pull`** — log in to `ghcr.io` with a `read:packages` token,
or check the tag exists at
`https://github.com/bawaaaaah/wing-mcp-server/pkgs/container/wing-mcp-server`.
