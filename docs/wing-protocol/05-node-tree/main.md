<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->

# Main Node Tree

90 parameters from `WING_PARAM_CATALOG`.

| Path | Type | Range/Enum | Unit | RO | Models | Description |
|---|---|---|---|---|---|---|
| `/main/{n}/fdr` | float | -144..10 | dB |  | all | 1024 steps; -144 renders as "-oo". |
| `/main/{n}/mute` | int | 0..1 |  |  | all |  |
| `/main/{n}/pan` | float | -100..100 |  |  | all |  |
| `/main/{n}/wid` | float | -150..150 |  |  | all |  |
| `/main/{n}/busmono` | int | 0..1 |  |  | all |  |
| `/main/{n}/name` | string |  |  |  | all | Up to 16 characters. |
| `/main/{n}/col` | int | 1..18 |  |  | all |  |
| `/main/{n}/icon` | int | 0..999 |  |  | all |  |
| `/main/{n}/led` | int | 0..1 |  |  | all |  |
| `/main/{n}/eq/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/eq/tilt` | float | -12..12 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/eq/1g` | float | -15..15 | dB |  | all |  |
| `/main/{n}/eq/1f` | float | 20..20000 | Hz |  | all |  |
| `/main/{n}/eq/1q` | float | 0.3..8 |  |  | all |  |
| `/main/{n}/eq/2g` | float | -15..15 | dB |  | all |  |
| `/main/{n}/eq/2f` | float | 20..20000 | Hz |  | all |  |
| `/main/{n}/eq/2q` | float | 0.3..8 |  |  | all |  |
| `/main/{n}/eq/3g` | float | -15..15 | dB |  | all |  |
| `/main/{n}/eq/3f` | float | 20..20000 | Hz |  | all |  |
| `/main/{n}/eq/3q` | float | 0.3..8 |  |  | all |  |
| `/main/{n}/eq/4g` | float | -15..15 | dB |  | all |  |
| `/main/{n}/eq/4f` | float | 20..20000 | Hz |  | all |  |
| `/main/{n}/eq/4q` | float | 0.3..8 |  |  | all |  |
| `/main/{n}/eq/5g` | float | -15..15 | dB |  | all |  |
| `/main/{n}/eq/5f` | float | 20..20000 | Hz |  | all |  |
| `/main/{n}/eq/5q` | float | 0.3..8 |  |  | all |  |
| `/main/{n}/eq/6g` | float | -15..15 | dB |  | all |  |
| `/main/{n}/eq/6f` | float | 20..20000 | Hz |  | all |  |
| `/main/{n}/eq/6q` | float | 0.3..8 |  |  | all |  |
| `/main/{n}/dyn/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/dyn/mdl` | string |  |  |  | all | Compressor model selector; not individually enumerated. Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/dyn/thr` | float | -60..0 | dB |  | all |  |
| `/main/{n}/dyn/ratio` | float | 1.1..100 |  |  | all |  |
| `/main/{n}/dyn/knee` | float | 0..10 |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/dyn/det` | enum | PEAK, RMS |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/dyn/att` | float | 0..100 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/dyn/hld` | float | 0..2000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/dyn/rel` | float | 0..4000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/dyn/env` | string |  |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/dyn/auto` | int | 0..1 |  |  | all |  |
| `/main/{n}/dyn/mix` | float | 0..100 | % |  | all |  |
| `/main/{n}/dyn/gain` | float | -20..20 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX1/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX1/lvl` | float | -144..10 | dB |  | all |  |
| `/main/{n}/send/MX1/pon` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX1/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX1/plink` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX1/pan` | float | -100..100 |  |  | all |  |
| `/main/{n}/send/MX2/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX2/lvl` | float | -144..10 | dB |  | all |  |
| `/main/{n}/send/MX2/pon` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX2/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX2/plink` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX2/pan` | float | -100..100 |  |  | all |  |
| `/main/{n}/send/MX3/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX3/lvl` | float | -144..10 | dB |  | all |  |
| `/main/{n}/send/MX3/pon` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX3/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX3/plink` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX3/pan` | float | -100..100 |  |  | all |  |
| `/main/{n}/send/MX4/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX4/lvl` | float | -144..10 | dB |  | all |  |
| `/main/{n}/send/MX4/pon` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX4/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX4/plink` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX4/pan` | float | -100..100 |  |  | all |  |
| `/main/{n}/send/MX5/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX5/lvl` | float | -144..10 | dB |  | all |  |
| `/main/{n}/send/MX5/pon` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX5/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX5/plink` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX5/pan` | float | -100..100 |  |  | all |  |
| `/main/{n}/send/MX6/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX6/lvl` | float | -144..10 | dB |  | all |  |
| `/main/{n}/send/MX6/pon` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX6/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX6/plink` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX6/pan` | float | -100..100 |  |  | all |  |
| `/main/{n}/send/MX7/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX7/lvl` | float | -144..10 | dB |  | all |  |
| `/main/{n}/send/MX7/pon` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX7/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX7/plink` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX7/pan` | float | -100..100 |  |  | all |  |
| `/main/{n}/send/MX8/on` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX8/lvl` | float | -144..10 | dB |  | all |  |
| `/main/{n}/send/MX8/pon` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX8/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/main/{n}/send/MX8/plink` | int | 0..1 |  |  | all |  |
| `/main/{n}/send/MX8/pan` | float | -100..100 |  |  | all |  |
