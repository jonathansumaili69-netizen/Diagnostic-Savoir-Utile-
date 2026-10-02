# CONQUISTADOR OS — VIDEO ENGINE V2 (Character Registry, timeline longue, publication)

> Ce document décrit **ce qui fonctionne réellement** et **ce qui nécessite une
> infrastructure externe**. Aucune fonctionnalité n'est présentée comme
> opérationnelle si elle ne l'est pas.

## 1. Character Registry / Character Bible

`src/core/characterRegistry.js` — source de vérité des identités visuelles
officielles (Samuel, Marc).

Pour chaque personnage sont conservés : `character_id`, nom, **référence
principale**, **références secondaires versionnées**, description visuelle,
caractéristiques du visage, coiffure, apparence générale, vêtements/style,
éléments distinctifs, style visuel, `metadata`, chemins/URL, version,
`content_sha256` et `reference_id` stable (16 hex).

Structure sur disque :

```
assets/personnages/
  samuel/samuel-reference-principale.jpeg      <- PRIMAIRE (immuable, prioritaire)
  samuel/refs/ref-samuel-*.jpg                 <- secondaires versionnées
  samuel/refs/ref-samuel-marc-*.jpg            <- scenes a deux personnages
  marc/marc-reference-principale.jpg           <- PRIMAIRE (immuable, prioritaire)
  marc/refs/ref-marc-*.jpg                     <- secondaires versionnées
  bible/bible-personnages-samuel-marc-v2-20260920.jpg
assets/logo/logo-savoir-utile-officiel.jpeg    <- logo officiel (jamais régénéré)
assets/logo/logo-savoir-utile-officiel-v2-20260920.jpg
```

**Aucun fichier officiel pré-existant n'a été supprimé, écrasé ou remplacé.**
Les 17 images fournies ont été ajoutées comme références **SECONDAIRES
versionnées**. La preuve d'intégrité (hashes SHA-256 des assets protégés) est
produite par `node scripts/register-character-refs.js` dans
`docs/evidence/asset-integrity-before-after.json`.

Politique d'invention : `resolveCharacterId()` renvoie `null` pour tout nom non
officiel ; `assertOfficialCharacter()` lève `CHARACTER_NOT_OFFICIAL`.
**Aucun personnage générique n'est jamais fabriqué en substitution.**

## 2. Génération conditionnée par référence (optionnelle)

`src/core/imageProviders/providerAdapter.js` — abstraction multi-fournisseurs
(Stability, fal.ai FLUX Kontext/FLUX.2, Replicate, endpoint générique), activée
**uniquement** par variable d'environnement + clé API. Aucune clé n'est écrite
en dur, aucun provider n'est requis.

`src/core/imageProviders/characterReferenceProvider.js` — provider
`character_reference` : construit un prompt d'identité explicite à partir de la
bible, envoie la référence principale **puis** les secondaires, et contrôle la
cohérence du résultat.

Chaîne de repli effective :

| Scene | Provider img2img configuré | Ordre |
|---|---|---|
| Samuel / Marc | non | `existing_asset → graphic_engine` (inchangé) |
| Samuel / Marc | oui | `character_reference → existing_asset → graphic_engine` |
| logo officiel | — | `existing_asset → graphic_engine` (jamais régénéré) |
| générique | — | `pollinations → graphic_engine` (inchangé) |

## 3. Contrôle de cohérence visuelle (Character QC)

`src/core/visualConsistency.js` — pHash DCT 32×32 → 8×8 (64 bits, distance de
Hamming) **+** signature couleur perceptuelle. Verdict explicite
**PASS / REVIEW / FAIL**, seuils configurables
(`VISUAL_CONSISTENCY_PASS_THRESHOLD`, `VISUAL_CONSISTENCY_REVIEW_THRESHOLD`).

Un asset `AI_IMAGE_REFERENCED` dont le contrôle n'est pas `PASS` est marqué
`needs_review` : l'orchestrateur ne peut pas le considérer conforme et le job
porte `needs_review: true` avec la raison. Aucune identité parfaite n'est
promise : le module documente explicitement qu'un score PASS est un
**indicateur perceptuel**, pas une garantie.

## 4. Timeline et vidéos longues

`src/core/videoTimeline.js` — **aucune limite artificielle à 10 s**.
`contrainte_duree_maximale_appliquee` reste `null` par construction.

Priorité des durées : **voix réellement mesurée** → timeline du manifeste →
durée par défaut explicite. Chaque scène porte `scene_id`, `start`, `end`,
`duration`, `visual_asset`, `character_references`, `narration_segment`,
`subtitle_segment`, `transition`, `metadata`, `quality_status`.
Validations réelles : aucun écran vide, aucun trou, ordre chronologique, durée
cible respectée, voix couverte, sous-titres dans leurs scènes et non en retard.

Cibles de test : 37 / 45 / 60 / 90 s (et 20/30/75 s).

## 5. Rendu et contrôle qualité

`src/core/videoRenderer.js` (FFmpeg, inchangé) + `src/core/videoFileQualityCheck.js`
(ffprobe : durée, résolution, FPS, codecs vidéo/audio, présence des pistes,
taille, intégrité du conteneur). Le QC global du job ajoute la validation de
timeline et de synchronisation. **Jamais `COMPLETED` sans fichier réel vérifié**
et sans URL de sortie récupérable.

## 6. Jobs et jonction scheduler ↔ video_jobs

`src/core/videoJobs.js` — machine à états complète (production **et**
diffusion) : `QUEUED, PREPARING, GENERATING_SCRIPT, PREPARING_REFERENCES,
GENERATING_ASSETS, GENERATING_VOICE, BUILDING_TIMELINE, COMPOSING, RENDERING,
QUALITY_CHECK, COMPLETED, READY, SCHEDULED, PUBLISHING, PUBLISHED, FAILED,
CANCELLED`. Les transitions d'orchestration restent **inchangées** (aucune
régression) ; les états de diffusion sont posés par `markReady`,
`schedulePublication`, `markPublishing`, `markPublished`, `markPublicationFailed`.

`src/core/schedulerBridge.js` — **la jonction manquante** : le pipeline vidéo
écrit dans `video_jobs`, pas dans `video_reviews` ; sans ce pont, un job rendu
n'était jamais pris en compte par le planificateur. Appelé par
`scheduler-tick.js`, il respecte : kill switch → règles de campagne → quotas →
idempotence persistante (`video.publish`) → confirmation provider réelle. **Un
fichier créé n'est jamais une vidéo publiée** : `PUBLISHED` exige un
`external_post_id`.

Endpoint : `netlify/functions/video-publish.js`
(`ready` / `schedule` / `publish` / `process_due`, GET = diagnostic).

## 7. Sécurité

Aucun secret dans le ZIP. `.env.example` documente toutes les nouvelles
variables. `assertApiKey` sur tout endpoint mutant ; kill switch conservé et
prioritaire ; RLS et idempotence existantes non contournées ; aucun token
exposé au frontend.

## 8. CE QUI NÉCESSITE UNE INFRASTRUCTURE EXTERNE

| Élément | État réel |
|---|---|
| Rendu FFmpeg (y compris 37/45/60/90 s) | **Fonctionne** partout où ffmpeg est installé (vérifié dans cet environnement). En fonctions Netlify, un rendu long dépasse le timeout : utiliser `scripts/render-worker.js`. |
| Génération conditionnée par référence | **Optionnelle** : exige une clé API d'un provider image-to-image. |
| Voix off réelle | Exige `VOICE_STUDIO_API_URL`. Sinon `VOICE_UNAVAILABLE` explicite, aucun audio fabriqué. |
| Stockage durable des rendus | Exige Supabase Storage ; sinon le job ne passe pas `COMPLETED` (signalé honnêtement). |
| Publication TikTok/YouTube/Facebook/Instagram | Exige des comptes OAuth configurés. Non vérifiable sans eux. |
| Base Supabase (persistance jobs) | Fallback JSON local utilisé si non configurée. |

## 9. Scripts de diagnostic

```
node scripts/diagnostics-video-engine.js    # état complet du moteur (lecture seule)
node scripts/register-character-refs.js     # manifeste + preuve d'intégrité du registre
node scripts/verify-long-videos.js [--keep] # rendus réels 37/45/60/90 s + ffprobe
npm test                                    # suite complète (anciens + nouveaux tests)
```
