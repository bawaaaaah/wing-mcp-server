# Native Binary Protocol

Separate entirely from the OSC control protocol described in
[`02-osc-protocol.md`](./02-osc-protocol.md), WING also exposes a proprietary **binary, channel-multiplexed
protocol over TCP, port 2222**. This is the transport that the real-time **metering** feature rides on top of
— it is what `src/plugins/wing/wing-meter-client.ts` (`WingMeterClient`) speaks. This file documents the
low-level framing shared by the whole binary protocol; the meter-specific payload built on top of it is
documented separately in [`04-metering.md`](./04-metering.md).

Note that TCP port 2222 is the *same* port used for the tiny UDP discovery exchange described in
[`02-osc-protocol.md`](./02-osc-protocol.md) — they are unrelated uses of the same port number on two
different transports (UDP vs. TCP), not the same service.

## Escape-byte and channel-select framing

The binary protocol multiplexes multiple logical "channels" of communication over the single TCP:2222
connection using an escape byte:

- **Escape byte: `0xdf`.**
- **Channel selection**: sending `0xdf` followed by `0xd0 + ChID` switches the stream's current channel to
  `ChID`. All subsequent bytes on the connection are interpreted as belonging to that channel until another
  channel-select sequence is sent.
- **Escaping a literal `0xdf` in data**: because `0xdf` is the escape byte, any *actual* `0xdf` byte value
  that needs to appear in a channel's payload data must itself be escaped as the two-byte sequence
  `0xdf 0xde`, to disambiguate it from the start of a channel-select sequence.

This escape-byte multiplexing is always active on the TCP connection — it's the outer framing layer for
everything sent over TCP:2222, regardless of which logical channel is currently selected.

The receiver rule matters for decoding the console's output: per the spec's sample receive routine, a `0xdf`
is only an escape when the next byte is `0xde` (swallowed: the pair is one data `0xdf`) or a selector
`0xd0`..`0xdd`. Followed by any other byte, the `0xdf` is plain data — the sender escapes only where it would
be ambiguous, so `d7 02 df af 0e 02` and `d7 02 df de af 0e 02` carry the same payload. `WingChannelDemuxer`
follows that rule; `escapeBytes` always escapes, which every receiver accepts. A bare re-select of the current
channel (`0xdf 0xd1` with no data) is the control channel's keepalive.

## Known channels

| ChID | Selector bytes | Purpose | Used by this project? |
|---|---|---|---|
| 1 | `0xdf 0xd1` | Audio Engine & Control | **Decoded, not yet used for control.** The server's own control goes through OSC on UDP:2223 (see [`02-osc-protocol.md`](./02-osc-protocol.md)). `wing-native-codec.ts` tokenizes this channel for the tablet bridge and the capture tool — see below. |
| 3 | `0xdf 0xd3` | Meter Data Requests | **Yes.** This is the channel `WingMeterClient` selects and uses for all real-time metering — the setup handshake, keepalive, and meter-group configuration are all sent as payload on this channel. Fully detailed in [`04-metering.md`](./04-metering.md). |

Once channel 3 is selected via `0xdf 0xd3`, everything that follows (until another channel-select sequence, if
any) is the meter-subsystem's own command payload — setup bytes like `0xd3`/`0xd4`/`0xdc`/`0xde` described in
`04-metering.md` are **not** part of this outer framing layer; they are meter-specific commands sent *within*
the already-selected channel 3 payload stream.

## Channel 1: control tokens

The control channel is a stream of tokens that move a per-connection "current node" and read or write it.
`src/plugins/wing/wing-native-codec.ts` (`NativeTokenizer`) decodes them; words are 2 bytes and longs 4, big
endian.

| Bytes | Meaning |
|---|---|
| `0x00`..`0x3f` | int 0..63 (0/1 = false/true) |
| `0x40`..`0x7f`, `0xd2 word` | go to child by index (1..64, 1..65536) |
| `0x80`..`0xbf` + n bytes | string of n = 1..64 bytes |
| `0xc0`..`0xcf` + n bytes | go to child by name (n = 1..16) |
| `0xd0` / `0xd1 byte` + n | empty string / string of n = 1..256 bytes |
| `0xd3 word`, `0xd4 long` | int16, int32 |
| `0xd5 long`, `0xd6 long` | float32, raw float32 (0..1) |
| `0xd7 long` | go to node id (the node's 32-bit hash) |
| `0xd8`, `0xd9 byte` | click (toggle), step by a signed amount |
| `0xda`, `0xdb` | go to root, go up one level |
| `0xdc`, `0xdd`, `0xde` | request data, request children's definitions, end of a reply |
| `0xdf word [long]` + body | node definition: parent.l, id.l, index.w, name, long name, flags.w (b0-3 unit, b4-7 type, b9 read-only), then type-specific fields |
| `0xe0`..`0xff` | unused |

libwing (a Rust client) connects by selecting channel 1, re-sends `0xdf 0xd1` every 7 s as a keepalive,
reads with `0xd7 id 0xdc`, lists children with `0xd7 id 0xdd`, and writes with `0xd7 id <value>`.

## Capture spike: what the official apps actually do

The tablet bridge (WING-Q, Co-Pilot and WING Edit through this server) is designed on assumptions about these
apps that only their real traffic can confirm. `scripts/wing-native-capture.ts` records that traffic:

```bash
npm run wing:capture -- --console <console ip> --osc
```

It answers `WING?` as "WING-CAPTURE" with the real console's model and firmware, relays TCP 2222 one-to-one to
the console (rewriting the meter UDP port so meters come back through it), optionally relays OSC 2223, and on
Ctrl+C writes `captures/<run>/summary.json`, `events.jsonl` and `nodes.json`. By default the tablet's writes
are dropped (values, clicks and steps on channel 1; OSC sets) and OSC subscriptions are never forwarded, so it
is safe on a console in use. `--allow-writes` exists only to test echo on a parameter chosen for it;
`--verify-hash captures/<run>/nodes.json` checks with OSC reads whether native ids are the OSC `/#<hex>` hashes.
Run it from a real terminal on a host where nothing else holds 2222/2223 (the server itself does not).

What a session answers, by summary key:

| Key | Question |
|---|---|
| `A1_transports` | Which ports the app uses; whether it shows up at all (a 2021 WING-Q changelog mentions WebSocket) |
| `A2_discovery` | Whether it lists and connects to an entry with our name and a non-console serial |
| `A3_*` | Whether the token table and definition layout above hold (no unknown tokens, no parse errors) |
| `A4_*` | Whether the console pushes changes to every connection with no request |
| `A5_replyShapes`, `A5_A12_requests` | Reply shape and pipelining depth; startup sync volume |
| `A6_echo` | Whether a connection's own write comes back to it (needs `--allow-writes`) |
| `A9_navTokens` | Whether the app navigates only by id (`0xd7`) or also by root/up/index/name |
| `A10_keepalive` | Keepalive cadence on channels 1 and 3 |
| `A11_*` | Meter collections requested, packet sizes, the console's UDP source port |

Findings from real sessions go here.
