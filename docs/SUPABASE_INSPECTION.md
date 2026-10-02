# Inspection Supabase — Conquistador OS

Date de l’inspection : 15 août 2026 (heure de session).

## Projet inspecté

Le projet Supabase `conquistador-os` a été identifié par son `project_id` `sgbaltdxjdxlrqsefekf`, dans la région `eu-central-1`. Son état est `ACTIVE_HEALTHY`.

## État structurel

Les dix tables mémoire attendues sont présentes : `events`, `tasks`, `contacts`, `content`, `metrics`, `decisions`, `errors`, `learnings`, `approvals` et `executions`. Elles suivent le modèle documenté `id uuid`, `created_at timestamptz`, `updated_at timestamptz`, `data jsonb`.

Les deux migrations existantes sont `conquistador_os_initial_schema` et `harden_set_updated_at_search_path`. Le déclencheur `trg_set_updated_at` appelle `set_updated_at()` sur les dix tables. Les index historiques documentés sont présents : timestamps des événements et tâches, statut des tâches et approbations, identifiant des contacts, date des métriques et date des exécutions.

Les compteurs exacts retournés pour les dix tables sont tous à `0`. Aucune donnée de production existante ne doit donc être déplacée ou transformée, et aucune opération destructive n’est nécessaire.

## Sécurité observée

La RLS est activée sur les dix tables et aucune policy n’est définie. Cette configuration est cohérente avec le modèle retenu : seul le backend Netlify doit employer `SUPABASE_SERVICE_KEY`, jamais le navigateur ni une clé `anon`. Le linter signale donc des notices d’information `RLS enabled, no policy`, sans constituer une autorisation d’accès public.

La fonction `set_updated_at()` a son `search_path` fixé, ce qui corrige le défaut de sécurité correspondant. Les extensions nécessaires aux UUID et au schéma existant sont disponibles, notamment `pgcrypto` et `uuid-ossp`.

## Recommandation additive

La correction d’idempotence sera ajoutée sans suppression, réinitialisation, duplication de table, modification de policy, modification de trigger ou transformation de données. Elle ajoutera une clé de déduplication exploitable par `events` et un index de recherche. La migration sera idempotente (`IF NOT EXISTS` lorsque PostgreSQL le permet) et sera vérifiée avant puis après application.

La garantie atomique de production reposera sur une insertion concurrente protégée par la contrainte unique côté Supabase. Le fallback JSON local restera disponible pour les tests et le développement, mais sera documenté comme une compatibilité locale et non comme une garantie distribuée entre instances serverless.

---

## Suivi — Audit du 24 septembre 2026

Deuxième inspection complète, directement contre le projet Supabase `conquistador-os` (`sgbaltdxjdxlrqsefekf`, `ACTIVE_HEALTHY`), confrontée au code source du bundle 2.0.0 FINAL-COMPLETE.

### Écarts trouvés et corrigés (code ↔ base)

1. **RPC d'idempotence obsolètes (bug critique)** : la base n'avait que l'ancienne fonction `claim_idempotency_event` à 2 arguments (celle du 15 août). Le code de `src/core/memory.js` appelle désormais `claim_idempotency_event(scope, cle, ttl_ms)` à 3 arguments, plus `confirm_idempotency_event` et `release_idempotency_event`, qui n'existaient pas du tout en base. Concrètement : tout webhook (Chariow, Meta, TikTok, YouTube, scheduler) qui atteignait une confirmation ou une libération d'idempotence échouait. Corrigé par `docs/migrations/20260914_idempotency_claim_confirm_release.sql` (appliqué), testé en direct (cycle CLAIM→CONFIRM→re-CLAIM et CLAIM→RELEASE→re-CLAIM).
2. **Tables manquantes** : `tiktok_connections`, `tiktok_oauth_states`, `video_jobs` existaient dans le code et dans des fichiers de migration du dépôt, jamais appliquées en base. Corrigées (`docs/migrations/20260823_add_tiktok_connections.sql`, `docs/migrations/20260915_video_jobs.sql`, appliquées).
3. **Bucket `conquistador-media` privé** alors que `mediaStorage.js` utilise `getPublicUrl()` (et que `.env.example` documente un bucket public) : passé en public, avec `allowed_mime_types` restreints aux types réellement produits par le code (`audio/mpeg`, `image/png`, `image/jpeg`, `video/mp4`). La `file_size_limit` initialement configurée à 200 Mo était trompeuse : l'organisation est sur le plan Supabase **Free**, dont la limite plateforme est 50 Mio — voir point 6.

### Durcissement additif (au-delà du strict nécessaire au code)

4. **Grants par défaut retirés** (`docs/migrations/20260924_revoke_anon_authenticated_table_grants.sql`) : Supabase accorde par défaut `SELECT/INSERT/UPDATE/DELETE` à `anon` et `authenticated` sur toutes les tables `public`. Le backend n'utilise jamais ces rôles (uniquement `service_role`, `rolbypassrls=true` confirmé) ; seule la RLS empêchait l'accès réel. Ce premier niveau de privilège a été retiré explicitement (défense en profondeur), y compris pour les tables futures (`alter default privileges`). Vérifié : `anon` voit `0` ligne sur `decisions` (1018 lignes réelles) et un `insert` en tant qu'`anon` est rejeté par la RLS.
5. **Contraintes CHECK sur les statuts** (`docs/migrations/20260924_add_status_check_constraints.sql`) : les enums de statut réellement utilisés par `taskEngine.js`, `approval.js`, `metaStore.js`/`youtubeStore.js`/`tiktokStore.js` et `videoJobs.js` sont désormais imposés au niveau base (NULL toléré, toute autre valeur hors-enum rejetée). Vérifiées avant application contre les données live : aucune violation. Testé : une valeur inventée est rejetée, une valeur valide (`QUEUED`) est acceptée.
6. **Limite de taille du bucket alignée sur le plan Free** (`docs/migrations/20260924_fix_bucket_free_plan_size_limit.sql`) : le bucket annonçait 200 Mo alors que la plateforme (plan Free) rejette tout fichier au-delà de 50 Mio, quelle que soit la configuration du bucket. La limite configurée est désormais 50 Mio (52428800 octets), c'est-à-dire la limite réelle et atteignable. Non destructif : aucun objet supprimé.

### État final (24/09/2026)

17 tables (10 collections génériques + `meta_connections`/`meta_oauth_states` + `youtube_connections`/`youtube_oauth_states` + `tiktok_connections`/`tiktok_oauth_states` + `video_jobs`), RLS activée sur les 17, zéro policy publique, zéro grant `anon`/`authenticated`, 9 contraintes CHECK de statut, 3 fonctions RPC d'idempotence complètes (claim/confirm/release), bucket Storage `conquistador-media` public correctement configuré (MIME `audio/mpeg`, `image/png`, `image/jpeg`, `video/mp4` ; `file_size_limit` = 50 Mio, aligné sur la limite plateforme du plan Free). Aucune donnée existante modifiée ou supprimée (les compteurs de lignes de toutes les tables préexistantes sont inchangés). Aucune Edge Function Supabase (architecture 100% Netlify Functions, cohérent avec `netlify.toml`).

### Reste hors de portée de cet accès

- Test réel d'upload binaire (nécessite un appel HTTP à l'API Storage, indisponible depuis cet environnement d'audit).
- Confirmation du contenu de `SUPABASE_SERVICE_KEY` côté Netlify (seule sa présence dans le code est vérifiable, jamais sa valeur).
