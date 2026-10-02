# AI_PROVIDERS — recherche, classement et justification

Ce document repond aux sections 3-7 du prompt maitre V1.1 : identifier les
fournisseurs IA gratuits reellement exploitables, les classer de maniere
justifiee (pas de scores inventes), et documenter le routage.

Recherche effectuee par recherche web le 10 aout 2026. Les quotas gratuits
changent frequemment : revoir ce document periodiquement.

## Fournisseurs retenus (par ordre de priorite par defaut)

### 1. Google Gemini — `gemini-2.5-flash`

- **Cout** : gratuit (Google AI Studio)
- **Quota** : ~10-15 requetes/minute, quota journalier variable selon le modele
- **Contexte** : tres large, jusqu'a environ 1 million de tokens selon le modele — le plus grand du groupe
- **Carte bancaire requise** : non
- **Compatible serverless/Netlify** : oui (simple appel HTTPS REST)
- **Pourquoi priorite 1** : meilleur equilibre global entre qualite de raisonnement, taille de contexte et fiabilite d'infrastructure (Google). Le point faible est le quota par minute, modeste face a Groq.
- **Attention** : `gemini-2.0-flash` a ete retire le 3 mars 2026. Le nom de modele est configurable via `GEMINI_MODEL` pour absorber un futur changement sans toucher au code.

### 2. Groq — `llama-3.3-70b-versatile`

- **Cout** : gratuit (Groq Cloud)
- **Quota** : ~30 requetes/minute, quota de tokens/jour variable selon le modele
- **Contexte** : correct pour un modele open-weight generaliste (Llama 3.3 70B), plus limite que Gemini
- **Carte bancaire requise** : non
- **Compatible serverless/Netlify** : oui (API compatible OpenAI)
- **Pourquoi priorite 2** : de tres loin le plus rapide du groupe (materiel d'inference dedie LPU), fiabilite de service correcte. Sert de filet de vitesse quand Gemini est sature ou en quota depasse.

### 3. OpenRouter — modeles `:free` (defaut : `meta-llama/llama-3.3-70b-instruct:free`)

- **Cout** : gratuit pour les modeles suffixes `:free`
- **Quota** : 20 requetes/minute, 50 requetes/JOUR sans achat de credits (1000/jour apres un achat unique de 10$, credits qui n'expirent pas) — le quota journalier le plus restrictif des trois fournisseurs reels
- **Contexte** : variable selon le modele actif (le roster gratuit tourne dans le temps ; plusieurs sources independantes confirment des retraits de modeles sans preavis)
- **Carte bancaire requise** : non pour les modeles `:free`
- **Compatible serverless/Netlify** : oui (API compatible OpenAI, `https://openrouter.ai/api/v1`)
- **Pourquoi priorite 3 (dernier fournisseur reel avant Mock)** : utile comme troisieme filet de securite gratuit sans creer de nouvelle dependance lourde, mais documente par ses propres sources comme "best-effort" (pas de garantie de disponibilite en production). Le nom du modele est configurable via `OPENROUTER_MODEL` car le roster gratuit change regulierement — verifier `https://openrouter.ai/models?max_price=0` avant un usage intensif.

### 4. Mock — reserve locale (`mock-v1`)

- **Cout** : gratuit, aucun appel reseau
- **Quota** : illimite
- **Pourquoi toujours en dernier recours** : ne produit aucune vraie generation IA (reponse structuree deterministe). Garantit que le systeme ne plante jamais, meme si les trois fournisseurs precedents sont simultanement indisponibles ou non configures. Le systeme etiquette toujours explicitement une reponse Mock (`provider: "mock"`, `[MODE MOCK]` dans le texte) — jamais presentee comme une vraie generation IA.

## Classement justifie (echelle qualitative 1-5, pas de faux score numerique)

| Fournisseur | Raisonnement | Vitesse | Fiabilite | Contexte | Quota gratuit | Disponibilite |
|---|---|---|---|---|---|---|
| Gemini | 4 | 3 | 4 | 5 | 3 | 4 |
| Groq | 3 | 5 | 4 | 3 | 3 | 4 |
| OpenRouter | 3 | 3 | 2 | 3 | 2 | 3 |
| Mock | 1 | 5 | 5 | 1 | 5 | 5 |

Ces scores sont geres dans `src/core/aiProviders.js` (`PROVIDER_DEFINITIONS`) avec, pour chacun, une justification textuelle complete — jamais un chiffre sans explication. Voir aussi `GET /api/ai-providers` pour l'etat live (statut, derniere erreur, dernier appel) en plus de ces scores fixes.

## Routage intelligent par profil de tache

`src/core/aiProviders.js` expose `TASK_PROFILES`, utilise par `aiProvider.generate({ profile })` :

| Profil | Chaine (avant Mock) | Justification |
|---|---|---|
| `reasoning` (analyse complexe) | Gemini -> Groq -> OpenRouter | Gemini offre le meilleur raisonnement + le plus grand contexte |
| `fast` (generation rapide/volume) | Groq -> Gemini -> OpenRouter | Groq est le plus rapide de tres loin (materiel dedie) |
| `long_context` | Gemini -> Groq -> OpenRouter | Gemini a le contexte le plus large |
| `simple` (tache legere) | OpenRouter -> Groq -> Gemini | Economise les fournisseurs les plus utiles pour plus tard sur les taches peu exigeantes |
| (aucun profil precise) | Gemini -> Groq -> OpenRouter | Ordre par defaut demande explicitement pour ce projet |

Mock cloture systematiquement chaque chaine, quel que soit le profil.

## Fournisseurs evalues et ECARTES (avec raison precise)

### Cerebras Cloud

Sources contradictoires en aout 2026 : plusieurs guides tiers annoncent "1M tokens/jour gratuit, aucune carte requise", mais une source correspondant a la documentation officielle de Cerebras indique explicitement qu'un "Free Trial" necessite une carte bancaire enregistree et expire (bascule ensuite vers un mode payant a la premiere utilisation de credits). Face a cette contradiction directe sur un point critique (carte bancaire obligatoire ou non), et conformement a la regle "ne jamais pretendre qu'une API est gratuite si elle ne l'est pas reellement", Cerebras est ecarte de l'integration par defaut. A reevaluer si la documentation officielle Cerebras clarifie ce point.

### Mistral AI (La Plateforme, palier "Experiment")

Reellement gratuit et sans carte bancaire, confirme par plusieurs sources convergentes. Cependant, Mistral documente lui-meme ce palier comme reserve a l'evaluation et au prototypage ("not for production"), et ne publie pas de limites de requetes precises (renvoie vers "Admin Console -> Limits", non verifiable a l'avance). Trop imprevisible pour un moteur de production automatise, meme gratuit. Reste une option manuelle raisonnable si un utilisateur souhaite l'ajouter lui-meme (l'architecture en couches d'abstraction le permet facilement, voir "Ajouter un fournisseur" ci-dessous).

## Ajouter un nouveau fournisseur (extensibilite)

1. Ajouter une fonction `callXxx()` dans `src/core/aiProvider.js` suivant le meme contrat que `callGroq`/`callGemini`/`callOpenRouter` (retourne `{ text, provider, model, raw }`, leve une `AIProviderError` si la cle manque ou si l'appel echoue).
2. L'ajouter a `PROVIDER_FUNCTIONS` dans le meme fichier.
3. Ajouter sa definition (scores justifies, quota, cout) dans `PROVIDER_DEFINITIONS` de `src/core/aiProviders.js`.
4. L'inserer dans l'ordre voulu dans `TASK_PROFILES`.
5. Documenter ses limites gratuites ici et dans `docs/LIMITES.md`.
6. Ajouter sa cle dans `.env.example`.

Aucune autre partie du systeme n'a besoin d'etre modifiee : agents, taskEngine, dashboard et tests restent inchanges (le dashboard lit `GET /api/ai-providers`, qui reflete automatiquement tout nouveau fournisseur ajoute au registre).

## Robustesse (V1.1 - boost pass)

- **Timeout** (`AI_PROVIDER_TIMEOUT_MS`, 25s par defaut) par fournisseur, via `AbortController`.
- **Retry controle** (`AI_PROVIDER_MAX_RETRIES`, 1 par defaut) : uniquement pour les erreurs classees `timeout` ou `erreur_reseau` (voir `classifyError()` dans `src/core/aiProvider.js`) ; jamais pour `quota_depasse` ou `non_configure`, ou un retry immediat n'aiderait pas.
- **Circuit breaker** (`AI_CIRCUIT_BREAKER_THRESHOLD`, 3 echecs consecutifs par defaut ; `AI_CIRCUIT_BREAKER_COOLDOWN_MS`, 60s par defaut) : protege contre les boucles de fallback inutiles en mettant en pause un fournisseur en echec repete, sans jamais appeler reellement le reseau tant que le circuit est ouvert. Se referme automatiquement a l'expiration du cooldown, ou immediatement apres un succes manuel (`aiProviders.recordAttempt(id, { success: true })`).
- **Desactivation manuelle** : `aiProviders.setManuallyDisabled(id, true, raison)` — jamais possible sur `mock`, qui reste le dernier recours absolu et increvable.
- **Observabilite** : chaque tentative (y compris celles sautees par le circuit breaker) alimente `GET /api/ai-providers` (compteurs, derniere erreur classifiee, circuit ouvert jusqu'a quand) et le journal d'execution des taches (`fournisseur_ia` dans `executions`).

Ces mecanismes sont entierement additifs : ils n'ont pas modifie l'ordre de fallback (`Gemini -> Groq -> OpenRouter -> Mock`), ni le contrat de `aiProvider.generate()` pour les appelants existants.
