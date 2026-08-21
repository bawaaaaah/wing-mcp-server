# Model Differences

WING is sold in three physical form factors. They all speak the same OSC control protocol and binary metering
protocol described elsewhere in this documentation set, and they share the same node tree — the differences
below are hardware/surface differences, plus one console-reported identity field, not protocol differences.

The console reports which model it is at the read-only path `/$syscfg/$cnsmdl`, using the values in the table
below (the same values used by this codebase's `WingParamMeta.models` field: `"ngc-full"`, `"wing-rack"`,
`"wing-compact"`).

## At a glance

| | WING (Standard) — `ngc-full` | WING Rack — `wing-rack` | WING Compact — `wing-compact` |
|---|---|---|---|
| Form factor | Full console surface | 19" rack, 4U | Compact console surface |
| Motorized faders | 12 + 8 + 4 | — (rack unit, no physical faders) | 3×4 + 1 main fader |
| Jog wheel | Yes | No | No |
| DAW transport button | Yes | No | No |
| Local inputs | 8 | 24 | 24 |
| Local outputs | 8 | (mapped, see headphone note) | — |
| Aux inputs (local) | 8 | None | None |
| Aux outputs (local) | 8 | None | None |
| Headphone jacks | 2 | 4 (mapped onto the local outputs) | 1 |
| GPIO ports | 4 | 4 | **2** |
| MIDI ports | 4 | 2 | 2 |

A few things worth calling out explicitly:

- **WING Rack** has no physical faders at all (it's a rack-mount processing/routing unit meant to be
  remote-controlled or paired with a control surface), no jog wheel, and no dedicated DAW button — but it
  still exposes the full OSC node tree just like the other two models. Its 4 headphone outputs are not
  separate physical outputs; they are mapped onto its local output jacks.
- **WING Compact** has the smallest surface (3 banks of 4 faders plus a single main fader) and, notably, only
  **2 GPIO ports** where the other two models have 4 — this is the one place where the models diverge in
  count rather than just presence/absence.
- Both WING Rack and WING Compact have **no local aux input/output** hardware, unlike the Standard model's 8
  aux ins and 8 aux outs.

## Cross-model Snap loading

A **Snap** (see [`06-scenes-and-library.md`](./06-scenes-and-library.md) for the scenes/library conceptual
model) can be loaded on **any** of the three models, regardless of which model it was originally saved on. If
a Snap contains model-specific surface layer definitions — for example USER key or MIDI CC layer assignments
tied to controls that only exist on the originating model — those definitions are simply **ignored** when
loaded on a different model that lacks the corresponding controls. Critically, they are **not erased**: if the
same Snap is later loaded back on its original model (or another model with matching controls), those
layer definitions are still there and take effect again. This makes Snaps safe to share across a mixed fleet
of WING hardware without risking silent, permanent loss of model-specific surface configuration.
