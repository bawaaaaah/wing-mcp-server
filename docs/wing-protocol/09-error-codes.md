# Error Codes & Known Limitations

## Bulk-set acknowledgement status codes

Every write done through the compact bulk-set-with-acknowledgement OSC form (see
[`02-osc-protocol.md`](./02-osc-protocol.md#set--compact-bulk-form-with-acknowledgement)) — which is how this
project performs **every** write against the console — comes back with exactly one of the following string
statuses:

| Status | Meaning |
|---|---|
| `OK` | The assignment(s) in the request were applied successfully. |
| `NODE NOT FOUND` | One of the `key=value` assignments' keys does not resolve to an existing node under the request's base address. |
| `VALUE ERROR` | A supplied value is out of range, or of the wrong type/format, for the parameter it targets. |
| `BUFFER OVERFLOW` | The request payload was too large for the console to process in one go. |
| `NODE IS NOT PAR` | The target node exists but is not a settable parameter (e.g. it is a branch/container node, not a leaf). |
| `INCOMPLETE DATA` | The `key=value` payload itself was malformed or truncated before the console could fully parse it. |
| `STACK EMPTY` | Returned when there is nothing left to process for the request, an edge case of the console's internal request-handling state. |

This is the mechanism this project's tools rely on to know whether a `wing_set` / `wing_bulk_set` call
actually succeeded — see the `WingBulkSetResult` type used throughout `src/plugins/wing/`.

## Known limitations

These are limitations of the WING protocol itself (as documented by the manufacturer), not limitations
specific to this project's implementation — they are called out here so they're not mistaken for bugs:

- **32 KB maximum UDP packet size.** OSC responses — most notably full-subtree dumps (`*`, see
  [`02-osc-protocol.md`](./02-osc-protocol.md#dump--full-subtree-)) — are not fragmented across multiple
  packets. A dump request whose response would exceed 32 KB (dumping a root or a whole top-level namespace
  like `/ch`) simply fails rather than being split; only per-index subtrees (`/ch/1`, `/bus/2`, ...) are safe
  to dump.
- **No authentication of any kind.** Both the OSC control protocol (UDP:2223) and the binary metering
  protocol (TCP:2222) trust any client that can reach them on the network — there is no login, token, or
  pairing step at the protocol level. Access control is a network-boundary concern, not a protocol-level one.
- **Inactivity timeouts differ between the two protocols and are short.** The OSC control protocol
  (subscriptions in particular) drops after **10 seconds** of inactivity and must be renewed; the binary
  metering protocol's keepalive (the `0xd4` report-id resend) must arrive within **5 seconds** or the meter
  subscription is torn down. See [`02-osc-protocol.md`](./02-osc-protocol.md#subscribe--change-notifications)
  and [`04-metering.md`](./04-metering.md#setup-sequence) respectively.
- **An invalid GET address produces no response at all**, which makes it indistinguishable, from the client's
  point of view, from an ordinary network timeout. There is no explicit "path not found" error for a bare
  GET the way there is for a bulk-set (`NODE NOT FOUND`, above) — that explicit error only exists on the
  bulk-set/write path, not on plain reads.
- **The source specification is internally inconsistent about the maximum number of simultaneous
  connections**: its general overview section states 24, while its chapter on the binary protocol states 16.
  This project does not attempt to resolve which figure is authoritative; it implements defensively by never
  assuming more than the more conservative figure (16) is safe, as noted in
  [`02-osc-protocol.md`](./02-osc-protocol.md#connection-limit-inconsistency).
