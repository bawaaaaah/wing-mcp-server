# OSC Control Protocol

This is the protocol used for **all control** of a WING console: reading and writing faders, mutes, EQ,
routing, scenes, and system configuration. It is standard OSC (Open Sound Control) carried over UDP. It has
nothing to do with the metering protocol described in [`03-native-binary-protocol.md`](./03-native-binary-protocol.md)
and [`04-metering.md`](./04-metering.md) — see [`01-overview.md`](./01-overview.md) for why that separation
matters.

## Transport

| | |
|---|---|
| Discovery port | UDP **2222** |
| Control port | UDP **2223** |
| Authentication | None — the console trusts anyone who can reach it on the network |
| Inactivity timeout | **10 seconds** — a GET response wait or an active subscription that goes quiet for 10s is dropped and must be renewed |
| Simultaneous connection limit | **24** from firmware 3.1.1 onward (**16** before that — see below) |

### Discovery

Discovery does **not** use OSC framing. A client sends the literal 5-byte ASCII datagram `"WING?"` to UDP port
2222 (typically as a broadcast). Any WING console on the network replies with a comma-separated ASCII string:

```
WING,<ip>,<name>,<model>,<serial>,<firmware>
```

This is how a client can find a console's IP address on the LAN without it being configured manually.

### Connection limit, and the two figures in the spec

The limit is **24** simultaneous connections from firmware **3.1.1** onward. It was **16** before that,
and the manufacturer's document still carries both numbers: the general overview section was updated to
24, while the chapter covering the binary protocol was not and still reads 16. So the two figures are a
stale edit, not a genuine contradiction — 16 is simply the old limit.

Nothing in this project enforces or assumes either number; it is recorded here because reading the spec
cold makes it look like an unresolved inconsistency.

## OSC packet framing

WING's OSC usage is intentionally minimal:

- Only plain OSC **Messages** are used — there are **no OSC Bundles**.
- Argument types actually used: `i` (32-bit integer, big-endian), `f` (32-bit IEEE 754 float, big-endian), `s`
  (ASCII string, NUL-padded to a multiple of 4 bytes), and `b` (blob: a 32-bit length prefix followed by the
  raw bytes, then padded).
- **Maximum UDP packet size is 32 KB.** There is no fragmentation or reassembly — a message (or a dump
  response) that would exceed 32 KB simply fails. This has a direct, practical consequence documented below
  under "Known limitation: large dumps."

## Command forms

All of the operations below are just OSC messages sent to UDP:2223, distinguished by address shape and
argument types/values. The console replies (when it replies at all) with an OSC message back to the sender.

### GET — leaf value

Sending a bare address with no arguments to a **leaf** node requests its current value. The response shape
depends on the parameter's underlying type:

| Parameter type | Response tag | Response arguments |
|---|---|---|
| Float (e.g. a dB fader) | `,sff` | `(ascii string, raw value 0..1, real dB value)` |
| Integer (e.g. a boolean/enum-index) | `,sfi` | `(ascii string, raw value 0..1, real integer value)` |
| String / enum | `,s` | `(string value)` |

Example: a `GET /ch/1/fdr` on a channel sitting at unity would come back as `,sff` with something like
`("0.0", 0.671875, 0.0)`. A channel pulled all the way down comes back as `("-oo", 0.0, -144.0)` — see
[`07-value-encoding.md`](./07-value-encoding.md) for the `-oo` sentinel and the dB range in general.

### GET — branch value

Sending a bare address to a **non-leaf** node (a branch with children, e.g. `/ch/1/eq`) instead returns the
list of that node's direct children, rather than a single value. This is how a client can walk the tree
without prior knowledge of its exact shape.

### SET — simple (no acknowledgement)

Sending an address together with a value of the matching OSC tag (`,f`, `,i`, or `,s`) sets that parameter.
This is fire-and-forget: **the console does not reply**, so the caller has no built-in way to know whether the
write succeeded (wrong path, out-of-range value, etc. all fail silently from the caller's point of view). This
project therefore prefers the bulk-set form below for anything where the result matters, and keeps simple SET
available only as a low-level primitive.

### Toggle — the `-1` trick

For a boolean/integer parameter that only takes 0 or 1 (like a mute), sending a SET with the special value
`-1` flips the current value instead of setting an absolute one. This is the standard way WING exposes a
toggle operation without the client needing to first read the current state.

### SET — compact bulk form, with acknowledgement

This is the form used for **every** write in this project, because unlike simple SET it actually tells the
caller whether it worked. The message is sent to either the tree root (`/`) or to a specific node (e.g.
`/ch/1`), with a single string argument (tag `,s`) containing one or more `key=value` assignments,
comma-separated, where nested keys are dot-separated:

```
"fdr=-6.0,mute=1"
```

sent to base node `/ch/1` sets that channel's fader to -6 dB and mutes it in one round trip. Sent to the root
`/` instead, the same operation would need fully-qualified dotted keys, e.g. `"ch.1.fdr=-6.0,ch.1.mute=1"`.

The console always replies on `/*`, regardless of whether the base was the root or a specific node — verified
against real hardware (the spec's wording could be read as `<node>*` for a non-root base, e.g. `/ch/1*`, but
that is not what the console actually sends). The reply carries a single string argument (`,s`) with one of
these status values:

| Status | Meaning |
|---|---|
| `OK` | The assignment(s) were applied successfully. |
| `NODE NOT FOUND` | One of the keys does not resolve to an existing node under the given base. |
| `VALUE ERROR` | A value is out of range or of the wrong type/format for its target parameter. |
| `BUFFER OVERFLOW` | The request payload was too large for the console to process. |
| `NODE IS NOT PAR` | The target node is not a settable parameter (e.g. it's a branch, not a leaf). |
| `INCOMPLETE DATA` | The `key=value` payload was malformed or truncated. |
| `STACK EMPTY` | Reported when there is nothing left to process for the request (an edge case in the console's internal request handling). |

See [`09-error-codes.md`](./09-error-codes.md) for this same table alongside the protocol's other known
limitations.

### Dump — full subtree (`*`)

Sending an address with a single string argument `"*"` requests a **flat dump** of that entire subtree: the
response is a single string of comma-separated `key=value` pairs covering every parameter under that node,
e.g. dumping `/ch/1` yields something on the order of 2 KB of text covering every channel-strip parameter at
once. This is far more efficient than issuing dozens of individual GETs when you need "everything about this
channel."

### Describe (`?` and `#`)

Sending an address with argument `"?"` requests **metadata only** — type, numeric range, enum values — without
any current value. Sending `"#"` instead requests the same metadata **plus** the node's current value(s). Use
`?` to introspect what a parameter accepts before writing to it; use `#` when you also want its current state
in the same response.

### Response redirection

Any request address can be prefixed with `/%<port>/` to have the console send its response to a different UDP
port than the one the request originated from, e.g. `/%9000/ch/1/fdr` asks for `/ch/1/fdr`'s value but
delivers the response to port 9000 on the requester's IP. This project does not currently rely on this
feature, but it is a real, documented capability of the protocol.

### Subscribe — change notifications

Subscribing gets you a push notification whenever a parameter's value changes on the console — this is
**not** the same thing as the metering stream described in [`04-metering.md`](./04-metering.md), which is a
separate, continuous, high-rate binary feed. OSC subscriptions are strictly change-driven and low-rate by
comparison (fader moves, mute toggles, scene changes, etc.).

Three subscription forms exist, selected by which special address the subscribe request is sent to:

| Form | Behavior |
|---|---|
| `/*b` | Binary-encoded push notifications. Documented as available but best avoided in favor of the two forms below, which are simpler to parse. |
| `/*s` | Full OSC triplet notifications (the same `(ascii, raw, real)` / `(ascii, raw, integer)` shape as a GET response), delivered **twice** per change: once on the parameter's normal address, and once on its `$`-prefixed shadow address (see below). |
| `/*S` | Compact notifications: just the value itself (no triplet), again delivered on both the normal address and its `$`-shadow address. |

Whichever form is used, the subscription is subject to the same **10-second inactivity timeout** as everything
else in this protocol: if the console doesn't hear anything relevant for 10 seconds, the subscription dies
silently and must be re-established. In practice this means a subscribing client must **renew before 10
seconds elapse**, comfortably ahead of the deadline (this project renews well under that, see the
`subscriptionRenewalIntervalMs` option on `WingOscClient`).

**The `$`-shadow address concept**: every subscribable parameter has a parallel, read-only address prefixed
with `$` (e.g. `/ch/1/$mute` alongside `/ch/1/mute`). Subscription push notifications are delivered on this
shadow address (in addition to, or instead of, the plain address depending on the subscription form). These
`$`-addresses generally reflect the parameter's *effective* value after any DCA/mute-group influence has been
applied, which can differ from the raw parameter value a plain SET would target — see
[`07-value-encoding.md`](./07-value-encoding.md) for more on `$`-addresses.

### Hash addressing

As an alternative to textual paths, every node also has a stable 32-bit hash, and can be addressed as
`/#<hex>` instead of by its textual path. This is a known capability of the protocol, but this project does
not use it — textual paths are perfectly adequate for the parameter counts involved, and are vastly easier to
read, log, and debug.

## Known limitation: large dumps overflow the 32 KB UDP limit

Because dump (`*`) responses are flat, unfragmented UDP packets capped at 32 KB, dumping a large subtree —
the tree root `/`, or an entire top-level namespace like `/ch` (all 40 channels at once, on the order of
80 KB+) — simply fails; the console cannot fit the response into a single valid OSC/UDP packet. **Never dump
a root or namespace-wide node.** Only dump indexed leaves-of-branches, such as a single channel (`/ch/1`), a
single bus (`/bus/2`), and so on — those subtrees are small enough (roughly 2 KB) to fit comfortably. This
project's `wing_dump` tool enforces this with a client-side allowlist restricted to per-index roots.
