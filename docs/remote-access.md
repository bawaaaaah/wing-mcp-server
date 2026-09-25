# Reaching the server from outside your LAN

The console has to stay on the network it is plugged into. Your AI client usually is not on that
network: a hosted assistant runs in somebody else's datacentre, and even a desktop one follows you
onto other Wi-Fi. This page is about bridging that gap — and about not handing your console to the
internet while you do it.

It is the reason the OAuth flow in this server exists at all.

## What has to be true for a client to connect

The server speaks **MCP over Streamable HTTP at `/mcp`**, and authenticates in two ways:

- a **bearer token**, sent as `Authorization: Bearer <token>`; and
- an **OAuth 2.1 authorization-code flow** with PKCE and dynamic client registration, for clients
  that will not let you paste a token.

So the question is never "does this server support vendor X". It is "does vendor X's client
support a remote MCP server over Streamable HTTP, and can you give it a URL it can reach". Claude,
OpenAI, Mistral, Grok, Qwen and others have all shipped some form of MCP support, but what each one
accepts — remote or local only, OAuth or a pasted token, which transport — differs between products
from the same vendor and changes release to release. **Check your client's own current
documentation for how it adds a remote MCP server**; this page deliberately does not keep a
compatibility table it cannot keep honest.

Whatever the client, it needs:

1. a URL that reaches this server, over **HTTPS** (browsers and most clients refuse otherwise);
2. `PUBLIC_URL` set to that same origin, because it is the OAuth issuer — get this wrong and
   discovery fails with metadata pointing somewhere the client cannot reach;
3. the auth token, or a completed OAuth approval.

## Pick your exposure by one question: is the URL stable?

This matters more than which product you choose, because two things in this server are pinned to
that URL.

`PUBLIC_URL` is **persisted on first use** (see `docs/configuration.md`) — it is not re-read from
the environment on every boot. And it is also the **WebAuthn relying-party origin**, which is not a
policy this server chose: a passkey is bound to its origin by the authenticator itself.

So with a URL that changes on every restart:

- the OAuth issuer no longer matches, and clients fail discovery until you update it;
- **passkeys registered against the old hostname stop working, permanently.** The approval page
  simply stops offering the button. Nothing can recover them; they have to be re-registered.

**On an ephemeral URL, authenticate with the token, not with passkeys.** That is the whole
workaround, and it is a fine one.

| | URL | TLS terminated by | Self-hostable | Notes |
| --- | --- | --- | --- | --- |
| **Reverse proxy + your own domain** | stable | your proxy, your certificate | yes | Most work to set up, least to live with. Worked examples in [install-docker.md](install-docker.md) (Caddy) and [install-npm.md](install-npm.md). |
| **Cloudflare Tunnel** | stable with a named tunnel on your domain; random with a quick tunnel | Cloudflare | the connector, not the edge | No inbound port open on your network. |
| **ngrok** | stable only with a reserved domain on a paid plan | ngrok | no | The `ngrok` npm package is a wrapper; the tool itself is a standalone binary. |
| **Tunnelmole** | random by default; fixed subdomains are a paid feature, and the server is open source if you run your own | the tunnel service, or you | yes | `npx tunnelmole 8787` (also installs as `tmole`). |

Plans and what each tier unlocks change often enough that pinning numbers here would just age
badly — check each service's pricing page.

### The quickest thing that works

```bash
npx tunnelmole 8787
```

It prints an HTTPS URL. Then point the server at it and restart:

```bash
PUBLIC_URL=https://<the-url-it-printed> wing-mcp-server
```

Because that URL is persisted on first use, changing it later means editing `data/config.json` —
see [configuration.md](configuration.md#changing-a-persisted-value).

## If it is reachable from the internet, turn the hardening on

None of this is on by default, because a misconfigured origin allowlist locks you out of your own
console and most installs never leave the LAN. Once the server is publicly reachable, that
calculation changes: the bearer token becomes guessable from anywhere, at any rate, and what it
grants is total. There is no partial compromise here — the token an OAuth exchange hands out is the
same permanent master token, it does not expire, and revoking it means editing `data/config.json`
by hand.

Minimum for a public deployment, in `data/config.json`:

```json
{
  "server": {
    "security": {
      "allowedOrigins": ["https://wing.example.com"],
      "allowedHosts": ["wing.example.com"],
      "rateLimit": { "max": 30, "windowMs": 60000 },
      "trustProxy": 1
    }
  }
}
```

Or, as environment variables — these are re-read on every boot, unlike `PUBLIC_URL`:

```bash
MCP_ALLOWED_ORIGINS=https://wing.example.com
MCP_ALLOWED_HOSTS=wing.example.com
MCP_RATE_LIMIT_MAX=30
MCP_TRUST_PROXY=1
```

**`trustProxy` is not optional here.** Behind a proxy or tunnel, every request arrives from the
proxy's address, so without it all clients share one rate-limit bucket and a single attacker
exhausting it locks *you* out too — the limiter becomes the denial of service it exists to prevent.
Set it to the number of proxies in front of the server (`1` for a single one). Prefer the number
over `true`: `true` trusts the whole `X-Forwarded-For` chain, which lets any client forge its
apparent address and skip the limit entirely.

The server prints what is actually switched on at startup, so you can check rather than assume:

```
Hardening: origin checks, rate limit 30/60s
```

## What the people running the tunnel can see

With a hosted tunnel, TLS is terminated by the provider. Your bearer token is in a header of every
request, in the clear, on their infrastructure. This is the normal trade-off for these services
rather than a scandal — but it is the argument for the self-hostable options, and for a reverse
proxy with your own certificate if the console is doing anything you would mind a third party
being able to drive.

Also worth sizing honestly: anyone who reaches this server with the token can move faders, recall
scenes, and point the OSC mirror at an address of their choosing. On a show, that is not a data
breach, it is the PA.

## Checklist

- [ ] HTTPS, not plain HTTP.
- [ ] `PUBLIC_URL` matches the externally visible origin exactly, scheme and all.
- [ ] `allowedOrigins` / `allowedHosts` set to that origin.
- [ ] `rateLimit` set, and `trustProxy` set to the number of proxies in front.
- [ ] `quietToken` not set to `false` — the default keeps the master token out of `docker logs`
      and the journal (`--print-token` reads it when you need it).
- [ ] `data/config.json` is `0600` — the server enforces this now, `stat -c %a data/config.json`
      to confirm.
- [ ] You know how to rotate the token (stop the server, edit `data/config.json`, restart) before
      you need to.
