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
| `/main/{n}/col` | int | 1..18 |  |  | all | 1=Blue, 2=Azure, 3=Indigo, 4=Turquoise, 5=Green, 6=Lime, 7=Yellow, 8=Brown, 9=Red, 10=Salmon, 11=Magenta, 12=Purple, 13=Amber, 14=Sky Blue, 15=Orange Red, 16=Mint Green, 17=Gray, 18=White |
| `/main/{n}/icon` | int | 0..999 |  |  | all | General [0-14]: 0=Vide, 1=XLR, 2=Jack TRS, 3=Mini-Jack TRS, 4=RCA, 5=Faders / EQ, 6=FX, 7=Routing / Modular, 8=Clé de fa (bass), 9=Clé de sol (treble), 10=Multi-EQ / Matrix faders, 11=Sends / Bus arrows, 12=Multi-out / Parallel lines, 13=Smiley, 14=W \| Vocals & Mics [100-114]: 100=Micro main (handheld), 101=Micro main à boule, 102=Micro sans fil (wireless), 103=Micro canon (shotgun), 104=Micro scène / broadcast, 105=Micro pupitre (gooseneck / podium), 106=Micro sur pied, 107=Casque-micro (headset), 108=Casque avec micro (over-ear), 109=Micro studio vertical, 110=Micro vintage / ruban, 111=Micro condensateur, 112=Chœur / groupe, 113=Chanteuse (femme), 114=Chanteur (homme) \| Drums & Percussion [200-224]: 200=Grosse caisse (kick), 201=Caisse claire (snare), 202=Caisse claire + baguettes, 203=Tom, 204=Tom + baguettes, 205=Charleston (hi-hat), 206=Tom aigu (H), 207=Tom medium (M), 208=Tom grave (L), 209=Floor tom (F), 210=Batterie complète, 211=Cymbale crash (C), 212=Cymbale ride (R), 213=Cowbell, 214=Tambourin, 215=Congas, 216=Bongos, 217=Timbales / grosse percussion, 218=Cajón, 219=Maracas, 220=Xylophone / vibraphone, 221=Cymbale / splash, 222=Triangle, 223=Boîte à rythmes / pad électronique, 224=Claquements de mains (clap) \| Strings & Winds [300-319]: 300=Guitare électrique, 301=Guitare acoustique, 302=Guitare classique, 303=Banjo, 304=Guitare folk / ukulélé, 305=Guitare électrique (type Strat), 306=Guitare électrique (type SG), 307=Guitare électrique (Flying V), 308=Guitare électrique double manche, 309=Basse électrique, 310=Violon, 311=Clarinette, 312=Saxophone, 313=Trombone, 314=Trompette, 315=Harpe, 316=Accordéon, 317=Harmonica / mélodica, 318=Flûte, 319=Hautbois / clarinette basse \| Keys [400-409]: 400=Piano à queue, 401=Piano droit / piano électrique, 402=Synthétiseur / workstation, 403=Clavier avec pads, 404=Piano de scène / digital piano, 405=Synthétiseur, 406=Keytar, 407=Clavier sur pied, 408=Clavier sur stand en X, 409=Orgue / clavier double manuel \| Speakers [500-524]: 500=Ampli guitare (combo), 501=Ampli basse / stack, 502=Ampli 4 haut-parleurs, 503=Enceinte PA, 504=Moniteurs de studio (paire), 505=Enceinte + micro, 506=Caisson de basse (sub), 507=Enceinte pleine bande, 508=Enceinte double horizontale, 509=Enceintes sur pied (paire), 510=Enceintes murales / stéréo, 511=Enceinte suspendue, 512=Enceinte sur pied, 513=Enceintes sur mât (paire), 514=Enceintes avec délai (Δt), 515=Enceinte gauche (L), 516=Enceinte droite (R), 517=Enceinte centrale / double, 518=Colonne PA, 519=Enceintes PA (paire), 520=Retour de scène (wedge gauche), 521=Retour de scène (wedge droit), 522=Moniteur de sol (wedge), 523=Line array / enceinte courbe, 524=Enceinte plafond / suspendue \| Specials [600-614]: 600=Signe rock (cornes), 601=Oreille (écoute), 602=Casque, 603=Piste A, 604=Piste B, 605=Ordinateur portable, 606=Lecteur multimédia / iPod, 607=Smartphone, 608=Clé USB, 609=Carte mémoire / SD, 610=CD / disque, 611=Vinyle / platine, 612=Magnétophone à bandes, 613=Cassette, 614=Serveur / baie de disques |
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
