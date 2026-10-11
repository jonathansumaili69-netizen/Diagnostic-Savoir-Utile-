# Vérification technique du checkpoint Tiny-SD

Date de consultation : 2026-10-11.

Source officielle : https://huggingface.co/segmind/tiny-sd
Configuration du dépôt : https://huggingface.co/segmind/tiny-sd/resolve/main/model_index.json
Métadonnées des fichiers (API Hub) : https://huggingface.co/api/models/segmind/tiny-sd/tree/main?recursive=true&expand=true

- La fiche annonce Diffusers et `StableDiffusionPipeline`; le modèle est étiqueté Text-to-Image.
- La fiche indique que Tiny-SD est distillé depuis `SG161222/Realistic_Vision_V4.0`. Ce n’est pas l’exécution du modèle original Realistic Vision.
- `model_index.json` déclare `_class_name: StableDiffusionPipeline`, scheduler DPM-Solver, encodeur CLIP, U-Net conditionné au texte et VAE.
- Somme des fichiers du dépôt au moment de la vérification : 1,063,162,548 octets (environ 1,06 Go), dont U-Net 646,923,637 octets, text encoder 246,187,869 octets et VAE 167,407,857 octets.
- Le worker de ce projet installe `diffusers==0.32.2`; ce runtime expose `StableDiffusionImg2ImgPipeline`. Une exécution locale img2img réelle est consignée séparément dans le commit de réparation et ses tests d’acceptation.
