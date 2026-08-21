<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->

# DCA Node Tree

8 parameters from `WING_PARAM_CATALOG`.

| Path | Type | Range/Enum | Unit | RO | Models | Description |
|---|---|---|---|---|---|---|
| `/dca/{n}/name` | string |  |  |  | all | Up to 8 characters. |
| `/dca/{n}/col` | int | 1..18 |  |  | all |  |
| `/dca/{n}/icon` | int | 0..999 |  |  | all |  |
| `/dca/{n}/led` | int | 0..1 |  |  | all |  |
| `/dca/{n}/mute` | int | 0..1 |  |  | all |  |
| `/dca/{n}/fdr` | float | -144..10 | dB |  | all |  |
| `/dca/{n}/$solo` | int | 0..1 |  | yes | all |  |
| `/dca/{n}/mon` | enum | A, B, A+B |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
