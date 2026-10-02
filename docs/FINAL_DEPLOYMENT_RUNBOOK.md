# Runbook actuel — Conquistador OS

## État réel du bundle

Cette archive contient une version locale améliorée de l’application existante Conquistador OS, basée sur Node/CommonJS, Netlify Functions et Supabase ou fallback JSON local. Elle ne contient aucun secret et n’effectue aucun déploiement automatiquement. Elle ne réinitialise, ne supprime et ne remplace aucune donnée Supabase.

La suite isolée `npm test` est verte à **196 tests réussis, 0 échec** au 25 août 2026. Les contrôles de syntaxe JavaScript du dashboard et du backend sont également passés. Le dashboard local a été servi par Netlify Dev sur une instance dédiée et les nouveaux panneaux, la clé inline, la relance commerciale, le graphique de métriques, le panneau Rémy et les routes protégées ont été exercés.

## Ce qui est réellement dans cette version

Le pipeline `pipeline.video` crée le contenu, déclenche la revue éditoriale, déclenche la revue vidéo, transmet les corrections structurées à `content.revise` et limite les cycles de révision. Il persiste les revues vidéo et relie chaque revue à la clé et au titre du contenu. Il ne publie jamais directement.

Le rapport contrôleur-créatif expose les champs `problemes_identifies`, `corrections_demandees`, `comment_corriger` et `elements_a_preserver`, ainsi que les informations de timeline, voix, images, sous-titres, CTA, transitions, zooms et style de marque lorsqu’elles sont présentes dans le manifeste. Les preuves audiovisuelles réelles restent nécessaires : une URL HTTPS publique et une clé Gemini configurée sont requises pour une inspection média réelle. Les métadonnées seules ne valident jamais une vidéo.

Toute publication vidéo passe devant le contrôleur et renvoie `NON_EXECUTE_QUALITE_VIDEO` avant tout appel externe si la revue est absente, incomplète ou négative. En modes Silencio/Copilot, une revue conforme reste soumise à l’approbation humaine, à son expiration, à l’idempotence et au kill switch. En mode Conquistador, la publication peut être automatique une fois la qualité validée (seuil par défaut 85/100), la connexion vérifiée, les quotas/horaires/fuseau respectés et le kill switch désengagé.

Les modes **Silencio**, **Copilot** et **Conquistador** sont persistés. Conquistador ne lance pas un planificateur autonome : il permet seulement de préparer une campagne bornée si le mode, la campagne, la limite quotidienne et la plateforme sont valides. L’approbation humaine reste obligatoire. Le quota compte uniquement les sorties réellement retournées comme `PUBLIE`, pas les blocages ni les demandes d’approbation.

Le dashboard affiche le cycle de vie consolidé du contenu, les dernières revues vidéo persistées, le suivi TikTok `publish_id`/statut, les paramètres opérationnels, les variantes multiplateformes préparées, les références de connaissance, l’agent commercial, l’historique des relances et le graphique réel des vues par source. Une relance est enregistrée pour relecture et n’est jamais envoyée par ce formulaire. L’interface reçoit un retour inline pour l’enregistrement de la clé de navigateur afin d’éviter l’alerte native bloquante sur mobile.

La base de connaissances est additive et accepte actuellement des références texte ou URL HTTPS classées `text`, `image`, `document`, `video` ou `reference`, avec un marqueur officiel. Le contenu est injecté côté serveur dans le contexte des agents. L’upload natif de fichiers et leur extraction automatique ne sont pas prétendus disponibles dans cette version.

L’adaptateur Rémy Neural utilise une URL HTTPS durable facultative dans `VOICE_STUDIO_API_URL`. Tant qu’elle n’est pas configurée et réellement accessible, l’état vocal reste non disponible et aucune génération n’est simulée.

## Variables Netlify sans valeurs secrètes dans ce document

La liste complète et actuelle se trouve dans `docs/NETLIFY_FINAL_VARIABLES_CHECKLIST.md`. Les variables essentielles sont :

```text
CONQUISTADOR_API_KEY
CONQUISTADOR_WEBHOOK_SECRET
REQUIRE_WEBHOOK_SIGNATURE=true
MAX_HTTP_BODY_BYTES=1048576
ALLOWED_ORIGIN=https://conquistadoros1.netlify.app
SUPABASE_URL
SUPABASE_SERVICE_KEY
GEMINI_API_KEY
GROQ_API_KEY
OPENROUTER_API_KEY
VOICE_STUDIO_API_URL
```

Les variables `META_*`, `YOUTUBE_*` et `TIKTOK_*` ne doivent être ajoutées que lorsque les applications, callbacks, permissions et autorisations officielles correspondants sont prêts. Pour TikTok, le suivi post-publication utilise ensuite `GET /api/tiktok/publish-status?publication_id=...`; le `publish_id` ne doit jamais être confondu avec une publication finale. Les valeurs doivent être saisies directement dans Netlify. Aucun mot de passe, OTP, code MFA, token OAuth, secret d’application ou clé de fournisseur ne doit être copié dans le chat.

## Déploiement contrôlé à effectuer par l’utilisateur

Après validation du bundle et des variables, ouvrir le site Netlify existant `conquistadoros1`, choisir le déploiement manuel de l’archive ZIP et attendre que le déploiement termine. Ne pas créer un nouveau site ni remplacer le projet Supabase. Si Netlify demande des variables, les saisir dans **Project configuration → Environment variables** avec leurs scopes appropriés, sans les envoyer dans la conversation.

Après le déploiement, vérifier `/api/health`, `/api/diagnostics`, `/terms`, `/privacy`, puis le dashboard. Vérifier que `ALLOWED_ORIGIN` est l’URL exacte du site final. Une requête avec cette origine doit fonctionner ; une autre origine doit être refusée. Vérifier que les connecteurs Facebook, Instagram, TikTok et YouTube restent `NON CONNECTÉ` tant qu’un OAuth réel et un test serveur ne sont pas terminés.

Appliquer la migration TikTok additive `docs/migrations/20260823_add_tiktok_connections.sql` uniquement après validation explicite et dans le projet Supabase existant `sgbaltdxjdxlrqsefekf`. Elle doit être inspectée avant application et vérifiée ensuite par des lectures non sensibles. Cette migration ne doit être ni remplacée ni précédée d’un reset.

## Plateformes et limites connues

Meta, YouTube et TikTok nécessitent leurs autorisations officielles et leurs variables serveur. TikTok utilise `PULL_FROM_URL` et impose une URL HTTPS compatible ainsi que l’audit et les scopes approuvés pour la publication publique. YouTube reçoit en V1 une URL vidéo HTTPS accessible et reste privé par défaut. WhatsApp est hors périmètre de ce bundle.

Chariow a été audité uniquement à partir de sa documentation officielle. La base URL documentée est `https://api.chariow.com/v1`, l’authentification est `Authorization: Bearer ...`, et les Pulses sont des webhooks. Aucune route Chariow n’est implémentée ici et aucune variable `CHARIOW_API_KEY` ne doit être ajoutée pour cette version. Il ne faut pas inventer de signature webhook Chariow tant que la documentation ou la configuration de la boutique ne la confirme pas.

## Références officielles

1. [Documentation API Chariow](https://chariow.dev/api-reference/introduction)
2. [Authentification API Chariow](https://chariow.dev/api-reference/authentication)
3. [Pulses Chariow](https://chariow.dev/api-reference/pulses/list-pulses)
4. [Meta Graph API](https://developers.facebook.com/docs/graph-api/)
5. [Google OAuth 2.0 — Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
6. [YouTube Data API — videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
7. [TikTok Content Posting API](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
