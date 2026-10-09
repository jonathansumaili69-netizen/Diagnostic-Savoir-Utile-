# Profil d’images Realistic Vision + LCM (CPU local)

**Branche d’intégration :** `agent/rv-lcm-routing-video`  
**État :** intégré au profil strict, sans déploiement ni modification de `main`.

## Route effective

Le routeur n’évalue que les **erreurs techniques**. Chaque variante s’exécute séquentiellement dans un processus Python distinct; ainsi, un processus OOM ou interrompu par son délai est terminé avant le chargement suivant. Une image techniquement valide termine la chaîne; la qualité visuelle reste une revue distincte et n’est jamais inférée de l’absence d’exception.

| Ordre | Identifiant interne | Base, revision HF exacte | LoRA, revision exacte | Pas | Guidance | Scheduler | Sortie modèle |
|---|---|---|---|---:|---:|---|---|
| 1 | `rv4-lcm8` | `SG161222/Realistic_Vision_V4.0_noVAE` — `1685907c0283c7278ba26c5fe561506f564b48d3` | `latent-consistency/lcm-lora-sdv1-5` — `cf2fced511dbe7e26c8d1d397e728fbab875db4b` | 8 | 1.5 | `LCMScheduler` | 504×896 |
| 2 | `rv4-lcm6` | même base et revision canonique V4 | même LoRA et revision | 6 | 1.5 | `LCMScheduler` | 504×896 |
| 3 | `rv51-lcm4` | `SG161222/Realistic_Vision_V5.1_noVAE` — `1e9f017a7b1eaefb63a1900ea6c5953d2739fd21` | même LoRA et revision | 4 | 1.5 | `LCMScheduler` | 504×896 |

Le VAE est chargé depuis le composant `vae/` des dépôts Diffusers épinglés; V5.1 recommande en outre dans sa fiche l’usage d’un VAE pour améliorer le rendu. La sortie 504×896 correspond à la taille du benchmark réel; Sharp la convertit ensuite au format de rendu demandé (généralement 720×1280) afin d’éviter la hausse de mémoire d’une diffusion native plus grande.

**Tiny-SD n’est pas autorisé dans le profil strict.** Pas d’ajout de quatrième modèle ni d’appel à un endpoint d’inférence. Les téléchargements HF sont anonymes; aucun token n’est transmis au sous-processus.

## Provenance et licences observées

- Les fiches officielles Hugging Face des deux bases indiquent `creativeml-openrail-m` (CreativeML OpenRAIL-M); la révision V4 épinglée a été vérifiée par l’API Hub. Ce V4 canonique n’est pas le miroir `stablediffusionapi/realistic-vision-v40` du benchmark : les résultats de ce dernier ne prouvent pas la qualité précise des poids canoniques V4.
- La fiche du LoRA indique littéralement le tag `openrail++` et décrit un adaptateur SD1.5 utilisable avec `LCMScheduler` en 2–8 pas et guidance 0 ou 1–2.
- Les deux licences déclarées autorisent des usages sans redevance sous leurs restrictions d’usage; ce résumé n’est pas un avis juridique. Respecter les restrictions, avis et conditions de redistribution des poids. Crédits de prudence : SG161222 / Realistic Vision; latent-consistency / LCM-LoRA.
- Sources primaires : [RV V4 officiel](https://huggingface.co/SG161222/Realistic_Vision_V4.0_noVAE), [RV V5.1 officiel](https://huggingface.co/SG161222/Realistic_Vision_V5.1_noVAE), [LCM-LoRA SD1.5](https://huggingface.co/latent-consistency/lcm-lora-sdv1-5), [CreativeML OpenRAIL-M](https://github.com/CompVis/stable-diffusion/blob/main/LICENSE), [OpenRAIL++-M](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md).

## Personnages officiels et références

Le registre existant a été confirmé. Il n’est pas modifié et aucun provider payant de référence n’est activé. Le générateur Realistic Vision est **texte-vers-image seulement** (`reference_image_conditioning: false`); le code ne lui transmet pas d’images de référence. Pour les scènes Samuel/Marc dans la chaîne non stricte, Conquistador conserve le repli `existing_asset`, c’est-à-dire les images officielles exactes, avec mise en scène fixe. La cohérence d’une nouvelle pose de ces personnages n’est donc pas revendiquée.

- Samuel : `assets/personnages/samuel/samuel-reference-principale.jpeg`, SHA-256 `ef4a1704941de4e6f2085725859db0a3273a35e622f44cfdb2ad8d93ea56d252`.
- Marc : `assets/personnages/marc/marc-reference-principale.jpg`, SHA-256 `8c38e2baa720e57bd7f6fd025284848f1d42bd3d4cd8a7bb363e66e12966f354`.
- Le MP4 final utilise les références secondaires officielles exactes : Samuel `assets/personnages/samuel/refs/ref-samuel-SAVE_20260920_165721.jpg`, SHA-256 `a86bbd1863e40624e924ba206bf0ba50dcb74026191fd24db2522f931c9c7057`; Marc `assets/personnages/marc/refs/ref-marc-SAVE_20260920_165637.jpg`, SHA-256 `7fe83f07dfff971590613d211e1895df251528f1a4e5befb5b7b777bdc4a3fc1`. Les deux correspondent au registre; ces portraits de contexte préservent leur identité et évitent de fabriquer une nouvelle pose.

Le provider `character_reference` existant transmet réellement les références seulement si un service image-to-image et sa clé sont configurés; dans cet environnement ils ne le sont pas. Ne pas connecter une API payante sans décision et budget séparés. L’image de preuve `route-real-generation.png` a été inspectée : bureau lumineux, carnet vierge, tasse, aucun texte lisible ni personne non officielle; le PNG est intègre et son SHA-256 est `02deaac1729c7fb8edcb576cca240cb5bd6e24051c4813b31eace65db3522721`.

## Coût, ressources, cache et limites d’exécution

- Inference locale CPU, dépendances ouvertes et poids publics; aucun appel API d’image payant. L’installation requise est PyTorch CPU 2.6.0, Diffusers 0.32.2, Transformers 4.51.3, Accelerate 1.6.0, PEFT 0.14.0, safetensors et Pillow.
- Le cache Hugging Face garde les poids dans le runner pendant le job. GitHub-hosted runners étant éphémères, les poids seront à nouveau téléchargés sur les prochains jobs; le worker ne relance pas de téléchargement distinct pour les scènes si les snapshots sont déjà dans son cache local.
- Le workflow conserve le kill switch, les quotas, l’approbation, l’idempotence, les contrôles de doublons/qualité, et la concurrence sérialisée existants. Le `VOICE_STUDIO_API_URL` et Supabase ne sont pas configurés dans cet environnement local.

## Voix, job et vidéo

Voice Studio, vérifié via l’interface existante, est indisponible ici : `VOICE_STUDIO_API_URL non configurée`. Le contournement direct Edge TTS gratuit avec `fr-FR-RemyMultilingualNeural` a produit trois segments MP3 utilisables. Il ne s’agit **pas** du serveur Voice Studio configuré de l’application, et les droits d’usage commercial du service Edge Read Aloud restent à confirmer séparément.

Un vrai job durable dans Conquistador n’a pas pu être créé/achevé dans ce sandbox, car `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` et `VOICE_STUDIO_API_URL` sont absents. Le rendu du renderer et FFmpeg existe toutefois localement : `conquistador-demo-realistic-vision-lcm.mp4`, 26,6 s, 3 scènes, H.264/AAC, 720×1280, 30 fps, 964 024 octets, voix Edge TTS, 12 segments de sous-titres gravés, mouvement Ken Burns, coupes propres. SHA-256 du MP4 : `0c2bf1c5e5477aa3793b00f062e6aa63146c5b8e86589f07fbb5d5586cd86c33`. `video-qc.json` enregistre tous les contrôles requis comme passés; l’analyse de silence à −42 dB ne trouve aucun silence ≥2,5 s. C’est un **MP4 réel et contrôlé**, mais pas la preuve d’un job Supabase `COMPLETED`, d’un upload durable ou d’une approbation du profil strict.

## Tests

`npm test` : succès complet, code de sortie 0 — 462 tests répartis sur 57 résumés de fichiers, zéro échec — après migration des tests de profil strict. `tests/realisticVisionLcmCpuProvider.test.js` couvre l’ordre, l’arrêt au succès technique, les échecs timeout/OOM/fichier invalide, le refus du backend Tiny-SD, et les hashes officiels Samuel/Marc. La variante 1 `rv4-lcm8` a également réellement réussi (79,36 s, sans fallback); taille du PNG 504×896; pic RSS agrégé mesuré du worker Node+Python ≈6 090 MiB. Les tests unitaires simulent les erreurs; cette génération réelle n’a pas exécuté les trois variantes parce que la première a réussi.
