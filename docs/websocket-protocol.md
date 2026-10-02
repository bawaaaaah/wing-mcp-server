# WebSocket protocol

The dashboard's live channel. One endpoint, `/api/ws`, and two **subprotocols**, each declaring
what a connection carries and what it may do. A client opens one connection per subprotocol it
needs — the dashboard keeps a control connection open and opens a stream connection only while
something on screen shows meters or the RTA.

This document is the contract; `src/core/ws-hub.ts` (transport), `src/core/ws-rest.ts` (REST over
WebSocket), `src/plugins/wing/wing-live-topics.ts` (WING topics) and `web/src/api/live-codec.ts`
(dashboard decoding) implement it.

## Opening a connection

1. Get a ticket with an authenticated request (the same bearer token, or passkey session, as any
   other API call):

   ```http
   POST /api/auth/ws-ticket
   Authorization: Bearer <token>
   ```

   ```json
   { "ticket": "…" }
   ```

   A ticket is single-use and expires 30 s after it is issued. The browser's `WebSocket` cannot
   set an `Authorization` header, and putting the real token in a URL would leak it into proxy
   logs and browser history — the ticket is what goes in the URL instead.

2. Open the socket with the ticket and **exactly one** subprotocol:

   ```js
   new WebSocket("wss://host/api/ws?ticket=" + ticket, "wing.control.v1.msgpack");
   ```

The upgrade is refused with an HTTP status, before any WebSocket frame:

| status | why |
|---|---|
| 400 | no subprotocol this server speaks was offered |
| 401 | missing, unknown, spent or expired ticket — or the credential that minted it is no longer valid |
| 403 | the `Origin` header is neither the request's own host, the configured public URL, nor in `security.allowedOrigins` |
| 404 | any path other than `/api/ws` |
| 503 | the server is shutting down, or already holds 64 connections |

The connection then lives as long as its credential: a passkey session revoked or expired while
the socket is open closes it with `4401`.

## Subprotocols

`wing.<channel>.v<version>.<codec>`

| subprotocol | channel | may | behaviour |
|---|---|---|---|
| `wing.control.v1.msgpack`, `wing.control.v1.json` | control | subscribe to **control** topics; send REST requests (`req`) | low-rate; a message is never dropped; events and replies keep their order |
| `wing.stream.v1.msgpack`, `wing.stream.v1.json` | stream | subscribe to **stream** topics — read only | high-rate; every frame supersedes the previous one, so frames are skipped while the client falls behind |

Why two connections: on one TCP connection, a reply or a one-shot event would queue behind meter
frames whenever the network slows (wifi, a tunnel). Separated, control stays responsive and only
the stream degrades — and a stalled stream is cut without touching the control connection.

### Codecs

The messages are the same in both codecs.

- **msgpack** — [MessagePack](https://msgpack.org), binary WebSocket frames. What the dashboard
  uses. Byte arrays are native `bin`.
- **json** — JSON, text frames, for debugging (`wscat`, the browser's network tab) and tests.
  Byte arrays are written `{"$b64": "<base64>"}`.

A frame that does not decode in the connection's codec — including a text frame on a msgpack
connection and vice versa — closes it with `4400`.

### Compression

`permessage-deflate` (RFC 7692) is offered and every browser negotiates it on its own. Messages
under 1 KiB are sent uncompressed; RTA frames never are compressed.

### Versioning

A breaking change to the envelope or to a topic's data is a new version, negotiated through the
subprotocol (`wing.control.v2.…`). The server may speak several versions side by side; a client
offering only versions the server no longer speaks is refused with `400`.

## Envelope

Every message is a map whose `t` says what it is. When a reply is expected the client sets `id` —
an integer it numbers itself, per connection — and the reply carries the same `id`.

| t | direction | fields |
|---|---|---|
| `hello` | server → client | `v` (protocol version), `channel`, `topics` (what this connection may subscribe to). Sent once, first. |
| `sub` | client → server | `id`, `topic`, `params?` |
| `unsub` | client → server | `id`, `topic` |
| `ack` | server → client | `id`, `topic`, `data?` (topic-specific, e.g. the meter column layout) |
| `evt` | server → client | `topic`, `ts` (ms since epoch, when the server published it), `data` |
| `req` | client → server | `id`, `method`, `path`, `query?`, `body?` — control only, see [REST over WebSocket](#rest-over-websocket) |
| `res` | server → client | `id`, `status`, `body` |
| `err` | server → client | `id?` (absent when the message it answers had none), `error`, `detail?` |

`sub` on a topic already subscribed replaces its params — that is how a client changes which strips
it watches, without a gap. `unsub` on a topic not subscribed is acknowledged all the same.

### Errors (`err.error`)

| error | meaning |
|---|---|
| `invalid-message` | the message decoded but is not a valid envelope; the connection stays open |
| `unknown-topic` | no such topic |
| `forbidden` | the topic exists but belongs to the other channel |
| `invalid-params` | the topic refused the `sub` params; `detail` says why |
| `too-many-subscriptions` | more than 64 topics on one connection |
| `busy` | 32 requests already in flight on this connection; the request was not run |
| `timeout` | a request got no response within 60 s; it may still have run |

### Close codes

| code | meaning |
|---|---|
| 1001 | the server is shutting down — reconnect with a fresh ticket |
| 1009 | a message over the channel's size limit (control 1 MiB, stream 16 KiB) |
| 1011 | an unexpected server error while handling a message |
| 4400 | a frame that does not decode |
| 4401 | the credential behind the connection is no longer valid — get a new token/session |
| 4429 | too many messages (control: 100/s sustained, burst 300; stream: 20/s, burst 50) |
| 1006 (seen by the client) | the server terminated the connection: no pong to its ping within 15–30 s, or a stream connection that stayed more than 256 KiB behind for 5 s |

The server pings every 15 s; browsers answer on their own.

## REST over WebSocket

On a control connection, any call of the dashboard's REST API can be sent as a `req` instead of
an HTTP request:

```json
{ "t": "req", "id": 12, "method": "POST", "path": "/api/plugins/wing/set", "body": { "path": "/ch/3/fdr", "value": -6 } }
```

```json
{ "t": "res", "id": 12, "status": 200, "body": { "…": "…" } }
```

The server replays it as a real HTTP request into its own listener, with the credential the
connection was opened with: it runs through the very same route, with the same authentication,
rate limit, validation, show-mode confirmation and write verification, and `status`/`body` are
what that route answered over HTTP (`body` is the parsed JSON, a string for a non-JSON response,
`null` when empty). A `401` means the credential is no longer valid.

- `method`: `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. `body`, when present, is sent as JSON.
- `path`: under `/api/`, percent-encoded like a URL path, without a query string — pass `query`
  (`{ "name": "value" | ["v1", "v2"] }`) instead. `/api/auth/…` and `/api/ws` are refused
  (`invalid-message`): tickets and passkeys stay on HTTP.
- Requests run concurrently: replies come back as each one finishes, matched by `id`, not in the
  order they were sent.

## WING topics

### Control

| topic | data |
|---|---|
| `wing:param-change` | `{ path, value, valueKind, raw?, shadow, receivedAt }` — a console parameter changed (from any source: the surface, another app, this server) |
| `wing:connection` | `{ meterStatus }` — `"connected"`, `"disconnected"` or `"reconnecting"` |
| `wing:cache-invalidated` | `{ reason, … }` — the server dropped its state cache (scene load, console back after an outage): anything the client derived from earlier reads should be reloaded |

### Stream

#### `wing:meters`

`params`: `{ "strips": "all" }` or `{ "strips": [{ "type": "channel", "index": 3 }, …] }` (at most
512). `type` is one of `channel`, `aux`, `bus`, `main`, `matrix`, their `…V2` variants, `dca`,
`fx`, `source`, `output`, `monitor`; `index` is 1-based, `0` for `monitor`.

`ack.data`:

```json
{
  "scale": 10,
  "columns": {
    "channel": ["inputL_dB", "inputR_dB", "outputL_dB", "outputR_dB", "gateKey_dB", "gateGain_dB", "dynKey_dB", "dynGain_dB"],
    "dca": ["preFaderL_dB", "preFaderR_dB", "postFaderL_dB", "postFaderR_dB"],
    "…": []
  }
}
```

`evt.data`, about 10 times a second, only when at least one requested strip is metered:

```json
{ "receivedAt": 1730000000000, "frames": [["channel", 3, -203, -213, -223, -233, -600, 0, -400, -42]] }
```

Each frame is `[type, index, …values]` in that type's column order. Values are integers in
1/`scale` dB for columns ending in `_dB`, and 0/1 for the others (`gateLed`, `dynActive`); `null`
means no reading. Each value is the peak (or, for gain reduction, the deepest) over the ~100 ms
window, so a short transient is never lost between two frames.

For scale: the full snapshot (every strip and DCA) is about 2.6 KB in msgpack, before compression,
against about 15 KB for the same data as JSON.

#### `wing:rta`

No params. `evt.data`, about 20 times a second:

```json
{ "receivedAt": 1730000000000, "scale": 128, "bands": "<bin: 240 bytes>" }
```

`bands` is 120 little-endian signed 16-bit words, one per band in ascending frequency, in
1/`scale` dB — the console's own resolution, so nothing is lost. Each band is its peak over the
~50 ms window. Decode with a `DataView` (a `bin` may sit at an odd byte offset, which an
`Int16Array` cannot view):

```js
const view = new DataView(bands.buffer, bands.byteOffset, bands.byteLength);
const db = Array.from({ length: bands.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true) / scale);
```

Which signal the RTA analyses is a console setting (`GET`/`POST /api/plugins/wing/rta/source`).
