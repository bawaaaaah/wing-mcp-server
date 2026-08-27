# Roadmap fonctionnalités WING (vs companion-module-behringer-wing)

Comparaison faite contre `bitfocus/companion-module-behringer-wing` (2026-08-27). Objectif : combler l'écart fonctionnel, une fonctionnalité à la fois, chacune testée (unitaire **et en direct sur la console réelle**) avant de passer à la suivante. Chaque section ci-dessous est autonome — un agent qui ne lit que cette section doit pouvoir implémenter, tester et cocher les cases sans contexte supplémentaire.

Légende de statut : ⬜ pas commencé · 🔧 en cours · ✅ code + tests unitaires faits · 🟢 test live confirmé (terminé) · ❌ bloqué (voir note)

## Conventions à respecter partout

Chaque fonctionnalité "read/write d'un bloc OSC" suit ce pattern à trois couches, déjà utilisé pour auto-compress/auto-gate/autogain :

1. **Logique métier** dans `src/plugins/wing/wing-<feature>.ts` — fonction(s) async pure(s) `run<Feature>(ctx: WingPluginContext, opts): Promise<Result>`, ne connaît que `ctx.client`/`ctx.meterClient`, aucune notion MCP/Express. Lève `WingValueError` (validation) / `WingUnavailableError` (pas de données) — jamais de try/catch générique.
2. **Wrapper MCP fin** dans `src/plugins/wing/tools/<feature>.ts` — `registerXTools(server, ctx)` avec un ou plusieurs `server.registerTool("wing_xxx", {title, description, inputSchema}, handler)`, handler = `wrapWingTool(async () => { ... runXxx(ctx, opts) ... })`. `inputSchema` en objet de schémas Zod. Toujours retourner `{content: [textResult(...)], structuredContent: {...}}`.
3. **Route REST** dans `src/plugins/wing/http-routes.ts` — parseur de body défensif + adaptateur `respondXxx(res, opts)` : `WingValueError` → HTTP 422, tout le reste → 502. Réutilise exactement la même fonction métier que l'outil MCP.
4. **Web** (seulement quand indiqué "Web : oui" ci-dessous) : hook dans `web/src/api/queries.ts` (`useMutation`/`useQuery` + `apiFetch`), composant dans `web/src/pages/WingMixerTab.tsx` ou nouveau fichier dédié. Erreurs via `mutation.isError` + `.error` ; succès via `mutation.isSuccess` + `.success`. Le live passe par le SSE `"meters"` déjà existant (`useEventSource`), ne pas réinventer de plomberie.

**Outils génériques déjà existants** (`tools/generic.ts`) : `wing_get`/`wing_set`/`wing_bulk_set`/`wing_dump`/`wing_describe` couvrent DÉJÀ n'importe quel chemin OSC arbitraire. Une nouvelle fonctionnalité "read/write un champ" est donc surtout un travail de **validation + UX + description explicite pour le LLM**, pas de nouvelle capacité protocole.

**Node-paths** : réutiliser les builders existants de `src/plugins/wing/wing-node-paths.ts` (`channelPath`, `auxPath`, `busPath`, `mainPath`, `matrixPath`, `resolveStripPath`, etc. — `channelPath(n, suffix?)` → `/ch/{n}[/suffix]`, même forme pour aux/bus/main/matrix/dca/mutegroup/fx).

**Règle stricte : une seule fonction métier partagée par fonctionnalité — jamais de logique dupliquée entre MCP et REST.** L'outil MCP et la route REST doivent tous les deux appeler exactement la même fonction de `wing-<feature>.ts` (comme `runAutoCompress` est appelé à l'identique par `tools/auto-compress.ts` ET par les 4 routes REST). Pour l'**USB player**, dont la logique existe aujourd'hui *uniquement* dans les routes REST (`http-routes.ts:185-311`) : l'extraire d'abord vers `src/plugins/wing/wing-usb-player.ts`, puis faire pointer À LA FOIS le nouvel outil MCP et les routes REST existantes vers ce module. Même règle pour tout embryon REST-only déjà présent (`/channels/:index/proc` GET — l'écriture existe déjà via `ProcessingOrderCard` → `setWingValue` → `wing_set` générique, mais seulement via le chemin générique).
**Périmètre de cette règle** : elle s'applique au partage MCP↔REST (même runtime Node, même langage — trivial à partager). Elle ne s'applique PAS à la duplication déjà existante et acceptée entre `src/` (serveur) et `web/src/` (dashboard) — deux workspaces TypeScript séparés qui ne partagent pas de code aujourd'hui (ex : `isBidirectionalDynModel`/la correction d'échelle sont déjà dupliquées à la main entre le serveur et `DynamicsLiveCard`). Dupliquer la petite logique de présentation côté web reste acceptable.

**Tests unitaires** : `test/plugins/wing/wing-plugin-tools.test.ts` — ajouter les nouveaux chemins dans `GET_FIXTURES`, de nouvelles branches `if (path === ...)` dans le `dump()`/`describe()` du fake client (`createFakeWingClient`), tests `client.callTool(...)` classiques avec assertions sur `structuredContent`/`handle.bulkSetCalls`. Ajouter chaque nouveau nom d'outil à la liste `include.members([...])` du test de surface.

**Test en direct (obligatoire pour CHAQUE fonctionnalité, pas optionnel)** : pattern établi (mémoire `project_live_console_testing`) — instance isolée `PORT=8788 WING_METER_UDP_PORT=14136 WING_HOST=192.168.20.31 MCP_CONFIG_PATH=./data-test/config.json WING_PRESETS_DIR=./data-test/presets MCP_AUTH_TOKEN=<token> npx tsx src/index.ts`. Ne **jamais** toucher au port de production 8787. Redémarrer le process après chaque édition (pas de hot-reload). Au moins un appel réel (tool MCP direct ou `curl` REST) confirmant le comportement attendu sur la console physique, avant de cocher la case "test live". Nettoyer `data-test/` et restaurer l'état console modifié après chaque fonctionnalité validée.

**Parallélisation future** : plusieurs fonctionnalités touchent les mêmes fichiers partagés (`http-routes.ts`, `tools/index.ts`, `queries.ts`, `WingMixerTab.tsx`). Du vrai parallélisme (plusieurs agents Claude Desktop en même temps) demande des worktrees git séparées + merge séquentiel. Pour l'instant : séquentiel, une fonctionnalité à la fois.

---

## Priorité 1 (dans l'ordre)

### 1. USB player → MCP — statut global : 🟢
- [x] Extraire la logique de `http-routes.ts:185-311` vers `src/plugins/wing/wing-usb-player.ts` (`getUsbPlayerState`, `runUsbPlayAction`, `runUsbRecordAction`, `setUsbRepeat`)
- [x] Faire pointer les routes REST existantes (`/media`, `/media/play`, `/media/rec`) vers ce module (pas de duplication)
- [x] Nouveau `tools/usb-player.ts` (`wing_usb_player_status`, `wing_usb_play`, `wing_usb_record`, `wing_usb_set_repeat`) appelant le même module
- [x] Ajouter l'écriture de `/play/repeat` (nouvelle route `POST /media/repeat` + tool dédié `wing_usb_set_repeat`)
- [x] Enregistrer dans `tools/index.ts`
- [x] Web : contrôle repeat déjà présent dans `WingMediaTab` (utilisait déjà `setWingValue("/play/repeat", ...)` en générique) — rien à ajouter, confirmé fonctionnel
- [x] Tests unitaires : fixtures `dump("/play")`/`dump("/rec")` + `describe("/play")` ($songs), 7 tests (status, play-by-index, playfile sans fichier rejeté, playfile avec fichier, record, set-repeat, + surface de tools) — suite complète 257 passing (était 251), mêmes 5 échecs docs-sync préexistants sans rapport
- [x] **Test live** : confirmé sur la console réelle (192.168.20.31, instance isolée 8788) — lecture d'un vrai morceau ("Divine C", USB 117GB attachée), PAUSE/PLAY réels avec ACK OK, `wing_usb_set_repeat` on/off avec ACK OK, `GET /media` REST + `POST /media/repeat` REST testés directement. **`/rec/$action=IDLE` est accepté par le firmware réel (ACK OK)** malgré l'absence de documentation dans le PDF — gardé tel quel dans `USB_REC_ACTIONS`, aucun changement nécessaire.
- [x] Nettoyage + case cochée (repeat restauré à son état d'origine "on", instance isolée arrêtée, `data-test/` supprimé, port 8787 jamais touché)
- OSC : `/play/$action` (S: `IDLE, STOP, PLAY, PAUSE, NEXT, PREV, PLAYFILE`), `/play/$playfile`, `/play/$actionidx` (1-based), `/play/repeat` (I 0..1) ; `/rec/$action` (S: `STOP, REC, PAUSE, NEWFILE, IDLE` — IDLE confirmé accepté en live)
- **Note d'implémentation** : les routes REST `/media/play` et `/media/rec` renvoient maintenant `422` (au lieu de `400`) pour une action invalide, par cohérence avec la convention `WingValueError` → 422 déjà établie pour auto-compress/auto-gate/autogain. Le timeout de `/media` (GET) reste `504` via un mapping explicite de `WingUnavailableError`.

### 2. Insert on/off — statut global : 🟢
- [x] Nouveau `src/plugins/wing/wing-insert.ts` (`getInsertStatus`, `setInsert`)
- [x] Nouveau `tools/insert.ts` (`wing_get_insert`, `wing_set_insert` — `{type, index, slot: "pre"|"post", on?, fx?, mode?, w?}`)
- [x] Valider/rejeter post-insert sur aux avec message clair (aux n'a pas de post-insert, même pattern que le rejet gate-sur-aux existant)
- [x] Route(s) REST appelant le même module
- [x] Web : toggle pré/post insert dans les `ProcessingCard` existantes de `WingMixerTab.tsx`
- [x] Tests unitaires : nouvelles branches `dump()` pour `.../preins`/`.../postins`, test de rejet post-insert sur aux
- [x] **Test live** : activer/désactiver pré- et post-insert sur un channel réel, confirmer visuellement sur la console
- [x] Nettoyage + case cochée
- OSC : pré-insert (channel/aux/bus/main/mtx) `{prefix}/preins/on` (I 0..1), `/preins/ins` (S: `NONE, FX1..FX16`), `/preins/$stat` (RO) ; post-insert (channel/bus/main/mtx, **pas aux**) `{prefix}/postins/on`, `/postins/mode` (S: `FX, AUTO_X, AUTO_Y`), `/postins/ins`, `/postins/w` (F -12..12), `/postins/$stat` (RO)
- **Notes d'implémentation** : `type` réutilise la même union que `AutoGateType`/`resolveStripPath` ("channel"|"aux"|"bus"|"main"|"matrix"), `slot` distingue pre/post ; le rejet post-insert-sur-aux et le rejet mode/w-sur-pre-insert sont tous les deux des `WingValueError` → 422 en REST. Web : nouveau composant `InsertCard` (queries.ts: `useInsert`/`useSetInsert`) branché dans `ChannelProcessingPanels` (pre+post), `AuxProcessingPanels` (pre seulement), `StripProcessingPanels` (pre+post pour bus/main/mtx).
- **Test live (2026-08-27)** : instance isolée port 8788, console réelle 192.168.20.31, port 8787 jamais touché. `GET /channels/1/insert/pre` → `{on:true, fx:"NONE", status:"-"}` (état d'origine) ; `GET /channels/1/insert/post` → `{on:false, fx:"NONE", mode:"FX", w:0, status:"-"}` ; `GET /aux/1/insert/post` → 422 avec le message de rejet attendu, confirmé à la fois côté REST et côté MCP (`wing_get_insert`). Écriture réelle testée : `POST /channels/1/insert/pre {on:false}` → ack OK, relecture confirme `on:false`, puis restauré à `on:true` (état d'origine). `$stat` renvoie `"-"` sur ce firmware (pas de lien d'insert externe branché) — comportement normal, pas une erreur.
- **Nettoyage** : process isolé tué, `data-test/` supprimé, état console restauré (pré-insert channel 1 remis à `on:true`).

### 3. EQ / Gate / Dyn on-off — statut global : 🟢
- [x] Nouvelle petite fonction partagée `setProcessingBlockOn(ctx, {type, index, block, on})` (dans `wing-dynamics-models.ts` ou nouveau fichier léger)
- [x] Nouveau `tools/processing-toggle.ts` appelant cette fonction
- [x] Route REST fine appelant la même fonction
- [x] Web : toggle on/off par bloc (EQ/Gate/Dyn) dans les `ProcessingCard` existantes
- [x] Tests unitaires : `bulkSetCalls` contient `{on: 1|0}` sur le bon path pour chaque combinaison type/bloc, rejet gate-sur-non-channel
- [x] **Test live** : basculer EQ/Gate/Dyn on/off sur un channel réel et confirmer sur la console
- [x] Nettoyage + case cochée
- OSC (déjà cataloguée dans `wing-param-catalog.ts`, jamais exposée en tool dédié) : `{prefix}/eq/on`, `{prefix}/gate/on` (channel seulement), `{prefix}/dyn/on` — tous `I 0..1`
- **Notes d'implémentation** : nouveau fichier léger `src/plugins/wing/wing-processing-toggle.ts` (pas ajouté à `wing-dynamics-models.ts`, qui est dédié au scaling de la réduction de gain, pas au on/off) — `getProcessingBlockOn`/`setProcessingBlockOn(ctx, {type, index, block, on})`, `type` = `"channel"|"aux"|"bus"|"main"|"matrix"` (même union qu'`AutoGateType`/`InsertStripType`), `block` = `"eq"|"gate"|"dyn"`. Le rejet `"gate"` hors channel est un `WingValueError` → 422, même pattern que `wing-auto-gate.ts`. Lecture via `ctx.client.get(\`${prefix}/${block}/on\`)` (leaf direct, pas `dump()` du bloc entier — suffisant pour un simple booléen). Écriture via `ctx.client.bulkSet(prefix/block, {on: 0|1})`, comme `wing-insert.ts`. **Web : aucun nouveau composant nécessaire** — `ParamPanel` (déjà utilisé par les `ProcessingCard` EQ/Gate/Dynamics existantes) rend déjà génériquement tout champ `int 0..1` (dont `on`) comme un bouton toggle on/off (`web/src/components/ParamPanel.tsx:501-518`), donc le toggle demandé par le plan existait déjà côté dashboard ; ce lot ajoute la couche MCP+REST dédiée et validée (les outils génériques `wing_get`/`wing_set` couvraient déjà la capacité protocole, mais sans nommer les 3 blocs ni rejeter "gate" proprement pour un LLM).
- **Test live (2026-08-27)** : instance isolée port 8788, console réelle 192.168.20.31, port 8787 jamais touché (ni avant ni après — aucun listener dessus à aucun moment). `GET /channels/1/eq/on` → `{on:true}`, `/gate/on` → `{on:true}`, `/dyn/on` → `{on:true}` (état d'origine). Rejet confirmé : `GET /aux/1/gate/on` → 422, `POST /strips/bus/2/gate/on` → 422, message clair dans les deux cas. Écriture réelle testée côté REST : `POST /channels/1/eq/on {on:false}` → ack OK, relecture confirme `on:false`, restauré à `on:true`, relecture confirme la restauration. Écriture réelle testée côté MCP (script `verify-processing-toggle.mjs` avec le SDK MCP) : `wing_get_processing_block`/`wing_set_processing_block` sur le bloc `dyn` du channel 1 — lecture `on:true`, rejet `gate`-sur-aux confirmé avec le même message que REST, écriture `on:false` avec ack OK, relecture confirme, restauré à `on:true`. Les deux surfaces (REST et MCP) appellent la même fonction et renvoient un état identique.
- **Nettoyage** : process isolé tué, `data-test/` supprimé, état console final confirmé identique à l'état d'origine (eq/gate/dyn tous `on:true` sur channel 1).

### 4. Ordre de traitement (proc chain) — écriture — statut global : 🟢
*(Confirmé : l'écriture fonctionne déjà via `wing_set` générique/`ProcessingOrderCard` — ce lot ajoute un tool MCP dédié avec validation stricte, pas une nouvelle capacité)*
- [x] Nouveau `wing-proc-order.ts` — constante des 24 permutations valides + `getProcOrder(ctx, channel)`/`setProcOrder(ctx, channel, order)`
- [x] Nouveau `tools/proc-order.ts` (`wing_channel_set_proc` avec `z.enum([...24 valeurs])`, `wing_channel_get_proc`)
- [x] Nouvelle route REST `POST /channels/:index/proc` à côté du GET existant, appelant `setProcOrder`
- [x] Web (optionnel) : `ProcessingOrderCard` pointe maintenant vers la nouvelle route dédiée (`useSetChannelProc`) au lieu du générique `setWingValue`
- [x] Tests unitaires : valeur valide + rejet Zod sur permutation invalide, `bulkSetCalls` vérifié avec `{baseNode: "/ch/4", assignments: {proc: "EDGI"}}`
- [x] **Test live** : changer l'ordre G/E/D/I sur un channel réel via le nouveau tool et confirmer sur la console
- [x] Nettoyage + case cochée
- OSC : `/ch/{n}/proc` (S), 24 permutations : `GEDI, GEID, GIED, IGED, GDEI, GDIE, GIDE, IGDE, EGDI, EGID, EIGD, IEGD, EDGI, EDIG, EIDG, IEDG, DEGI, DEIG, DIEG, IDEG, DGEI, DGIE, DIGE, IDGE`. Channel-exclusif.
- **Légende des lettres (important — l'ordre des lettres EST l'ordre de traitement sur la console, de gauche à droite = premier au dernier)** :
  - `G` = **G**ate
  - `E` = **E**qualisation (EQ)
  - `D` = **D**ynamique (compresseur)
  - `I` = **I**nsert
  - Exemple : `EDGI` = EQ, puis Dynamique, puis Gate, puis Insert. Documenté dans la description des tools MCP (`wing_channel_get_proc`/`wing_channel_set_proc`) et dans le docstring de `wing-proc-order.ts`.

**Notes d'implémentation :**
- `setProcOrder` écrit via `ctx.client.bulkSet(channelPath(channel), {proc: order})` (ACK'd), pas via `client.set` fire-and-forget — cohérent avec le pattern déjà utilisé par `wing-insert.ts`/`wing-processing-toggle.ts` pour toute écriture qui doit rapporter un statut.
- Le GET existant (`ctx.client.get(channelPath(channel, "proc"))`) est resté fonctionnellement identique mais route maintenant à travers `getProcOrder` (même module partagé), qui valide aussi que la valeur lue est bien l'une des 24 permutations connues.
- `wing-proc-order.ts` valide la chaîne d'entrée (`requireProcOrder`) indépendamment du `z.enum` du tool MCP, car la route REST reçoit un `order` de type `unknown` dans le body JSON et n'a pas Zod pour la filtrer — nécessaire pour que le rejet 422 fonctionne aussi côté REST.
- Web : le composant générait déjà localement ses 24 permutations (`generateGediPermutations()`) pour peupler le `<select>` — inchangé ; seul l'appel d'écriture change (nouvelle mutation `useSetChannelProc` au lieu de `setWingValue` générique), ce qui fait que toute tentative d'écrire une valeur hors-enum est maintenant rejetée par le serveur avec un message clair plutôt que silencieusement.

**Test live (2026-08-27) :**
- Ordre d'origine du channel 1 lu avant tout changement : `DGEI` (à restaurer en fin de test).
- REST : `POST /api/plugins/wing/channels/1/proc {"order":"EGDI"}` → `{"channel":1,"order":"EGDI","ack":{"status":"OK","ok":true,"raw":"OK"}}`, relu via `GET` → `{"value":"EGDI"}` confirmé sur la console réelle (192.168.20.31).
- REST : rejet d'une permutation invalide (`"XXXX"`) → HTTP 422 avec message explicite, aucune écriture envoyée à la console.
- MCP direct (`verify-proc-order.mjs`, `Client`+`StreamableHTTPClientTransport`) : `wing_channel_get_proc` → `EGDI`, `wing_channel_set_proc(order: "GDEI")` → ack OK, relecture confirme `GDEI`, puis restauration à `wing_channel_set_proc(order: "DGEI")` → ack OK, relecture confirme `DGEI` (état d'origine).
- Les deux surfaces (REST et MCP) ont produit un comportement identique pour le même état OSC sous-jacent, confirmant l'exigence anti-duplication.

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (config + script de vérification), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché pendant ce test. État console du channel 1 restauré à `DGEI`.

### 5. Patch d'entrée physique (Main/Alt) — statut global : 🟢
- [x] Nouveau `wing-input-patch.ts` (`getInputPatch`, `setInputConnection(ctx, {type, index, slot: "main"|"alt", grp, in})`, `setAltSourceActive`, `getGlobalAltSwitch`, `setGlobalAltSwitch`)
- [x] Nouveau `tools/input-patch.ts` (`wing_get_input_patch`, `wing_set_input_connection`, `wing_set_alt_source_active`, `wing_get_global_alt_switch`, `wing_set_global_alt_switch`)
- [x] Route(s) REST appelant le même module : `GET/POST /channels|aux/:index/in/patch`, `POST /channels|aux/:index/in/set/altsrc`, `GET/POST /io/altsw`
- [x] Web : carte "Input Source (Main/Alt)" (statut Main/Alt + bouton actif) dans `ChannelProcessingPanels`/`AuxProcessingPanels` — testée en navigateur (screenshot, aucune erreur console)
- [x] Tests unitaires : bulkSet sur `in/conn` (Main et Alt), sur `in/set/altsrc`, sur `/io` (altsw/autoaltovr) — 8 nouveaux tests, tous verts
- [x] **Test live** : re-patché une entrée réelle (Main et Alt, channel 1 et aux 1) et basculé Main/Alt sur la console
- [x] Nettoyage (patch d'origine restauré) + case cochée
- OSC : `{ch|aux}/{n}/in/conn/{grp,in}` (Main, déjà lu par `resolvePhysicalSource`), `/in/conn/{altgrp,altin}` (Alt, nouveau), `/in/set/srcauto` (déjà lu), `/in/set/altsrc` (I 0..1, nouveau, sélecteur Main/Alt actif) ; global `/io/altsw` (I 0..1), `/io/autoaltovr` (I 0..1)

**Notes d'implémentation :**
- `resolvePhysicalSource` (tools/physical-source.ts) refactorisé pour partager sa logique de décodage display-vs-value avec un nouveau `resolveAltSource`, plutôt que de dupliquer le quirk d'off-by-one déjà vérifié en live pour Main.
- `getInputPatch`/`setInputConnection`/`setAltSourceActive` valident en interne que `type` est bien `channel`/`aux` (`requireInputPatchStripType`) — les seuls types avec une entrée physique — rejeté avec un `WingValueError` clair sinon.
- `grp` n'est volontairement PAS validé contre une enum fixe (les noms de groupe varient selon le modèle de console et sont découverts en direct via `GET /io`, même principe que `ioInPath`) — une valeur invalide est rejetée par la console elle-même (`ack.ok === false`), pas par ce code.
- Web : la découverte a montré que l'édition grp/index (Main ET Alt) existe déjà dans l'onglet I/O → Mapping (`StripRow`, écriture via `bulkSetWing` générique) — ne pas dupliquer cette UI. La nouvelle carte se concentre uniquement sur ce qui manquait réellement : le sélecteur "lequel des deux est actif" (`in/set/altsrc`), avec un renvoi textuel vers l'onglet I/O pour changer le patch lui-même.

**Test live (2026-08-27) :**
- État d'origine enregistré avant tout changement : channel 1 main={PLAY,1}, alt={OSC,1}, altActive=false ; aux 1 main=null(OFF), alt={MOD,1}, altActive=false ; global `/io/altsw`={on:false, autoOverride:false}.
- REST : patch channel 1 Main → `{grp:"LCL", in:5}`, relecture confirme `{group:"LCL", index:5}` sur la console réelle — **round-trip d'index confirmé sans décalage** (contrairement à la lecture, l'écriture n'a pas besoin de compensation display-vs-value : écrire l'index affiché tel quel donne le bon résultat en lecture).
- REST : patch channel 1 Alt → `{grp:"LCL", in:6}`, relecture confirmée.
- **Découverte importante** : `in/set/altsrc` n'a aucun effet tant que le switch global `/io/altsw` est éteint — un strip se comporte toujours comme "Main" et se lit `altActive:false` quel que soit son bit `altsrc` stocké (qui reste mémorisé mais dormant). En allumant `/io/altsw`, l'aux 1 (jamais touché) s'est révélé avoir déjà `altsrc=1` en interne — préexistant, pas introduit par ce test.
- **Découverte importante (limite firmware)** : une fois `altsrc` mis à 1 (Alt) sur channel 1 avec le switch global allumé, aucune méthode d'écriture testée (`bulkSet`, `set` fire-and-forget, convention `toggle`/-1, avec délai jusqu'à 2s) n'a permis de le repasser à 0 (Main) — la console acquitte "OK" sans appliquer le changement. Documenté explicitement dans le docstring de `setAltSourceActive` et la description du tool MCP correspondant. **Contournement confirmé et suffisant** : éteindre le switch global `/io/altsw` force le comportement "Main" partout, quel que soit le bit `altsrc` bloqué d'un strip — utilisé pour restaurer l'état fonctionnel exact du channel 1.
- Restauration complète confirmée par relecture : channel 1 main={PLAY,1}, alt={OSC,1}, altActive=false ; aux 1 main=null, alt={MOD,1}, altActive=false ; global altsw={on:false, autoOverride:false} — identique à l'état de départ dans les trois cas.
- MCP + REST vérifiés en parallèle (mêmes fonctions partagées) tout au long du test, comportement identique sur les deux surfaces.
- Web : carte "Input Source (Main/Alt)" testée dans un vrai navigateur (Playwright, contre l'instance isolée) — rendu correct (Main/Alt/Active affichés avec les vraies valeurs de la console), requête réseau `GET .../in/patch` → 200, aucune erreur console JS.

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (config + scripts + screenshots), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché pendant ce test. État console (channel 1, aux 1, `/io/altsw`) restauré et vérifié identique à l'état d'origine.

### 6. Fades (courbes d'easing) — statut global : 🟢
- [x] Nouveau `src/plugins/wing/wing-easing.ts` (fonctions d'easing — linéaire déjà existant + au moins quadratic/cubic/sinusoidal/exponential en in/out/in-out pour commencer)
- [x] Étendre `wing-fade.ts`/`runFade` pour accepter `easing?: EasingName` appliqué à la fonction de progression
- [x] Mettre à jour `tools/fade.ts` (paramètre `easing` optionnel) et la route REST `/fade`
- [x] Web : `<select>` de courbe d'easing à côté de la durée dans les contrôles de fade existants
- [x] Tests unitaires : `runFade` avec easing produit une séquence non-linéaire vérifiable (comparer la valeur à mi-durée à un fade linéaire)
- [x] **Test live** : lancer un fade avec easing sur un fader réel et observer le comportement non-linéaire
- [x] Nettoyage + case cochée
- OSC : aucun changement protocole — ramp 100% client-side, portage TS des courbes (11 algos × 3 directions dans le module Companion, pas besoin des 33 combinaisons dès le premier jet)

**Notes d'implémentation :** `wing-easing.ts` porte 13 courbes (`linear` + quad/cubic/sine/expo × in/out/in-out) comme fonctions pures `t ↦ t'` sur `[0,1]`, plus `requireEasingName` (assertion function levant `WingValueError` sur un nom inconnu, utilisée aussi bien côté MCP — via l'enum Zod `EASING_NAMES` — que côté REST, qui reçoit `easing` en `string` libre dans le body JSON et doit donc valider explicitement avant d'appeler `startFade`). `wing-fade.ts` applique la courbe à `step/steps` avant l'interpolation `from + (to-from)*eased`, et renvoie `easing` dans son résultat (`FadeStartResult`) pour que l'appelant sache quelle courbe a réellement tourné. Web : nouveau champ "Curve" dans `FadeSection` (dupliqué en TS côté `web/src/api/queries.ts` comme une simple liste de noms + labels FR/EN, cohérent avec la politique déjà actée de ne pas partager de code entre les deux workspaces pour ce genre de petite logique de présentation).

**Test live (2026-08-28) :** instance isolée sur 8788 (8787 jamais démarré/touché). Fade `expo-in` de 2000ms sur `/ch/1/fdr` (0dB → -40dB) : lecture à ~600ms (30% de la durée) = -0.88dB, soit ~2% du trajet total — comportement clairement non-linéaire confirmé sur le fader réel (un fade linéaire aurait donné ~-12dB à ce point). Valeur finale exactement -40dB (bulkSet ACK'd). Validation testée en direct aussi côté REST : `POST /fade` avec `easing: "bogus"` → 422 sans aucune écriture console. UI testée via Playwright contre le bundle web rebuild : sélecteur "Curve" affiché et fonctionnel, fade "Exponential — ease out" déclenché depuis le navigateur, message de succès conforme, zéro erreur console JS, capture d'écran vérifiée. Fader du channel 1 restauré à sa valeur d'origine (0dB) et revérifié après chaque manipulation (script + navigateur).

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (scripts de vérification + screenshot), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché pendant ce test.

### 7. Statut des liaisons AES50 — statut global : 🟢
- [x] Nouveau `wing-link-status.ts` (`getAesLinkStatus(ctx)` — dump groupé A/B/C + StageConnect, `clearAesErrors(ctx, port)`)
- [x] Nouveau `tools/link-status.ts` (`wing_get_link_status`, `wing_clear_link_errors`)
- [x] Route(s) REST appelant le même module
- [x] Web : carte de diagnostic dans l'onglet Config (statut/erreurs par port, bouton reset)
- [x] Tests unitaires : lecture groupée, écriture `clrerr`
- [x] **Test live** : lire le statut réel des ports AES50/StageConnect de la console (même si "non connecté", vérifier que la lecture ne plante pas) et tester le reset des compteurs d'erreur
- [x] Nettoyage + case cochée
- OSC : `/$stat/{A,B,C}/stat` (S RO: `-, OK, ERR, UPD`), `/dev` (RO), `/errorsc`/`errorsu` (I RO), `/clrerr` (I 0..1, écriture) ; bonus `/$stat/rmt_{a,b,c}`, `/$stat/sc_stat` (S: `OK, ERR`), `/sc_devices`, `/sc_upcnt`/`sc_dncnt`

**Notes d'implémentation :** `wing-link-status.ts` lit tout via **un seul** `ctx.client.dump("/$stat")` (clé plate `"A.stat"`, `"sc_upcnt"`, etc.) plutôt que 15 `get()` individuels — voir "Test live" ci-dessous pour pourquoi ce choix a changé en cours de route. `clearAesErrors(ctx, port)` valide `port` via une assertion function (`requireAesPort`, levant `WingValueError`, même pattern que `requireEasingName`/`requireInputPatchStripType`) avant un `bulkSet("/$stat/{port}", {clrerr: 1})`. Web : nouvelle carte "AES50 / StageConnect link status" dans `WingConfigTab` (`WingPage.tsx`), avec un bouton "Reset counters" par port ; poll 5s comme le reste des cartes de statut non-SSE (Media).

**Test live (2026-08-28) :** instance isolée sur 8788 (8787 jamais démarré/touché). Console réelle : port AES50 A "-" (rien connecté), port B "OK" avec un stage box "S16" réellement lié (`remoteName: "S16"`), port C "-" ; StageConnect "-" (non utilisé), `sc_upcnt`/`sc_dncnt` à 32/32 — cette valeur par défaut à 32 (plutôt que 0) est confirmée par l'exemple de snapshot brut du PDF protocole lui-même (p.32), pas un bug. `wing_clear_link_errors` sur le port A a bien renvoyé un ACK "OK" réel du firmware. Testé aussi côté REST (`GET /link-status`, `POST /link-status/clear-errors`) avec les mêmes résultats, plus un port invalide → 422 sans écriture. **Itération notable** : l'implémentation initiale interrogeait chaque feuille individuellement (15 `get()`) pour éviter le bug de mauvais-clé de `dump()` documenté ailleurs (voir `getTags()` dans `http-routes.ts`, où un `/ch/N` très imbriqué produit des clés avec un point parasite) — testé en direct dans un navigateur réel (Playwright), cette approche provoquait un 502 systématique au premier chargement de l'onglet Config (la requête à 15 aller-retours OSC séquentiels expirait après 1000ms quand la file OSC était aussi occupée par le trafic de l'onglet Mixer). Vérifié en direct que `dump("/$stat")` — nettement moins imbriqué qu'un channel — ne souffre pas de ce bug (clés propres `"A.stat"`, `"B.dev"`, etc., confirmées face aux mêmes valeurs lues individuellement) ; le code final utilise donc un seul `dump()`, plus rapide et fiable sous charge, et le test navigateur re-exécuté ensuite ne montre plus aucune erreur console.

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (scripts de vérification + screenshot), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché pendant ce test. Aucun état console à restaurer (lecture seule + reset de compteurs déjà à 0, non destructif).

### 8. Sauvegarde manuelle en flash — statut global : 🟢
- [x] Nouveau tool `tools/save-flash.ts` (`wing_save_to_flash` — description qui prévient explicitement du risque d'usure flash, pas de retry automatique)
- [x] Petite fonction métier partagée (nouveau `wing-console-admin.ts` — `saveToFlash`, plus `getAutoSaveConfig`/`setAutoSaveConfig` pour le champ `$noautosave` du même nœud `$globals`)
- [x] Route REST appelant la même fonction
- [x] Web : non (action rare/sensible, MCP/REST seulement)
- [x] Tests unitaires : appel `bulkSet` exact (`{baseNode: "/$ctl/$globals", assignments: {$savenow: 1}}` / `{$noautosave: 0|1}`), pas de retry silencieux en cas d'échec
- [x] **Test live** : déclencher UNE sauvegarde flash réelle (une seule fois, pas en boucle vu l'avertissement du PDF sur l'usure) et confirmer l'ack
- [x] Nettoyage + case cochée

**Notes d'implémentation :** confirmé directement dans le PDF (`pdftotext -layout`) que le nœud canonique du node-tree (section "Global Settings" du contrôleur, p.90-91) est bien `/$ctl/$globals/$savenow` et `/$ctl/$globals/$noautosave` — la mention `/$ctl/cfg/$noautosave`/`/$ctl/cfg/savenow` n'apparaît que dans une note de bas de page (note 53, p.72) à propos d'un tout autre sujet (les nœuds exemptés d'un comportement), pas dans le node-tree lui-même ; traité comme une incohérence interne du PDF, pas un chemin alternatif à tester. Aucun fallback nécessaire. `getAutoSaveConfig`/`setAutoSaveConfig` ajoutés dans le même fichier car ils partagent le même nœud `/$ctl/$globals` et le même mécanisme `bulkSet` — ce n'est pas un ajout de périmètre, juste le reste documenté du même nœud console-admin.

**Test live (2026-08-28) :** instance isolée sur 8788 (8787 jamais démarré/touché). `GET /console/autosave` a lu l'état réel de la console (`enabled: true`, soit `$noautosave=0`, la valeur par défaut) ; `POST /console/autosave {enabled: false}` a reçu un ACK "OK" réel du firmware et la relecture a confirmé le changement, puis restauré à `enabled: true` (relecture confirmée) — aucun état console laissé modifié. Corps invalide (`enabled: "yes"`) rejeté en 400 sans écriture. `wing_save_to_flash` appelé **une seule fois** via le tool MCP (jamais en boucle, conformément à l'avertissement du PDF sur l'usure de la flash) : ACK réel `{status: "OK", ok: true, raw: "OK"}` du firmware, confirmant que la console a bien accepté et exécuté la sauvegarde.

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (script de vérification MCP), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché pendant ce test. État console restauré (autosave remis à `enabled: true`) ; la sauvegarde flash elle-même n'a rien à restaurer (elle persiste l'état déjà existant, ne le modifie pas).

### 9. Strip sélectionné — statut global : 🟢
- [x] Nouveau `wing-selected-strip.ts` (`getSelectedStrip`, `setSelectedStrip` — réutilise `decodeRtaSourceIndex`/`encodeRtaSource` de `wing-rta-source.ts`, même schéma canonique 1..76)
- [x] Nouveau `tools/selected-strip.ts` (`wing_get_selected_strip`, `wing_set_selected_strip`)
- [x] Route REST (`GET`/`POST /selected-strip`) appelant le même module
- [x] Web : aucun composant dédié dans ce lot (utile surtout pour un agent MCP), comme prévu
- [x] Tests unitaires : off-by-one lecture (raw 6 → canonique 7 → channel 7) / écriture (bus 3 → raw 51, même mapping que les tests RTA existants), + rejet d'un index hors plage
- [x] **Test live** : sélectionner un channel réel via le tool et confirmer via relecture que la console reflète bien ce strip comme sélectionné
- [x] Nettoyage + case cochée

**Notes d'implémentation :** le PDF confirme noir sur blanc (node-tree, `/$ctl/$stat/selidx`, note de bas de page 54) : "The get command reports values between 0 and 75, but index 1 to 76 should be used when setting values." `getSelectedStrip` lit donc la valeur brute (0..75) et lui ajoute 1 avant de la faire passer par `decodeRtaSourceIndex` (qui attend la numérotation canonique 1..76 partagée par `rtasrc`, les cibles USER, FSND, etc.) ; `setSelectedStrip` encode directement avec `encodeRtaSource` puisque c'est exactement ce que SET attend (1..76), sans transformation supplémentaire.

**Test live (2026-08-28) :** instance isolée sur 8788 (8787 jamais démarré/touché). Lecture initiale de la console réelle : `rawIndex: 0` → `channel 1` (sélection de départ). Écriture réelle `{type: "channel", index: 5}` via REST → ACK `OK` du firmware, relecture confirmant `rawIndex: 4` → `channel 5` (l'écart de 1 entre l'index écrit et l'index relu est exactement l'off-by-one documenté, vérifié en conditions réelles). Puis via le tool MCP : sélection réelle de `aux 2` (écrit 42, relu 41 → décode bien en aux 2), remise à l'état d'origine (`channel 1`) confirmée par une dernière lecture, et rejet d'un index hors plage (`main 9`) confirmé sans écriture console.

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (script de vérification MCP), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché. Sélection de strip restaurée à son état d'origine (`channel 1`) avant l'arrêt du process.
- OSC : `/$ctl/$stat/selidx` (I, lecture 0..75 / écriture 1..76 — off-by-one confirmé à la fois dans le PDF et en direct sur la console) ; voisins `pageidx`, `bandidx`, `sof` (non utilisés par ce lot)

### 10. Ligne à retard (delay) — statut global : 🟢
- [x] Nouveau `wing-delay.ts` avec deux resolvers de chemin (`delayBaseNode`/`delayFieldKeys`, channel/aux → `in/set` vs bus/main/matrix → `dly`) unifiés derrière `setDelay(ctx, {type, index, on?, mode?, value?})`
- [x] Nouveau `tools/delay.ts` (`wing_get_delay`, `wing_set_delay`)
- [x] Route(s) REST (`GET`/`POST /channels/:index/delay`, `/aux/:index/delay`, `/strips/:type/:index/delay`) appelant le même module
- [x] Web : nouvelle `DelayCard` (on/off + unité + valeur) ajoutée dans les panneaux de traitement channel/aux/bus/main/matrix existants
- [x] Tests unitaires : un test channel (forme `in/set/dly*`) + un test bus (forme `dly/*`), écriture partielle (seuls les champs fournis sont envoyés), rejet si aucun champ fourni
- [x] **Test live** : activer un delay réel sur un channel ET sur un bus (les deux formes différentes) et confirmer via relecture + capture d'écran navigateur
- [x] Nettoyage + case cochée

**Notes d'implémentation :** le plan initial nommait le paramètre d'écriture `ms?`, mais le champ `dly` n'est pas toujours en millisecondes — son unité dépend de `mode` (M=mètres, FT=pieds, MS=millisecondes, SMP=échantillons), confirmé dans le PDF (plages différentes par mode : 0..150 pour M, 0.5..500 pour FT/MS, 16..500 pour SMP). Renommé en `value` pour éviter un nom trompeur quand `mode` n'est pas `MS`. Comme `wing-insert.ts`/`setInsert`, `setDelay` ne renvoie que `{type, index, ack}` (pas de valeurs synthétisées pour les champs non fournis) — cohérent avec la convention déjà établie pour les setters partiels de ce dépôt.

**Test live (2026-08-28) :** instance isolée sur 8788 (8787 jamais démarré/touché). Channel 1 (forme `in/set/dly*`) : état d'origine réel `{on: false, mode: "M", value: 0.1}` (correspond exactement à l'exemple de dump brut du PDF) ; écriture réelle `{on: true, mode: "MS", value: 25.5}` via REST → ACK "OK" du firmware, relecture confirmant exactement ces valeurs ; restauré à l'état d'origine (relecture confirmée). Bus 1 (forme `dly/*`) testé via le tool MCP : état d'origine `{on: false, mode: "M", value: 0.1}`, écriture réelle `{on: true, mode: "MS", value: 40}` → ACK "OK", relecture confirmée, restauré à l'état d'origine ; rejet (aucun champ fourni) confirmé sans écriture console. Vérification navigateur (Playwright, build web reconstruit) : nouvelle carte "Delay" confirmée visible entre "Post-Insert" et "EQ" sur le panneau de traitement du channel 1, avec les vrais boutons/select/input (on/off, unité, valeur) et les vraies valeurs de la console (`Off`, `M`, `0.1`), zéro erreur console/HTTP, capture d'écran (`data-test/delay-card.png`) revue et confirmée correcte.

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (scripts de vérification MCP/REST + capture d'écran), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché. Delay restauré à son état d'origine sur channel 1 et bus 1 avant l'arrêt du process.
- OSC : Channel/Aux (`{ch|aux}/{n}/in/set/dlyon`, `/dlymode` S: `M,FT,MS,SMP`, `/dly` F plage selon mode) ; Bus/Main/Matrix (`{bus|main|mtx}/{n}/dly/on`, `/dly/mode`, `/dly/dly`) — **deux formes différentes, pas un seul builder, confirmé en direct**

### 11. WING Live — statut global : 🟢
- [x] Nouveau `wing-live.ts` : `getWLiveStatus(ctx)`, `runWLiveTransport(ctx, {card, action})`, `manageWLiveSession(ctx, {card, action, ...})`, `manageWLiveMarker(ctx, {card, action, ...})`, `formatWLiveCard(ctx, card)`
- [x] Nouveau `tools/wing-live.ts` (`wing_get_wlive_status`, `wing_wlive_transport`, `wing_wlive_session`, `wing_wlive_marker`, `wing_wlive_format_sd_card`) — un tool par groupe d'actions plutôt qu'un tool géant
- [x] Route(s) REST (`/wlive/status`, `/wlive/:card/transport`, `/wlive/:card/session`, `/wlive/:card/marker`, `/wlive/:card/format`) appelant les mêmes fonctions
- [x] Web : reporté comme prévu — pas de `WingLiveTab` dans ce lot
- [x] Tests unitaires : fixtures `/cards/$type`, `/cards/wlive`, `/cards/wlive/1/$stat`+`cfg` (slot 1 accessible), `/cards/wlive/2/$stat` qui lève une erreur (slot 2 inaccessible) — un test par famille (status agrégé avec un slot reachable + un unreachable, transport, session avec validation, marker/seek, format), plus un test standalone (`wing-live.test.ts`) pour le court-circuit "pas de carte" (`/cards/$type` ≠ `WLIVE` → aucun `dump()` tenté)
- [x] **Test live** : une vraie carte WING Live **est installée** sur la console de test, avec 2 slots SD actifs contenant chacun 3 sessions réelles — testé en conséquence avec prudence (voir notes)
- [x] Nettoyage + case cochée

**Notes d'implémentation :** `getWLiveStatus` vérifie d'abord `/cards/$type` — si ce n'est pas `"WLIVE"`, retourne immédiatement `{installed: false, ...}` sans jamais tenter de `dump()` sur `/cards/wlive/*`, pour ne prendre aucun risque de timeout sur un sous-arbre qui pourrait ne pas exister. Chaque slot (1/2) est lu indépendamment via `dump()` sur `$stat`/`cfg`, avec un `.catch(() => null)` par slot — un slot qui ne répond pas (pas de carte SD insérée, ou un vrai timeout) donne `reachable: false` avec des valeurs par défaut plutôt que de faire échouer tout l'appel. Les champs `$actlink`/`$battstate` (préfixés `$`) sont lus individuellement via `get()`, pas via `dump()` — cohérent avec le comportement déjà vérifié ailleurs (USB player, insert) où les champs `$`-préfixés ne sont jamais inclus dans un `dump()`. L'action marker `"seek"` combine `stime` + `gotomarker: 101` en un seul `bulkSet` (le PDF précise que `gotomarker=101` doit suivre l'écriture de `stime` pour être pris en compte — un seul appel groupé suffit puisque `bulkSet` envoie plusieurs affectations dans le même paquet).

**Test live (2026-08-28) :** instance isolée sur 8788 (8787 jamais démarré/touché). Contrairement à l'hypothèse du plan ("hardware potentiellement indisponible"), la console de test a réellement une carte WING Live installée : `cardType: "WLIVE"`, les deux slots `reachable: true`, `sdState: "READY"`, 128 Go chacun, **3 sessions réelles par slot**. Lecture complète confirmée exacte (`GET /wlive/status` via REST et `wing_get_wlive_status` via MCP, résultats identiques). Étant donné la présence de vraies sessions enregistrées sur les deux cartes, le test live s'est volontairement limité aux actions sûres et réversibles plutôt que d'exploiter toute la surface en conditions réelles : `wing_wlive_transport` testé avec un no-op réel (`card: 1, action: "STOP"` alors que l'état était déjà `STOP`) → ACK réel `OK` du firmware, état confirmé inchangé après coup. Validation testée en direct sans aucune écriture console : `card: 3` (hors plage, MCP) → erreur ; `card: 9` (REST) → 422 avec message clair ; `wing_wlive_session` action `"open"` sans `sessionIndex` → erreur. **Délibérément non testés en direct** : `wing_wlive_format_sd_card` (destructeur, aurait effacé les vraies sessions), `deletesession`/`deletemarker`, et toute action `PLAY`/`REC` non triviale (risque de perturber un enregistrement ou une lecture en cours sur une carte contenant de vraies données) — ce n'est pas une limite du matériel comme anticipé par le plan, mais un choix de prudence délibéré face à de vraies données utilisateur, cohérent avec l'exigence de ne jamais laisser un test dégrader l'état de la console.

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (scripts de vérification MCP/REST), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché. Aucun état console à restaurer — la seule écriture réelle effectuée (STOP→STOP) était un no-op sur un état déjà identique ; aucune session, marqueur, ou carte SD n'a été modifié ou effacé.

**Revue de code (2026-08-28) — 2 corrections, non re-testées en direct (prudence : vraies sessions présentes sur les 2 cartes, voir ci-dessus) :**
1. `manageWLiveSession`/`manageWLiveMarker` ne validaient `sessionIndex`/`markerIndex`/`name` que côté Zod (MCP) — un appel REST direct avec un `sessionIndex` hors plage passait tel quel jusqu'au `bulkSet`. Corrigé en déplaçant la validation (bornes 0..100, longueur du nom) dans la logique métier partagée : REST et MCP rejettent désormais identiquement, sans changement de comportement pour un appel déjà valide.
2. L'action marker `"goto"` acceptait `markerIndex: 101`, ce qui semait la confusion avec le comportement de `"seek"` : `gotomarker=101` n'est pas un 101ᵉ marqueur, c'est un signal interne de "validation de `stime`" qui n'a de sens que combiné à une écriture `stime` dans le même appel (exactement ce que fait `"seek"`). Utilisé via `"goto"` seul, il aurait sauté vers un `stime` obsolète plutôt qu'un marqueur réel. Corrigé : `"goto"`/`"edit"`/`"delete"` sont maintenant restreints à `markerIndex` 0..100 (comme documenté pour edit/delete), `101` n'étant plus jamais accepté que via le mécanisme interne de `"seek"`.
- OSC : sous-arbre `/cards/wlive` (global : `sdlink`, `$actlink`, `$battstate`, `autoin`, `auto_stop/play/rec`) + `/cards/wlive/{1,2}` (par carte : `$ctl/control` transport, `$ctl/opensession`/`namesession`/`deletesession`, `$ctl/setmarker`/`editmarker`/`gotomarker`/`deletemarker`, `$ctl/stime` seek ms, `$ctl/formatsdcard`, `cfg/rectracks`, `cfg/playmode`, `$stat/state`, `$stat/etime`, `$stat/sdfree`/`sdsize`/`sdstate`, `$stat/sessionlist`/`sessions`, `$stat/markerlist`/`markers`, `$stat/sessionlen`/`sessionpos`, `$stat/linkedpos`, `$stat/start`/`stop`, `$stat/errormessage`/`errorcode`) — tous confirmés présents et cohérents avec le PDF en direct

### 12. Sous-mixeur "Direct Input" des matrices — statut global : 🟢
- [x] Nouveau `wing-matrix-direct.ts` (`getMatrixDirectInput`, `setMatrixDirectInput`)
- [x] Nouveau `tools/matrix-direct.ts` (`wing_get_matrix_direct_input`, `wing_set_matrix_direct_input`)
- [x] Route(s) REST (`GET`/`POST /mtx/:index/direct-input`) appelant le même module
- [x] Web : nouvelle `MatrixDirectInputCard` dans `StripProcessingPanels`, rendue uniquement pour `type === "mtx"`, distincte des sends
- [x] Tests unitaires : lecture/écriture des 4 champs (dont l'enum `dir/in`), écriture partielle, rejet si aucun champ fourni
- [x] **Test live** : activer le direct input sur une matrix réelle, changer la source, confirmer sur la console + capture d'écran navigateur
- [x] Nettoyage + case cochée

**Test live (2026-08-28) :** instance isolée sur 8788 (8787 jamais démarré/touché). Matrix 1, état d'origine réel `{on: false, input: "OFF", levelDb: 0, invert: false}`. Écriture réelle via REST `{on: true, input: "AES", levelDb: -6, invert: true}` → ACK "OK" du firmware, relecture exacte. Changement de source vers `MON.BUS` testé via le tool MCP, relecture confirmée. Restauré à l'état d'origine, relecture confirmée. Rejet (aucun champ fourni) confirmé sans écriture console. Vérification navigateur (Playwright, build web reconstruit) : nouvelle carte "Direct Input" confirmée visible entre "Delay" et "EQ" sur le panneau Matrix 1 (onglet Bus/Main/Matrix → Type "Matrix"), avec les vrais contrôles (on/off, source, niveau, invert) et l'état restauré, zéro erreur console/HTTP, capture d'écran (`data-test/matrix-direct-input.png`) revue et confirmée correcte.

**Nettoyage :** process isolé (port 8788) arrêté, `data-test/` supprimé (scripts de vérification + capture d'écran), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché. Direct Input de la matrix 1 restauré à son état d'origine avant l'arrêt du process.
- OSC (déjà cataloguée dans `wing-param-catalog.ts:480-483`, jamais exposée, confirmée identique dans le PDF et en direct) : `/mtx/{n}/dir/on` (I 0..1), `/dir/lvl` (F -144..10dB), `/dir/inv` (I 0..1), `/dir/in` (S: `OFF, AES, MON.PH, MON.SPK, MON.BUS`)

**Revue de code (2026-08-28) :** `setMatrixDirectInput` n'imposait aucune borne sur `levelDb`/`input` — seul le schéma Zod côté MCP validait (-144..10dB, enum), donc un appel REST avec `levelDb: 500` partait tel quel vers `bulkSet`. Corrigé en ajoutant la même validation dans la logique métier partagée (`WingValueError` si hors bornes ou enum invalide), donc REST et MCP rejettent maintenant identiquement. Revérifié en direct : `POST /mtx/1/direct-input {"levelDb": 500}` → HTTP 422 `"levelDb must be between -144 and 10 (got 500)."`, aucune écriture console.

### 13. Pattern Store/Restore/Adjust-par-delta/Undo — statut global : 🟢
- [x] Nouveau `wing-value-memory.ts` — état en mémoire process (`Map<path, {checkpoint?, lastAdjust?}>`) : `storeValue`, `restoreValue`, `adjustValueByDelta` (avec clamp min/max via describe() quand disponible, même pattern que `wing-auto-compress.ts`), `undoLastAdjust`
- [x] Nouveau `tools/value-memory.ts` (`wing_store_value`, `wing_restore_value`, `wing_adjust_value_by_delta`, `wing_undo_last_adjust`) — 4 tools génériques prenant un `path` arbitraire (comme `wing_get`/`wing_set`), pas de duplication par type de strip
- [x] Route(s) REST (`/value-memory/store`, `/restore`, `/adjust`, `/undo`) appelant les mêmes fonctions
- [x] Web : aucun dans ce lot, comme prévu
- [x] Tests unitaires : store→restore retrouve la valeur d'origine ; adjustByDelta clamp aux bornes (via describe()) ; adjust sans clamp + undo annule exactement ce delta ; rejets sans état préalable (restore/undo) ; store→adjust→restore revient bien au checkpoint d'ORIGINE ; undo après un store seul (sans adjust) est rejeté — chemins isolés sur des channels distincts pour ne pas interférer avec la map partagée au niveau module
- [x] **Test live** : store/restore et adjust/undo sur un fader réel, confirmé exact sur la console + une découverte notable (voir notes)
- [x] Nettoyage + case cochée

**Notes d'implémentation :** la Map process-lifetime est un singleton au niveau module (pas rattaché à `ctx`), donc partagée entre toutes les sessions MCP/REST — cohérent avec la formulation du plan ("état en mémoire process"), mais les tests unitaires utilisent volontairement des chemins distincts par scénario pour éviter toute interférence entre `it()` puisque la map n'est jamais réinitialisée entre les tests.

**Revue de code (2026-08-28) — 2 bugs réels trouvés et corrigés :**
1. **Clamping mort en pratique** : `adjustValueByDelta` appelait `describe()` sur la feuille brute (ex. `/ch/1/fdr`) au lieu du bloc parent — or `describe()` sur une feuille brute échoue réellement sur ce firmware (voir découverte ci-dessous), donc le clamp ne se déclenchait jamais en pratique, contrairement à `wing-auto-compress.ts`/`wing-auto-gate.ts` qui décrivent bien un bloc. Corrigé : `describe(baseNode)` (le bloc parent, via `splitLeafPath`) puis filtrage du paramètre par sa clé exacte (`parseWingDescribeParams(...).find(p => p.key === key)`), au lieu de prendre `params[0]` à l'aveugle.
2. **`restoreValue` ne revenait plus au checkpoint d'origine après un `adjustValueByDelta` intercalé** : les deux fonctions partageaient le même champ de la map, donc un adjust écrasait silencieusement la valeur d'origine mémorisée par `storeValue` — `restoreValue` réécrivait alors la valeur déjà ajustée (no-op), au lieu de revenir en arrière. Corrigé en séparant la map en deux champs indépendants (`checkpoint` pour store/restore, `lastAdjust` pour adjust/undo) qui ne s'écrasent jamais l'un l'autre. Corrige au passage un bug annexe : `undoLastAdjust` ne pouvait pas distinguer une entrée "store seul" d'un vrai ajustement et acceptait donc d'"annuler" un ajustement qui n'avait jamais eu lieu — `lastAdjust` est maintenant `undefined` tant qu'aucun `adjustValueByDelta` n'a eu lieu, et supprimé une fois consommé par `undoLastAdjust`.

2 nouveaux tests de régression ajoutés (store→adjust→restore revient à l'origine ; undo après store seul rejeté), fixture `describe()` mise à jour pour décrire le bloc `/ch/2`/`/ch/3` (plusieurs paramètres, pas juste `fdr`) au lieu de la feuille.

**Test live (2026-08-28, avant ET après la correction) :** instance isolée sur 8788 (8787 jamais démarré/touché). Cycle complet sur le vrai fader du channel 1 (valeur d'origine réelle : 0 dB) : `wing_store_value` → checkpoint 0 ; `wing_adjust_value_by_delta` (delta -3) → ACK réel, relecture confirmant -3.0 dB sur la vraie console ; `wing_undo_last_adjust` → ACK réel, relecture confirmant le retour exact à 0 dB ; rejet d'un undo sans adjust préalable confirmé sans écriture. **Découverte notable (toujours valide)** : `wing_describe` sur une feuille simple comme `/ch/1/fdr` échoue réellement sur cette console (`isError: true`) — mais `describe("/ch/1")` (le bloc parent) **fonctionne**, confirmé en direct après la correction ci-dessus. Re-testé après le fix : `wing_store_value(/ch/1/fdr)` (checkpoint 0) → `wing_adjust_value_by_delta(delta: -1000)` → `clamped: true, newValue: -144` (le clamp se déclenche maintenant réellement, describe du bloc `/ch/1` ayant réussi) → `wing_restore_value` → revient exactement à 0 dB (le checkpoint d'ORIGINE, pas la valeur ajustée -144) → relecture console confirmant 0 dB. Fader restauré à son état d'origine.

**Nettoyage :** process isolé (port 8788) arrêté à chaque cycle, `data-test/` supprimé (scripts de vérification), aucun résidu sur 8788 confirmé, port de production 8787 jamais démarré ni touché. Fader du channel 1 confirmé revenu à sa valeur d'origine (0 dB) avant l'arrêt du process.
- OSC : aucun, couche client-side pure au-dessus des champs déjà lisibles/écrivables

---

## Priorité 2 (le reste, après les 13 ci-dessus)

Toutes nouvelles, MCP+REST seulement (pas de web UI dans ce lot sauf demande ultérieure). Chaque item suit le même schéma de checklist (métier → MCP → REST → tests unitaires → **test live** → nettoyage) :

- [ ] **Talkback** — `/cfg/talk` : `assign` (S: `OFF, CH40, AUX8`), sources `A`/`B` (`$on`, `mode`: `AUTO,PUSH,LATCH`, `mondim`/`busdim`, bits d'assignation par destination `B1..B16`/`MX1..MX8`/`M1..M4`) → `wing-talkback.ts` + `tools/talkback.ts`
- [ ] **Section solo/monitoring (control room)** — chemins exacts à extraire du PDF au moment de l'implémenter (pas encore fait)
- [ ] **GPIO** — `/$ctl/gpio/1..4` : `mode` (S: `TGLNO,TGLNC,INNO,INNC,OUTNO,OUTNC`), `$state` (RO), `gpstate` (écriture) → `wing-gpio.ts` + `tools/gpio.ts`
- [ ] **Éclairage console** — `/$ctl/cfg/lights` : zones `btns`,`leds`,`meters`,`rgbleds`,`chlcds`/`chlcdctr`,`chedit`,`main`,`glow`,`patch`,`lamp` (I, 0..100 sauf exceptions) → `wing-lighting.ts` + `tools/lighting.ts`, un seul tool avec paramètres optionnels par zone
- [ ] **Renvoi OSC brut vers une deuxième app** — pas un besoin protocole WING, fonctionnalité du serveur lui-même (mirror de ce que `ctx.client`/`ctx.meterClient` reçoit vers un host:port configuré) ; à concevoir séparément
- [ ] **Scribble light / icône / couleur — tool dédié** — champs déjà catalogués (`{prefix}/led` I 0..1, `/col` I 1..18, `/icon` I 0..999) mais accessibles seulement via le générique aujourd'hui ; ajouter `wing_set_scribble` (led/couleur/icône en un seul appel validé)
- [x] **Auto-discovery** — déjà couvert, aucun travail nécessaire : `wing_discover` retourne déjà IP/nom/modèle/série/firmware.

### Nouveau (2026-08-28, proposé par l'utilisateur) — Catalogue des plugins Gate/Dynamique/FX

**Constat** : `wing-param-catalog.ts` type déjà `gate/mdl`/`dyn/mdl` comme chaînes libres avec la note *"30+ models in firmware; not individually enumerated"* ; `tools/dynamics-status.ts`/`tools/auto-compress.ts` disent au LLM d'introspecter `mdl` en live faute de catalogue. `wing-dynamics-models.ts` ne connaît que 2 faits ad-hoc (préfixe `DEQ` bidirectionnel, modèle `GATE` à plage variable). Les slots d'insert `FX1..FX16` (`tools/insert.ts`) sont aussi complètement opaques. Le PDF de référence (`docs/WING_Remote-Protocols-3.1-03.pdf`) contient des annexes par-modèle jamais transcrites.

**Avis** : bonne idée — aucun nouvel appel OSC (`mdl` déjà lu/écrit), pure couche de données/introspection dans l'esprit de `WING_COLOR_NAMES`/`WING_ICON_CATEGORIES` (déjà dans `wing-param-catalog.ts`) et de la fonctionnalité #13 (pas de nouvelle capacité protocole). Le coût réel est la transcription manuelle des annexes PDF, pas le code. Recommandation : catalogue statique minimal `{id, type: "gate"|"dyn"|"fx", name, shortDescription, goodFor: string[]}` par modèle connu d'abord (sans specs exhaustives de chaque paramètre par modèle dès le premier jet — enrichissable modèle par modèle ensuite, comme `isBidirectionalDynModel` l'a fait pour DEQ). Prioriser les modèles déjà vus en live (CMB, 76LA, SBUS, NSTR, GATE, COMP, DEQ2) puis compléter avec le reste de l'annexe.

- [ ] **`wing_get_plugin_model`** — détail par `id` (complet), par `type` (`gate`/`dyn`/`fx`, liste de ce type), ou sans argument (liste complète en résumé) → nouveau `wing-plugin-catalog.ts` (données statiques) + `tools/plugin-catalog.ts`
- [ ] **`wing_list_plugins_by_usage`** — `{usage: string}` (ex: "vocal", "de-essing", "bus de mixage", "reverb") → sous-ensemble filtré du même catalogue avec mini-description, pour aider le LLM à choisir un modèle adapté
- [ ] Web : non prévu (outil d'introspection pour l'IA)
- [ ] Pas de test live requis pour la donnée elle-même (catalogue statique) — seulement vérifier que les 3 modes de `wing_get_plugin_model` et le filtre de `wing_list_plugins_by_usage` répondent correctement

## Vérification (cycle par fonctionnalité)

1. `npm test` — suite complète verte. Les 5 échecs docs-sync préexistants sont résolus (2026-08-28, `npm run docs:gen:wing` relancé après les fonctionnalités #6-13 — 326/326 tests passants).
2. **Test live obligatoire** sur l'instance isolée (port 8788, jamais 8787) — voir la case dédiée de chaque fonctionnalité ci-dessus.
3. Nettoyage : process tué, `data-test/` supprimé, tout état console modifié pour le test restauré à sa valeur d'origine.
4. Mettre à jour les cases ci-dessus (⬜ → ✅ après tests unitaires, → 🟢 après test live) avant de passer à la fonctionnalité suivante.
5. **Après tout changement de code touchant les chemins OSC** (nouveaux champs catalogués, nouvelles routes), relancer `npm run docs:gen:wing` avant de committer.
