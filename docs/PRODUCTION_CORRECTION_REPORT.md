# Conquistador OS — rapport de correction production

**Version livrée :** V1.1.1 corrigée — archive CORS fixe\
**Date de vérification :** 17 août 2026\
**Périmètre :** archive existante `/home/ubuntu/work/conquistador-original-audit/conquistador-os/`, sans remplacement fonctionnel ni réinitialisation Supabase.

## Synthèse

Les défauts P0/P1 identifiés par l’audit ont été corrigés dans la copie de travail du projet existant. Les changements sont additifs : les dix tables Supabase existantes, leurs données, les déclencheurs et les activations RLS ont été conservés. Les seules opérations Supabase appliquées sont deux migrations d’indexation, de claim atomique et de privilèges RPC.

Le backend est désormais fail-closed en production pour la clé API, limite la taille des corps HTTP, vérifie les signatures HMAC des quatre webhooks entrants, ajoute des en-têtes de sécurité, normalise le rate limiting, empêche les décisions et reprises d’approbation invalides, et sérialise les courses locales par clé ou par tâche. Lorsque Supabase est configuré, il reste la mémoire persistante réelle ; une erreur de ce backend est remontée explicitement au lieu d’être masquée par un basculement JSON.

## Corrections principales

| Domaine | Correction livrée | Preuve |
|---|---|---|
| Authentification | `assertApiKey()` refuse l’absence de `CONQUISTADOR_API_KEY` en production | `src/core/validation.js`, `tests/production-hardening.test.js` |
| Webhooks | HMAC-SHA256 du corps brut exigé par défaut en production pour message, commentaire, vente et statistique | `src/core/validation.js`, `netlify/functions/webhook-*.js` |
| HTTP | Limite `MAX_HTTP_BODY_BYTES`, JSON partagé et en-têtes `nosniff`, `DENY`, `no-store`, CORS explicite | `src/core/validation.js`, `src/utils/http.js` |
| Rate limiting | Identité extraite des en-têtes de plateforme avec fallback contrôlé, sans faire confiance à un header applicatif arbitraire | `src/core/validation.js`, `netlify/functions/*.js` |
| Idempotence | Claim atomique Supabase par index unique partiel et RPC ; verrou local sérialisé en développement | `src/core/idempotency.js`, `src/core/memory.js`, `docs/migrations/20260815_add_atomic_idempotency.sql` |
| Concurrence | Verrou par tâche et compare-and-set des décisions d’approbation | `src/core/taskEngine.js`, `src/core/approval.js` |
| Expiration | Une approbation expirée ne peut plus reprendre ni exécuter une tâche | `src/core/approval.js`, `src/core/taskEngine.js` |
| Kill switch | Sélection déterministe du dernier état ; blocage externe conservé, analyses autorisées | `src/core/killswitch.js`, `src/core/memory.js`, `src/core/memoryStoreJson.js` |
| Cascade IA | Vérité publique unifiée : **Gemini → Groq → OpenRouter → Mock** ; fournisseur utilisé exposé dans le journal | `netlify/functions/health.js`, `public/app.js`, `.env.example` |
| Statuts | Distinction entre workflow terminé, action préparée, action exécutée et validation requise | `public/app.js` |
| Interface | Wizard réel en cinq étapes : Supabase, IA, Facebook/Instagram, TikTok, WhatsApp ; reflow mobile vérifié | `public/index.html`, `public/style.css`, `public/app.js` |
| Connecteurs | Aucun état social fabriqué ; les plateformes non configurées restent `NON CONNECTE` ; Facebook/Instagram disposent maintenant d’un flux OAuth Meta serveur | `src/core/socialConnectors.js`, `src/core/metaGraph.js`, `public/app.js` |

## Supabase

Le projet `conquistador-os` (`sgbaltdxjdxlrqsefekf`, région `eu-central-1`) reste `ACTIVE_HEALTHY`. L’inspection initiale a confirmé dix tables existantes avec la structure `id`, `created_at`, `updated_at`, `data jsonb`, RLS activée, des triggers `updated_at` et aucune donnée de production à migrer.

Les migrations additives appliquées sont `add_atomic_idempotency_events`, `harden_claim_idempotency_rpc_grants` puis `add_meta_connections_and_oauth_states`. Cette dernière crée uniquement `meta_connections` et `meta_oauth_states`, avec RLS, index d’unicité et aucun enregistrement initial. La première crée `uq_events_idempotency_scope_cle`, `idx_events_idempotency_lookup` et `claim_idempotency_event(text,text)`. La seconde révoque explicitement `EXECUTE` pour `public`, `anon` et `authenticated`, puis accorde uniquement ce privilège à `service_role`. La vérification PostgreSQL finale ne liste pour la RPC que `postgres` et `service_role`.

Le dernier advisor sécurité ne retourne aucun `WARN` ou `ERROR`. Les dix notices restantes `RLS enabled, no policy` sont de niveau `INFO` et correspondent à l’architecture backend-only : le navigateur ne reçoit jamais la clé `service_role` et aucune policy client publique n’a été inventée.

La preuve détaillée est conservée dans [`docs/SUPABASE_INSPECTION.md`](SUPABASE_INSPECTION.md). Le schéma reproductible et les migrations sont conservés dans [`docs/supabase-schema.sql`](supabase-schema.sql) et [`docs/migrations/`](migrations/).

## Tests et vérifications

La commande `npm test` a été corrigée pour Node.js 22 et exécute désormais `node --test --test-concurrency=1 tests/*.test.js`, afin de sérialiser les scénarios qui partagent le fallback JSON local. Après l’ajout de Meta, la suite finale compte **138 scénarios passants, 0 échec, 0 scénario ignoré**. `tests/metaIntegration.test.js` couvre le chiffrement AES-GCM, le state OAuth à usage unique, l’URL authorization-code, les capacités, le challenge/signature webhook, l’absence de fuite de tokens, le refus des actions sans permission et la clé API. Elle couvre les contrôles API, les corps trop grands, le JSON invalide, HMAC, les en-têtes HTTP, l’idempotence concurrente, le verrou de tâche, la double approbation, l’expiration, le kill switch et les régressions existantes.

Tous les fichiers JavaScript du backend et du dashboard passent également `node --check`. Le dashboard a été rendu dans Netlify Dev et sur le site public, puis capturé en 390×844 pixels. Le rendu mobile conserve les stations existantes, empile les blocs, maintient des cibles tactiles lisibles et rend les cinq étapes dans une rangée horizontale scrollable sans débordement fatal. Les notes et les captures sont dans [`docs/evidence/visual-verification-notes.md`](evidence/visual-verification-notes.md), [`docs/evidence/dashboard-mobile.png`](evidence/dashboard-mobile.png) et [`docs/evidence/live-dashboard-mobile-stabilized.png`](evidence/live-dashboard-mobile-stabilized.png) ; l’archive contient le code, les tests et les preuves reproductibles.

La comparaison entre le premier ZIP déployé et le code corrigé a détecté que l’ancien `src/utils/http.js` ne refusait pas encore une origine étrangère au niveau HTTP. La correction additive `assertAllowedOrigin(event)` est maintenant incluse dans l’archive CORS fixe : l’origine exacte reçoit HTTP 200, une origine étrangère HTTP 403, et les tests directs confirment ces trois cas.

L’archive compacte déposée depuis la page Deploys dédiée est `conquistador-os-netlify-deploy.zip` (7,19 Mo). Le déploiement final `6a81a4cc9bd23fdf8de62464` a bundlé 19 fonctions et le health public retourne désormais `memoire_backend: supabase`, avec l’origine autorisée exacte et l’ordre IA `gemini, groq, openrouter, mock`. Les contrôles live des webhooks donnent 401 sans signature, 401 avec signature erronée, 400 pour JSON ou corps non conforme et 413 pour un corps trop grand.

## Limites de déploiement à respecter

La clé `SUPABASE_SERVICE_KEY` doit être renseignée côté Netlify pour activer Supabase ; elle ne doit jamais être copiée dans le navigateur. Le secret `CONQUISTADOR_WEBHOOK_SECRET` doit être défini en production lorsque `REQUIRE_WEBHOOK_SIGNATURE=true`. Le fallback JSON est uniquement un mode local de développement et ne garantit pas la persistance entre invocations serverless. Les identifiants Meta et secrets Meta ne sont volontairement pas créés dans cette livraison. Le code d’intégration Facebook/Instagram est présent, mais les plateformes restent `NON CONNECTÉ` jusqu’à la création d’une application Meta et à la configuration des variables documentées dans [`docs/META_FACEBOOK_INSTAGRAM_SETUP.md`](META_FACEBOOK_INSTAGRAM_SETUP.md). Aucune connexion réelle n’a été simulée.
