# Metering

Real-time metering (level meters, gate/dynamics gain-reduction meters, RTA bands) is delivered over the binary
protocol described in [`03-native-binary-protocol.md`](./03-native-binary-protocol.md), on channel 3
("Meter Data Requests") of the TCP:2222 connection. It has nothing to do with the OSC control protocol on
UDP:2223 — see [`01-overview.md`](./01-overview.md) for why that split matters. This is the protocol
implemented by `src/plugins/wing/wing-meter-client.ts` (`WingMeterClient`).

## Setup sequence

After selecting channel 3 (`0xdf 0xd3`, see `03-native-binary-protocol.md`), a client goes through this
sequence, entirely as payload bytes on that channel:

1. **`0xd3` + a big-endian 16-bit word**: tells the console which **UDP port** the client is listening on to
   receive meter data. The console will send its meter-frame responses there (see "Response framing" below).
2. **`0xd4` + a big-endian 32-bit long**: an arbitrary **report id** chosen by the client. This value is
   echoed back at the start of every meter frame so the client can correlate frames to a request, and it
   **also serves as the subscription's keepalive**: the client must resend this same `0xd4` command **before
   5 seconds elapse**, or the console tears the meter subscription down. This is a *shorter* timeout than the
   OSC control protocol's 10-second inactivity timeout — do not confuse the two.
3. **`0xdc`** (start of collection) followed by one or more **meter-type tokens** (see below), each followed
   by its 0-based index byte(s) where applicable, followed by **`0xde`** (end of collection): this defines
   exactly which meter groups the console should start streaming.

Sending a new `0xdc ... 0xde` collection block replaces the previously requested set of meter groups; the
`0xd4` keepalive continues to apply to whatever is currently subscribed.

## Meter-type tokens

Each token identifies a class of meterable object; most take a 0-based index byte identifying which instance
of that class (channel number, bus number, etc.) is being requested. `0xa9` (monitor) and `0xaa` (RTA) are
singletons and take no index. `0xab`–`0xaf` are "V2" variants of the indexed groups that additionally report
gate-LED, dynamics-state, and automix-gain words (see the word-count table below).

| Token | Meter group | Index range | Word count |
|---|---|---|---|
| `0xa0` | Channel | 1–40 | 8 (standard) |
| `0xa1` | Aux | 1–8 | 8 (standard) |
| `0xa2` | Bus | 1–16 | 8 (standard) |
| `0xa3` | Main | 1–4 | 8 (standard) |
| `0xa4` | Matrix | 1–8 | 8 (standard) |
| `0xa5` | DCA | 1–8 | 4 |
| `0xa6` | FX | 1–16 | 10 |
| `0xa7` | Source | — | (source-dependent) |
| `0xa8` | Output | — | (output-dependent) |
| `0xa9` | Monitor | none (singleton) | 6 |
| `0xaa` | RTA | none (singleton) | 120 |
| `0xab`–`0xaf` | V2 variants of channel / aux / bus / main / matrix | same as base group | 11 |

### Word layout per group

The number of `int16` words returned per requested group instance depends on the group:

| Group | Words | Layout |
|---|---|---|
| Channel / Aux / Bus / Main / Matrix (standard, `0xa0`–`0xa4`) | 8 | `inL, inR, outL, outR, gateKey, gateGain, dynKey, dynGain` |
| Channel / Aux / Bus / Main / Matrix (V2, `0xab`–`0xaf`) | 11 | same 8 as above, **plus** `gateLed, dynState, automixGain` |
| DCA (`0xa5`) | 4 | (level-related words for the DCA) |
| FX (`0xa6`) | 10 | 4 level words + 6 state words |
| Monitor (`0xa9`) | 6 | `soloL, soloR, mon1L, mon1R, mon2L, mon2R` |
| RTA (`0xaa`) | 120 | 120 frequency bands |

## Response framing (UDP)

Once subscribed, the console streams meter frames to the UDP port the client registered in step 1 above.
Each UDP datagram is:

```
<report id: 4 bytes, big-endian><words: int16, big-endian, one after another>
```

The `report id` at the start of every frame is the same 32-bit value the client sent in the `0xd4` setup step,
letting the client verify the frame belongs to its own active subscription (and disambiguate frames if it were
ever managing more than one). The rest of the datagram is simply a flat, back-to-back sequence of `int16`
words covering every requested meter group instance, in the order they were requested in the `0xdc ... 0xde`
collection block.

## dB conversion

Raw `int16` words are not dB values directly — they need a conversion, and the conversion formula depends on
which kind of meter the word came from:

| Meter kind | Formula |
|---|---|
| Standard level/gain-reduction meters (the general case: channel/aux/bus/main/matrix/DCA/monitor words) | `dB = word / 256` |
| RTA band words | `dB = word / 128` |
| FX **state** meters specifically (the 6 state words within the 10-word FX group) | `dB = word * 6.0 / 2048` |

The RTA exception is not in the protocol reference — it was measured on hardware: a 10 dB oscillator level
change moved every band by ~5 dB under `/256`. The RTA's 120 bands are 1/12 octave starting at 20 Hz (also
verified with a sine sweep). Everything else uses the general `word / 256` formula.

## Update rate and window

Once a subscription is active, the console streams meter frames at roughly **20 Hz** for a **5-second window**
following the initial request (or any renewal). Because the subscription window is 5 seconds and the
keepalive (`0xd4`) must be resent before that window elapses, a client that wants continuous, uninterrupted
metering needs to keep re-sending the keepalive well inside that 5-second budget — `WingMeterClient`'s default
`keepaliveIntervalMs` (3000ms) is set comfortably below the 5-second cutoff for exactly this reason.
