# Sélection du modèle d’image Hugging Face — Conquistador OS

**Vérification effectuée : 4 octobre 2026.** Les disponibilités de providers et tarifs étant susceptibles d’évoluer, les fiches HF/Fal liées ci-dessous restent la source d’autorité.

## Décision

| Élément | Choix de production |
|---|---|
| Modèle | `black-forest-labs/FLUX.1-schnell` |
| Provider routé par Hugging Face | `fal-ai` |
| Tâche HF | Text-to-image (`text-to-image`), état provider `live` lors de la vérification |
| Licence du modèle | Apache 2.0 |
| Usage commercial | **Oui**, explicitement permis dans la fiche officielle du modèle |
| Prix Fal au moment de la vérification | **0,003 $/MP**, facturation arrondie au mégapixel supérieur; pas de minimum ni d’abonnement. C’est le tarif Fal publié; le montant débité/crédité par le routage HF peut varier. |
| Coût estimé de 8 images 720×1280 | 8 × 1 MP facturé × 0,003 $ = **0,024 $**, hors éventuels changements de prix/taxes |
| Crédit HF gratuit | **0,10 $/mois** pour les comptes gratuits selon la documentation HF; montant soumis à changement et partagé avec l’usage du compte. Au-delà, des crédits doivent être achetés; ce n’est pas une gratuité illimitée. |
| Référence image via la tâche HF publiée | Non exposée dans le mapping HF `FLUX.1-schnell` vérifié; le profil strict ne prétend donc pas maintenir l’identité par image de référence. Il utilise des prompts et un style communs. |

Liens : [fiche modèle FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell), [mapping public HF des providers](https://huggingface.co/api/models/black-forest-labs/FLUX.1-schnell?expand%5B%5D=inferenceProviderMapping), [tarif Fal](https://fal.ai/models/fal-ai/flux/schnell), [tarification HF Inference Providers](https://huggingface.co/docs/inference-providers/en/pricing).

## Options comparées

| Modèle | Provider HF réellement `live` | Licence/usage commercial | Coût/documentation provider | Référence image | Évaluation |
|---|---|---|---|---|---|
| `black-forest-labs/FLUX.1-schnell` | `fal-ai`, `nscale`, `wavespeed` (text-to-image) | Apache 2.0; commercial autorisé | Fal : 0,003 $/MP arrondi au MP | Pas dans le mapping HF text-to-image vérifié | **Choix** : qualité élevée, rapide (1–4 étapes), commercial et suffisamment peu coûteux pour le test à 8 scènes dans le crédit HF mensuel standard, si celui-ci est disponible. |
| `Qwen/Qwen-Image` | `fal-ai`, `replicate`, `wavespeed` (text-to-image) | Apache 2.0; commercial autorisé | Fal : 0,02 $/MP arrondi au MP | Modèle T2I; édition/reference est une tâche distincte | Qualité élevée, mais l’estimation de 8 images verticales est d’environ 0,16 $, supérieure au crédit mensuel gratuit de 0,10 $. Non retenu pour éviter de présenter un usage potentiellement payant comme gratuit. |
| `Qwen/Qwen-Image-Edit-2511` | `fal-ai`, `wavespeed` (image-to-image) | Apache 2.0 selon sa fiche; commercial autorisé | Fal : 0,03 $/MP arrondi au MP | Oui, édition conditionnée par image de référence | Meilleure option de cette comparaison pour la continuité par référence, mais 7 éditions plus une première génération dépasseraient vraisemblablement le crédit mensuel gratuit; conserver comme option explicitement payante, pas dans ce profil strict. |

Les mappings ont été lus dans l’API publique Hugging Face `inferenceProviderMapping`; les entrées `status:error` ne sont pas comptées comme disponibles. Sources : [Qwen Image](https://huggingface.co/Qwen/Qwen-Image), [Qwen Image Edit 2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511), [Fal Qwen Image](https://fal.ai/models/fal-ai/qwen-image), [Fal Qwen Image Edit 2511](https://fal.ai/models/fal-ai/qwen-image-edit-2511).

## Comportement du profil `strict_multiscene`

- Toutes les scènes passent par un appel réel HF `textToImage` avec le modèle sélectionné et le token conservé côté serveur.
- Aucune utilisation du cache, `existing_asset`, du fournisseur Pollinations, du moteur graphique ou d’un placeholder comme résultat de scène.
- Le texte doit venir d’un provider LLM réel; le profil strict refuse `mock`/fallback. Il vise 8 scènes faceless, chaque narration faisant partie du script.
- Échec HF, image non valide, doublon binaire, stockage Supabase impossible, voix absente, sous-titres incomplets ou contrôle vidéo échoué ⇒ job **FAILED**, jamais `COMPLETED`.
- Chaque image acceptée possède un événement de log `AI_IMAGE_GENERATED`, un SHA-256 et une référence Supabase distincts. Les événements `EXISTING_ASSET` et `FALLBACK` sont explicitement différenciés pour les chemins non stricts.
- L’image générée est redimensionnée en PNG 720×1280 après la génération, pour aligner la sortie sur le canevas vertical du rendu.
- Le renderer anime chaque visuel par un zoom Ken Burns lent et assemble les scènes par coupes nettes; cela évite une seule image immobile, sans altérer les bornes audio/sous-titres.
- Chaque piste Rémy est décodée et vérifiée contre les silences continus de 2,5 s ou plus avant rendu.

## Limites

1. Le crédit HF de 0,10 $ est individuel, mensuel, potentiellement déjà consommé par d’autres usages, et HF le dit sujet à changement. Il n’y a donc aucune garantie qu’un appel passe sans achat de crédits.
2. Les 0,024 $ pour huit images sont une estimation au tarif Fal public de la date de vérification, avant taxes ou différences de routage HF; vérifier le solde et le tarif affiché par HF avant toute production payante.
3. Le profil strict utilise la génération T2I et le style/palette communs; il ne revendique pas de conditionnement par l’image précédente avec FLUX.1-schnell via la route HF vérifiée.
4. La génération de la vidéo complète dépend aussi de `HF_TOKEN`, des secrets Supabase, de la disponibilité du studio Rémy Neural et du worker FFmpeg. Ces secrets ne doivent jamais être exposés dans ce document, les journaux ou le frontend.
