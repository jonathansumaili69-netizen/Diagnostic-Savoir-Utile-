# Limites gratuites des services utilises

Conformement a la section 31 du prompt maitre. Modèles et prix LLM vérifiés
le 4 octobre 2026 ; les quotas gratuits changent et doivent être revérifiés.

| Service | Cout | Limites du palier gratuit | Obligatoire ? |
|---|---|---|---|
| **Netlify (Free)** | 0$ | Modele a credits depuis 2025-2026 : 300 credits/mois partages entre bande passante (20 credits/Go), deploiements (15 credits/deploiement), et calcul des fonctions (10 credits/Go-heure). Fonctions synchrones limitees a 10 secondes d'execution sur ce palier. Quand les credits sont epuises, les fonctions s'arretent jusqu'au mois suivant. | Oui (c'est la plateforme d'hebergement cible) |
| **Google Gemini API (palier Free)** | 0$ pour `gemini-3.5-flash-lite` selon le tableau officiel | Prix d'entrée/sortie « Free of charge » avec quotas de modèle/compte/région variables; vérifier [pricing officiel](https://ai.google.dev/gemini-api/docs/pricing). Modèle par défaut : `gemini-3.5-flash-lite`. | Non (route gratuite prioritaire; le palier peut limiter des requêtes) |
| **Groq** | Payant pour le modèle actif `openai/gpt-oss-120b`: 0,15 $/M tokens entrée, 0,60 $/M sortie selon le catalogue | Pas considéré gratuit. `llama-3.3-70b-versatile` est retiré du palier Developer. Une clé seule ne permet pas d'appeler Groq : opt-in `GROQ_ALLOW_PAID=true` requis; profil vidéo strict l'exclut. | Non, désactivé par défaut |
| **OpenRouter (modèles `:free`)** | 0$ pour un modèle listé avec prix d'entrée/sortie nuls | Modèle par défaut vérifié dans le catalogue public : `qwen/qwen3.8-27b:free`. Roster, quotas et disponibilité évolutifs; aucun achat de crédits n'est effectué par le profil strict. | Non (repli gratuit après Gemini; si indisponible, profil strict échoue au lieu de payer ou de faire semblant) |
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
2. **Avec une clé Gemini ou OpenRouter active**, les agents peuvent produire
   de vraies générations IA. Groq nécessite l'opt-in payant explicite
   `GROQ_ALLOW_PAID=true` et le profil vidéo strict ne l'utilise jamais,
   mais la memoire reste en JSON local (fiable en developpement, pas
   garantie en production Netlify) tant que Supabase n'est pas configure.
3. **Avec SUPABASE_URL + SUPABASE_SERVICE_KEY en plus**, la memoire devient
   reellement persistante en production. C'est la configuration recommandee
   pour un usage reel, et elle reste 100% gratuite dans les limites du plan
   Supabase Free ci-dessus.
4. **Le système ne prétend jamais qu'un quota est illimité.** Le profil vidéo
   strict n'utilise que les modèles gratuits sélectionnés Gemini/OpenRouter;
   si tous échouent, son garde-fou refuse Mock et marque le job `FAILED`.
   Les autres profils ignorent également Groq sans opt-in payant.
