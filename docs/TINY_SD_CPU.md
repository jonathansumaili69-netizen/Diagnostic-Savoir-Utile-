# Backend d’images IA gratuit sur CPU

Le profil strict peut utiliser `IMAGE_TEXT_TO_IMAGE_BACKEND=tiny_sd_cpu` pour générer une image **nouvelle** par scène avec les poids publics `segmind/tiny-sd`. Cette voie ne requiert ni `HF_TOKEN` ni appel à Hugging Face Inference Providers : le Worker télécharge anonymement les poids puis exécute Diffusers/PyTorch sur CPU. Le provider strict échoue explicitement si le runtime local ne fonctionne pas; il ne retombe ni sur une ancienne image, ni sur un provider payant.

## Modèle et droits

- Modèle : [`segmind/tiny-sd`](https://huggingface.co/segmind/tiny-sd), Stable Diffusion distillé, dérivé de Realistic Vision.
- Licence déclarée par sa carte : `creativeml-openrail-m` (CreativeML OpenRAIL-M), **pas Apache 2.0**. La licence accorde des droits sans redevance, y compris pour des usages commerciaux, sous réserve de ses restrictions d’utilisation; le titulaire reste responsable des outputs et de leur usage. Pour le texte de licence et l’Attachment A, voir [la licence OpenRAIL-M](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md).
- Pour une scène nommant Samuel ou Marc, le provider transmet à `StableDiffusionImg2ImgPipeline` le fichier primaire officiel sélectionné par le registre. Une scène duo utilise `assets/personnages/samuel-et-marc-ensemble.jpg`. Le script refuse tout chemin hors de `assets/personnages`, et le provider échoue si le reçu post-génération ne confirme pas le chemin exact demandé. Les scènes sans personnage officiel restent en text-to-image.
- La force img2img par défaut est `0.30`, configurable par `TINY_SD_IMG2IMG_STRENGTH` (strictement >0 et ≤1). La force basse privilégie le visage, la carnation et les vêtements, mais conserve davantage le cadrage de la référence; la force haute change plus la scène et entraîne une dérive d’identité observée. Un asset conditionné est marqué `AI_IMAGE_REFERENCED`; les deux types IA restent soumis aux exigences de hash distinct, URL durable et conformité des assets stricts.
- Les scènes nommant Samuel ou Marc incluent toujours leur description visuelle officielle, traits du visage, coiffure et tenue dans le prompt. Leur prompt négatif n’exclut pas les humains; les scènes sans personnage gardent cette exclusion. Le conditionnement réduit la dérive sans garantir une identité parfaite. Le contrôle pHash/couleur existant est uniquement un signal perceptuel, pas une reconnaissance biométrique : il a donné un faux PASS sur un Marc visiblement plus clair à force 0,58.
- Realistic Vision n’est pas un modèle installé/exécuté par ce dépôt au moment du diagnostic : le backend codé est `segmind/tiny-sd`, documenté comme dérivé de Realistic Vision. Le code ne constate pas de poids préinstallés et le worker les télécharge sur son runner à l’exécution.

## Exécution

Le workflow existant s’exécute sur `ubuntu-24.04`, runner standard public (4 CPU, 16 GB RAM), gratuit pour le dépôt public GitHub. Il installe une version CPU de PyTorch, Diffusers et Transformers. Tiny-SD produit nativement du `504×896` (9:16), à 25 steps; Sharp l’agrandit à `720×1280` avant stockage et montage.

Validation réelle dans le sandbox de réparation : PyTorch `2.6.0+cpu`, Diffusers `0.32.2`, Transformers `4.51.3`; checkpoint Tiny-SD téléchargé depuis Hugging Face : environ `1,06 Go`. Deux images de contrôle ont été produites à 6 steps en environ 40 s chacune, avec les images primaires Samuel et Marc réellement reçues par img2img. Les sorties sont des PNG valides en `504×896`; après inspection, Marc à force `0,58` dérivait visiblement (carnation/visage), alors qu’un essai à `0,30` conservait mieux son apparence. Enfin, deux images ont été générées avec le réglage par défaut (25 steps, force `0,30`) puis assemblées par le renderer réel en MP4 H.264/AAC de deux scènes, validé par ffprobe et le contrôle qualité vidéo. Ce montage de contrôle n’utilise ni stockage Supabase ni voix de production.

## Workflow

Le workflow existant est verrouillé sur `tiny_sd_cpu` : il ne propose aucun sélecteur HF, ne transmet aucun `HF_TOKEN` et n’appelle aucun endpoint d’inférence externe. Les clés Groq/Gemini/OpenRouter ne sont pas transmises au Worker de rendu. Pour les jobs stricts, tout backend autre que Tiny-SD CPU échoue fermé sans fallback.
