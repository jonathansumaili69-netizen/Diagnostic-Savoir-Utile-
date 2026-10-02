# QUICKSTART — Je viens de telecharger Conquistador OS, que dois-je faire ?

Ce guide suppose que vous ne connaissez pas encore l'architecture du
projet. Suivez les etapes dans l'ordre. Chaque etape indique clairement si
elle est **obligatoire** ou **optionnelle**.

## Etape 1 — Installer (obligatoire)

```bash
cd conquistador-os
npm install
cp .env.example .env
```

## Etape 2 — Choisir une cle API pour proteger votre systeme (obligatoire)

Ouvrez `.env`, remplacez la ligne suivante par une phrase longue et
aleatoire que vous seul connaissez :

```
CONQUISTADOR_API_KEY=choisissez-une-cle-longue-et-aleatoire-ici
```

En local, cette clé permet de protéger les endpoints sensibles. En
production, elle est strictement obligatoire : le système refuse les requêtes
sensibles si `CONQUISTADOR_API_KEY` est absente. Sans autre configuration,
Conquistador OS fonctionne en local avec l’IA Mock et les fichiers JSON ; ce
fallback local ne constitue pas une mémoire persistante de production Netlify.

## Etape 3 — Verifier que tout fonctionne (recommande)

```bash
npm test
```

Doit afficher `# fail 0`. Puis lancez le systeme en local :

```bash
npx netlify-cli dev
```

Ouvrez http://localhost:8888 : le tableau de bord doit s'afficher. Le wizard
**Mise en route en cinq étapes** vérifie Supabase, l’IA, Facebook/Instagram,
TikTok et WhatsApp sans simuler de connexion. En haut de la page, la section
**"Etat systeme"** — cliquez sur **"Lancer le
diagnostic"** : il vous dira exactement ce qui est deja pret et ce qui
reste a configurer (🟢 / 🟡 / 🔴), sans que vous ayez besoin de comprendre
le code.

## Etape 4 — Connecter une vraie IA (optionnel, recommande)

Sans cle, le systeme fonctionne en mode "Mock" (reponses de reserve, pas
une vraie IA). Pour une vraie generation IA, choisissez-en au moins un
(les trois sont gratuits) :

1. **Gemini** (recommande en premier) : cle sur https://aistudio.google.com/app/apikey
   → coller dans `GEMINI_API_KEY`
2. **Groq** : cle sur https://console.groq.com → coller dans `GROQ_API_KEY`
3. **OpenRouter** : cle sur https://openrouter.ai → coller dans `OPENROUTER_API_KEY`

Aucune carte bancaire requise pour ces trois services (voir
`docs/AI_PROVIDERS.md` pour le detail complet).

## Etape 5 — Connecter une memoire persistante reelle (optionnel, recommande pour la production)

Sans configuration, la memoire est stockee dans des fichiers JSON locaux
(fonctionnel, mais pas garanti persistant une fois deploye sur Netlify).
Pour une vraie persistance :

1. Pour un nouveau projet, dans **SQL Editor**, coller et executer
   `docs/supabase-schema.sql`, puis `docs/migrations/20260815_add_atomic_idempotency.sql`.
2. Pour le projet dédié déjà préparé, les deux migrations sont déjà appliquées ;
   ne réinitialisez pas la base et ne recréez pas les tables.
3. Dans **Project Settings > API**, copier `Project URL` → `SUPABASE_URL`
   et la clé `service_role` (jamais `anon`) → `SUPABASE_SERVICE_KEY`.
4. Vérifier `/api/health` : `memoire_backend` doit devenir `supabase`.

Voir SETUP.md etape 4 pour le detail complet.

## Etape 6 — Verifier les references visuelles (deja fait pour vous)

Samuel, Marc et le logo officiel Savoir Utile sont **deja** integres et
actives par defaut (dossier `assets/`, variables deja pre-remplies dans
`.env.example`). Rien a faire ici sauf si vous remplacez ces references par
de nouvelles versions officielles (voir `assets/README.md`).

## Etape 7 — Signer les webhooks et connecter des plateformes sociales (optionnel, pour plus tard)

Pour la configuration actuelle, définir `CONQUISTADOR_WEBHOOK_SECRET`,
`REQUIRE_WEBHOOK_SIGNATURE=true`, `MAX_HTTP_BODY_BYTES=1048576` et
`ALLOWED_ORIGIN=__SAME_ORIGIN__`. Ce mode n’utilise jamais `*` : il accepte
uniquement l’origine qui correspond au même hôte que la requête. Après le
premier déploiement, remplacer obligatoirement `ALLOWED_ORIGIN` par l’URL HTTPS
exacte du site Netlify, redéployer, puis tester une origine autorisée et une
origine étrangère. Les webhooks doivent envoyer
`x-conquistador-signature: sha256=<HMAC-SHA256 du corps brut>`.

Aucune plateforme (WhatsApp, TikTok, Instagram...) n'est connectee par
defaut : le systeme prepare toujours les messages/publications mais ne les
envoie jamais automatiquement tant qu'aucun connecteur reel n'est ajoute.
Consultez la section **"Connecteurs sociaux"** du tableau de bord pour voir
l'etat actuel, et `src/core/socialConnectors.js` quand vous serez pret a
brancher une vraie integration (le fichier contient un exemple commente).

## Etape 8 — Deployer sur Netlify (quand vous etes pret)

Voir **SETUP.md, etape 6** pour la procedure complete, pas a pas. Resume :
poussez ce dossier sur un nouveau depot GitHub, importez-le sur Netlify,
ajoutez vos variables d'environnement dans les reglages du site, deployez.

## Et ensuite ?

- Le tableau de bord (`/`) est votre poste de commandement principal.
- La section "Etat systeme" repond a "qu'est-ce qui fonctionne / qu'est-ce
  qui manque ?" a tout moment — relancez le diagnostic apres chaque
  changement de configuration.
- Le "mode securise" (kill switch) est disponible en haut du tableau de
  bord si vous voulez temporairement bloquer tout envoi/publication sans
  toucher a la configuration.
- README.md reste la reference complete si vous avez besoin de plus de
  detail sur une fonctionnalite precise.
