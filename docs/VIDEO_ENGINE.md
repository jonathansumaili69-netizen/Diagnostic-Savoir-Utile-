# Video Engine — architecture, capacités réelles et limites

Ce document décrit ce que le Video Engine de Conquistador OS fait **réellement**,
distinctement de ce qui reste dépendant d'une infrastructure externe. Aucune
section ci-dessous ne prétend qu'une capacité fonctionne si elle n'a pas été
vérifiée dans ce dépôt.

## Vue d'ensemble du pipeline

```
IDEA/SCRIPT (contenu.fullVideo, existant)
   -> SCENES (existant, prompts + voix off par scène)
   -> VISUAL ENGINE (src/core/visualEngine.js)          [NOUVEAU]
        -> providers d'image (src/core/imageProviders/) [NOUVEAU]
        -> cache d'assets (src/core/assetCache.js)       [NOUVEAU]
   -> VOICE (src/agents/voiceOver.js + voiceStudio.js, existant, réutilisé)
   -> SUBTITLES (src/core/subtitles.js)                  [NOUVEAU]
   -> COMPOSITION + RENDER (src/core/videoRenderer.js)   [NOUVEAU — FFmpeg réel]
   -> QUALITY CHECK (src/core/videoFileQualityCheck.js)  [NOUVEAU — ffprobe réel]
   -> STOCKAGE (src/core/mediaStorage.js, existant)
   -> VIDEO JOB (src/core/videoJobs.js) piloté par
      src/core/videoOrchestrator.js                      [NOUVEAU]
```

Statut de chaque brique, honnêtement :

| Brique | Statut | Preuve |
|---|---|---|
| Graphic Engine (SVG→PNG, sharp) | **IMPLEMENTED + TESTED** | `tests/graphicEngine.test.js`, aucune dépendance réseau |
| Continuité visuelle (Samuel/Marc/logo, `existing_asset`) | **IMPLEMENTED + TESTED** | `tests/imageProviders.test.js` — réutilise les vraies images de `assets/` |
| Provider IA réseau (pollinations) | **IMPLEMENTED, NON TESTABLE ICI** | Code réel (fetch HTTP réel) ; ce bac à sable de développement n'a pas d'accès réseau sortant — voir "Limites" |
| Cache d'assets | **IMPLEMENTED + TESTED** | `tests/assetCache.test.js` |
| Sous-titres (.srt réel, timing mesuré) | **IMPLEMENTED + TESTED** | `tests/subtitles.test.js` |
| Video Renderer (FFmpeg réel) | **IMPLEMENTED + TESTED** | `tests/videoRenderer.test.js` — produit un vrai MP4 vérifié par ffprobe |
| Quality Check fichier (ffprobe réel) | **IMPLEMENTED + TESTED** | `tests/videoFileQualityCheck.test.js` |
| Video Job System (machine à états) | **IMPLEMENTED + TESTED** | `tests/videoJobs.test.js` |
| Orchestrateur `createVideo()` | **IMPLEMENTED + TESTED** (bout en bout, avec manifeste fourni) | `tests/videoOrchestrator.test.js` |
| Stockage durable (upload MP4/assets) | **IMPLEMENTED, BLOCKED PAR L'INFRASTRUCTURE DE CE BAC À SABLE** | Supabase non configuré ici ; voir `src/core/mediaStorage.js` (existant, réutilisé) |
| Génération de script par IA (`contenu.fullVideo`) | **EXISTANT, NON RE-TESTÉ ICI** | Nécessite un fournisseur IA réseau + clé API (déjà le cas avant cette mission) |

### Hugging Face Inference Providers (mise à jour 2026-10-04)

Le provider image-to-image `huggingface` utilise le SDK officiel
`@huggingface/inference` et le routeur Inference Providers. Le modèle
`black-forest-labs/FLUX.1-Kontext-dev` est actuellement publié par le Hub avec
le provider `fal-ai` pour la tâche image-to-image; il n'est pas listé par le
provider `hf-inference`. Configurer `IMAGE_IMG2IMG_PROVIDER=huggingface` et un
`HF_TOKEN` dont le scope inclut **Inference Providers** et l'accès accepté au
modèle FLUX. Si `HF_ENDPOINT` est renseigné, il reste réservé à un endpoint HF
dédié; le fonctionnement standard ne contacte plus l'ancien domaine
`api-inference.huggingface.co`.

Test de production réalisé le 4 octobre 2026 : le job isolé
`b15bcdae-910c-4161-9676-a3962df2e057` a abouti et produit un MP4 vérifié par
ffprobe (720×1280, H.264/AAC, 30 fps, 4,8 s), avec narration « Rémy Neural » et
stockage Supabase récupérable. Ce premier test a également mis en évidence le
défaut de l'ancien endpoint : les tentatives Hugging Face ont échoué puis le
pipeline a utilisé `existing_asset` comme prévu. Après migration au SDK, il
faut un nouveau job ciblé pour attester en production que le routeur Fal accepte
le token et renvoie effectivement une image. Le repli sur l'asset officiel
reste intentionnel et ne constitue jamais une preuve de génération IA.

## Ce qui a réellement été vérifié dans ce dépôt

Une exécution complète du pipeline (`videoOrchestrator.createVideo()`) avec un
manifeste fourni directement (donc sans dépendre du réseau pour le script) a
produit, dans ce bac à sable :
- 2 scènes avec assets visuels réels (référence officielle Samuel + Graphic
  Engine) ;
- un rendu MP4 réel de 6 secondes, vérifié valide par `ffprobe` (résolution,
  ratio, pistes vidéo/audio, durée) ;
- un échec **honnête** à la toute dernière étape car Supabase Storage n'est
  pas configuré dans ce bac à sable — le job est marqué `FAILED`, jamais
  `COMPLETED`, avec la cause exacte (voir `videoOrchestrator.stepFinalize`).

Voir `CONQUISTADOR_PROGRESS.md` pour le détail de cette exécution.

## Limites réelles connues (BLOCKED_BY_EXTERNAL_INFRASTRUCTURE)

1. **Aucun accès réseau sortant dans ce bac à sable de développement.** Le
   provider d'image IA réseau (`pollinationsProvider.js`) et tout
   téléchargement d'URL (voix, assets en cache) échouent ici avec une erreur
   réseau explicite, interceptée par la chaîne de repli
   (`imageProviders/index.js`) qui retombe alors sur le Graphic Engine — un
   vrai déploiement (Netlify, avec accès réseau normal) doit être utilisé
   pour vérifier ce chemin.
2. **Provider d'image `pollinations` : ni gratuit "illimité" ni garanti.**
   Au moment de la rédaction, `image.pollinations.ai` accepte des requêtes
   anonymes sans clé API, mais applique un débit limité (documentation
   communautaire du service : de l'ordre d'une requête toutes les ~15
   secondes en usage anonyme) et n'offre aucun SLA formel. Le code gère
   explicitement l'échec/quota/timeout et retombe sur le Graphic Engine —
   jamais un succès simulé. Si ce service change ses conditions, seul
   `src/core/imageProviders/pollinationsProvider.js` a besoin d'être ajusté
   (voir "Ajouter un provider" ci-dessous).
3. **Rendu FFmpeg dans une fonction Netlify standard.** Les fonctions Netlify
   standard ont un délai d'exécution limité (voir `netlify.toml`), souvent
   incompatible avec un rendu FFmpeg réel de plusieurs scènes. Le pipeline
   est conçu pour être **repris étape par étape** (`videoOrchestrator.processJob`,
   idempotent) plutôt que de tout exécuter d'un bloc :
   - `POST /api/video/jobs` crée le job et tente de le mener à COMPLETED
     dans le temps disponible (adapté aux vidéos courtes/simples) ;
   - si le temps est insuffisant, le job reste à son dernier statut atteint
     (jamais de double-rendu, jamais d'état incohérent) ;
   - `POST /api/video/jobs/:id/process` (ou `scripts/render-worker.js`,
     voir plus bas) reprend exactement là où le job s'est arrêté.
4. **Voix off réelle.** Dépend du service `VOICE_STUDIO_API_URL` existant
   (`src/core/voiceStudio.js`, non modifié). Non configuré ici → le job
   rapporte honnêtement `VOICE_UNAVAILABLE` et compose avec du silence
   explicite (jamais une voix inventée) — voir `videoOrchestrator.stepVoice`.
5. **Stockage durable.** Sans `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`
   configurés, un rendu peut être valide localement mais ne peut pas être
   livré à l'utilisateur : le job échoue explicitement à l'étape finale
   plutôt que d'être déclaré `COMPLETED` sans URL exploitable.

## Le "Render Worker" externe

`src/core/videoRenderer.js` est le seul module qui exécute FFmpeg. Il ne
connaît ni les jobs, ni Supabase, ni le réseau — il compose des fichiers
locaux déjà résolus. Cette séparation permet d'exécuter le rendu **en dehors**
de Netlify sans réécrire Conquistador OS :

```bash
node scripts/render-worker.js            # boucle continue (sondage 15s)
node scripts/render-worker.js --once     # traite les jobs en attente puis quitte (cron externe)
node scripts/render-worker.js --job=<id> # traite un job précis jusqu'à COMPLETED/FAILED
```

Prérequis réels pour que ce worker produise effectivement des MP4 livrables :
FFmpeg installé sur la machine, accès réseau sortant pour les providers
réseau, et les mêmes variables d'environnement Supabase que le reste de
Conquistador OS.

## Format vidéo

`format: { ratio, width, height }` est un paramètre du job, jamais codé en
dur dans le renderer — `9:16` (1080×1920) par défaut, `16:9`, `1:1`, `4:5`
supportés nativement par la même logique (voir le formulaire de génération
dans l'interface, vue "Vidéos").

## Ajouter un nouveau provider d'image

1. Créer `src/core/imageProviders/monProvider.js` respectant le contrat :
   `{ id, requiresNetwork, requiresApiKey, generate({scene, width, height, mode}) -> { buffer, contentType, provider, model, asset_type } }`.
   Lever une erreur avec `err.notApplicable = true` si le provider ne
   convient pas à cette scène (pour ne pas polluer les tentatives).
2. L'enregistrer dans `PROVIDERS` et l'inclure dans `buildProviderOrder()`
   (`src/core/imageProviders/index.js`).
3. Rien d'autre ne change : `visualEngine.js` et `videoOrchestrator.js`
   n'appellent que `imageProviders.generateAsset()`.

## Ajouter un nouveau renderer/composeur

`videoRenderer.renderManifest()` est le point d'entrée unique. Pour un
moteur de composition alternatif (ex. un service de rendu cloud dédié),
implémenter la même signature (`scenes`, `audioSegments`, `subtitlesSrtPath`,
`width`/`height`, `outputPath`, `workDir` → `{ outputPath, durationSeconds, ... }`)
et le substituer dans `videoOrchestrator.stepRender` — aucune autre étape du
pipeline n'a besoin de changer.

## Variables d'environnement (voir `.env.example`)

`IDEMPOTENCY_TTL_MS`, `IMAGE_PROVIDER_TIMEOUT_MS`, `POLLINATIONS_MODEL` sont
nouvelles pour le Video Engine ; `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`,
`VOICE_STUDIO_API_URL`, `CHARACTER_REF_SAMUEL`/`CHARACTER_REF_MARC`/`LOGO_ASSET_ID`
existaient déjà et sont réutilisées telles quelles.

---

## AUDIT FINAL 2.0.0-FINAL-FIXED (corrections de robustesse et d'honnêteté des états)

### 1. Cohérence des personnages — FAIL jamais masqué
`characterReferenceProvider.generate()` ne retourne PLUS le « meilleur résultat disponible »
lorsque la meilleure tentative reste en dessous du seuil REVIEW : il lève une erreur explicite
(`n'a jamais atteint le seuil`, avec `consistency_attempts` en pièce jointe). La chaîne de
repli retombe alors sur `existing_asset` (référence officielle exacte). Un visuel FAIL n'est
jamais présenté comme cohérent ; un job dont la cohérence n'est pas PASS est marqué
`needs_review` avec sa raison (visible dans le frontend).

### 2. Stockage vérifié obligatoire (`storage_ok`)
`videoJobs.transition()` et `videoJobs.patchJob()` REFUSENT désormais d'enregistrer une
`output_url` sans `storage_ok: true` — c'est-à-dire sans preuve d'un upload durable réel
(Supabase Storage, URL publique obtenue et retournée par `mediaStorage.upload`). Un fichier
créé localement n'est pas une vidéo récupérable. `stepFinalize` pose `storage_ok: true`
uniquement après un upload réussi.

### 3. Preuve de durée (`duration_proof`)
À la finalisation, le job enregistre `duration_proof` : `target_duration_seconds`
(entrée utilisateur `target_duration_seconds`), `actual_duration_seconds` (ffprobe réel,
via `videoFileQualityCheck`), `duration_delta_seconds` (écart signé). Aucune durée inventée.

### 4. Écart de durée (+2,4 à +3,5 s) — cause prouvée et corrigée
Cause réelle : la marge anti-coupure de voix (`VOICE_SAFETY_SECONDS`, 0,35 s) était ajoutée
à la fin de CHAQUE scène (0,35 × N). Or le renderer amortit déjà chaque voix dans la durée
de sa scène (`apad`, voir `videoRenderer.normalizeAudioSegment`) : aucune voix
intermédiaire n'est jamais coupée sans marge. Désormais la marge ne s'applique QU'À LA
DERNIÈRE scène. Résultat vérifié en test : rendu réel 37 s → durée ffprobe ≈ 37 s
(écart ≤ 0,5 s), et la marge est configurable via `VIDEO_VOICE_SAFETY_SECONDS` (0 = somme
exacte des voix). Le frontend permet de saisir une durée cible (`target_duration_seconds`).

### 5. Variables d'environnement concernées
- `IMAGE_IMG2IMG_PROVIDER` + clé correspondante (`STABILITY_API_KEY` | `FAL_API_KEY` |
  `REPLICATE_API_TOKEN` | `IMAGE_IMG2IMG_API_KEY` [+ `IMAGE_IMG2IMG_ENDPOINT` pour
  `generic`]) : génération image-to-image conditionnée par référence officielle. OPTIONNEL.
- `VOICE_STUDIO_API_URL` : voix off réelle. Sans lui : `VOICE_UNAVAILABLE` honnête.
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` + bucket `SUPABASE_MEDIA_BUCKET` : stockage
  durable. Sans eux : un rendu reste valable localement mais n'atteint PAS COMPLETED.
- `VIDEO_VOICE_SAFETY_SECONDS` : marge finale anti-coupure (défaut 0,35).
- `VIDEO_PUBLISH_MAX_ATTEMPTS`, `VISUAL_CONSISTENCY_PASS_THRESHOLD` (0,78),
  `VISUAL_CONSISTENCY_REVIEW_THRESHOLD` (0,60).

### 6. Limites honnêtes (tests non exécutables sans credentials externes)
Appels réseau RÉELS non exécutés dans l'environnement de validation (aucune clé fournie) :
providers image-to-image (stability/fal/replicate/generic), Voice Studio, OAuth
TikTok/YouTube/Meta et publication réelle. Ces chemins sont couverts par des tests
simulés/mockés (endpoint injoignable, réponse sans image, confirmation provider absente)
et par des vérifications de configuration ; aucun succès n'est simulé.
