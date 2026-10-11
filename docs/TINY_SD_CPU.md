# Backend d’images IA gratuit sur CPU

Le profil strict peut utiliser `IMAGE_TEXT_TO_IMAGE_BACKEND=tiny_sd_cpu` pour générer une image **nouvelle** par scène avec les poids publics `segmind/tiny-sd`. Cette voie ne requiert ni `HF_TOKEN` ni appel à Hugging Face Inference Providers : le Worker télécharge anonymement les poids puis exécute Diffusers/PyTorch sur CPU. Le provider strict échoue explicitement si le runtime local ne fonctionne pas; il ne retombe ni sur une ancienne image, ni sur un provider payant.

## Modèle et droits

- Modèle : [`segmind/tiny-sd`](https://huggingface.co/segmind/tiny-sd), Stable Diffusion distillé, dérivé de Realistic Vision.
- Licence déclarée par sa carte : `creativeml-openrail-m` (CreativeML OpenRAIL-M), **pas Apache 2.0**. La licence accorde des droits sans redevance, y compris pour des usages commerciaux, sous réserve de ses restrictions d’utilisation; le titulaire reste responsable des outputs et de leur usage. Pour le texte de licence et l’Attachment A, voir [la licence OpenRAIL-M](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md).
- Les références d’image ne sont pas utilisées par ce provider (`reference_image_conditioning: false`). Chaque asset strict doit être classé `AI_IMAGE_GENERATED`, avoir un hash distinct et être stocké durablement avant que l’orchestrateur puisse poursuivre.
- Les scènes nommant Samuel ou Marc incluent désormais leur description visuelle officielle, leurs traits du visage, coiffure et tenue dans le prompt. Leur prompt négatif n’exclut plus `people`, `human` ni les visages; les scènes sans personnage officiel gardent cette exclusion. Cela supprime un blocage de rendu, mais **ne remplace pas** le conditionnement avec les images de référence et ne garantit pas l’identité visuelle.
- Realistic Vision n’est pas un modèle installé/exécuté par ce dépôt au moment du diagnostic : le backend codé est `segmind/tiny-sd`, documenté comme dérivé de Realistic Vision. Le code ne constate pas de poids préinstallés et le worker les télécharge sur son runner à l’exécution.

## Exécution

Le workflow existant s’exécute sur `ubuntu-24.04`, runner standard public (4 CPU, 16 GB RAM), gratuit pour le dépôt public GitHub. Il installe une version CPU de PyTorch, Diffusers et Transformers. Tiny-SD produit nativement du `504×896` (9:16), à 25 steps; Sharp l’agrandit à `720×1280` avant stockage et montage.

Mesure précédemment rapportée dans le dépôt : une génération `504×896`, 25 steps, a pris `296,5 s` dans un Sandbox à 2 CPU. Cette valeur n’a pas été reproduite pendant la présente réparation; l’extrapolation à huit scènes n’est qu’une estimation. Dans le sandbox de cette réparation, aucun poids Realistic Vision/Tiny-SD ni PyTorch/Diffusers n’est présent : une inférence locale réelle n’a donc pas été exécutée.

## Workflow

Le workflow existant est verrouillé sur `tiny_sd_cpu` : il ne propose aucun sélecteur HF, ne transmet aucun `HF_TOKEN` et n’appelle aucun endpoint d’inférence externe. Les clés Groq/Gemini/OpenRouter ne sont pas transmises au Worker de rendu. Pour les jobs stricts, tout backend autre que Tiny-SD CPU échoue fermé sans fallback.
