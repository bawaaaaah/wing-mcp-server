# WING Protocol Overview

Behringer WING is a family of fully digital, remote-controllable mixing consoles. Every parameter on the
console — every fader, every EQ band, every routing-matrix cell, every scene recall, every bit of system
configuration — is exposed over the network. That is what makes a project like this one possible: an MCP
server that lets an LLM agent inspect and drive a WING console the same way a human would from its touchscreen
or a hardware control surface.

## The three models, briefly

WING ships in three physical form factors. All three speak the *same* remote-control protocol and share the
same underlying node tree, but differ in I/O count, surface controls, and a few model-reported fields:

| Model | Protocol model id (`/$syscfg/$cnsmdl`) |
|---|---|
| WING (Standard) | `ngc-full` |
| WING Rack | `wing-rack` |
| WING Compact | `wing-compact` |

The differences that actually matter to a remote-control client — physical fader/GPIO/MIDI counts, headphone
jacks, local input/output availability — are detailed in full in
[`08-model-differences.md`](./08-model-differences.md). For everything else that this documentation set and
this codebase care about — the OSC node tree, value encoding, scene recall — the three models behave
identically.

## The crucial architectural fact: two separate wire protocols

This is the single most important thing to understand before writing or reading any code that talks to a WING
console: **there is no one "WING protocol."** There are two, and they share neither a transport, a framing
format, nor even a port:

| | Control | Metering |
|---|---|---|
| Purpose | Get, set, and subscribe to any of the roughly 25,000 parameters in the node tree (faders, mutes, EQ, dynamics, routing, scenes, system config, ...) | Real-time level / gain-reduction / RTA data streaming, for VU meters and similar live displays |
| Transport | OSC over UDP, port **2223** (plus a tiny UDP **2222** exchange used only for discovery) | TCP, port **2222**, for setup and keepalive, with responses delivered over UDP on a client-chosen port |
| Wire format | Standard OSC (Open Sound Control) messages | Behringer's own binary framing (escape-byte + channel-select multiplexing) — unrelated to OSC |
| Authentication | None | None |
| Documented here in | [`02-osc-protocol.md`](./02-osc-protocol.md) | [`03-native-binary-protocol.md`](./03-native-binary-protocol.md) for the framing, [`04-metering.md`](./04-metering.md) for the meter-specific payload |

Metering data is **not** available via OSC at all — there is no "subscribe to this fader's audio level" OSC
message. If you want real-time levels, gate/dynamics gain reduction, or an RTA display, you have to speak the
separate binary protocol on TCP:2222. Conversely, that binary protocol is not used for control in this
project: every get/set/subscribe/scene-recall operation goes through OSC on UDP:2223.

Keep this split in mind throughout the rest of this documentation set, and throughout the codebase: a
`WingOscClient` (control) and a `WingMeterClient` (metering) are two independent classes talking to two
independent sockets. Either one can be connected, disconnected, or erroring completely independently of the
other, and a healthy console connection for control purposes says nothing about whether metering is currently
flowing.

## Where to go next

- New to the wire-level OSC commands (GET/SET/subscribe/dump/...)? Read
  [`02-osc-protocol.md`](./02-osc-protocol.md).
- Need to understand how values are encoded on the wire (dB, `-oo`, booleans, enums)? Read
  [`07-value-encoding.md`](./07-value-encoding.md).
- Building or debugging the metering pipeline? Read
  [`03-native-binary-protocol.md`](./03-native-binary-protocol.md) and then
  [`04-metering.md`](./04-metering.md).
- Looking for a specific parameter's path, type, or range? Start at
  [`05-node-tree/README.md`](./05-node-tree/README.md) and drill into the relevant category file.
