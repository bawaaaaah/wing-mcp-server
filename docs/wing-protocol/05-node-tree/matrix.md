<!-- GÉNÉRÉ — ne pas éditer à la main. Source : src/plugins/wing/wing-param-catalog.ts -->

# Matrix Node Tree

55 parameters from `WING_PARAM_CATALOG`.

| Path | Type | Range/Enum | Unit | RO | Models | Description |
|---|---|---|---|---|---|---|
| `/mtx/{n}/fdr` | float | -144..10 | dB |  | all | 1024 steps; -144 renders as "-oo". |
| `/mtx/{n}/mute` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/pan` | float | -100..100 |  |  | all |  |
| `/mtx/{n}/wid` | float | -150..150 |  |  | all |  |
| `/mtx/{n}/busmono` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/name` | string |  |  |  | all | Up to 16 characters. |
| `/mtx/{n}/col` | int | 1..18 |  |  | all | 1=Blue, 2=Azure, 3=Indigo, 4=Turquoise, 5=Green, 6=Lime, 7=Yellow, 8=Brown, 9=Red, 10=Salmon, 11=Magenta, 12=Purple, 13=Amber, 14=Sky Blue, 15=Orange Red, 16=Mint Green, 17=Gray, 18=White |
| `/mtx/{n}/icon` | int | 0..999 |  |  | all | General [0-14]: 0=Vide, 1=XLR, 2=Jack TRS, 3=Mini-Jack TRS, 4=RCA, 5=Faders, 6=FX, 7=Routing / Modular, 8=Clé de fa (bass), 9=Clé de sol (treble), 10=Multi-EQ / Matrix faders, 11=Sends / Bus arrows, 12=Multi-out / Parallel lines, 13=Smiley, 14=W \| Vocals & Mics [100-114]: 100=Micro main (handheld), 101=Micro main à boule, 102=Micro sans fil (wireless), 103=Micro canon (shotgun), 104=Micro scène / broadcast, 105=Micro pupitre (gooseneck / podium), 106=Micro interview (avec flag), 107=Casque avec micro (headset), 108=Micro serre-tête (headset léger), 109=Micro sur pied de table (studio), 110=Micro vintage (broadcast), 111=Micro condensateur sur trépied, 112=Chœur / groupe, 113=Chanteuse (femme), 114=Chanteur (homme) \| Drums & Percussion [200-224]: 200=Grosse caisse, côté pédale (kick in), 201=Grosse caisse, face avant (kick out), 202=Caisse claire, dessus (snare top), 203=Caisse claire, dessous (snare bottom), 204=Caisse claire + baguettes, 205=Charleston (hi-hat), 206=Tom aigu (H), 207=Tom medium (M), 208=Tom grave (L), 209=Floor tom (F), 210=Batterie complète, 211=Cymbale crash (C), 212=Cymbale ride (R), 213=Cowbell, 214=Tambourin, 215=Congas, 216=Bongos, 217=Timbale d'orchestre (timpani), 218=Cajón, 219=Maracas, 220=Xylophone / vibraphone, 221=Handpan / steel drum, 222=Triangle, 223=Boîte à rythmes / pad électronique, 224=Claquements de mains (clap) \| Strings & Winds [300-319]: 300=Guitare électrique, 301=Guitare demi-caisse (hollow body), 302=Guitare jazz (archtop), 303=Banjo, 304=Guitare acoustique (folk), 305=Guitare électrique (type Les Paul), 306=Guitare électrique (type superstrat), 307=Guitare électrique (Flying V), 308=Violon, 309=Violon électrique, 310=Violoncelle, 311=Clarinette, 312=Saxophone, 313=Trombone, 314=Trompette, 315=Harpe, 316=Accordéon, 317=Harmonica / mélodica, 318=Flûte, 319=Hautbois / clarinette basse \| Keys [400-409]: 400=Piano à queue, 401=Piano droit / piano électrique, 402=Synthétiseur / workstation, 403=Synthétiseur (curseurs et boutons), 404=Clavier workstation (écran), 405=Synthétiseur, 406=Keytar, 407=Clavier sur pied, 408=Clavier sur stand en X, 409=Orgue / clavier double manuel \| Speakers [500-524]: 500=Ampli guitare (combo), 501=Ampli stack (tête + baffle), 502=Ampli 4 haut-parleurs, 503=Enceinte PA, 504=Moniteurs de studio (paire), 505=Enceinte + micro, 506=Caisson de basse (sub), 507=Enceinte pleine bande, 508=Enceinte double horizontale, 509=Enceintes suspendues (paire), 510=Enceintes sur pont / mât, 511=Enceinte suspendue, 512=Enceinte sur pied, 513=Enceintes sur mât (paire), 514=Enceintes avec délai (Δt), 515=Enceinte gauche (L), 516=Enceinte droite (R), 517=Enceinte centrale / double, 518=Colonne PA, 519=Enceintes PA (paire), 520=Retour de scène (wedge gauche), 521=Retour de scène (wedge droit), 522=Moniteur de sol (vue de face), 523=Line array / enceinte courbe, 524=Enceinte de plafond \| Specials [600-614]: 600=Signe rock (cornes), 601=Oreille (écoute), 602=Casque, 603=Talkback A, 604=Talkback B, 605=Ordinateur portable, 606=Lecteur multimédia, 607=Smartphone, 608=Clé USB, 609=Carte mémoire / SD, 610=CD / disque, 611=Vinyle / platine, 612=Magnétophone à bandes, 613=Cassette, 614=Serveur / baie de disques |
| `/mtx/{n}/led` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/eq/on` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/eq/mdl` | enum | STD, SOUL, E88, E84, F110, PULSAR, PIA |  |  | all |  |
| `/mtx/{n}/eq/mix` | float | 0..125 | % |  | all |  |
| `/mtx/{n}/eq/lg` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/lf` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/lq` | float | 0.44..10 |  |  | all |  |
| `/mtx/{n}/eq/leq` | enum | PEQ, SHV, CUT, BW6, BW12, BS12, LR12, BW18, BW24, BS24, LR24, BW48, LR48 |  |  | all |  |
| `/mtx/{n}/eq/1g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/1f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/1q` | float | 0.44..10 |  |  | all |  |
| `/mtx/{n}/eq/2g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/2f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/2q` | float | 0.44..10 |  |  | all |  |
| `/mtx/{n}/eq/3g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/3f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/3q` | float | 0.44..10 |  |  | all |  |
| `/mtx/{n}/eq/4g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/4f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/4q` | float | 0.44..10 |  |  | all |  |
| `/mtx/{n}/eq/5g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/5f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/5q` | float | 0.44..10 |  |  | all |  |
| `/mtx/{n}/eq/6g` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/6f` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/6q` | float | 0.44..10 |  |  | all |  |
| `/mtx/{n}/eq/hg` | float | -15..15 | dB |  | all |  |
| `/mtx/{n}/eq/hf` | float | 20..20000 | Hz |  | all |  |
| `/mtx/{n}/eq/hq` | float | 0.44..10 |  |  | all |  |
| `/mtx/{n}/eq/heq` | enum | PEQ, SHV, CUT, BW6, BW12, BS12, LR12, BW18, BW24, BS24, LR24, BW48, LR48 |  |  | all |  |
| `/mtx/{n}/eq/tilt` | float | -6..6 | dB |  | all |  |
| `/mtx/{n}/dyn/on` | int | 0..1 |  |  | all |  |
| `/mtx/{n}/dyn/mdl` | string |  |  |  | all | Compressor model selector; not individually enumerated. Ratio accepts numbers or strings depending on the model; use wing_describe on the slot for valid values. Approximate — exact values not confirmed against hardware/firmware, transcribed best-effort from the protocol reference. |
| `/mtx/{n}/dyn/thr` | float | -60..0 | dB |  | all |  |
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
