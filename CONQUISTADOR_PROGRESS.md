# CONQUISTADOR OS — JOURNAL DE PROGRESSION

Session limitée. Livraison intermédiaire demandée par l'utilisateur avant
la fin de l'audit complet (phases 2 à 18 non traitées).

## Constat important sur l'état réel du projet à la reprise

Le document de mission affirmait que les corrections suivantes étaient
déjà faites. Vérification factuelle : **aucune des deux n'existait dans
le ZIP fourni.**
- `deriveStatut()` (YouTube) : absente du code.
- `planner.getPublishedContentKeys()` : absente du code.
- Le garde-fou `review.publie === true` existait dans `scheduler-tick.js`
  mais `review.publie` n'était **jamais écrit** nulle part : republication
  garantie à chaque cycle (toutes les 30 min) pour tout contenu déjà publié.

## PHASE 0 — TERMINÉE

- Inspection de l'arborescence (`conquistador-os/`, ~140 fichiers hors
  node_modules).
- `npm test` exécuté sans `npm install` (le runner de test n'utilise que
  des modules Node natifs pour le cœur métier testé) : **264/264 tests
  existants PASS** avant toute modification.

## PHASE 1 — YOUTUBE + SCHEDULER : TERMINÉE

### Bug 1 corrigé : statut YouTube devenant un objet (`[object Object]`)

Fichier : `src/agents/systemActions.js`

- Ajout d'une vraie fonction `deriveStatut(publishResult, plateforme)`,
  exportée pour les tests.
- Ancien code : `publishResult.statut || publishResult.status` — si
  `status` est l'objet YouTube `{ uploadStatus, privacyStatus }`, il
  devenait le statut interne tel quel (bug `[object Object]`).
- Nouveau comportement :
  - `uploadStatus` `uploaded`/`processed` → `PUBLIE`
  - `uploadStatus` `rejected`/`failed`/`deleted` → `ECHEC` (jamais `PUBLIE`)
  - `status` objet sans `uploadStatus` exploitable → `EN_TRAITEMENT`
    (jamais `PUBLIE` par défaut, prudence)
  - un `statut` déjà fourni en chaîne par un connecteur (TikTok) reste
    prioritaire et intact.
- `publishPost()` utilise désormais `deriveStatut()` au lieu de l'ancienne
  ligne bugguée.

### Bug 2 corrigé : republication infinie du même contenu

Fichiers : `src/core/planner.js`, `netlify/functions/scheduler-tick.js`

- Ajout de `planner.getPublishedContentKeys()` : reconstruit l'ensemble
  des publications **réellement confirmées** à partir du journal
  persistant `DECISIONS` (`kind: planner_action`, `action: publish`,
  `status: success`), avec une **clé composite `content_key::plateforme`**
  (un même contenu publié sur deux plateformes différentes n'est pas un
  doublon ; sur la même plateforme, ça l'est).
- `scheduler-tick.js` vérifie cette clé **avant** toute tentative de
  publication et bloque avec `status: 'already_published'` si déjà
  publié avec succès.
- Après un succès (`PUBLIE` ou `EN_TRAITEMENT`), le contenu est en plus
  marqué `review.publie = true` dans sa fiche `video_review` (best-effort,
  garde-fou local rapide ; le journal `DECISIONS` reste la source de
  vérité en cas d'échec de cette écriture).
- Un échec de publication n'est **jamais** marqué comme publié → reste
  éligible à un nouvel essai au cycle suivant (vérifié par test).

### Tests

- `tests/agents.test.js` : 5 tests ajoutés (statut YouTube uploaded/
  rejected/failed/deleted/sans uploadStatus, non-régression du statut
  string TikTok).
- `tests/schedulerTick.test.js` (nouveau fichier) : 4 tests — publication
  au 1er cycle puis aucune republication aux cycles suivants ; l'historique
  est bien reconstruit par `getPublishedContentKeys()` ; un même
  `content_key` sur deux plateformes distinctes donne deux entrées
  séparées (pas un doublon) ; un échec reste éligible à un nouvel essai.
- **Résultat : 273/273 tests PASS** (264 existants + 9 nouveaux, 0
  régression).

### Limitation découverte, non corrigée (hors périmètre de cette session)

Dans `scheduler-tick.js`, la boucle qui construit la liste `ready` déduplique
les `video_review` **uniquement par `content_key`** (`seen.has(key)`), sans
tenir compte de la plateforme. Si deux fiches `video_review` distinctes
partagent le même `content_key` mais visent deux plateformes différentes,
seule la plus récente est retenue — l'autre est silencieusement ignorée.
Le scheduler ne peut donc pas aujourd'hui publier un seul contenu vers
plusieurs plateformes en un cycle à partir de deux fiches de revue
séparées. Ce n'est pas le bug de republication (déjà corrigé et testé),
mais une limitation de conception distincte à trancher : soit une fiche
de revue par (contenu, plateforme), soit un vrai fan-out multi-plateforme
explicite dans `scheduler-tick.js`.

### Note d'environnement (pas un bug produit)

`scheduler-tick.js` importe `@netlify/functions` (`schedule()`) en tête de
fichier — dépendance déjà déclarée dans `package.json`. Dans le bac à
sable utilisé pour cette session, aucun accès réseau n'était disponible
pour `npm install`, donc ce fichier ne pouvait pas être chargé sans un
stub temporaire local (créé puis supprimé avant livraison, jamais inclus
dans ce ZIP). Avec un `npm install` normal, ce point ne pose aucun
problème.

## PHASE SUIVANTE

Phase 2 (TaskEngine + approval + modes + kill switch), puis phases 3 à 18
telles que définies dans le brief. Non commencées.

## PHASE 2 — TASKENGINE + APPROVAL + MODES + KILL SWITCH : TERMINÉE

### Bug 3 corrigé (critique) : le kill switch ne bloquait JAMAIS REPLY_COMMENT

Fichier : `src/core/killswitch.js`

- `EXTERNAL_ACTION_TYPES` (liste des actions que le kill switch peut
  bloquer) contenait `SEND_MESSAGE, PUBLISH_POST, UPDATE_DATA, DELETE,
  COMMERCIAL_SENSITIVE` — **`REPLY_COMMENT` était absent**, alors que
  `taskEngine.js` le traite explicitement comme une action externe
  automatique au même titre que les autres.
- Conséquence réelle : même kill switch engagé (mode sécurisé), une
  réponse à un commentaire déclenchée par un webhook n'était **jamais**
  bloquée — violation directe de "le kill switch doit toujours avoir la
  priorité".
- Corrigé : `REPLY_COMMENT` ajouté à `EXTERNAL_ACTION_TYPES`.
- Tests : nouveau fichier `tests/killswitch.test.js` (4 tests unitaires)
  + un test d'intégration bout-en-bout dans `taskEngine.test.js`
  (webhook → mode Conquistador → kill switch engagé → bloqué).

### Bug 4 corrigé (critique, silencieux) : `statut_sortie` jamais persisté

Fichier : `src/core/memory.js`

- `memory.recordExecution()` avait un whitelist de champs à l'insertion
  qui **omettait `statut_sortie`**, alors que `taskEngine.js` et
  `scheduler-tick.js` le fournissent systématiquement à chaque appel.
- Conséquence réelle : `row.data.statut_sortie` valait toujours
  `undefined` en lecture, sans aucune erreur. Deux vérifications qui en
  dépendaient étaient donc inopérantes :
  - le quota quotidien de campagne dans `taskEngine.js`
    (`row.data?.statut_sortie === 'PUBLIE'`) — ne comptait jamais rien,
    le quota ne pouvait donc jamais bloquer par ce chemin ;
  - la nouvelle vérification stricte de `statistiques.js` (voir Bug 5).
- Corrigé : `statut_sortie: entry.statut_sortie || null` ajouté à
  l'objet inséré.
- Tests : 2 tests ajoutés dans `tests/memory.test.js` (persistance
  réelle + valeur `null` explicite si absent).

### Bug 5 corrigé : "tâche done" confondue avec "action réussie"

Fichier : `src/core/taskEngine.js`

- Toute tâche dont l'agent ne levait pas d'exception journalisait
  systématiquement `resultat: 'succes'` dans EXECUTIONS et
  `succes: true` dans LEARNINGS — **y compris quand l'action externe
  réelle était `NON_EXECUTE_AUCUNE_CONNEXION`, `ECHEC`, etc.** Une tâche
  "done" ne prouve que "l'agent n'a pas crashé", jamais qu'une
  publication/envoi/mise à jour a réellement été confirmée.
- Corrigé : nouvelle fonction `deriveExecutionResult(actionType, output)`
  qui n'accorde `resultat: 'succes'` pour PUBLISH_POST / SEND_MESSAGE /
  REPLY_COMMENT / UPDATE_DATA que si le statut de sortie réel confirme
  l'action (`PUBLIE`/`EN_TRAITEMENT`, `ENVOYE`, `ENVOYE`, `MIS_A_JOUR`
  respectivement) ; toute autre action (analyses, générations...) garde
  le comportement historique (`succes` = pas d'exception).
- Tests : 1 test unitaire direct sur la table de correspondance + 1 test
  d'intégration bout-en-bout confirmant qu'une tâche `done` sans
  connecteur journalise honnêtement `resultat: 'non_execute'`.

### Bug 6 corrigé (Phase 16 anticipée) : statistiques "publié" trop larges

Fichier : `src/agents/statistiques.js`

- `contenus_publies` comptait tout `PUBLISH_POST` avec `resultat ===
  'succes'` — ce qui, avec le Bug 5 corrigé, inclut légitimement
  `EN_TRAITEMENT` (soumission TikTok acceptée mais pas encore confirmée).
  Une stat affichée à l'utilisateur comme "publié" ne doit compter que
  du réellement confirmé.
- Corrigé : filtre resserré à `statut_sortie === 'PUBLIE'` explicitement.
- Test existant mis à jour (pas affaibli) pour couvrir explicitement le
  cas EN_TRAITEMENT exclu.

### Trou de couverture comblé : mode Copilot + REPLY_COMMENT

Silencio-bloque et Conquistador-auto-approuve étaient déjà testés pour
REPLY_COMMENT ; le cas Copilot (attente d'approbation humaine, ni
bloqué ni auto-approuvé) ne l'était pas. Ajouté dans `taskEngine.test.js`.
Vérifié : DM (SEND_MESSAGE) et kill switch scheduler (`planner.checkAction`)
avaient déjà une couverture directe suffisante — pas de nouveau test
ajouté pour ces deux-là.

### Bug de test corrigé (flaky, préexistant, sans lien avec les phases)

`tests/weeklyObjectives.test.js` : le test de `periodComparison` semaine
utilisait un décalage fixe de 10 jours pour placer une donnée "semaine
précédente" — invalide pour les semaines ISO (lundi-dimanche) certains
jours (échoue chaque lundi/mardi/mercredi). Corrigé avec un calcul
explicite du début de semaine ISO courante, robuste tous les jours de
la semaine. Vérifié stable sur 3 exécutions répétées.

### Tests

- 3 nouveaux fichiers/ajouts : `tests/killswitch.test.js` (nouveau, 4
  tests), extensions de `tests/taskEngine.test.js` (+3 tests),
  `tests/memory.test.js` (+2 tests), `tests/weeklyObjectives.test.js`
  (1 test réécrit + 1 test corrigé pour flakiness).
- **Résultat : 283/283 tests PASS** (274 après Phase 1 + 9 nouveaux,
  0 régression).

## PHASE 3 — MODES : COUVERTE PAR LA PHASE 2

Les règles Silencio/Copilot/Conquistador pour PUBLISH_POST, SEND_MESSAGE
(DM) et REPLY_COMMENT (commentaire), ainsi que la priorité du kill
switch (taskEngine ET scheduler), sont maintenant toutes testées
explicitement (voir ci-dessus + `tests/inboundPipeline.test.js` déjà
existant pour le chemin DM complet). Aucun bug supplémentaire trouvé
au-delà de ceux listés en Phase 2.

## PHASE SUIVANTE

Phase 4 (Instagram) puis Phase 5 (Facebook), telles que définies dans
le brief. Non commencées.

## SESSION SUIVANTE — IDEMPOTENCE META (PHASE 6) + BUG CHARIOW : TERMINÉE

Reprise sur checkpoint (283/283 tests PASS au départ, confirmé avant toute
modification).

### Bug 7 corrigé (critique) : idempotence Meta non atomique (claim = terminé pour toujours)

Fichiers : `src/core/memory.js`, `src/core/idempotency.js`,
`src/core/inboundPipeline.js`, `netlify/functions/meta-webhook.js`,
`src/core/config.js`, `docs/migrations/20260914_idempotency_claim_confirm_release.sql`,
`docs/supabase-schema.sql`.

- Constat : `claimIdempotencyEvent()` posait une marque définitive dès la
  première réclamation, **avant** tout traitement. Dans un payload
  contenant plusieurs événements (A + B), si A réussissait et B échouait,
  B restait marqué "déjà vu" pour toujours : un retry Meta ne le
  retraitait jamais, sans aucune erreur visible.
- Corrigé : chaque marqueur porte désormais un statut `EN_COURS` ou
  `TERMINE`. Cycle `CLAIM → traitement → CONFIRM` (uniquement après succès
  réel) ou `RELEASE` (après échec, pour un nouvel essai immédiat sans
  attendre l'expiration). Un `EN_COURS` non libéré (crash, timeout) redevient
  réclamable après expiration (`IDEMPOTENCY_TTL_MS`, 10 min par défaut) —
  "reprise raisonnable" au lieu d'un blocage définitif.
- Appliqué à deux niveaux dans le pipeline Meta :
  - `inboundPipeline.processInboundEvent` (scope `meta.inbound`, clé =
    événement individuel) — **c'est le niveau où se produisait le bug A/B**.
  - `meta-webhook.js` (scope `meta.webhook`, clé = payload entier) — protège
    en plus contre une exception non gérée qui interromprait tout avant la
    fin (le retry Meta de cette même livraison peut alors réessayer).
- `idempotency.checkAndMark()` reste inchangé pour les appelants qui n'ont
  pas de succès/échec distinct à protéger après coup (`webhook-sale.js`,
  `webhook-comment.js`, `webhook-message.js`) : implémenté comme
  claim+confirm immédiat, donc **aucune régression de comportement** pour
  ces trois handlers (vérifié par les tests existants, inchangés).
- Marqueurs pré-existants (écrits par l'ancien code, sans champ `statut`) :
  traités comme `TERMINE` par sécurité — jamais de retraitement silencieux
  de données antérieures à cette correction.
- Migration Supabase additive et non destructive (nouveau fichier
  `20260914_idempotency_claim_confirm_release.sql`) : `drop` explicite de
  l'ancienne fonction `claim_idempotency_event(text, text)` à 2 arguments
  (sinon PostgreSQL aurait créé une deuxième fonction surchargée au lieu de
  la remplacer, laissant l'ancien comportement bogué accessible en
  parallèle), puis recréation avec `p_ttl_ms` optionnel, plus
  `confirm_idempotency_event` et `release_idempotency_event` (ce dernier ne
  touche jamais une marque déjà `TERMINE`).
- Bug annexe découvert et corrigé au passage : `docs/supabase-schema.sql`
  (copie de référence "reproductible") était déjà désynchronisé de la
  fonction RPC réellement déployée par la migration du 15/08 (noms de
  colonnes de retour différents : `is_duplicate/existing_at` au lieu de
  `claimed/created_at`). Remis en cohérence avec l'état réel.
- Tests : 7 nouveaux tests dans `tests/memory.test.js` (les 6 scénarios
  demandés : nouvel événement, doublon immédiat, retry après échec,
  scénario A/B exact, EN_COURS non expiré, EN_COURS expiré — plus un 7e :
  `release` ne touche jamais un `TERMINE`) + 1 test d'intégration bout-en-
  bout dans `tests/inboundPipeline.test.js` reproduisant le scénario A/B
  via une vraie panne simulée sur l'agent `commercial.analyze_intent`.

### Bug 8 corrigé (critique) : webhook Chariow cassé (`claimIdempotencyEvent is not a function`)

Fichier : `netlify/functions/webhook-chariow.js`

- Constat : le handler importait `claimIdempotencyEvent` depuis
  `src/core/idempotency` — module qui n'exporte que `checkAndMark` et
  `deriveKey` (`claimIdempotencyEvent` vit dans `src/core/memory.js`,
  jamais appelé directement par les handlers webhook). Conséquence réelle :
  **tout appel avec un `id` présent levait une exception non gérée**. Même
  corrigé, l'appel original combinait scope+clé en une seule chaîne et
  traitait l'objet de retour (`{ doublon, ... }`) comme un booléen —
  toujours vrai, donc déduplication silencieusement désactivée même une
  fois le nom de fonction réparé.
- Corrigé : réécrit avec le même motif que les handlers Chariow/webhook
  fonctionnels (`webhook-sale.js`) : `idempotency.checkAndMark(scope, clé)`
  puis vérification explicite de `.doublon`.
- Tests : nouveau fichier `tests/webhookChariow.test.js` (4 tests) —
  absence de crash avec un `id` présent (régression directe du bug),
  doublon réellement ignoré, événement `successful_sale` journalisé,
  notification sans `id` acceptée sans idempotence.

### Tests — résultat final de session

- 33 fichiers de tests (32 existants + `tests/webhookChariow.test.js`
  nouveau).
- **295/295 tests PASS** (283 du checkpoint + 12 nouveaux : 7 dans
  `memory.test.js`, 1 dans `inboundPipeline.test.js`, 4 dans
  `webhookChariow.test.js`). **0 régression, 0 test affaibli ou retiré**
  pour obtenir ce résultat — vérifié en relisant chaque diff avant/après :
  aucune assertion existante modifiée ou supprimée, uniquement des ajouts.
- Suite exécutée sans réseau dans ce bac à sable via un stub local
  temporaire de `@netlify/functions` (créé, utilisé pour valider, puis
  supprimé — **absent du ZIP livré**, comme en Phase 1). Avec un `npm
  install` normal, aucun impact.

### RESTE À TRAITER — mise à jour

Phase 6 (idempotence webhook Meta par événement) retirée de la liste :
traitée cette session. Reste identique sinon : Phases 4-5, 7-18 (voir liste
ci-dessus, section "RESTE À TRAITER (rappel brief)") — non commencées.
- Phase 9 : OAuth (Meta/YouTube/TikTok) — state/CSRF/tokens/secrets.
- Phase 10 : connecteurs / statuts (CONNECTED vs CAPABILITY_UNAVAILABLE).
- Phase 11 : frontend.
- Phase 12 : sécurité (RLS, logs, secrets).
- Phase 13 : recherche routes legacy.
- Phase 14 : erreurs (promesses non awaitées, faux succès).
- Phase 15 : médias/stockage.
- Phase 16 : statistiques/logs (distinctions statuts) — partiellement
  anticipée (Bug 6 ci-dessus), reste à auditer plus largement.
- Phase 17 : `npm test` + tests supplémentaires.
- Phase 18 : recherche finale (TODO/FIXME/mock/placeholder/etc.).

## SESSION SUIVANTE — VIDEO ENGINE + FRONTEND REDESIGN + MODES/THÈMES : TERMINÉE (périmètre livré ci-dessous)

Reprise sur `CONQUISTADOR-OS-FINAL-FIXED.zip` (351/351 tests avant modification, 295 baseline confirmée + 56 tests hérités de la session précédente — corrigé : en réalité 295 était déjà le total avec les 12 ajouts idempotence/Chariow ; voir sessions précédentes pour le détail).

### Bug 9 corrigé (critique, frontend) : synchronisation du mode/thème

Fichiers : `public/app.js`, `public/index.html`, `public/style.css`.

- Constat confirmé par lecture de code puis **reproduit et vérifié corrigé en
  Playwright réel** (Chromium headless, viewport mobile 390px) : le clic sur
  un bouton de mode faisait `document.body.dataset.mode = requestedMode`
  immédiatement, avant tout appel réseau — le thème changeait avant la
  confirmation serveur. Root cause : deux flux de sauvegarde distincts
  (sélection de bouton vs bouton "Enregistrer" séparé) et deux sources de
  lecture du mode (`/dashboard` pour la Vue générale, `/settings` pour
  Paramètres), sans point d'application unique.
- Corrigé : `applyConfirmedMode()` est désormais le SEUL endroit qui touche
  `document.body.dataset.mode`, jamais appelé qu'avec une valeur confirmée
  par le serveur (réponse de `/dashboard`, `/settings`, ou d'un
  `PUT /settings` réussi). Nouvelle fonction `changeMode()` : le clic sur un
  bouton de mode déclenche directement une sauvegarde réelle (plus de
  sélection "en attente" ambiguë) ; échec → message d'erreur, aucun
  changement visuel n'a eu lieu donc aucun rollback nécessaire.
- Badge de mode ajouté dans la topbar (`#modeBadge`, visible depuis toutes
  les vues), rafraîchissement périodique (45s) de l'état confirmé.
- **Vérifié en conditions réelles (Playwright, pas seulement en lecture de
  code)** : mode inchangé pendant que la modale de confirmation est ouverte,
  changement effectif uniquement après résolution du `PUT /settings` réel,
  badge et Vue générale reflètent la même valeur. Un faux positif initial
  (403 "Origine non autorisée") était une protection CSRF existante
  (`ALLOWED_ORIGIN`, voir `src/utils/http.js`) mal configurée dans le
  harnais de test local — pas un bug du produit ; non modifié.

### Design system (Partie 2-3)

`public/style.css` : nouveau jeu de tokens centralisés (surface/texte
primaire-secondaire-muted/success/warning/error/info/shadow/radius/spacing/
transitions), identité par mode renforcée (Silencio = bleu-gris sobre,
Copilot = bleu actif, Conquistador = violet intense + bordures cuivrées),
transition fluide entre modes via `transition` sur `body[data-mode] *`.
Existant préservé (base ink/parchment/brass déjà présente et cohérente,
non réécrite inutilement) — étendu, pas remplacé.

### Video Engine — construit réellement (Parties 3-11 de la mission)

Nouveaux modules `src/core/` : `graphicEngine.js` (SVG→PNG via `sharp`,
zéro réseau), `subtitles.js` (SRT réel depuis des timings mesurés,
jamais inventés), `assetCache.js` (clé déterministe SHA-256, TTL),
`imageProviders/` (`graphicProvider.js`, `existingAssetProvider.js` réutilisant
les vraies images de `assets/`, `pollinationsProvider.js` réseau réel avec
repli honnête), `visualEngine.js` (orchestration continuité + providers +
cache + stockage), `videoFileQualityCheck.js` (ffprobe réel, distinct de
l'agent `videoQuality.js` existant qui contrôle le MANIFESTE),
`videoRenderer.js` (FFmpeg réel — RENDER WORKER, séparé de l'orchestrateur),
`videoJobs.js` (machine à états `video_jobs`), `videoOrchestrator.js`
(`createVideo()`/`processJob()` réels, résumables étape par étape).
3 endpoints Netlify (`video-jobs.js`, `video-job-get.js`,
`video-job-process.js`) + `scripts/render-worker.js` (worker externe réel).
Nouvelle vue "Video Engine" dans le frontend (formulaire + liste de jobs).

**Preuve réelle obtenue dans ce bac à sable** (ffmpeg/ffprobe/sharp présents,
réseau absent) : pipeline complet exécuté avec un manifeste fourni →
2 scènes avec assets réels (référence Samuel bundlée + Graphic Engine) → MP4
réel de 6s produit par FFmpeg → contrôle qualité ffprobe conforme → échec
HONNÊTE à la toute dernière étape (Supabase Storage non configuré ici) → job
`FAILED` avec cause exacte, jamais `COMPLETED` sans fichier livrable. Détail
et documentation complète : `docs/VIDEO_ENGINE.md`.

Bugs réels trouvés et corrigés en cours de développement (aucun n'existait
avant cette session sauf le premier) :
- `memory.getSupabaseClient` définie mais jamais exportée (pré-existant) →
  `mediaStorage.upload()` aurait levé une `TypeError` dès que Supabase est
  réellement configuré en production. Corrigé (export ajouté).
- `videoOrchestrator` : clé d'idempotence par étape manquante (bug introduit
  puis corrigé pendant cette session, avant livraison) — bloquait tout le
  pipeline après la première étape. Test de régression ajouté.
- `assetCache.get()` : `ttlMs: 0` traité comme "désactiver l'expiration" au
  lieu de "expirer immédiatement" (bug introduit puis corrigé pendant cette
  session). Test de régression ajouté.
- `docs/supabase-schema.sql` resynchronisé (table `video_jobs` ajoutée).

### Tests — résultat final de session

- **43 fichiers de tests, 351/351 PASS, 0 FAIL** (295 hérités + 56 nouveaux :
  graphicEngine 6, subtitles 6, assetCache 4, imageProviders 6, visualEngine
  3, videoFileQualityCheck 6, videoRenderer 5, videoJobs 8, videoOrchestrator
  6, videoJobEndpoints 6, +1 régression memory.getSupabaseClient).
- Tests réels, pas de mock présenté comme fonctionnel : rendu FFmpeg
  effectif vérifié par ffprobe, vrais fichiers PNG/MP4 sur disque inspectés.
- Vérification frontend réelle en plus des tests unitaires : Playwright +
  Chromium (déjà présents dans ce bac à sable) contre un mini-serveur
  reproduisant le routage Netlify — chargement de la page, navigation mobile
  (tiroir hamburger), affichage de la vue Video Engine, cycle complet de
  changement de mode avec vérification du non-changement prématuré du thème.
- Suite exécutée avec le même stub temporaire `@netlify/functions` que les
  sessions précédentes (créé, utilisé, supprimé avant packaging — absent du
  ZIP livré).

### Limitations réelles (non masquées — voir `docs/VIDEO_ENGINE.md` pour le détail)

- Génération d'image IA réseau (pollinations) et voix off réelle : code réel
  mais non vérifiable dans ce bac à sable (aucun accès réseau sortant) —
  repli automatique et fonctionnel sur le Graphic Engine / silence explicite,
  jamais un faux succès.
- Stockage durable (Supabase Storage) non configuré ici : un rendu valide
  reste honnêtement `FAILED` plutôt que `COMPLETED` sans URL livrable.
- Rendu FFmpeg dans une fonction Netlify standard : limite de temps
  d'exécution connue (voir `netlify.toml`) — pipeline conçu comme résumable
  étape par étape pour cette raison ; `scripts/render-worker.js` fournit le
  worker externe réel pour les rendus qui dépassent ce budget.
- Périmètre non traité cette session (déjà hors du champ le plus critique) :
  audit exhaustif ligne-par-ligne de nettoyage (Partie 11, fait de façon
  ciblée seulement), accessibilité complète (Partie 10, non auditée dans le
  détail), Phases 4-5/7-18 du brief global antérieur toujours en attente.
