<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->

# Channel Node Tree

214 parameters from `WING_PARAM_CATALOG`.

| Path | Type | Range/Enum | Unit | RO | Models | Description |
|---|---|---|---|---|---|---|
| `/ch/{n}/fdr` | float | -144..10 | dB |  | all | 1024 steps; -144 renders as "-oo". |
| `/ch/{n}/mute` | int | 0..1 |  |  | all |  |
| `/ch/{n}/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/wid` | float | -150..150 |  |  | all |  |
| `/ch/{n}/name` | string |  |  |  | all | Up to 16 characters. |
| `/ch/{n}/col` | int | 1..18 |  |  | all | 1=Blue, 2=Azure, 3=Indigo, 4=Turquoise, 5=Green, 6=Lime, 7=Yellow, 8=Brown, 9=Red, 10=Salmon, 11=Magenta, 12=Purple, 13=Amber, 14=Sky Blue, 15=Orange Red, 16=Mint Green, 17=Gray, 18=White |
| `/ch/{n}/icon` | int | 0..999 |  |  | all | General [0-14]: 0=Vide, 1=XLR, 2=Jack TRS, 3=Mini-Jack TRS, 4=RCA, 5=Faders / EQ, 6=FX, 7=Routing / Modular, 8=Clé de fa (bass), 9=Clé de sol (treble), 10=Multi-EQ / Matrix faders, 11=Sends / Bus arrows, 12=Multi-out / Parallel lines, 13=Smiley, 14=W \| Vocals & Mics [100-114]: 100=Micro main (handheld), 101=Micro main à boule, 102=Micro sans fil (wireless), 103=Micro canon (shotgun), 104=Micro scène / broadcast, 105=Micro pupitre (gooseneck / podium), 106=Micro sur pied, 107=Casque-micro (headset), 108=Casque avec micro (over-ear), 109=Micro studio vertical, 110=Micro vintage / ruban, 111=Micro condensateur, 112=Chœur / groupe, 113=Chanteuse (femme), 114=Chanteur (homme) \| Drums & Percussion [200-224]: 200=Grosse caisse (kick), 201=Caisse claire (snare), 202=Caisse claire + baguettes, 203=Tom, 204=Tom + baguettes, 205=Charleston (hi-hat), 206=Tom aigu (H), 207=Tom medium (M), 208=Tom grave (L), 209=Floor tom (F), 210=Batterie complète, 211=Cymbale crash (C), 212=Cymbale ride (R), 213=Cowbell, 214=Tambourin, 215=Congas, 216=Bongos, 217=Timbales / grosse percussion, 218=Cajón, 219=Maracas, 220=Xylophone / vibraphone, 221=Cymbale / splash, 222=Triangle, 223=Boîte à rythmes / pad électronique, 224=Claquements de mains (clap) \| Strings & Winds [300-319]: 300=Guitare électrique, 301=Guitare acoustique, 302=Guitare classique, 303=Banjo, 304=Guitare folk / ukulélé, 305=Guitare électrique (type Strat), 306=Guitare électrique (type SG), 307=Guitare électrique (Flying V), 308=Guitare électrique double manche, 309=Basse électrique, 310=Violon, 311=Clarinette, 312=Saxophone, 313=Trombone, 314=Trompette, 315=Harpe, 316=Accordéon, 317=Harmonica / mélodica, 318=Flûte, 319=Hautbois / clarinette basse \| Keys [400-409]: 400=Piano à queue, 401=Piano droit / piano électrique, 402=Synthétiseur / workstation, 403=Clavier avec pads, 404=Piano de scène / digital piano, 405=Synthétiseur, 406=Keytar, 407=Clavier sur pied, 408=Clavier sur stand en X, 409=Orgue / clavier double manuel \| Speakers [500-524]: 500=Ampli guitare (combo), 501=Ampli basse / stack, 502=Ampli 4 haut-parleurs, 503=Enceinte PA, 504=Moniteurs de studio (paire), 505=Enceinte + micro, 506=Caisson de basse (sub), 507=Enceinte pleine bande, 508=Enceinte double horizontale, 509=Enceintes sur pied (paire), 510=Enceintes murales / stéréo, 511=Enceinte suspendue, 512=Enceinte sur pied, 513=Enceintes sur mât (paire), 514=Enceintes avec délai (Δt), 515=Enceinte gauche (L), 516=Enceinte droite (R), 517=Enceinte centrale / double, 518=Colonne PA, 519=Enceintes PA (paire), 520=Retour de scène (wedge gauche), 521=Retour de scène (wedge droit), 522=Moniteur de sol (wedge), 523=Line array / enceinte courbe, 524=Enceinte plafond / suspendue \| Specials [600-614]: 600=Signe rock (cornes), 601=Oreille (écoute), 602=Casque, 603=Piste A, 604=Piste B, 605=Ordinateur portable, 606=Lecteur multimédia / iPod, 607=Smartphone, 608=Clé USB, 609=Carte mémoire / SD, 610=CD / disque, 611=Vinyle / platine, 612=Magnétophone à bandes, 613=Cassette, 614=Serveur / baie de disques |
| `/ch/{n}/led` | int | 0..1 |  |  | all |  |
| `/ch/{n}/eq/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/eq/mdl` | enum | STD, SOUL, E88, E84, F110, PULSAR, MACH4 |  |  | all |  |
| `/ch/{n}/eq/mix` | float | 0..125 | % |  | all |  |
| `/ch/{n}/eq/lg` | float | -15..15 | dB |  | all |  |
| `/ch/{n}/eq/lf` | float | 20..20000 | Hz |  | all |  |
| `/ch/{n}/eq/lq` | float | 0.44..10 |  |  | all |  |
| `/ch/{n}/eq/leq` | enum | PEQ, SHV |  |  | all |  |
| `/ch/{n}/eq/1g` | float | -15..15 | dB |  | all |  |
| `/ch/{n}/eq/1f` | float | 20..20000 | Hz |  | all |  |
| `/ch/{n}/eq/1q` | float | 0.44..10 |  |  | all |  |
| `/ch/{n}/eq/2g` | float | -15..15 | dB |  | all |  |
| `/ch/{n}/eq/2f` | float | 20..20000 | Hz |  | all |  |
| `/ch/{n}/eq/2q` | float | 0.44..10 |  |  | all |  |
| `/ch/{n}/eq/3g` | float | -15..15 | dB |  | all |  |
| `/ch/{n}/eq/3f` | float | 20..20000 | Hz |  | all |  |
| `/ch/{n}/eq/3q` | float | 0.44..10 |  |  | all |  |
| `/ch/{n}/eq/4g` | float | -15..15 | dB |  | all |  |
| `/ch/{n}/eq/4f` | float | 20..20000 | Hz |  | all |  |
| `/ch/{n}/eq/4q` | float | 0.44..10 |  |  | all |  |
| `/ch/{n}/eq/hg` | float | -15..15 | dB |  | all |  |
| `/ch/{n}/eq/hf` | float | 20..20000 | Hz |  | all |  |
| `/ch/{n}/eq/hq` | float | 0.44..10 |  |  | all |  |
| `/ch/{n}/eq/heq` | enum | PEQ, SHV |  |  | all |  |
| `/ch/{n}/gate/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/gate/mdl` | string |  |  |  | all | 30+ models in firmware; not individually enumerated. Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/gate/thr` | float | -80..0 | dB |  | all |  |
| `/ch/{n}/gate/range` | float | -80..60 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/gate/att` | float | 0..100 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/gate/hld` | float | 0..2000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/gate/rel` | float | 0..4000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/gate/ratio` | float | 1..100 |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/gate/mix` | float | 0..100 | % |  | all |  |
| `/ch/{n}/gate/gain` | float | -20..20 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/dyn/mdl` | string |  |  |  | all | Compressor model selector; not individually enumerated. Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/thr` | float | -60..0 | dB |  | all |  |
| `/ch/{n}/dyn/ratio` | enum | 1.1:1, 1.3:1, 1.6:1, 2:1, 2.5:1, 3.2:1, 4:1, 5.6:1, 8:1, 16:1, 32:1, INF:1 |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/knee` | float | 0..10 |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/det` | enum | PEAK, RMS |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/att` | float | 0..100 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/hld` | float | 0..2000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/rel` | float | 0..4000 | ms |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/env` | string |  |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/dyn/auto` | int | 0..1 |  |  | all |  |
| `/ch/{n}/dyn/mix` | float | 0..100 | % |  | all |  |
| `/ch/{n}/dyn/gain` | float | -20..20 | dB |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/1/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/1/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/1/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/1/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/1/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/1/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/2/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/2/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/2/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/2/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/2/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/2/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/3/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/3/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/3/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/3/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/3/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/3/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/4/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/4/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/4/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/4/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/4/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/4/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/5/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/5/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/5/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/5/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/5/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/5/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/6/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/6/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/6/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/6/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/6/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/6/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/7/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/7/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/7/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/7/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/7/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/7/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/8/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/8/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/8/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/8/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/8/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/8/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/9/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/9/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/9/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/9/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/9/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/9/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/10/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/10/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/10/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/10/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/10/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/10/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/11/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/11/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/11/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/11/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/11/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/11/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/12/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/12/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/12/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/12/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/12/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/12/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/13/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/13/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/13/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/13/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/13/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/13/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/14/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/14/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/14/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/14/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/14/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/14/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/15/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/15/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/15/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/15/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/15/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/15/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/16/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/16/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/16/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/16/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/16/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/16/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/MX1/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX1/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/MX1/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX1/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/MX1/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX1/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/MX2/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX2/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/MX2/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX2/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/MX2/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX2/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/MX3/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX3/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/MX3/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX3/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/MX3/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX3/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/MX4/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX4/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/MX4/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX4/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/MX4/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX4/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/MX5/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX5/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/MX5/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX5/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/MX5/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX5/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/MX6/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX6/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/MX6/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX6/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/MX6/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX6/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/MX7/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX7/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/MX7/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX7/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/MX7/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX7/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/send/MX8/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX8/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/send/MX8/pon` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX8/mode` | enum | PRE, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/send/MX8/plink` | int | 0..1 |  |  | all |  |
| `/ch/{n}/send/MX8/pan` | float | -100..100 |  |  | all |  |
| `/ch/{n}/main/1/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/main/1/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/main/1/pre` | int | 0..1 |  |  | all |  |
| `/ch/{n}/main/2/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/main/2/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/main/2/pre` | int | 0..1 |  |  | all |  |
| `/ch/{n}/main/3/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/main/3/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/main/3/pre` | int | 0..1 |  |  | all |  |
| `/ch/{n}/main/4/on` | int | 0..1 |  |  | all |  |
| `/ch/{n}/main/4/lvl` | float | -144..10 | dB |  | all |  |
| `/ch/{n}/main/4/pre` | int | 0..1 |  |  | all |  |
| `/ch/{n}/tags` | string |  |  |  | all | Free-form tag string used for filtering/search on the console. |
| `/ch/{n}/clink` | string |  |  |  | all | On WING (unlike the X32/XR18 protocol reference this catalog was transcribed from, where the same name means stereo/group channel pairing), this is confirmed — live packet capture, 2026-08-28 — to be the console app's "link customization to source" toggle: {path: "/ch/{n}/clink", value: "1"}. See wing-input-patch.ts's setSrcAuto(). Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/ptap` | enum | IN, FILT, 3, 4, 5, PFL, AFL, POST |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/ch/{n}/mon` | enum | A, B, A+B |  |  | all | Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
