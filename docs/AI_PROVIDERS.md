# AI_PROVIDERS — modèles, coût et routage

Vérification des catalogues et prix officiels effectuée le **4 octobre 2026**. Les noms, quotas et paliers gratuits des fournisseurs changent : vérifier les sources ci-dessous avant toute mise à jour. Conquistador distingue une route documentée gratuite d'une route facturable et n'étiquette jamais Mock comme génération externe.

## Modèles retenus

### 1. Google Gemini — `gemini-3.5-flash-lite`

- **Coût vérifié** : le tableau Google affiche les entrées et sorties du palier Free « Free of charge »; le palier et ses quotas restent soumis aux limites de compte/région.
- **Disponibilité** : identifiant stable publié dans le catalogue officiel. Google indique que certains modèles 2.5 sont réservés aux comptes les ayant déjà utilisés; les nouveaux projets sont orientés vers les modèles récents.
- **Intégration** : endpoint REST `generateContent`, compatible avec l'adaptateur actuel de Conquistador.
- **Sources** : [tarification Gemini](https://ai.google.dev/gemini-api/docs/pricing), [catalogue des modèles](https://ai.google.dev/gemini-api/docs/models), [notes d'accès et de versions](https://ai.google.dev/gemini-api/docs/changelog).

### 2. OpenRouter — `qwen/qwen3.8-27b:free`

- **Coût vérifié** : le catalogue public OpenRouter retourne actuellement un prix d'entrée et de sortie nul pour ce slug `:free`; pas d'achat de crédits dans ce test.
- **Disponibilité** : confirmé dans le catalogue public le 4 octobre 2026. Le roster gratuit est best-effort, les quotas sont finis et le modèle peut être retiré ou limité.
- **Intégration** : API compatible OpenAI déjà prise en charge par Conquistador.
- **Source** : [catalogue public API des modèles](https://openrouter.ai/api/v1/models) et [liste des modèles à prix nul](https://openrouter.ai/models?max_price=0).

### 3. Groq — `openai/gpt-oss-120b` (payant, opt-in)

- **Coût vérifié** : tarif publié au moment de la vérification : **0,15 $/million de tokens en entrée et 0,60 $/million en sortie**; ce n'est pas un modèle gratuit.
- **Protection** : `GROQ_ALLOW_PAID` est `false` par défaut. Une clé seule ne déclenche aucun appel. Passer à `true` constitue un opt-in explicite de l'administrateur à la facturation. Le profil vidéo strict exclut Groq même après opt-in.
- **Dépréciation** : `llama-3.3-70b-versatile` n'est plus disponible pour le palier Developer; Groq recommande `openai/gpt-oss-120b` ou `qwen/qwen3.6-27b` comme remplaçants.
- **Sources** : [catalogue et prix Groq](https://console.groq.com/docs/models), [dépréciations officielles](https://console.groq.com/docs/deprecations).

### Mock — `mock-v1`

Aucun appel réseau, mais **aucune génération IA réelle**. C'est un secours transparent pour les usages ordinaires. Le profil vidéo strict rejette sa réponse et échoue honnêtement si aucun modèle réel à coût nul n'est disponible.

## Routage

| Profil | Fournisseurs tentés dans l'ordre | Règle de coût |
|---|---|---|
| `strict_video` | Gemini → OpenRouter → Mock | Gemini 3.5 Flash-Lite et le slug OpenRouter `:free` uniquement; Groq exclu; Mock rejeté par l'orchestrateur strict |
| `reasoning`, `long_context`, défaut | Gemini → Groq → OpenRouter → Mock | Groq est sauté sans appel réseau tant que `GROQ_ALLOW_PAID=false` |
| `fast` | Groq → Gemini → OpenRouter → Mock | Même garde-fou opt-in Groq |
| `simple` | OpenRouter → Groq → Gemini → Mock | Même garde-fou opt-in Groq |

Le profil `strict_video` est transmis par l'agent `fullVideo` lorsqu'un job demande `strict_multiscene`. La sortie conserve `provider` et `model`; si le fournisseur retourne Mock, le job échoue avant de créer des scènes ou des médias. Les quotas gratuits peuvent être épuisés : dans ce cas, l'application ne contourne pas la limite par un appel payant, elle essaie l'autre route gratuite puis s'arrête si nécessaire.

## Limites vérifiées et changement de modèle

- Ne jamais déduire la gratuité de la présence d'une clé. Lire le tarif du modèle exact et la route réellement utilisée.
- Les comptes Gemini gratuits ne disposent que d'un sous-ensemble de modèles; l'accès et les quotas peuvent varier. Le catalogue/pricing officiel est la référence.
- OpenRouter `:free` signifie tarif nul dans le catalogue au moment du contrôle, pas disponibilité garantie ni quota illimité.
- Groq facture le modèle actif retenu; toute activation requiert `GROQ_ALLOW_PAID=true` hors profil strict.
- Les modèles `gemini-2.5-flash`, `llama-3.3-70b-versatile` et `meta-llama/llama-3.3-70b-instruct:free` ne sont plus les valeurs par défaut : leurs appels réels ont retourné 404 le 4 octobre 2026.

## Ajouter ou changer un fournisseur

1. Vérifier son identifiant et sa tâche dans le catalogue officiel.
2. Vérifier la tarification exacte, le palier gratuit et les limites sans supposer qu'une clé équivaut à un accès gratuit.
3. Implémenter l'adaptateur avec timeout et erreurs assainies, sans journaliser une clé.
4. Ajouter une entrée `PROVIDER_DEFINITIONS` et un profil si nécessaire.
5. Ajouter des tests de routage, de refus du mode Mock en production stricte et d'absence d'appel payant sans opt-in.
6. Mettre à jour `.env.example`, `docs/LIMITES.md` et la checklist Netlify.

## Robustesse conservée

- **Timeout** (`AI_PROVIDER_TIMEOUT_MS`, 25 s par défaut) par fournisseur.
- **Retry contrôlé** (`AI_PROVIDER_MAX_RETRIES`, 1 par défaut) uniquement sur timeout ou erreur réseau.
- **Circuit breaker** après plusieurs erreurs consécutives.
- **État observable** via `GET /api/ai-providers`; aucun secret n'est inclus.
