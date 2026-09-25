# WING Protocol Reference

This directory is the WING remote-control protocol reference for this project: everything the Wing plugin
(`src/plugins/wing/`) implements against a Behringer WING mixing console is documented here, split into small,
focused files rather than one giant page. It serves two audiences at once — humans browsing the repository,
and MCP clients (LLM agents) reading these same files live as MCP resources (see the mapping table below).

The content is transcribed and organized from Behringer's official "WING Remote Protocols" specification.
Nothing here is invented: where the source spec is ambiguous or internally inconsistent, that is called out
explicitly (see e.g. the connection-limit note in [`02-osc-protocol.md`](./02-osc-protocol.md)) rather than
silently resolved.

If you're new to this protocol, start with these two:
- [`01-overview.md`](./01-overview.md) explains the single most important architectural fact: WING actually
  exposes **two completely separate wire protocols** (OSC control vs. a proprietary binary metering channel),
  not one.
- [`05-node-tree/README.md`](./05-node-tree/README.md) maps the root of the roughly 25,000-parameter node
  tree that the OSC control protocol addresses.

## Contents

| File | Description |
|---|---|
| [`01-overview.md`](./01-overview.md) | What WING is, the three hardware models at a glance, and the control-vs-metering protocol split. |
| [`02-osc-protocol.md`](./02-osc-protocol.md) | The OSC control protocol on UDP:2223 — transport, framing, GET/SET/toggle/bulk-set/dump/describe/subscribe. |
| [`03-native-binary-protocol.md`](./03-native-binary-protocol.md) | The native binary channel-multiplexing protocol on TCP:2222 that underlies metering. |
| [`04-metering.md`](./04-metering.md) | The real-time metering protocol: setup sequence, meter-type tokens, frame format, dB conversion. |
| [`05-node-tree/README.md`](./05-node-tree/README.md) | Root namespace map (`$stat`, `cfg`, `ch`, `bus`, `main`, ...) plus links to per-category detail tables. |
| [`05-node-tree/io-patch.md`](./05-node-tree/io-patch.md) | Input/output patch, stereo pairs, internal taps, user signals, strip identity (`clink`, `$name`), integer and string encoding quirks — verified on hardware. |
| [`06-scenes-and-library.md`](./06-scenes-and-library.md) | The Shows/Scenes/Snaps/Snippets/Presets/Tags conceptual model and the scene-recall recipe. |
| [`07-value-encoding.md`](./07-value-encoding.md) | How values are encoded on the wire: dB and `-oo`, booleans, enums, `$`-shadow addresses, hash addressing. |
| [`08-model-differences.md`](./08-model-differences.md) | Hardware differences between WING Standard, WING Rack, and WING Compact. |
| [`09-error-codes.md`](./09-error-codes.md) | Bulk-set ACK status codes and the protocol's known limitations. |

`05-node-tree/` additionally contains per-namespace parameter tables (`channel.md`, `bus.md`, `main.md`,
`matrix.md`, `dca.md`, `mutegroup.md`, and a few more) that are **generated** from
`src/plugins/wing/wing-param-catalog.ts` by `scripts/generate-wing-docs.ts` (run via `npm run docs:gen:wing`).
Each generated file starts with an HTML comment banner saying so — never hand-edit those files; edit the
catalog and regenerate instead. `05-node-tree/README.md` itself is hand-written and is not touched by the
generator.

## MCP resource mapping

The Wing plugin exposes these same files as MCP resources under the `wing-docs://` URI scheme (via a
`ResourceTemplate`), so any MCP client — Claude Desktop, Claude Code, a custom agent — can read this
documentation directly, without filesystem access to the repository. The resource id maps to a file in this
directory:

| Resource id (`wing-docs://{id}`) | File |
|---|---|
| `overview` | `01-overview.md` |
| `osc-protocol` | `02-osc-protocol.md` |
| `native-binary-protocol` | `03-native-binary-protocol.md` |
| `metering` | `04-metering.md` |
| `node-tree` | `05-node-tree/README.md` |
| `node-tree/channel` | `05-node-tree/channel.md` |
| `node-tree/bus` | `05-node-tree/bus.md` |
| `node-tree/main` | `05-node-tree/main.md` |
| `node-tree/matrix` | `05-node-tree/matrix.md` |
| `node-tree/dca` | `05-node-tree/dca.md` |
| `node-tree/mutegroup` | `05-node-tree/mutegroup.md` |
| `node-tree/io-patch` | `05-node-tree/io-patch.md` |
| `scenes-and-library` | `06-scenes-and-library.md` |
| `value-encoding` | `07-value-encoding.md` |
| `model-differences` | `08-model-differences.md` |
| `error-codes` | `09-error-codes.md` |

This table is meant to stay in lockstep with the manifest used by `src/plugins/wing/resources.ts`. Note that
`scripts/generate-wing-docs.ts` also produces a few additional per-namespace files under `05-node-tree/`
(`scenes-library.md`, `system-status.md`, `control-surface.md`, `io-routing.md`, `fx.md`, `config.md`) that
are not individually listed as `wing-docs://` resources above; they remain reachable on disk and can be added
to the manifest later if a finer-grained resource split turns out to be useful.
