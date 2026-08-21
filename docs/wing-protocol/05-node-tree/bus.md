<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->

# Bus Node Tree

198 parameters from `WING_PARAM_CATALOG`.

| Path | Type | Range/Enum | Unit | RO | Models | Description |
|---|---|---|---|---|---|---|
| `/bus/{n}/fdr` | float | -144..10 | dB |  | all | 1024 steps; -144 renders as "-oo". |
| `/bus/{n}/mute` | int | 0..1 |  |  | all |  |
| `/bus/{n}/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/wid` | float | -150..150 |  |  | all |  |
| `/bus/{n}/busmono` | int | 0..1 |  |  | all |  |
| `/bus/{n}/name` | string |  |  |  | all | Up to 16 characters. |
| `/bus/{n}/col` | int | 1..18 |  |  | all |  |
| `/bus/{n}/icon` | int | 0..999 |  |  | all |  |
| `/bus/{n}/led` | int | 0..1 |  |  | all |  |
| `/bus/{n}/eq/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/eq/tilt` | float | -12..12 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/eq/1g` | float | -15..15 | dB |  | all |  |
| `/bus/{n}/eq/1f` | float | 20..20000 | Hz |  | all |  |
| `/bus/{n}/eq/1q` | float | 0.3..8 |  |  | all |  |
| `/bus/{n}/eq/2g` | float | -15..15 | dB |  | all |  |
| `/bus/{n}/eq/2f` | float | 20..20000 | Hz |  | all |  |
| `/bus/{n}/eq/2q` | float | 0.3..8 |  |  | all |  |
| `/bus/{n}/eq/3g` | float | -15..15 | dB |  | all |  |
| `/bus/{n}/eq/3f` | float | 20..20000 | Hz |  | all |  |
| `/bus/{n}/eq/3q` | float | 0.3..8 |  |  | all |  |
| `/bus/{n}/eq/4g` | float | -15..15 | dB |  | all |  |
| `/bus/{n}/eq/4f` | float | 20..20000 | Hz |  | all |  |
| `/bus/{n}/eq/4q` | float | 0.3..8 |  |  | all |  |
| `/bus/{n}/eq/5g` | float | -15..15 | dB |  | all |  |
| `/bus/{n}/eq/5f` | float | 20..20000 | Hz |  | all |  |
| `/bus/{n}/eq/5q` | float | 0.3..8 |  |  | all |  |
| `/bus/{n}/eq/6g` | float | -15..15 | dB |  | all |  |
| `/bus/{n}/eq/6f` | float | 20..20000 | Hz |  | all |  |
| `/bus/{n}/eq/6q` | float | 0.3..8 |  |  | all |  |
| `/bus/{n}/dyn/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/dyn/mdl` | string |  |  |  | all | Compressor model selector; not individually enumerated. Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/dyn/thr` | float | -60..0 | dB |  | all |  |
| `/bus/{n}/dyn/ratio` | float | 1.1..100 |  |  | all |  |
| `/bus/{n}/dyn/knee` | float | 0..10 |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/dyn/det` | enum | PEAK, RMS |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/dyn/att` | float | 0..100 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/dyn/hld` | float | 0..2000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/dyn/rel` | float | 0..4000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/dyn/env` | string |  |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/dyn/auto` | int | 0..1 |  |  | all |  |
| `/bus/{n}/dyn/mix` | float | 0..100 | % |  | all |  |
| `/bus/{n}/dyn/gain` | float | -20..20 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/1/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/1/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/1/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/1/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/1/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/1/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/2/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/2/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/2/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/2/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/2/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/2/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/3/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/3/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/3/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/3/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/3/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/3/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/4/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/4/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/4/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/4/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/4/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/4/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/5/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/5/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/5/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/5/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/5/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/5/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/6/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/6/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/6/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/6/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/6/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/6/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/7/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/7/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/7/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/7/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/7/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/7/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/8/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/8/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/8/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/8/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/8/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/8/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/9/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/9/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/9/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/9/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/9/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/9/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/10/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/10/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/10/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/10/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/10/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/10/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/11/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/11/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/11/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/11/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/11/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/11/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/12/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/12/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/12/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/12/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/12/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/12/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/13/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/13/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/13/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/13/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/13/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/13/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/14/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/14/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/14/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/14/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/14/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/14/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/15/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/15/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/15/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/15/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/15/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/15/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/16/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/16/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/16/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/16/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/16/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/16/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/MX1/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX1/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/MX1/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX1/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/MX1/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX1/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/MX2/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX2/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/MX2/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX2/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/MX2/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX2/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/MX3/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX3/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/MX3/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX3/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/MX3/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX3/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/MX4/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX4/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/MX4/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX4/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/MX4/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX4/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/MX5/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX5/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/MX5/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX5/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/MX5/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX5/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/MX6/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX6/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/MX6/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX6/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/MX6/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX6/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/MX7/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX7/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/MX7/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX7/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/MX7/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX7/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/send/MX8/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX8/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/send/MX8/pon` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX8/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/bus/{n}/send/MX8/plink` | int | 0..1 |  |  | all |  |
| `/bus/{n}/send/MX8/pan` | float | -100..100 |  |  | all |  |
| `/bus/{n}/main/1/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/main/1/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/main/1/pre` | int | 0..1 |  |  | all |  |
| `/bus/{n}/main/2/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/main/2/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/main/2/pre` | int | 0..1 |  |  | all |  |
| `/bus/{n}/main/3/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/main/3/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/main/3/pre` | int | 0..1 |  |  | all |  |
| `/bus/{n}/main/4/on` | int | 0..1 |  |  | all |  |
| `/bus/{n}/main/4/lvl` | float | -144..10 | dB |  | all |  |
| `/bus/{n}/main/4/pre` | int | 0..1 |  |  | all |  |
