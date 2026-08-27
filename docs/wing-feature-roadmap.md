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

### 6. Fades (courbes d'easing) — statut global : ⬜
- [ ] Nouveau `src/plugins/wing/wing-easing.ts` (fonctions d'easing — linéaire déjà existant + au moins quadratic/cubic/sinusoidal/exponential en in/out/in-out pour commencer)
- [ ] Étendre `wing-fade.ts`/`runFade` pour accepter `easing?: EasingName` appliqué à la fonction de progression
- [ ] Mettre à jour `tools/fade.ts` (paramètre `easing` optionnel) et la route REST `/fade`
- [ ] Web : `<select>` de courbe d'easing à côté de la durée dans les contrôles de fade existants
- [ ] Tests unitaires : `runFade` avec easing produit une séquence non-linéaire vérifiable (comparer la valeur à mi-durée à un fade linéaire)
- [ ] **Test live** : lancer un fade avec easing sur un fader réel et observer le comportement non-linéaire
- [ ] Nettoyage + case cochée
- OSC : aucun changement protocole — ramp 100% client-side, portage TS des courbes (11 algos × 3 directions dans le module Companion, pas besoin des 33 combinaisons dès le premier jet)

### 7. Statut des liaisons AES50 — statut global : ⬜
- [ ] Nouveau `wing-link-status.ts` (`getAesLinkStatus(ctx)` — dump groupé A/B/C + StageConnect, `clearAesErrors(ctx, port)`)
- [ ] Nouveau `tools/link-status.ts` (`wing_get_link_status`, `wing_clear_link_errors`)
- [ ] Route(s) REST appelant le même module
- [ ] Web : carte de diagnostic dans l'onglet Config (statut/erreurs par port, bouton reset)
- [ ] Tests unitaires : lecture groupée, écriture `clrerr`
- [ ] **Test live** : lire le statut réel des ports AES50/StageConnect de la console (même si "non connecté", vérifier que la lecture ne plante pas) et tester le reset des compteurs d'erreur
- [ ] Nettoyage + case cochée
- OSC : `/$stat/{A,B,C}/stat` (S RO: `-, OK, ERR, UPD`), `/dev` (RO), `/errorsc`/`errorsu` (I RO), `/clrerr` (I 0..1, écriture) ; bonus `/$stat/rmt_{a,b,c}`, `/$stat/sc_stat` (S: `OK, ERR`), `/sc_devices`, `/sc_upcnt`/`sc_dncnt`

### 8. Sauvegarde manuelle en flash — statut global : ⬜
- [ ] Nouveau tool `tools/save-flash.ts` (`wing_save_to_flash` — description qui prévient explicitement du risque d'usure flash, pas de retry automatique)
- [ ] Petite fonction métier partagée (fichier existant pertinent ou nouveau `wing-console-admin.ts`, éventuellement regroupé avec l'item 9)
- [ ] Route REST appelant la même fonction
- [ ] Web : non (action rare/sensible, MCP/REST seulement)
- [ ] Tests unitaires : appel `set`/`bulkSet` exact, pas de retry silencieux en cas d'échec
- [ ] **Test live** : déclencher UNE sauvegarde flash réelle (une seule fois, pas en boucle vu l'avertissement du PDF sur l'usure) et confirmer l'ack
- [ ] Nettoyage + case cochée
- OSC : `/$ctl/$globals/$savenow` (I, écrire 1), `/$ctl/$globals/$noautosave` (I 0..1). Fallback à vérifier live si échec : `/$ctl/cfg/savenow`/`/$ctl/cfg/$noautosave` (incohérence interne du PDF entre deux sections)

### 9. Strip sélectionné — statut global : ⬜
- [ ] Nouveau `wing-selected-strip.ts` (`getSelectedStrip`, `setSelectedStrip` — réutiliser `decodeRtaSourceIndex`/`encodeRtaSource` de `wing-rta-source.ts:57-82`, même schéma 1..76 déjà testé)
- [ ] Nouveau `tools/selected-strip.ts`
- [ ] Route REST appelant le même module
- [ ] Web : aucun composant dédié dans ce lot (utile surtout pour un agent MCP)
- [ ] Tests unitaires : vérifier l'off-by-one lecture (0..75) / écriture (1..76) avec les mêmes cas que les tests RTA existants
- [ ] **Test live** : sélectionner un channel réel via le tool et confirmer que la console affiche bien ce strip comme sélectionné
- [ ] Nettoyage + case cochée
- OSC : `/$ctl/$stat/selidx` (I, lecture 0..75 / écriture 1..76 — off-by-one confirmé) ; voisins `pageidx`, `bandidx`, `sof`

### 10. Ligne à retard (delay) — statut global : ⬜
- [ ] Nouveau `wing-delay.ts` avec deux resolvers de chemin (`channelAuxDelayPath` vs `busMainMtxDelayPath`) unifiés derrière `setDelay(ctx, {type, index, on?, mode?, ms?})`
- [ ] Nouveau `tools/delay.ts`
- [ ] Route(s) REST appelant le même module
- [ ] Web : contrôle delay (on/off + valeur + unité) dans les panneaux de traitement existants
- [ ] Tests unitaires : un test channel (forme `in/set/dly*`) + un test bus/main/mtx (forme `dly/*`)
- [ ] **Test live** : activer un delay réel sur un channel ET sur un bus/main/matrix (les deux formes différentes) et confirmer sur la console
- [ ] Nettoyage + case cochée
- OSC : Channel/Aux (`{ch|aux}/{n}/in/set/dlyon`, `/dlymode` S: `M,FT,MS,SMP`, `/dly` F plage selon mode) ; Bus/Main/Matrix (`{bus|main|mtx}/{n}/dly/on`, `/dly/mode`, `/dly/dly`) — **deux formes différentes, pas un seul builder**

### 11. WING Live — statut global : ⬜
- [ ] Nouveau `wing-live.ts` : `getWLiveStatus(ctx)`, `runWLiveTransport(ctx, {card, action})`, `manageWLiveSession(ctx, {card, action, ...})`, `manageWLiveMarker(ctx, {card, action, ...})`, `formatWLiveCard(ctx, card)`
- [ ] Nouveau `tools/wing-live.ts` — un tool par groupe d'actions plutôt qu'un tool géant
- [ ] Route(s) REST appelant les mêmes fonctions
- [ ] Web : reporté — nouvel onglet dédié `WingLiveTab` seulement une fois le MCP+REST validé et si confirmé utile (ampleur trop grande pour l'entasser dans `WingMixerTab.tsx`)
- [ ] Tests unitaires : fixtures `/cards/wlive` et `/cards/wlive/1`, un test par famille (transport, session, marker, format)
- [ ] **Test live** : ⚠️ nécessite une vraie carte WING Live + carte SD insérée — si le hardware n'est pas disponible au moment du test, documenter explicitement cette limite ici plutôt que cocher 🟢 à tort ; au minimum confirmer que la lecture de statut "pas de carte" ne plante pas
- [ ] Nettoyage + case cochée
- OSC : sous-arbre `/cards/wlive` (global : `sdlink`, `$actlink`, `$battstate`, `autoin`, `auto_stop/play/rec`) + `/cards/wlive/{1,2}` (par carte : `$ctl/control` transport, `$ctl/opensession`/`namesession`/`deletesession`, `$ctl/setmarker`/`editmarker`/`gotomarker`/`deletemarker`, `$ctl/stime` seek ms, `$ctl/formatsdcard`, `cfg/rectracks`, `cfg/playmode`, `$stat/state`, `$stat/etime`, `$stat/sdfree`/`sdsize`/`sdstate`, `$stat/sessionlist`/`sessions`, `$stat/markerlist`/`markers`, `$stat/sessionlen`/`sessionpos`, `$stat/linkedpos`, `$stat/start`/`stop`, `$stat/errormessage`/`errorcode`)

### 12. Sous-mixeur "Direct Input" des matrices — statut global : ⬜
- [ ] Nouveau `wing-matrix-direct.ts` (`getMatrixDirectInput`, `setMatrixDirectInput`)
- [ ] Nouveau `tools/matrix-direct.ts`
- [ ] Route(s) REST appelant le même module
- [ ] Web : nouvelle section dans le panneau matrix existant (`StripProcessingPanels`), distincte des sends
- [ ] Tests unitaires : lecture/écriture des 4 champs, y compris l'enum `dir/in`
- [ ] **Test live** : activer le direct input sur une matrix réelle, changer la source, confirmer sur la console
- [ ] Nettoyage + case cochée
- OSC (déjà cataloguée dans `wing-param-catalog.ts:480-483`, jamais exposée) : `/mtx/{n}/dir/on` (I 0..1), `/dir/lvl` (F -144..10dB), `/dir/inv` (I 0..1), `/dir/in` (S: `OFF, AES, MON.PH, MON.SPK, MON.BUS`)

### 13. Pattern Store/Restore/Adjust-par-delta/Undo — statut global : ⬜
- [ ] Nouveau `wing-value-memory.ts` — état en mémoire process (`Map<path, {value, previousValue}>`) : `storeValue`, `restoreValue`, `adjustValueByDelta` (avec clamp min/max via describe(), même pattern que `wing-auto-compress.ts`), `undoLastAdjust`
- [ ] Nouveau `tools/value-memory.ts` — 4 tools génériques prenant un `path` arbitraire (comme `wing_get`/`wing_set`), pas de duplication par type de strip
- [ ] Route(s) REST appelant les mêmes fonctions
- [ ] Web : optionnel pour ce lot, pas de bouton dédié sauf besoin ultérieur
- [ ] Tests unitaires : store→modif→restore retrouve la valeur d'origine ; adjustByDelta clamp aux bornes ; undo après un seul adjust annule le delta
- [ ] **Test live** : store/restore et adjust/undo sur un fader réel, confirmer les valeurs exactes sur la console
- [ ] Nettoyage + case cochée
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

## Vérification (cycle par fonctionnalité)

1. `npm test` — suite complète verte hors les 5 échecs docs-sync préexistants sans rapport.
2. **Test live obligatoire** sur l'instance isolée (port 8788, jamais 8787) — voir la case dédiée de chaque fonctionnalité ci-dessus.
3. Nettoyage : process tué, `data-test/` supprimé, tout état console modifié pour le test restauré à sa valeur d'origine.
4. Mettre à jour les cases ci-dessus (⬜ → ✅ après tests unitaires, → 🟢 après test live) avant de passer à la fonctionnalité suivante.
