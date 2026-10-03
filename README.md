# Conquistador OS — Savoir Utile

Système agentique de production de contenu pour **Savoir Utile** : agents, planification, approbation humaine, kill switch, connecteurs (Chariow, Meta, YouTube, TikTok), Voice Studio et un **moteur vidéo complet** (V2) produisant de **vrais MP4 vérifiés** — aucune réussite simulée.

## Rôle du Worker de rendu

Le Worker (`scripts/render-worker.js`) est le **composant d'exécution** du Video Engine. Les fonctions Netlify ont une durée d'exécution limitée : un rendu FFmpeg réel (plusieurs scènes, voix off, sous-titres, 37/45/60/90 s) peut légitimement la dépasser. Le Worker fait tourner **exactement le même code** que le reste du système — `src/core/videoOrchestrator.js` — dans un processus sans cette contrainte :

1. récupère les `video_jobs` non terminaux (`QUEUED → … → QUALITY_CHECK`), FIFO ;
2. fait avancer chaque job via l'orchestrateur existant (aucun moteur parallèle) ;
3. le pipeline réel s'enchaîne : assets (`assetCache`, `existingAssetProvider`, `graphicEngine`, provider image-to-image Hugging Face optionnel), voix (Voice Studio), timeline, composition, **rendu FFmpeg réel** ;
4. **contrôle qualité réel** du fichier produit (`videoFileQualityCheck.js` + `ffprobe` : existence, taille, conteneur, codec, durée, résolution, framerate, flux vidéo/audio) — un fichier invalide fait échouer le job proprement ;
5. upload vérifié vers **Supabase Storage** (bucket `conquistador-media`) via `mediaStorage.js` : `output_url` n'est enregistrable qu'avec `storage_ok: true` (garde-fou anti faux succès, appliqué dans `videoJobs.js`) ;
6. mise à jour d'état du job, logs structurés, nettoyage des fichiers temporaires.

### Idempotence et concurrence

- Création de job idempotente par `idempotency_key` (`videoJobs.createJob`) : un job relancé ne crée jamais un doublon.
- Un job en **statut terminal** (`COMPLETED`, `PUBLISHED`, `FAILED`, `CANCELLED`) ne peut plus être transitionné — pas de double rendu.
- Verrous d'idempotence `EN_COURS / TERMINE` avec TTL (`idempotency.js` + `memory.claimIdempotencyEvent`) : récupération propre après crash.
- Côté GitHub Actions, `concurrency: conquistador-worker` (sans `cancel-in-progress`) garantit qu'aucun passage planifié ne tourne en parallèle d'un autre.

### Usage

```bash
node scripts/render-worker.js            # boucle continue (poll 15 s)
node scripts/render-worker.js --once     # un passage sur tous les jobs en attente (cron/CI)
node scripts/render-worker.js --job=<id> # traite un job précis jusqu'à completion
node scripts/render-worker.js --interval=30000
```

Le mode `--once` renvoie maintenant un code de sortie non nul si un job échoue ou termine en `FAILED`; le mode continu journalise les échecs et poursuit les autres jobs. Prérequis machine : `ffmpeg` + `ffprobe` installés, Node ≥ 22, et les variables Supabase pour le stockage durable.

## Architecture générale

```
public/                 Dashboard (UI)
netlify/functions/      API serverless (tasks, approvals, connecteurs, video-jobs, voice…)
src/core/               Noyau : taskEngine, planner, approval, killswitch, memory,
                        idempotency, mediaStorage, videoOrchestrator, videoRenderer,
                        videoFileQualityCheck, videoJobs, voiceStudio, imageProviders/…
src/agents/             Agents métier (contenu, commercial, qualité, voiceOver, …)
scripts/                render-worker.js, verify-long-videos.js, diagnostics…
tests/                  Suite node:test (unitaires, intégration locale, longs rendus)
docs/                   Schéma Supabase, migrations, runbooks, rapports de production
```

Modes opératoires conservés : **silence / copilot / conquistador**, approbation humaine, kill switch, quotas — voir `src/core/operationalState.js`, `approval.js`, `killswitch.js`.

## Installation

```bash
npm ci            # installation reproductible (package-lock.json)
cp .env.example .env   # développement local uniquement — JAMAIS committer .env
npm test          # suite complète (node:test, séquentielle)
```

## Variables d'environnement principales

Voir **`.env.example`** pour la liste exhaustive et documentée. En résumé pour le Worker :

| Variable | Rôle | Obligatoire |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Accès à la file persistante des jobs et au stockage durable (serveur uniquement) | requis pour le Worker de production |
| `SUPABASE_MEDIA_BUCKET` | Bucket Storage média (défaut projet : `conquistador-media`) | non (fallback local honnête) |
| `HF_TOKEN` | Provider image-to-image Hugging Face — **serveur uniquement, jamais exposé** | non (repli `existing_asset`) |
| `IMAGE_IMG2IMG_MODEL` | Modèle img2img (défaut : `black-forest-labs/FLUX.1-Kontext-dev`) | non |
| `VOICE_STUDIO_API_URL` | Service voix off externe | non (statut VOICE_UNAVAILABLE honnête) |
| `CONQUISTADOR_DATA_DIR` | Répertoire du fallback JSON | non |

## GitHub Actions — Worker automatisé

`.github/workflows/conquistador-worker.yml` :

- **Planification automatique toutes les 5 heures** : `cron: "0 */5 * * *"` (00:00, 05:00, 10:00, 15:00, 20:00 UTC) ;
- **Déclenchement manuel** `workflow_dispatch` conservé, avec `job_id` optionnel ;
- permissions minimales (`contents: read`), `concurrency` anti double exécution, timeout 45 min ;
- étapes : checkout → Node 22 + `npm ci` → installation FFmpeg/ffprobe → syntaxe et suite complète `npm test` → préflight sans affichage de valeurs secrètes → état HF → vérification Voice Studio → **exécution** via `scripts/render-worker.js` (qui réutilise `videoOrchestrator`). Si l’URL ou la clé de service Supabase manque, le Worker de production est bloqué avant traitement.
- `workflow_dispatch` expose `validate_only: true` pour vérifier installation, syntaxe, tests et préflight sans appeler les services externes ni démarrer le Worker.

### Secrets GitHub à configurer (Settings → Secrets and variables → Actions)

Secrets requis pour traiter la file de production : `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. Facultatifs selon le chemin utilisé : `HF_TOKEN` (sinon repli officiel `existing_asset`), `VOICE_STUDIO_API_URL` (sinon voix indisponible signalée honnêtement), `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` (providers IA optionnels). Ils sont injectés uniquement dans les étapes qui en ont besoin ; le préflight n’affiche que les noms manquants, jamais leurs valeurs.

## Accès API et données privées

- `CONQUISTADOR_API_KEY` est exigée par l’API pour les lectures et écritures contenant des données métier : tableau de bord, tâches, approbations, jobs vidéo, réglages, connecteurs, objectifs, diagnostics détaillés, fournisseurs IA et rapport quotidien. Le navigateur l’envoie dans `x-conquistador-key`; elle est conservée dans le stockage local du navigateur qui l’a saisie.
- `GET /api/health` reste public pour la supervision et ne renvoie que des états de service, jamais une clé. La clé ne doit jamais être intégrée au JavaScript servi ni committée.
- Le flux n8n `docs/n8n-workflows/daily-report.json` exige une credential n8n `conquistadorApiKey` pour l’en-tête `x-conquistador-key`; ne pas inscrire la clé en clair dans le JSON exporté.
- Cette clé est un secret **partagé** : elle protège contre les appels anonymes, mais ne fournit pas d’identités individuelles ni de rôles. Tout détenteur autorisé de la clé dispose du même accès aux données du projet.

## Limites connues

- Un rendu long (90 s) tient dans le timeout CI de 45 min, mais un runner GitHub gratuit n'est pas dimensionné pour des files de jobs massives — prévoir un runner dédié au-delà.
- Sans Supabase accessible, le rendu local réussit mais le job ne peut pas être marqué COMPLETED (comportement volontaire, anti faux succès).
- Les quotas des providers gratuits (HF, voix, IA) s'appliquent ; les erreurs réseau sont retentées avec parcimonie par les modules concernés, jamais aveuglément sur des opérations non idempotentes.
