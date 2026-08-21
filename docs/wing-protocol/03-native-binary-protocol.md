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

## Known channels

| ChID | Selector bytes | Purpose | Used by this project? |
|---|---|---|---|
| 1 | `0xdf 0xd1` | Audio Engine & Control | **No.** All control in this project goes through the OSC protocol on UDP:2223 (see [`02-osc-protocol.md`](./02-osc-protocol.md)), which fully covers get/set/subscribe/scene-recall needs. This channel is not implemented here. |
| 3 | `0xdf 0xd3` | Meter Data Requests | **Yes.** This is the channel `WingMeterClient` selects and uses for all real-time metering — the setup handshake, keepalive, and meter-group configuration are all sent as payload on this channel. Fully detailed in [`04-metering.md`](./04-metering.md). |

Once channel 3 is selected via `0xdf 0xd3`, everything that follows (until another channel-select sequence, if
any) is the meter-subsystem's own command payload — setup bytes like `0xd3`/`0xd4`/`0xdc`/`0xde` described in
`04-metering.md` are **not** part of this outer framing layer; they are meter-specific commands sent *within*
the already-selected channel 3 payload stream.
