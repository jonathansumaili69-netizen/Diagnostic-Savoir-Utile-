# Limites gratuites des services utilises

Conformement a la section 31 du prompt maitre. Chiffres verifies par
recherche web en aout 2026 ; a reverifier periodiquement car ces plans
evoluent souvent.

| Service | Cout | Limites du palier gratuit | Obligatoire ? |
|---|---|---|---|
| **Netlify (Free)** | 0$ | Modele a credits depuis 2025-2026 : 300 credits/mois partages entre bande passante (20 credits/Go), deploiements (15 credits/deploiement), et calcul des fonctions (10 credits/Go-heure). Fonctions synchrones limitees a 10 secondes d'execution sur ce palier. Quand les credits sont epuises, les fonctions s'arretent jusqu'au mois suivant. | Oui (c'est la plateforme d'hebergement cible) |
| **Google Gemini API (palier Free)** | 0$ | Pour `gemini-2.5-flash` (modele par defaut configure) : environ 10-15 requetes/minute, jusqu'a 1 000 000 tokens/minute, et environ 250-1500 requetes/jour selon la region et les mises a jour recentes de Google. `gemini-2.0-flash` a ete retire le 3 mars 2026 : ne pas l'utiliser. | Non (fournisseur prioritaire par defaut ; bascule automatique vers Groq puis OpenRouter puis Mock, voir docs/AI_PROVIDERS.md) |
| **Groq (fournisseur IA, palier Free)** | 0$ | Environ 30 requetes/minute, ~6000 tokens/minute, et ~1000-14400 requetes/jour selon le modele (limites appliquees au niveau du compte, plusieurs cles n'aident pas). Le modele par defaut configure est `llama-3.3-70b-versatile`. | Non (deuxieme fournisseur, bascule automatique vers OpenRouter puis Mock) |
| **OpenRouter (fournisseur IA, modeles `:free`)** | 0$ | 20 requetes/minute, 50 requetes/JOUR sans achat de credits (1000/jour apres un achat unique et non renouvelable de 10$). Roster de modeles gratuits variable dans le temps ; modele par defaut `meta-llama/llama-3.3-70b-instruct:free`, configurable. | Non (troisieme et dernier fournisseur reel avant Mock) |
| **Mode Mock (fournisseur IA de secours)** | 0$ | Aucune limite : reponse locale deterministe sans appel reseau. Ne remplace pas une vraie IA generative, sert de filet de securite pour que le systeme continue de fonctionner. | Non, mais toujours disponible (aucune cle requise) |
| **Supabase (Free)** | 0$ | 500 Mo de base de donnees Postgres, 1 Go de stockage fichiers, 5 Go de bande passante sortante, 50 000 utilisateurs actifs mensuels (non utilise ici), 2 projets actifs maximum. **Un projet Free est mis en pause automatiquement apres 7 jours sans requete** (redemarrage manuel depuis le dashboard Supabase, ou ping hebdomadaire documente dans SETUP.md). | Recommande en production ; le JSON local n’est utilise que si Supabase n’est pas configure |
| **Fallback JSON local (memoryStoreJson.js)** | 0$ | Aucune limite de volume autre que le disque disponible. **Non persistant de maniere fiable sur une fonction Netlify deployee** (systeme de fichiers en lecture seule + `/tmp` ephemere) : fiable uniquement en developpement local (`netlify dev`). | Non, c'est deja le mode par defaut sans Supabase |
| **n8n Cloud** | Payant (24€/mois minimum, essai 14 jours) | N/A | Non, jamais utilise par ce projet |
| **n8n self-hosted (Community)** | Logiciel gratuit (licence fair-code) | Aucune limite logicielle ; cout reel = hebergement (VPS ~5-7$/mois) | Non, entierement optionnel (voir docs/ALTERNATIVES.md) |
| **GitHub Actions (cron, optionnel)** | 0$ sur depot public ; quota de minutes/mois sur depot prive | Execution "au mieux" (delai possible de quelques minutes), pas un vrai temps reel | Non, alternative de secours uniquement |
| **cron-job.org (optionnel)** | 0$ | Frequence minimale limitee sur le palier gratuit | Non, alternative de secours uniquement |

## Consequences concretes pour cette V1

1. **Sans aucune cle configuree**, Conquistador OS fonctionne integralement
   en mode MOCK (IA) + JSON local (memoire), ce qui permet de tester tout le
   systeme en local sans depenser un centime. Cette configuration n’est pas
   une garantie de persistance sur Netlify.
2. **Avec au moins une cle IA (GEMINI_API_KEY, GROQ_API_KEY ou
   OPENROUTER_API_KEY)**, les agents produisent de vraies generations IA,
   mais la memoire reste en JSON local (fiable en developpement, pas
   garantie en production Netlify) tant que Supabase n'est pas configure.
3. **Avec SUPABASE_URL + SUPABASE_SERVICE_KEY en plus**, la memoire devient
   reellement persistante en production. C'est la configuration recommandee
   pour un usage reel, et elle reste 100% gratuite dans les limites du plan
   Supabase Free ci-dessus.
4. **Le systeme ne pretend jamais qu'un quota est illimite.** Les erreurs de
   depassement de quota (HTTP 429 ou equivalent) sur Gemini/Groq/OpenRouter
   font basculer automatiquement vers le fournisseur suivant dans la
   chaine, puis vers Mock en dernier recours (voir `src/core/aiProvider.js`
   et `src/core/aiProviders.js`).
