# Bridge: tablets and apps through the server

The bridge lets apps connect to this server instead of the console:

- **OSC apps** (TouchOSC, Companion, ...) on UDP `bridgeOscPort` (2223 by default).
- **The console's own apps**, WING-Q, Co-Pilot and WING Edit, on TCP `bridgeNativePort` (2222 by default,
  the native protocol). With `bridgeDiscovery` on, the server also answers their `WING?` search, so they
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
scenes (`/$ctl/lib`) or change `/cfg`.

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

## Not verified yet: the beta label

The native proxy was built from the protocol documentation and libwing, and tested against a simulated
console. These points need a real tablet to confirm: run `npm run wing:capture` first (see the capture
section of the protocol doc).

| | Assumption | If wrong |
|---|---|---|
| A1 | WING-Q uses only discovery (UDP 2222) and the native protocol (TCP 2222), no WebSocket | the app never connects to the bridge |
| A2 | Apps accept the bridge's name and the serial `<serial>-BR` | set `bridgeSerialMode: real` |
| A4 | The console pushes every change to every native connection, without a request | tablets miss changes made elsewhere |
| A5 | Replies come in request order and end with `0xde` | requests time out; three in a row reset the console link |
| A6 | The console does not echo a write to the connection that made it | harmless: tablets get the value twice |
| A7 | OSC `/#<hash>` addresses are native ids | `/#` writes stay refused while anything is safe |
| A9 | Apps navigate mostly by id | writes after unmapped relative steps are refused while anything is safe |
| A11 | Apps accept meter packets from any source port | meters stay blank |
| A15 | Changing a processing model renumbers the nodes under it | handled by re-mapping in any case |

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
