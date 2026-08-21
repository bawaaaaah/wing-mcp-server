<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->

# Matrix Node Tree

46 parameters from `WING_PARAM_CATALOG`.

| Path | Type | Range/Enum | Unit | RO | Models | Description |
|---|---|---|---|---|---|---|
| `/mtx/{n}/fdr` | float | -144..10 | dB |  | all | 1024 steps; -144 renders as "-oo". |
| `/mtx/{n}/mute` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/pan` | float | -100..100 |  |  | all |  |
| `/mtx/{n}/wid` | float | -150..150 |  |  | all |  |
| `/mtx/{n}/busmono` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/name` | string |  |  |  | all | Up to 16 characters. |
| `/mtx/{n}/col` | int | 1..18 |  |  | all |  |
| `/mtx/{n}/icon` | int | 0..999 |  |  | all |  |
| `/mtx/{n}/led` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/eq/on` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/eq/tilt` | float | -12..12 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/eq/1g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/1f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/1q` | float | 0.3..8 |  |  | all |  |
| `/mtx/{n}/eq/2g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/2f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/2q` | float | 0.3..8 |  |  | all |  |
| `/mtx/{n}/eq/3g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/3f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/3q` | float | 0.3..8 |  |  | all |  |
| `/mtx/{n}/eq/4g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/4f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/4q` | float | 0.3..8 |  |  | all |  |
| `/mtx/{n}/eq/5g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/5f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/5q` | float | 0.3..8 |  |  | all |  |
| `/mtx/{n}/eq/6g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/6f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/6q` | float | 0.3..8 |  |  | all |  |
| `/mtx/{n}/dyn/on` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/dyn/mdl` | string |  |  |  | all | Compressor model selector; not individually enumerated. Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dyn/thr` | float | -60..0 | dB |  | all |  |
| `/mtx/{n}/dyn/ratio` | float | 1.1..100 |  |  | all |  |
| `/mtx/{n}/dyn/knee` | float | 0..10 |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dyn/det` | enum | PEAK, RMS |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dyn/att` | float | 0..100 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dyn/hld` | float | 0..2000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dyn/rel` | float | 0..4000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dyn/env` | string |  |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dyn/auto` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/dyn/mix` | float | 0..100 | % |  | all |  |
| `/mtx/{n}/dyn/gain` | float | -20..20 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dir/on` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/dir/lvl` | float | -144..10 | dB |  | all |  |
| `/mtx/{n}/dir/inv` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/dir/in` | enum | OFF, AES, MON.PH, MON.SPK, MON.BUS |  |  | all |  |
