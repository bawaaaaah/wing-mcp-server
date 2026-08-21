<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->

# Scenes & Library Node Tree

7 parameters from `WING_PARAM_CATALOG`.

| Path | Type | Range/Enum | Unit | RO | Models | Description |
|---|---|---|---|---|---|---|
| `/$ctl/lib/$scenes` | string |  |  | yes | all | Bare GET returns only the first scene name; use describe('?') for the full list. |
| `/$ctl/lib/$actidx` | int |  |  | yes | all |  |
| `/$ctl/lib/$active` | string |  |  | yes | all |  |
| `/$ctl/lib/$actshow` | string |  |  | yes | all |  |
| `/$ctl/lib/$action` | enum | IDLE, GOPREV, GONEXT, GO, PREV, NEXT, GOTAG |  |  | all | Set $actionidx first, then set $action=GO (or GOTAG for a tag target). |
| `/$ctl/lib/$actionidx` | int | 0..16384 |  |  | all |  |
| `/$ctl/lib/$activeid` | int |  |  | yes | all |  |
