# SETUP.md — Installation pas a pas de Conquistador OS

Ce guide part de zero : un dossier de projet extrait du ZIP, jusqu'a un
systeme deploye et utilisable depuis un telephone Android.

> Pour l'essentiel en 8 etapes rapides sans lire tout ce document, voir
> **QUICKSTART.md**.

## Etape 0 - Prerequis

- Node.js 18 ou plus recent installe sur votre machine (`node --version`).
- Un compte GitHub (ou GitLab/Bitbucket) pour heberger le code — Netlify
  deploie depuis un depot Git.
- Un compte Netlify gratuit (https://app.netlify.com).
- Optionnel mais recommande : un compte Google AI Studio
  (https://aistudio.google.com), un compte Groq (https://console.groq.com)
  et/ou un compte OpenRouter (https://openrouter.ai) pour de vraies
  generations IA. Sans cela, le systeme fonctionne en mode MOCK.
- Optionnel mais recommande pour la production : un compte Supabase
  (https://supabase.com) pour une memoire reellement persistante.

## Etape 1 - Installation locale

```bash
cd conquistador-os
npm install
cp .env.example .env
```

Ouvrir `.env` et definir au minimum (obligatoire en production) :

```
CONQUISTADOR_API_KEY=choisissez-une-cle-longue-et-aleatoire-ici
```

Toutes les autres variables sont optionnelles au demarrage (voir
docs/LIMITES.md pour l'impact de chacune).

## Etape 2 - Verifier que tout fonctionne (tests)

```bash
npm test
```

Doit afficher `# fail 0` a la fin. Si un test echoue, ne pas deployer avant
d'avoir corrige (voir la section "Tests" de README.md).

## Etape 3 - Lancer en local avec Netlify CLI

```bash
npx netlify-cli dev
```

Cette commande demarre le site statique (`public/`) ET les fonctions
(`netlify/functions/`) ensemble, sur http://localhost:8888. Ouvrir cette URL
dans un navigateur : le tableau de bord doit s'afficher. Renseigner la cle
API (celle definie dans `.env`) dans le champ prevu en haut du tableau de
bord pour pouvoir creer des taches et approuver des actions.

Cliquer sur **"Lancer le diagnostic"** en haut du tableau de bord : il
indique immediatement, sans avoir besoin de lire ce guide, ce qui est deja
pret (🟢), ce qui reste optionnel (🟡) et ce qui pose reellement probleme
(🔴).

Tester rapidement un endpoint :

```bash
curl http://localhost:8888/api/health
curl http://localhost:8888/api/diagnostics
```

## Etape 4 - Supabase : deja prepare, une seule action manuelle reste a faire

Un projet Supabase **dedie** a Conquistador OS a deja ete cree et configure
pour vous :

- Nom du projet : `conquistador-os`
- Region : `eu-central-1`
- URL : `https://sgbaltdxjdxlrqsefekf.supabase.co`
- Schema (`docs/supabase-schema.sql`) deja applique : les 10 tables
  (`events`, `tasks`, `contacts`, `content`, `metrics`, `decisions`,
  `errors`, `learnings`, `approvals`, `executions`) existent, avec Row Level
  Security activee (aucun acces client anonyme possible) et le trigger
  `updated_at` fonctionnel.
- Migration additive `add_atomic_idempotency_events` deja appliquee : index
  unique partiel sur les marqueurs d’idempotence, index de recherche et RPC
  `claim_idempotency_event` réservé à `service_role`. Aucune donnée de
  production existante n’a été supprimée ou transformée.
- Le linter peut conserver la notice informative `RLS enabled, no policy`,
  volontaire dans ce modèle backend-only ; la fonction `set_updated_at()` et
  la RPC ont un `search_path` explicite.
- `SUPABASE_URL` est deja renseignee dans `.env.example`.

**Il ne vous reste qu'UNE etape manuelle**, parce qu'Anthropic/Supabase ne
permettent pas de recuperer une cle secrete `service_role` automatiquement
(bonne pratique de securite : cette cle contourne toutes les protections et
ne doit jamais transiter par un outil tiers) :

1. Ouvrir https://supabase.com/dashboard/project/sgbaltdxjdxlrqsefekf/settings/api-keys
2. Copier la cle **`service_role`** (PAS la cle `anon` ni `publishable`).
3. La coller dans `.env` (local) et dans les variables d'environnement
   Netlify (etape 6) sous le nom `SUPABASE_SERVICE_KEY`.

Une fois cette clé renseignée, `GET /api/health` doit afficher
`"memoire_backend": "supabase"` au lieu de `"json"`. Les erreurs Supabase
sont désormais remontées explicitement : le système ne bascule pas
silencieusement vers JSON lorsqu’un backend persistant est configuré.

En production, définir aussi `CONQUISTADOR_WEBHOOK_SECRET` et laisser
`REQUIRE_WEBHOOK_SIGNATURE=true`. Les quatre webhooks entrants doivent fournir
`x-conquistador-signature: sha256=<HMAC-SHA256 du corps brut>`.

Un projet Supabase Free se met en pause apres 7 jours sans requete : si
Conquistador OS est utilise au moins une fois par semaine, ce n'est jamais
un probleme. Sinon, ajouter un ping hebdomadaire (GitHub Actions ou
cron-job.org) qui appelle `/api/health` pour maintenir l'activite.

> Si vous preferez utiliser un autre projet Supabase (le votre, ou un
> nouveau), executez simplement `docs/supabase-schema.sql` dans son SQL
> Editor et remplacez `SUPABASE_URL` en consequence — rien d'autre dans le
> code n'a besoin de changer.

## Etape 5 - (Optionnel mais recommande) Configurer un fournisseur IA

**Gemini** (fournisseur prioritaire par defaut) :
1. Creer une cle sur https://aistudio.google.com/app/apikey.
2. Ajouter `GEMINI_API_KEY=...` dans `.env` / Netlify.
3. Verifier que `GEMINI_MODEL` correspond a un modele gratuit actuellement
   disponible (voir docs/LIMITES.md ; `gemini-2.5-flash` par defaut).

**Groq** (deuxieme fournisseur, le plus rapide) :
1. Creer un compte sur https://console.groq.com.
2. Generer une cle API dans **API Keys**.
3. Ajouter `GROQ_API_KEY=...` dans `.env` / Netlify.

**OpenRouter** (troisieme fournisseur, filet de securite supplementaire) :
1. Creer un compte sur https://openrouter.ai (aucune carte bancaire requise
   pour les modeles `:free`).
2. Generer une cle API dans **Keys**.
3. Ajouter `OPENROUTER_API_KEY=...` dans `.env` / Netlify.
4. Le roster de modeles gratuits change regulierement : verifier
   `https://openrouter.ai/models?max_price=0` et ajuster `OPENROUTER_MODEL`
   si necessaire.

Sans aucune de ces trois cles, le systeme utilise automatiquement le mode
MOCK (voir docs/LIMITES.md et docs/AI_PROVIDERS.md pour le classement
justifie complet) : tout continue de fonctionner, sans vraie IA.

## Etape 5b - Verifier les references visuelles officielles (Samuel, Marc, logo)

Les references officielles de Samuel, Marc et du logo Savoir Utile sont
**deja incluses** dans ce projet (dossier `assets/`, voir `assets/README.md`
pour le detail complet des bios et du style vestimentaire) et
**deja pointees par defaut** dans `.env.example` via `CHARACTER_REF_SAMUEL`,
`CHARACTER_REF_MARC` et `LOGO_ASSET_ID`. Aucune action n'est necessaire pour
activer VISUAL_CONTINUITY_POLICY : copier `.env.example` vers `.env` (etape
1) suffit a ce que le systeme considere ces references comme presentes.

Si vous remplacez ces references par de nouvelles versions officielles a
l'avenir, mettez a jour les fichiers dans `assets/` ET les variables
correspondantes en consequence.

## Etape 6 - Deployer sur Netlify

**Important : Conquistador OS est un projet Netlify entierement separe.**
Les etapes ci-dessous creent un **nouveau** site Netlify a partir d'un
**nouveau** depot Git : votre site Savoir Utile actuel (le site principal,
la boutique, etc.) n'est jamais touche, modifie, ni redeploye par ce
processus. Aucune etape de ce guide n'ecrit sur un site existant.

### Option A - Via l'interface Netlify (recommandee, sans ligne de commande)

1. Pousser le dossier `conquistador-os` sur un nouveau depot GitHub.
2. Sur https://app.netlify.com, cliquer **Add new site > Import an existing
   project**, choisir le depot.
3. Netlify detecte `netlify.toml` automatiquement (publish = `public`,
   functions = `netlify/functions`). Laisser les reglages par defaut.
4. Avant de cliquer sur Deploy, aller dans **Site settings > Environment
   variables** et ajouter toutes les variables necessaires (voir
   `.env.example`) : `CONQUISTADOR_API_KEY`, `CONQUISTADOR_WEBHOOK_SECRET`,
   `REQUIRE_WEBHOOK_SIGNATURE=true`, `MAX_HTTP_BODY_BYTES=1048576`,
   `ALLOWED_ORIGIN=__SAME_ORIGIN__`, et idealement `GEMINI_API_KEY`, `GROQ_API_KEY`,
   `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
5. Cliquer **Deploy site**. Le mode `__SAME_ORIGIN__` est temporaire et
   n’utilise jamais `*`.
6. Récupérer l’URL HTTPS exacte fournie par Netlify, remplacer
   `ALLOWED_ORIGIN` par cette URL seule, redéployer, puis vérifier une requête
   avec cette origine et le refus d’une origine différente. Le nom du site propose par defaut sera
   aleatoire ; le changer en `conquistador-os` (ou une variante si ce nom
   est deja pris) dans **Site settings > Site details > Change site name**.
7. Une fois deploye, ouvrir l'URL fournie : le tableau de bord doit
   s'afficher et `ALLOWED_ORIGIN` doit déjà contenir cette URL exacte.

### Option B - Via la ligne de commande

```bash
npx netlify-cli login
npx netlify-cli init
# suivre les instructions (creer un nouveau site, nom "conquistador-os")
npx netlify-cli env:set CONQUISTADOR_API_KEY "votre-cle"
npx netlify-cli env:set GEMINI_API_KEY "votre-cle-gemini"
npx netlify-cli env:set GROQ_API_KEY "votre-cle-groq"
npx netlify-cli env:set OPENROUTER_API_KEY "votre-cle-openrouter"
npx netlify-cli env:set SUPABASE_URL "https://xxxx.supabase.co"
npx netlify-cli env:set SUPABASE_SERVICE_KEY "votre-cle-service-role"
npx netlify-cli deploy --prod
```

## Etape 7 - Verifier le deploiement

```bash
curl https://VOTRE-SITE.netlify.app/api/health
```

Doit renvoyer un JSON avec `"statut": "operationnel"`. Ouvrir ensuite l'URL
du site sur un telephone Android (Chrome ou tout navigateur) : le tableau de
bord est concu pour etre utilisable directement sur mobile, sans application
a installer.

## Etape 8 - Utilisation quotidienne

- Renseigner la cle API dans le tableau de bord (bouton "Enregistrer",
  stockage local au navigateur uniquement).
- Utiliser le formulaire "Lancer une tache" pour tester chaque type de tache
  (voir README.md pour la liste complete).
- Les actions sensibles (envoi, publication) apparaissent dans "Approbations
  en attente" et doivent etre validees manuellement.
- Le bouton "Generer maintenant" dans la section Rapport quotidien produit
  un rapport a la demande ; la fonction planifiee `report-daily-scheduled.js`
  en genere un automatiquement chaque jour a 06h00 UTC.
- En cas de doute ou de comportement inattendu (spam de commentaires,
  ventes suspectes, etc.), activer le **mode securise** (kill switch) en
  haut du tableau de bord : plus aucune action externe (envoi, publication)
  ne peut s'executer tant qu'il n'est pas desactive manuellement, meme pour
  des actions deja approuvees. Les analyses et rapports continuent de
  fonctionner normalement.

## Etape 9 - (Optionnel) Connecter n8n ou une alternative

Voir README.md section "Connexion n8n" et docs/ALTERNATIVES.md pour le choix
de l'outil, et le dossier `docs/n8n-workflows/` pour des exemples prets a
importer.

## Depannage rapide

| Symptome | Cause probable | Solution |
|---|---|---|
| `401 Cle API invalide` | `CONQUISTADOR_API_KEY` non renseignee dans le tableau de bord | Renseigner la meme cle que celle definie sur Netlify |
| Le rapport quotidien montre `memoire_backend: json` en production | Supabase non configure | Suivre l'etape 4, ou accepter que la memoire ne persiste pas de maniere fiable entre les invocations |
| `429` ou reponses IA en mode MOCK inattendues | Quota Gemini/Groq/OpenRouter depasse | Normal : bascule automatique, verifier `/api/health` ou `/api/ai-providers` pour voir l'etat des fournisseurs |
| Fonction planifiee ne semble jamais s'executer | Netlify a change son mecanisme de scheduled functions | Utiliser le workflow n8n ou GitHub Actions de secours (docs/n8n-workflows/daily-report.json) |
| `npm install` echoue en local | Pas d'acces reseau ou registre npm restreint | Reessayer avec un reseau standard ; ce projet n'a que deux dependances (`@supabase/supabase-js`, `@netlify/functions`) |
