# Scenes & Library

Scene management lives under the `/$ctl/lib/` node in the OSC tree — see
[`05-node-tree/README.md`](./05-node-tree/README.md) for where that sits in the overall namespace map, and
[`05-node-tree/scenes-library.md`](./05-node-tree/scenes-library.md) (generated from the parameter catalog)
for the exhaustive parameter table. This file covers the conceptual model and the practical recall recipe.

## The `$ctl/lib` control nodes

| Path | Type | Access | Meaning |
|---|---|---|---|
| `$ctl/lib/$scenes` | String | Read-only | The list of scenes. **Note:** a simple GET only returns the *first* name in the list — use a `?` describe request (see [`02-osc-protocol.md`](./02-osc-protocol.md#describe--and-)) to retrieve the full list. |
| `$ctl/lib/$actidx` | Integer | Read-only | The index of the currently active scene. |
| `$ctl/lib/$active` | String | Read-only | The name of the currently active scene, e.g. `"I:SHOW2/scene_1.snap"`. |
| `$ctl/lib/$actshow` | String | Read-only | The name of the currently active show. |
| `$ctl/lib/$action` | String (enum) | Read/write | One of `IDLE`, `GOPREV`, `GONEXT`, `GO`, `PREV`, `NEXT`, `GOTAG` — see the recall recipe below. |
| `$ctl/lib/$actionidx` | Integer | Read/write | `0..16384` — the target scene index or tag, to be set **before** issuing `GO` or `GOTAG`. |
| `$ctl/lib/$activeid` | Integer | Read-only | The tag of the currently active scene. |

## Recalling a scene: the GO / GOTAG / NEXT / PREV recipe

A scene recall is a **two-step** operation:

1. **Set the target** by writing `$ctl/lib/$actionidx` to either a scene's numeric index (its position in the
   list) or its numeric tag, depending on which addressing scheme you're using.
2. **Trigger the recall** by writing `$ctl/lib/$action` to:
   - **`GO`** if `$actionidx` was set to a plain scene **index**, or
   - **`GOTAG`** if `$actionidx` was set to a scene **tag** instead.

For sequential navigation without needing to know an exact index or tag, `$action` also accepts:
- **`NEXT`** / **`PREV`** — move to the next/previous scene in list order.
- **`GONEXT`** / **`GOPREV`** — equivalent "go" forms of the same idea, for consistency with how `GO` pairs
  with an explicit index.

A **show must already be open** on the console for any of these recall operations to do anything — scene
recall operates within the currently loaded show's scene list.

Because this project routes all writes through the bulk-set-with-acknowledgement OSC form (see
[`02-osc-protocol.md`](./02-osc-protocol.md#set--compact-bulk-form-with-acknowledgement)), a scene recall in
this codebase is implemented as a single atomic `bulkSet` call setting both `$actionidx` and `$action` in one
acknowledged round trip, rather than as two separate SETs that could race or partially fail.

## Conceptual model: Show, Scene, Snap, Snippet, Preset, Tag

WING's scene system is organized in a small hierarchy of concepts:

- **Show**: the top-level container that's "open" on the console at any given time. A show can contain **up
  to 1,000 Scenes**.
- **Scene**: an entry in a show's ordered list. Each Scene references what should actually be recalled — a
  **Snap**, a **Snippet**, a **Preset**, or an **Audio Clip** — rather than being the recallable content
  itself. This indirection is what lets the same underlying content be reused across multiple scenes, or
  reordered within a show without re-saving anything.
- **Snap / Snippet / Preset / Audio Clip**: the actual recallable content a Scene points to. A Snap is
  generally a full console-state snapshot; Snippets and Presets are narrower, more targeted pieces of state
  (the precise scoping of each is a console-level authoring concern rather than something this remote-control
  layer needs to distinguish for get/set purposes).
- **Tags**: every scene can additionally be addressed by a stable numeric **tag**, in the range `#1`–`#16384`.
  Unlike a scene's list index (which shifts if scenes are reordered, inserted, or deleted), a tag stays
  attached to the same scene regardless of where it sits in the list — this is why `GOTAG` exists alongside
  `GO`: it lets an external controller (like this MCP server) recall "the scene I mean" reliably, even if a
  human operator has since reordered the show's scene list on the console itself.
- **Scopes and Global Safes**: a scene recall does not necessarily overwrite the *entire* console state.
  Scopes determine which categories of parameters (content vs. configuration, for instance) a given recall
  actually touches, and Global Safes let specific parameters or channels be protected from being changed by
  *any* scene recall, console-wide. These are authoring-time concepts configured on the console itself; this
  remote-control layer does not need to model them beyond being aware that "recall a scene" is not always
  synonymous with "restore every parameter to the saved snapshot."
