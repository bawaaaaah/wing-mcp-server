# Node Tree Overview

WING exposes essentially its entire state — around 25,000 parameters — as an OSC-addressable tree, described
at the protocol level in [`../02-osc-protocol.md`](../02-osc-protocol.md). This file maps the **root** of that
tree: the top-level namespaces you'll see if you GET the bare address `/`.

This is a hand-written narrative overview, kept deliberately short and stable. For exhaustive, per-parameter
detail (exact path, type, range/enum, unit, read-only flag, applicable models, description) within a given
namespace, see the generated per-category files in this same directory — `channel.md`, `bus.md`, `main.md`,
`matrix.md`, `dca.md`, `mutegroup.md`, `scenes-library.md`, `system-status.md`, `control-surface.md`,
`io-routing.md`, `fx.md`, `config.md`. Those files are generated directly from
`src/plugins/wing/wing-param-catalog.ts` by `scripts/generate-wing-docs.ts`, so **they may be more exhaustive
and more current than this narrative page** — if the two ever disagree on a detail, trust the generated file.

## Root namespaces

A bare `GET /` returns this list of top-level branch nodes:

`$stat`, `cfg`, `$syscfg`, `io`, `ch`, `aux`, `bus`, `main`, `mtx`, `dca`, `mgrp`, `fx`, `cards`, `play`, `rec`,
`$ctl`, `$globals`

| Namespace | Description |
|---|---|
| `$stat` | Read-only console **status**: AES50 link status for the A/B/C ports, clock lock state, solo status, USB drive presence, and the console's clock/date. Nothing under `$stat` is writable — it reflects live console state. |
| `cfg` | General console **configuration**: monitor bus setup (`cfg/mon/1..2`), solo behavior (`cfg/solo`), RTA configuration (`cfg/rta`), meter configuration (`cfg/mtr`), talkback A/B (`cfg/talk/A`, `cfg/talk/B`), automix settings, and DCA/mute-group behavior (`cfg/dcamgrp`). |
| `$syscfg` | **System identity and network configuration**: console name, IP address/subnet mask/gateway, firmware version, serial number, and the read-only model identifier `$syscfg/$cnsmdl` (one of `ngc-full`, `wing-rack`, `wing-compact` — see [`../08-model-differences.md`](../08-model-differences.md)). Also USB port speed and Ethernet mode. |
| `io` | **I/O routing.** Shaped as `io/in|out/<GROUP>/<n>/...`. The known I/O groups are: `LCL`, `AUX`, `A`, `B`, `C`, `SC`, `USB`, `CRD`, `MOD`, `PLAY`, `AES`, `USR`, `OSC`, `$BUS`, `$MAIN`, `$MTX`, `$SEND`, `$MON`. |
| `ch` | **Channels**, indexed `1..40`. Fader, mute, pan, EQ, gate, dynamics, filters, sends to bus/matrix/main, input processing, and more. See the generated `channel.md`. |
| `aux` | **Aux inputs**, indexed `1..8`. |
| `bus` | **Buses**, indexed `1..16`. See the generated `bus.md`. |
| `main` | **Main mixes**, indexed `1..4`. See the generated `main.md`. |
| `mtx` | **Matrices**, indexed `1..8`. See the generated `matrix.md`. |
| `dca` | **DCA groups**, indexed `1..16`. See the generated `dca.md`. |
| `mgrp` | **Mute groups**, indexed `1..8`. See the generated `mutegroup.md`. |
| `fx` | **Effects**, indexed `1..16`. |
| `cards` | Expansion card configuration/state. |
| `play` | USB **player** (playback) state and controls. |
| `rec` | USB **recorder** state and controls. |
| `$ctl` | Console **surface and control-surface behavior**: `$ctl/daw` (DAW control integration), `$ctl/midi`, `$ctl/OSC` (including `$ctl/OSC/ronly`, a lock that makes the console's OSC surface read-only), `$ctl/lib` (the Shows/Scenes library — see [`../06-scenes-and-library.md`](../06-scenes-and-library.md) and the generated `scenes-library.md`), `$ctl/$globals`, `$ctl/gpio/1..4`, `$ctl/user/...` (USER key assignments), and `$ctl/layer/<L\|C\|R>/<bank>/<slot>` (physical layer/bank/slot mapping). |
| `$globals` | Global system behavior: clock rate/source, `startmute` (mute-on-startup behavior), USB/StageConnect configuration, and custom sync settings. |

## Indexing convention

Indexed namespaces (`ch`, `aux`, `bus`, `main`, `mtx`, `dca`, `mgrp`, `fx`) are always **1-based** in their OSC
paths (e.g. the first channel is `/ch/1`, not `/ch/0`), and the generated per-category files in this directory
render each parameter's path with the literal placeholder token `{n}` in place of the index (e.g.
`/ch/{n}/fdr`), matching `WingParamMeta.pathTemplate` in `src/plugins/wing/wing-param-catalog.ts`.
