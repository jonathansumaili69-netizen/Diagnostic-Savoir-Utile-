# Ancien backend Tiny-SD CPU (hors routeur strict actuel)

> **Statut (9 octobre 2026)** : Tiny-SD reste dans le dépôt à titre de compatibilité historique, mais n’est plus sélectionné automatiquement ni autorisé par le profil strict. Le worker strict utilise maintenant `realistic_vision_lcm_cpu`; voir [REALISTIC_VISION_LCM.md](REALISTIC_VISION_LCM.md).


L’ancien provider pouvait utiliser `IMAGE_TEXT_TO_IMAGE_BACKEND=tiny_sd_cpu` pour générer une image **nouvelle** par scène avec les poids publics `segmind/tiny-sd`. Cette voie ne requiert ni `HF_TOKEN` ni appel à Hugging Face Inference Providers : le Worker télécharge anonymement les poids puis exécute Diffusers/PyTorch sur CPU. Le provider strict échoue explicitement si le runtime local ne fonctionne pas; il ne retombe ni sur une ancienne image, ni sur un provider payant.

## Modèle et droits

- Modèle : [`segmind/tiny-sd`](https://huggingface.co/segmind/tiny-sd), Stable Diffusion distillé, dérivé de Realistic Vision.
- Licence déclarée par sa carte : `creativeml-openrail-m` (CreativeML OpenRAIL-M), **pas Apache 2.0**. La licence accorde des droits sans redevance, y compris pour des usages commerciaux, sous réserve de ses restrictions d’utilisation; le titulaire reste responsable des outputs et de leur usage. Pour le texte de licence et l’Attachment A, voir [la licence OpenRAIL-M](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md).
- Les références d’image ne sont pas utilisées par ce provider (`reference_image_conditioning: false`). Chaque asset strict doit être classé `AI_IMAGE_GENERATED`, avoir un hash distinct et être stocké durablement avant que l’orchestrateur puisse poursuivre.

## Exécution

Le workflow existant s’exécute sur `ubuntu-24.04`, runner standard public (4 CPU, 16 GB RAM), gratuit pour le dépôt public GitHub. Il installe une version CPU de PyTorch, Diffusers et Transformers. Tiny-SD produit nativement du `504×896` (9:16), à 25 steps; Sharp l’agrandit à `720×1280` avant stockage et montage.

Mesure locale observée dans le Sandbox (2 CPU) : une génération réelle `504×896`, 25 steps, a pris `296,5 s`. L’extrapolation linéaire à 4 CPU donne environ `19,8 min` pour huit images; ce chiffre n’est qu’une estimation — le Worker conserve son timeout de 45 minutes et la vidéo n’est pas considérée terminée tant que tous ses contrôles ne passent pas.

## Workflow

Le workflow strict actuel est verrouillé sur `realistic_vision_lcm_cpu`; Tiny-SD n’est plus sélectionné automatiquement : il ne propose aucun sélecteur HF, ne transmet aucun `HF_TOKEN` et n’appelle aucun endpoint d’inférence externe. Les clés Groq/Gemini/OpenRouter ne sont pas transmises au Worker de rendu. Pour les jobs stricts, tout backend autre que Realistic Vision + LCM CPU échoue fermé sans fallback.
