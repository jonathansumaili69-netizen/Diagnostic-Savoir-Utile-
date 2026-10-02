# Référence qualité — Vidéo 6 (Savoir Utile)

⚠️ **Correction (28 août 2026)** : une version précédente de ce document
affirmait qu'une transcription vocale avait été réalisée et que le CTA final
disait « Écrivez GUIDE en commentaire ». Après re-vérification directe des
images extraites de la vidéo, aucun outil de transcription n'a en réalité été
utilisé, et le texte réellement affiché à l'écran est **« écrivez GUIDE EN
PRIVÉ »** (message privé, pas un commentaire public) — cohérent avec le
mécanisme déjà implémenté dans `commercial.js` qui priorise le canal DM.
L'analyse complète, vérifiée image par image et par mesures audio objectives
(silences, volume, spectrogramme), se trouve dans
`docs/REFERENCE_VIDEO_6_ANALYSE.md` : ce fichier-ci n'en est qu'un résumé et
doit être lu en second.

Vidéo verticale 1080×1918, 30 images/s, ~37,5 s (mesuré via ffprobe).

## Identité visuelle et technique (vérifié)
- Illustration numérique IA, palette chaude et lumineuse, rendu corporate propre.
- Un personnage "candidat" identique sur toute la vidéo (cheveux courts bouclés,
  chemise bleu clair, jean, ceinture marron). Un second personnage
  "mentor" (costume bleu marine, barbe courte) apparaît à partir de ~12s.
  ⚠️ Leur identité exacte ("Samuel" et/ou "Marc" selon `config.brand`) n'a
  pas pu être confirmée avec certitude visuelle et doit être validée par
  Savoir Utile plutôt que supposée.
- Sous-titres en bas, gras, tout en majuscules, mot déjà prononcé surligné
  en jaune (style karaoké).
- Ouverture en deux vues empilées (recruteur / candidat) pour CETTE vidéo
  précise — non obligatoire pour les vidéos futures (voir règle explicite
  ci-dessous).
- ⚠️ Présence de zooms/dézooms lents continus (Ken Burns) : plausible mais
  **non confirmée avec certitude** par l'échantillonnage effectué (une
  vérification fine sur 4s a montré un changement de plan plutôt qu'un
  panoramique continu) - à revérifier avec un échantillonnage image par
  image d'un même plan si cette information est nécessaire.
- CTA final : fond dégradé clair, logo Savoir Utile centré, « Fait par
  Savoir Utile / Aide à la recherche d'emploi », appel « écrivez GUIDE EN
  PRIVÉ » (message privé), URL en texte simple en bas.
- Audio : aucune preuve de musique de fond continue (spectrogramme), volume
  propre sans écrêtage (-19,3dB moyen / -2,8dB crête), loudness -15,87 LUFS.

## Principes à préserver (checklist contrôle qualité)
cohérence du personnage d'un plan à l'autre · sous-titres lisibles avec
surlignage mot à mot · CTA clair en fin avec lien/mot-clé DM · identité
Savoir Utile (logo, nom, tagline) · jamais de promesse d'emploi garanti.

Chaque nouvelle vidéo adopte la structure la plus adaptée à SON scénario ; la
Vidéo 6 est une référence de niveau et de principes, pas un gabarit à copier
mécaniquement (voir la règle explicite sur la disposition à deux vues).
