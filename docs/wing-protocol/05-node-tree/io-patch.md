# I/O, Patch, User Signals and Strip Identity

Hand-written narrative, like [`README.md`](./README.md) — not generated. Everything marked *verified* was
observed on a real console (a WING Rack, firmware 3.1.1) on 2026-09-25; the rest is from the protocol
reference.

## Integer replies: read `display`, not the third argument

A GET of an integer leaf answers `,sfi` = `(display, raw 0..1, int)`. *Verified:* the `int` argument is the
value's **offset from the parameter's minimum**, not the value. It only coincides with the value when the
range starts at 0 (`icon`, `mute`, `on`). For every 1-based parameter it reads one low:

| Leaf | Range | Console shows | Reply |
|---|---|---|---|
| `/ch/5/in/conn/in` | 1..64 | 10 | `("10", 0.1428, 9)` |
| `/io/in/USR/14/col` | 1..18 | 10 (Salmon) | `("10", 0.5294, 9)` |
| `/io/in/USR/14/icon` | 0..999 | 114 | `("114", 0.1141, 114)` |

The server decodes integers from `display`, so `value` in every tool result is what the console shows.
Compact `/*S` subscription pushes carry the same offset without the display string, which is why the server
subscribes with `/*s` (full triplets).

## Strings in a bulk-set

*Verified:* in an unquoted bulk-set value the console **strips every whitespace character** and still acks
`OK` (`name=TB Samuel` is stored as `TBSamuel`), and a `,` or `=` splits the assignment. Inside single quotes
everything survives — spaces, commas, `=`, UTF-8 — and that is also how the console writes such values in its
own dumps (`name='DM Karina'`). Inside the quotes `\` escapes the next character: `\'` for a quote, `\\` for a
backslash. Control characters (tab, newline) are dropped even when quoted. The server quotes any value that is
not a bare token, and rejects control characters.

`name` holds **16 UTF-8 bytes** (not characters: sixteen `é` are stored as eight) and `tags` 80. The console
truncates a longer value silently and acks `OK`, so the server refuses it instead.

## Strip identity: own, source, effective

Every channel/aux/bus/main/matrix has its own `name` / `col` / `icon`, and read-only shadows `$name` /
`$col` / `$icon` holding what the surface **displays**. *Verified on a channel:*

- `clink` ("link customization to source", 0/1) decides which one is shown. With `clink=1` the shadows switch
  to the patched source's (`/io/in/<grp>/<n>`) name/color/icon, and follow a rename or re-patch of that
  source. The strip's own fields are kept, and can still be written, invisibly. `clink=0` shows them again.
- `in/set/srcauto` is **not** that link. The protocol reference calls it the "input auto source switch". A
  channel with `srcauto=1` and `clink=0` shows its own name.
- DCAs and mute groups have no shadows: what they store is what they show.

`wing_list_names` and the summaries report `effectiveName` (= `$name`), `ownName`, `sourceName`,
`nameLinkedToSource` (= `clink`), and the same split for color and icon.

## Input patch and stereo pairs

A strip's input is `in/conn/grp` + `in/conn/in` (and `altgrp`/`altin`). *Verified:* a stereo source is one of
an odd/even pair whose two members are both `mode=ST` (A9 and A10 both report `mode=ST` and the same name). A
strip can be patched to either member. `in/conn/in` keeps whichever was written (CH 5 stores `10`), and the
strip is stereo (`in/set/$mode=ST`) either way. The console shows the pair (9/10), so the server reports
`{index: 9, storedIndex: 10, pair: [9, 10], stereo: true, label: "A9-10"}`.

## Internal taps: BUS, MAIN, MTX, SEND, MON

Outputs (`/io/out/<grp>/<n>`: `grp` + `in`) and strip inputs can take an internal signal. *Verified:* those
are numbered in L/R pairs. `/io/in/$BUS/7` and `/io/in/$BUS/8` both carry bus 4's name, so `grp=BUS, in=7`
is **bus 4, left**. In general, strip = ⌈in/2⌉ and odd = L, even = R.

| Group | Pairs | What |
|---|---|---|
| `BUS` | 32 | buses 1..16 |
| `MAIN` | 8 | mains 1..4 |
| `MTX` | 16 | matrices 1..8 |
| `SEND` | 32 | FX sends 1..16 (`$SEND/1` = "FX SEND 1") |
| `MON` | 4 | monitor outs: 1-2 PHONES, 3-4 SPEAKERS |

`/io/in/$<GROUP>/<n>` is a read-only node carrying the tapped strip's `name`/`col`/`icon`/`mode`.

## User signals and user patches (`/io/in/USR/1..56`)

Each has `mode`, `mute`, `pol`, `col`, `name`, `icon`, `tags`, and a `user` node for its source. *Verified*
(one dump returns all of it, e.g. `user.grp=CH,in=7,tap=PRE,lr=L`). The source schema differs by range:

| Range | Name | `user/grp` | `user/in` | `user/tap` | `user/lr` |
|---|---|---|---|---|---|
| 1-24 | User signals | `OFF, CH, AUX, BUS, MAIN, MTX` | 1..40 | `PRE, POST` | `L+R, L, R` |
| 25-56 | User patches | `OFF, LCL, AUX, A, B, C, SC, USB, CRD, MOD, PLAY, AES` | 1..64 | — | — |

`wing_usr_list` / `wing_usr_set` handle both ranges.

## Local inputs (`LCL`)

The number of `LCL` inputs comes from the console model and is discovered live (`GET /io/in/LCL` lists them).
The test console, a WING Rack, reports **24**. On it, `LCL 24` carries the talkback mic (48V on). This page
does not claim a mapping from `LCL` index to rear-panel connector for the other models. Check `wing_status`
for the model.

## What the console pushes (`/*s` subscription)

*Verified:*

- Pushes arrive only on the `$` shadow addresses (`/ch/40/$name`, `/ch/40/$col`, `/ch/40/in/set/$mode`), for
  changes from any client, this server included.
- A strip rename, a `clink` toggle, a rename of the linked source, and a re-patch of a linked strip all push
  the strip's `$name`/`$col`/`$icon`.
- Changing `in/conn/grp`/`in` pushes no path of its own (only `in/set/$mode` when the stereo-ness changes).
  Read the patch live; don't cache it from pushes.
- An idle console pushes nothing: renewing the subscription does not replay values.

Nothing is pushed while the console is unreachable. The server drops its cache when the console answers again
after a heartbeat failure, and on scene changes.

## Not available over OSC

- **Saving a scene**: `/$ctl/lib/$action` only offers `GO`, `GOTAG`, `NEXT`, `PREV`, `GONEXT`, `GOPREV`. There
  is no store/update action.
- **An "unsaved changes" flag**: none in the reference. The server counts changes since the last scene load
  itself (`wing_status`, `wing_history`).
