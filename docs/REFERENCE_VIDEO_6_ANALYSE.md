# Analyse de la Vidéo 6 (référence qualité Savoir Utile)

Fichier fourni : `lv_0_20260820161547.mp4`. Analyse réalisée par extraction réelle
d'images (une toutes les 2 secondes, 19 images), par mesures audio objectives
(ffmpeg : silencedetect, volumedetect, loudnorm) et par un spectrogramme complet
de la piste audio. Aucune transcription de la parole n'a été faite (aucun outil
de reconnaissance vocale n'était disponible) : le texte cité ci-dessous provient
exclusivement des sous-titres visibles à l'image, jamais d'une supposition sur
ce qui est dit.

Cette analyse sert de **référence de principes**, pas de modèle à copier. Voir
la section "Ce qui ne doit PAS être généralisé" plus bas.

## Fiche technique (mesurée, pas estimée)

- Format : 1080×1918 (vertical ~9:16), H.264, 30 im/s, AAC stéréo 44,1 kHz
- Durée : 37,53 s
- Débit global : ~8,77 Mbps (qualité d'export élevée)
- Volume moyen -19,3 dB / crête -2,8 dB (aucun écrêtage)
- Loudness intégrée mesurée : -15,87 LUFS (dans la norme habituelle des
  plateformes sociales, ni trop faible ni trop forte)
- Nombreuses micro-coupures de 0,3 à 0,7 s réparties toutes les 1-2 s environ
  (pauses naturelles de la voix, alignées sur les changements de sous-titre)
- Spectrogramme : énergie concentrée en dessous de ~13 kHz avec de nettes
  striures verticales séparées par des silences quasi totaux (signature typique
  d'une voix seule). **Aucune bande harmonique continue sous les silences
  n'a été détectée** : rien n'indique une musique de fond soutenue sous la
  narration. Cette lecture reste une analyse spectrale objective, pas une
  écoute humaine — à confirmer si un doute subsiste.

## Structure narrative observée

1. **Accroche (0-2 s)** : gros texte blanc/rouge sur bandeau noir "façon
   papier déchiré" : "PARLEZ MOI DE VOS DÉFAUTS" — ce style d'accroche
   n'apparaît qu'une seule fois, en ouverture.
2. **Écran partagé recruteur/candidat (0-10 s)** : deux cadres empilés (candidat
   en haut, recruteur en bas), chacun étiqueté par une flèche ("Candidat" /
   "Recruteur"). Le candidat donne une mauvaise réponse ("JE SUIS
   PERFECTIONNISTE" à l'écran) pendant que le recruteur note, sourcils froncés.
3. **Scène du mentor (à partir de ~11-12 s)** : passage à un cadre plein,
   un troisième personnage (costume bleu marine, barbe courte) enseigne une
   méthode en 3 points écrite à la main sur une feuille : "POINT FAIBLE →
   CONSCIENCE → PROGRES", pendant que le même candidat (identique d'un bout à
   l'autre : coupe courte bouclée, chemise bleu clair, jean, ceinture marron)
   regarde et apprend.
4. **Retour au recruteur avec la bonne réponse** ("RéPONSE PARFAITE" à
   l'écran) : nouveau plan plein cadre, candidat et mentor debout,
   démonstration de la méthode appliquée.
5. **Scène de validation** : candidat et mentor debout, complices, dialogue
   valorisant ("C'EST CETTE TECHNIQUE").
6. **Scène du guide physique** (~t=16 s et ~t=26 s, deux plans différents) :
   le candidat et le mentor tiennent ensemble le même livre ouvert, à deux
   reprises distinctes — forte cohérence de l'objet entre les deux plans.
7. **Carte de fin officielle** (~t=34-37 s) : fond clair dégradé, logo
   officiel centré, nom de marque, tagline, CTA, URL.

## Éléments de marque vérifiés (à conserver tels quels)

- **Logo** : carré à coins arrondis, dégradé bleu→violet, monogramme blanc
  stylisé combinant un "S" et une flèche montante. Présent en filigrane
  discret en haut à gauche sur tout le montage, et en grand sur la carte de
  fin.
- **Nom de marque** à la carte de fin : "SAVOIR" (gras) / "UTILE" (normal),
  séparés par un fin trait horizontal.
- **Tagline** : "Fait par Savoir Utile" / "Aide à la recherche d'emploi".
- **Couverture du guide** (visible et identique sur deux plans distincts) :
  fond bleu marine foncé, titre en majuscules blanc/jaune "LA MÉTHODE
  COMPLÈTE POUR TROUVER UN EMPLOI EN AFRIQUE FRANCOPHONE" (correspond mot
  pour mot à `config.brand.productName` déjà présent dans le code), icône
  discrète en haut de la couverture.
- **CTA final, construit mot à mot en surbrillance jaune** : "écrivez GUIDE EN
  PRIVé" — confirme que le mécanisme réel est une demande de mot-clé
  **"GUIDE" envoyé en message privé**, exactement ce que `commercial.js`
  détecte déjà (`DEFAULT_INTENT_KEYWORDS`) et priorise déjà comme un canal DM
  avant une réponse publique.
- **URL affichée en texte simple** sur la carte de fin :
  `https://savoir-utile.mychariow.shop` — identique à `config.brand.shopUrl`.

## Style des sous-titres (vérifié sur plusieurs images)

- Police sans-serif très grasse, tout en majuscules, contour noir épais pour
  la lisibilité sur fond variable.
- Mise en emphase mot par mot façon "karaoké" : le(s) mot(s) déjà prononcé(s)
  passent en jaune vif, le reste reste blanc — permet de confirmer une bonne
  synchronisation voix/texte à l'instant capturé à chaque fois.
- Position : toujours dans le tiers bas de la moitié d'écran concernée (écran
  partagé) ou du cadre plein (scènes suivantes).

## Personnages (cohérence vérifiée image par image)

- **Candidat** : jeune homme, cheveux courts bouclés, chemise bleu clair,
  jean, ceinture marron — identique sur les 8 images vérifiées entre 0 s et
  30 s (visage, vêtements, coiffure).
- **Recruteur** (écran partagé uniquement) : homme plus âgé, cheveux
  poivre-et-sel courts, costume gris, chemise blanche.
- **Mentor** (scènes à partir de ~12 s) : personnage distinct du recruteur,
  costume bleu marine, chemise bleu clair, barbe courte taillée. Il n'est pas
  possible de confirmer avec certitude s'il s'agit visuellement de "Samuel"
  ou "Marc" tels que nommés dans `config.brand.characters` : cette
  correspondance devra être confirmée par vous, pas supposée par le système.

## Ce qui ne doit PAS être généralisé (rappel explicite du brief)

La disposition en deux vues empilées (candidat/recruteur) du début **n'est
pas une règle obligatoire**. Elle convient à ce scénario précis (confrontation
candidat/recruteur). Une vidéo sur un autre thème peut très bien n'avoir
qu'un seul personnage, un seul plan, ou une structure totalement différente.
Ce qui doit être retenu comme principe transférable, ce sont : la cohérence
stricte d'un personnage d'un plan à l'autre, la lisibilité des sous-titres,
la clarté du CTA, l'usage cohérent du logo/marque, et un audio propre sans
écrêtage — pas la mise en scène elle-même.

## Limites honnêtes de cette analyse

- Aucune transcription vocale n'a été réalisée (pas d'outil de reconnaissance
  vocale disponible) : le contenu exact de la voix off n'est connu qu'à
  travers les sous-titres visibles sur les images échantillonnées.
- L'échantillonnage vidéo (1 image/2 s, avec une vérification plus fine sur
  une fenêtre de 4 s à 2 images/s) ne permet pas de confirmer avec certitude
  la présence d'un zoom lent continu dans un plan donné : les fenêtres
  vérifiées finement contenaient en réalité un changement de plan, pas un
  panoramique continu. Si Conquistador OS doit vérifier la présence réelle
  d'un zoom lent sur une future vidéo, il faudra une analyse image par image
  d'un même plan, pas un échantillonnage espacé.
- L'absence de musique de fond est une lecture du spectrogramme (silences
  quasi totaux entre les segments de voix), pas une écoute confirmée par une
  oreille humaine.
- **Mise à jour (13/09/2026)** : une fiche personnages officielle fournie
  confirme l'identité du "mentor" — voir section suivante. Cette ligne reste
  ici pour l'historique de ce qui n'était pas confirmable avec les seuls
  éléments disponibles à l'époque de l'analyse initiale.
- L'identité exacte du "mentor" (Samuel ou Marc) n'a pas pu être confirmée
  avec certitude et doit être précisée par Savoir Utile plutôt que supposée.

## Utilisation dans Conquistador OS

## Confirmation d'identité des personnages (13/09/2026)

Une fiche personnages officielle ("SAVOIR UTILE — PERSONNAGES PRINCIPAUX")
a été fournie et confirme, sans ambiguïté cette fois :

- **Samuel** — le chercheur d'emploi ambitieux (22-24 ans), chemise bleu
  clair, sac à dos, personnage jeune et expressif : c'est le "candidat"
  identifié dans cette analyse.
- **Marc** — le recruteur et mentor (35-45 ans), costume bleu marine élégant,
  barbe bien entretenue, posture confiante et bienveillante : c'est très
  probablement le "recruteur" ET le "mentor" de cette vidéo (les deux rôles
  décrits dans la fiche - recruteur qui évalue, mentor qui guide -
  correspondent exactement aux deux apparitions du personnage plus âgé dans
  cette vidéo). Cette identification reste une déduction raisonnable à
  partir de la fiche officielle et de la cohérence visuelle observée, pas
  une confirmation extraite d'un métadonnée de la vidéo elle-même.
- Le fichier vidéo fourni pour la mission "qualité vidéo" du 13/09/2026
  (`b5c8bbca...mp4`) a été vérifié techniquement (ffprobe + frames) : il
  s'agit du même contenu que cette Vidéo 6 (même hook, mêmes plans, même
  durée ~37,5s), exporté différemment (HEVC, débit plus faible). Aucune
  nouvelle analyse de contenu n'a donc été nécessaire.


Ce document est prévu pour être enregistré comme référence dans la base de
connaissances (`asset_type: "reference"`, `official: true`) via le nouvel
outil `scripts/seed-knowledge.js` (voir ce script), afin que l'agent créatif
(`contenu.js`) et l'agent de contrôle qualité (`videoQuality.js`) puissent s'y
référer lors de la conception et de la relecture de nouvelles vidéos — sans
jamais prétendre "copier" cette vidéo, et en respectant explicitement la règle
de non-généralisation de la mise en scène ci-dessus.
