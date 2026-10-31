# Bridge: tablets and apps through the server

The bridge lets apps connect to this server instead of the console:

- **OSC apps** (TouchOSC, Companion, ...) on UDP `bridgeOscPort` (2223 by default).
- **The console's own apps**, WING-Q, Co-Pilot and WING Edit, on TCP `bridgeNativePort` (2222 by default,
  the native protocol). WING Edit speaks it raw; WING-Q (a WebView app) sends the same stream as binary
  messages of a WebSocket opened on that port — the bridge, like the console, accepts both. With `bridgeDiscovery` on, the server also answers their `WING?` search, so they
  list it next to the console (as `<console name>-BR` unless `bridgeName` is set).

Two reasons to do this:

1. **Fewer connections on the console.** The WING accepts only one OSC subscriber, and 16 TCP clients (24
   from firmware 3.1.1). Through the bridge, every OSC app shares the server's own subscription, and every
   native app shares one TCP connection. Their meters come from the server's own meter stream.
2. **Safe strips.** Strips marked safe cannot be changed by a bridged app. MCP tools and the dashboard are
   not restricted (show mode exists for them).

Turn it on from the dashboard (Wing > Bridge), with `wing_bridge_configure`, or in the config
([configuration.md](configuration.md)). Changing it never reconnects the console.

## What a safe protects

Sends belong to their destination:

| Safe | Protects | Does not protect |
|---|---|---|
| Channel / aux N | the strip, and the input it is patched from (main and alt source, both halves of a stereo pair) | its sends and main assigns |
| Bus N | the bus, and every send into it from channels, auxes and buses | its own sends to matrices and mains |
| Main N | the main, and every assign into it | its own sends to matrices |
| Matrix N | the matrix, and every send into it | — |
| DCA N | the DCA | the strips assigned to it |

With `bridgeProtectGlobal` (on by default), as soon as anything is safe, bridged apps also cannot recall
scenes (`/$ctl/lib`) or change `/cfg` — solo included, since it changes what the engineer hears — except
`/cfg/rta`: WING-Q picks the RTA's source there, which changes no sound.

### Per-device profiles

A profile gives one device its own rights. It is recognised by every criterion it gives: IP, MAC address
(read from the server's ARP table, so only for devices on the same network; Android and iOS use a random
MAC per network, stable on a given network) and model (WING-Q sends it, e.g. `SM-X700`; WING Edit does
not). Two kinds:

- **Only these strips** (`mode: "allow"`): everything is read-only for the device except the strips listed
  — and, for a bus, main or matrix, every send into it. With `scope: "mix"` (default): the allowed bus,
  main or matrix itself entirely (EQ, compression, inserts, fader...: it is the device's own mix); on every
  send into it, the mixing controls only (level, on, pan, pre/post, pan link); on an allowed channel, aux
  or DCA, only its fader, mute and pan, since its processing reaches every mix. Its inserts can be switched
  on and off and the FX loaded in them adjusted, but which FX is loaded, and that FX's model, stay the
  engineer's (the bridge follows the slot inserted, live; while it is unknown, no FX is writable). A channel's `tapwid` stays
  read-only for the same reason. With `scope: "full"`, everything about them. Typical: a musician's tablet
  that may only mix its in-ear bus.
- **Extra safes** (`mode: "safes"`): more safe strips for that device only.

Global safes always apply on top; a device no profile matches gets the global safes. The Bridge tab lists
connected apps with their MAC, model and profile, and creates a profile from one in a click. While a
device is first identified (a few milliseconds, when a profile keys on MAC), its writes are refused, never
let through.

A refused write never reaches the console. The app is sent the real value right after, so its control
snaps back. Refusals are listed in the Bridge tab and in `wing_bridge_status`.

**Safes only hold if the apps cannot reach the console directly.** Otherwise a tablet can pick the console
itself in its list, or type its address. Put the console on a network the tablets cannot reach (a second
network interface on the server, with `bridgeBindAddress` set to the tablet side, a VLAN, or a firewall).

## How native apps share one connection

The native protocol keeps a "current node" per connection, moved by navigation tokens (to an id, to the
root, up, to a child by index or name), then reads or writes it (see
[wing-protocol/03-native-binary-protocol.md](wing-protocol/03-native-binary-protocol.md)).

- Each tablet keeps its own position. Each request or write goes upstream as one self-contained unit:
  the position (`0xd7 id`, or the tablet's exact steps), then the action.
- Replies come back in request order. Definition listings and the closing `0xde` go to the tablet that
  asked. Values go to every tablet: they are state, as the console's own change pushes are.
- An accepted write is passed on to the other tablets at once, then read back so everyone settles on
  what the console stored.
- Safes are written as paths, but native apps address nodes by id. The bridge maps ids to paths by
  listing node definitions: the protected subtrees and every node above them. While that map is being
  built (when the first tablet connects, and again when the safes, a safe strip's patch, or a processing
  model under it change), native writes wait. A write the bridge cannot place (unmapped relative steps)
  is refused while anything is safe.
- Meters: each tablet's meter request is added to the server's own subscription, and every frame is
  re-cut into each tablet's packet (its report id, its groups, its order).
- If the console connection drops, the tablets are disconnected so they reconnect and resync.

## What captures confirmed, and what is still open: the beta label

Captured 2026-10-31 on a WING Rack (fw 3.1.1) with WING Edit (macOS) and WING-Q (Android, Galaxy Tab
S8), writes blocked (`npm run wing:capture`, see the capture section of the protocol doc):

| | Finding |
|---|---|
| A1 | **WING Edit: raw native protocol on TCP 2222. WING-Q: a WebSocket on `ws://<console>:2222/`** (origin `http://localhost`, no compression accepted by the console), whose binary messages carry the same native stream, channel selects and escapes included. Both use discovery on UDP 2222. |
| A2 | WING-Q lists the relay's entry (own name, derived serial) next to the console and connects to it. |
| A3 | Token table and definition records as documented: no unknown token, no unparsed record in ~180,000 tokens. |
| A4 | The console pushes changes to every connection without a request. |
| A5 | One read on the root answers the whole tree (~30,000 values, `0xd7 id value` pairs) then `0xde`; a read on one node answers `0xd7 id value 0xde`; a definition request on a leaf answers its own record then `0xde`. |
| A9 | Both apps navigate by id only (one root read at start-up). WING-Q re-selects channel 1 before every message. |
| A10 | Meter report ids are renewed every ~4–5 s; WING Edit does not re-select channel 1 as a keepalive. |
| A11 | Both apps announce a UDP port on channel 3 (WING-Q too, despite the WebView) and ask for V2 strip groups (`channelV2`, `busV2`, ...) and `source`. The console sends meters from UDP 2222; the bridge does the same when discovery is on. |

Still open (need writes, so a scratch parameter and your go-ahead): **A6**, whether the console echoes a
write to the connection that made it (if it does, tablets just get the value twice); **A7**, whether OSC
`/#<hash>` addresses are native ids (until then `/#` writes are refused while anything is safe); **A15**,
whether changing a processing model renumbers the nodes under it (re-mapped in any case).

## Deployment notes

- **Ports.** The bridge takes the console's port numbers on the server's address (2222 TCP and UDP, 2223
  UDP). Nothing else on the server may hold them. When the console is on the same machine (fake-wing),
  use other ports, e.g. 3222 and 3223, and leave discovery off.
- **Docker.** On Linux, use host networking: discovery needs broadcasts, and meters go back to each
  tablet's address. In NAT mode, publish `2222/tcp`, `2222/udp` and `2223/udp`, set `bridgeAdvertiseHost`
  to the host's address, and have tablets enter it by hand (broadcasts do not reach the container).
  Docker Desktop rewrites client addresses: not suitable.
- **Console connections used.** The server's own OSC client and meter connection, plus one TCP connection
  while at least one native app is connected (closed 30 s after the last one leaves).
