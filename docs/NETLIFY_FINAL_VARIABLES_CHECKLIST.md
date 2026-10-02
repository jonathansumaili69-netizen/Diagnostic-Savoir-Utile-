# Checklist actuelle des variables Netlify — Conquistador OS

> Cette checklist ne contient aucune clé, aucun token, aucun mot de passe ni aucun secret. Les valeurs réelles doivent être saisies directement dans Netlify ou dans les portails officiels, jamais dans la conversation, le frontend ou l’archive publique.

## 1. Protection et mémoire serveur

| Nom exact | Valeur à saisir | Scope conseillé |
|---|---|---|
| `CONQUISTADOR_API_KEY` | Valeur secrète choisie pour protéger les routes privées | Production uniquement, valeur secrète |
| `CONQUISTADOR_WEBHOOK_SECRET` | Secret HMAC choisi pour les webhooks Conquistador | Production uniquement, valeur secrète |
| `REQUIRE_WEBHOOK_SIGNATURE` | `true` | Production |
| `MAX_HTTP_BODY_BYTES` | `1048576` | Production |
| `ALLOWED_ORIGIN` | `https://conquistadoros1.netlify.app` si cette URL est bien l’URL finale du site | Production |
| `SUPABASE_URL` | URL du projet Supabase existant `sgbaltdxjdxlrqsefekf` | Production |
| `SUPABASE_SERVICE_KEY` | Service key du projet existant, saisie côté serveur uniquement | Production uniquement, valeur secrète |

Ne jamais utiliser `ALLOWED_ORIGIN=*` comme configuration finale. `SUPABASE_SERVICE_KEY` ne doit jamais apparaître dans `public/`, dans le navigateur, dans un log ou dans l’archive.

## 2. Fournisseurs IA — ordre canonique obligatoire

Le routage reste **Gemini → Groq → OpenRouter → Mock**. Le fournisseur réellement utilisé est enregistré dans les résultats et le journal. Mock est un repli local explicitement signalé, pas une génération distante.

| Nom exact | Valeur non secrète éventuelle | Rôle |
|---|---|---|
| `GEMINI_API_KEY` | Clé saisie directement dans Netlify | Premier fournisseur et inspection vidéo audiovisuelle si URL publique accessible |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Modèle Gemini |
| `GROQ_API_KEY` | Clé saisie directement dans Netlify | Repli 2 |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Modèle Groq |
| `OPENROUTER_API_KEY` | Clé saisie directement dans Netlify | Repli 3 facultatif |
| `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct:free` | Modèle OpenRouter facultatif |

Sans clé Gemini et sans URL vidéo HTTPS réellement accessible, le contrôleur ne prétend pas avoir inspecté les pixels, l’audio ou le binaire vidéo. Les métadonnées seules ne suffisent pas à déclarer une vidéo conforme.

## 3. Rémy Neural — configuration optionnelle

| Nom exact | Valeur à saisir | État attendu |
|---|---|---|
| `VOICE_PROVIDER` | `Rémy Neural via edge-tts` ou valeur équivalente réelle | Non sensible |
| `VOICE_NAME` | `Rémy Neural` | Non sensible |
| `VOICE_STUDIO_API_URL` | URL HTTPS durable du serveur Rémy Neural hébergé par l’utilisateur | Facultative |

Netlify ne fournit pas automatiquement ce serveur FastAPI. Tant qu’aucune URL HTTPS durable n’est configurée, `/api/voice/health` doit afficher `configured: false` ou une disponibilité fausse, et `/api/voice/generate` doit refuser proprement. Ne pas utiliser une URL temporaire ou inventée.

## 4. Meta Facebook et Instagram — après préparation officielle

| Nom exact | Valeur à saisir | Rôle |
|---|---|---|
| `META_APP_ID` | App ID de l’application Meta | Non secret côté configuration serveur |
| `META_APP_SECRET` | Secret de l’application Meta | Secret serveur |
| `META_CONFIGURATION_ID` | ID de configuration Facebook Login for Business | Configuration OAuth |
| `META_OAUTH_REDIRECT_URI` | `https://conquistadoros1.netlify.app/api/meta/oauth/callback` | Callback exact |
| `META_TOKEN_ENCRYPTION_KEY` | Clé de chiffrement préparée | Secret serveur |
| `META_WEBHOOK_VERIFY_TOKEN` | Jeton de vérification choisi | Secret serveur |
| `META_GRAPH_API_VERSION` | `v26.0` ou version officiellement supportée au moment du déploiement | Version Graph |

Le connecteur reste `NON CONNECTÉ` jusqu’à l’autorisation officielle et au test serveur réel. La présence des variables ne suffit pas à déclarer Facebook ou Instagram connectés.

## 5. YouTube

| Nom exact | Valeur à saisir | Rôle |
|---|---|---|
| `YOUTUBE_CLIENT_ID` | Client OAuth Web du projet Google associé à la chaîne visée | OAuth |
| `YOUTUBE_CLIENT_SECRET` | Secret client Web Google | Secret serveur |
| `YOUTUBE_OAUTH_REDIRECT_URI` | `https://conquistadoros1.netlify.app/api/youtube/oauth/callback` | Callback exact |
| `YOUTUBE_TOKEN_ENCRYPTION_KEY` | Clé de chiffrement préparée | Secret serveur |
| `YOUTUBE_OAUTH_SCOPE` | `https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload` | Lecture et upload |

Le compte choisi pendant l’autorisation doit administrer la chaîne visée. L’upload V1 utilise une URL vidéo HTTPS accessible depuis Netlify et reste privé par défaut. Le connecteur reste `NON CONNECTÉ` tant que l’OAuth et le test serveur n’ont pas réussi.

## 6. TikTok

| Nom exact | Valeur à saisir | Rôle |
|---|---|---|
| `TIKTOK_CLIENT_KEY` | Client key de l’application TikTok | OAuth |
| `TIKTOK_CLIENT_SECRET` | Secret client TikTok | Secret serveur |
| `TIKTOK_OAUTH_REDIRECT_URI` | `https://conquistadoros1.netlify.app/api/tiktok/oauth/callback` | Callback exact |
| `TIKTOK_TOKEN_ENCRYPTION_KEY` | Clé de chiffrement préparée | Secret serveur |
| `TIKTOK_OAUTH_SCOPE` | `user.info.basic,video.list,video.publish` uniquement si les scopes sont effectivement validés | Capacités autorisées |

TikTok doit avoir l’URI HTTPS exacte dans Login Kit Web, Login Kit activé et Content Posting API/Direct Post préparé. `video.publish` peut rester limité ou privé tant que l’audit TikTok n’est pas terminé. Aucun état connecté ne doit être affiché avant le stockage sécurisé et le test réel du token. Après une approbation, Conquistador conserve la correspondance `content_key`/`content_id` → `publish_id` → `provider_status`; `/api/tiktok/publish-status?publication_id=...` permet de relire l’état réel. Une soumission reste `EN_TRAITEMENT` tant que TikTok ne retourne pas un état final positif.

## 7. Variables de robustesse optionnelles

| Nom exact | Valeur conseillée |
|---|---|
| `APPROVAL_EXPIRY_HOURS` | `72` |
| `KILL_SWITCH_DEFAULT` | `false` pour test contrôlé, `true` pour démarrage entièrement bloqué |
| `AI_PROVIDER_TIMEOUT_MS` | `25000` |
| `AI_PROVIDER_MAX_RETRIES` | `1` |
| `AI_CIRCUIT_BREAKER_THRESHOLD` | `3` |
| `AI_CIRCUIT_BREAKER_COOLDOWN_MS` | `60000` |
| `RATE_LIMIT_PER_MINUTE` | `30` |

## 8. Préparation multiplateforme et médias

Le type `content.adapt_platforms` prépare séparément les variantes TikTok, Instagram Reels, Facebook Reels et YouTube Shorts. Il ne publie jamais. Le pipeline vidéo exige une URL HTTPS durable et un manifeste avec timeline minutée, voix et sous-titres ; les vidéos montées manuellement dans CapCut restent compatibles si le manifeste est fourni.

La base de connaissances accepte des références texte ou des URL HTTPS classées `text`, `image`, `document`, `video` ou `reference`, avec un marqueur officiel. Cette version ne prétend pas téléverser directement des fichiers ni extraire automatiquement le contenu d’un PDF.

## 9. Modes et campagnes

Les réglages sont persistés côté serveur dans les collections existantes. Le mode **Silencio** observe et prépare, **Copilot** propose et demande, et **Conquistador** autorise seulement une campagne bornée lorsque la campagne est activée, qu’un quota positif est défini et que la plateforme est autorisée.

Même dans Conquistador, la publication externe reste soumise à l’approbation humaine, à l’expiration de l’approbation, à l’idempotence et au kill switch. Le quota ne compte que les publications effectivement retournées comme `PUBLIE`; un blocage, une préparation ou une demande d’approbation ne consomme pas le quota.

## 10. Chariow — audit officiel, intégration non ajoutée

La documentation officielle Chariow confirme `https://api.chariow.com/v1`, l’authentification `Authorization: Bearer ...`, les ressources produits/ventes/clients et les Pulses webhook. Aucune route Chariow n’est encore ajoutée à ce bundle et aucune variable `CHARIOW_API_KEY` n’est attendue par le code actuel. Ne créez donc pas cette variable dans Netlify pour cette version. Une future intégration devra utiliser une clé créée dans **Settings → API Keys** du tableau de bord Chariow et la conserver uniquement côté serveur.

## 11. Ordre de vérification avant déploiement

Saisir les variables de protection et Supabase, puis les fournisseurs IA, puis les variables des plateformes réellement prêtes. Redéployer uniquement après une validation explicite. Vérifier `/api/health`, `/api/diagnostics`, `/terms`, `/privacy`, le dashboard, les statuts sociaux et les routes vocales. Tester une origine exacte autorisée et une origine différente refusée.

Le pipeline vidéo peut préparer, contrôler, transmettre les corrections et persister une revue. Il ne publie jamais directement. Une revue conforme signifie **prête pour l’approbation**, pas publiée.
