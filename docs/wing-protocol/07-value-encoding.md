# Value Encoding

This file describes how individual parameter values are represented on the wire in the OSC control protocol
(see [`02-osc-protocol.md`](./02-osc-protocol.md) for the command forms these values are carried in). It is
the reference to check when you're unsure how to interpret a GET response or what to put in a SET.

## dB levels and the `-oo` sentinel

Fader and gain-style parameters are documented with a range of **`-144` to `10`** (dB), spread across
**1,024 discrete steps**. The value `-144` is the encoded stand-in for **negative infinity** (i.e. fully
attenuated / silent), and is rendered in its ASCII form as the string **`"-oo"`** rather than as a plain
number.

Recall from [`02-osc-protocol.md`](./02-osc-protocol.md#get--leaf-value) that a GET on a float-typed leaf
returns a `,sff` triplet: `(ascii string, raw value 0..1, real dB value)`. For a channel pulled all the way
down, that triplet looks like `("-oo", 0.0, -144.0)` — the ASCII field shows the human-friendly `-oo`, while
the raw and real fields carry the actual numeric encoding (`0.0` normalized, `-144.0` dB). For a channel at
unity it would look more like `("0.0", 0.671875, 0.0)`.

## Booleans

Boolean-flavored parameters (mutes, on/off switches, etc.) are encoded as a plain **integer `0` or `1`**, and
a GET on one returns the `,sfi` tag: `(ascii string, raw value 0..1, real integer value)` — the same
three-field shape as a float GET, just with an integer in the last slot instead of a float.

### Known exception: Pitch Corrector note-enable flags are inverted

Not every boolean in the protocol follows the `0 = off, 1 = on` convention above. Verified against real
hardware: the Pitch Corrector effect's per-note enable parameters (which notes of the scale the corrector is
allowed to snap to) are **inverted** — `0` means the note is **active/allowed**, and `1` means it's
**disabled**. FX parameters aren't in this project's static catalog at all (unlike channel/bus/etc. — see
`wing-param-catalog.ts`); they're discovered dynamically per loaded effect via `wing_describe`/`wing_dump` on
`/fx/{n}`, since each of WING's ~40 effect models has its own parameter set. This inversion is exactly the
kind of thing that generic discovery won't warn you about — don't assume `0`/`1` means off/on for an FX
parameter just because that's the rule everywhere else; check the actual behavior (or ask someone who has)
before building automation around it.

### The `-1` toggle trick

Rather than requiring a client to read the current boolean value before deciding what to write, WING supports
a **toggle shortcut**: sending a SET of `-1` to a boolean/integer 0-or-1 parameter flips its current value.
This is documented in more detail as part of the SET command forms in
[`02-osc-protocol.md`](./02-osc-protocol.md#toggle--the--1-trick).

## Integers: the reply's int argument is an offset

A `,sfi` GET reply's third argument is the value's offset from the parameter's minimum, not the value itself:
a `col` of 10 replies `("10", 0.529, 9)`. Read the display string. See
[`05-node-tree/io-patch.md`](./05-node-tree/io-patch.md) for the verified cases.

## Strings in a bulk-set must be quoted

An unquoted bulk-set value loses all its whitespace (`TB Samuel` → `TBSamuel`, acked `OK`). Single-quote it,
escaping `'` and `\` with a backslash. Names hold 16 UTF-8 bytes. Details in
[`05-node-tree/io-patch.md`](./05-node-tree/io-patch.md).

## Enums

Enum-typed parameters (an EQ model, a gate type, an input source, etc.) are set by sending the **literal
string** of the desired option as a plain `,s` SET — e.g. setting `eq/mdl` to one of `STD`, `SOUL`, `E88`, and
so on picks that EQ model by name. There is no separate numeric-index form for enums in this protocol; the
string *is* the value.

## `$`-prefixed addresses: shadow / read-only values

Any parameter path can have a parallel address prefixed with `$` (e.g. `/ch/1/$mute` alongside the writable
`/ch/1/mute`). These `$`-addresses are **read-only** and typically reflect the parameter's *effective* value
after upstream influences — most notably DCA and mute-group assignments — have been applied. In other words,
a channel's plain `mute` might read `0` (not muted at the channel level) while its `$mute` shadow reads `1`,
because a DCA or mute group it belongs to is currently muting it.

These `$`-addresses are also where OSC subscription push notifications are delivered (see
[`02-osc-protocol.md`](./02-osc-protocol.md#subscribe--change-notifications)), which makes sense given their
role: a subscriber generally cares about the parameter's real, effective, currently-audible state, not just
whatever was last written to its plain address.

## Hash addressing (alternative, unused here)

As noted in [`02-osc-protocol.md`](./02-osc-protocol.md#hash-addressing), every node also has a stable 32-bit
hash and can alternatively be addressed as `/#<hex>` instead of by its textual path. This project does not use
hash addressing anywhere — textual paths are used exclusively, both because they are far easier to read and
debug and because nothing in this project's scale of usage benefits from the (presumably marginal) efficiency
gain of hash-based addressing.
