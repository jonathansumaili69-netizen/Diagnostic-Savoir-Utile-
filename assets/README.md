# Assets — references visuelles officielles

Ce dossier contient les references visuelles OFFICIELLES fournies par
Savoir Utile, integrees directement au projet pour que
VISUAL_CONTINUITY_POLICY (`src/core/visualContinuity.js`) puisse les
identifier et bloquer toute generation qui s'en ecarterait sans verification
(sections 12-14 du prompt maitre).

## Contenu

```
assets/
├── personnages/
│   ├── samuel/
│   │   └── samuel-reference-principale.jpeg   <- reference isolee, corps entier
│   ├── marc/
│   │   └── marc-reference-principale.jpg      <- reference isolee, corps entier
│   ├── bible-personnages-samuel-marc.jpg      <- fiche complete : identite, personnalite,
│   │                                              apparence, style vestimentaire, role dans
│   │                                              les videos, planches d'expressions
│   └── samuel-et-marc-ensemble.jpg            <- reference de continuite entre les 2 personnages
├── logo/
│   └── logo-savoir-utile-officiel.jpeg        <- lockup icone + wordmark "SAVOIR UTILE"
├── products/
│   └── guide-methode-8c-officiel.png           <- couverture officielle extraite du guide fourni
└── style-reference/                            <- exemples de style : interdits comme plans finaux
    ├── exemple-01-chambre-inquiet.png          <- fichier source, actuellement tronque/corrompu
    └── reference-index.json                    <- hashes SHA-256 et pHash des exemples a exclure
```

## Exclusion obligatoire des exemples

Le dossier `style-reference/` n'est pas une source de scènes. Le fichier
`reference-index.json` contient également les empreintes des huit images
issues du job vidéo incomplet `56059bc2` dans Supabase, notamment la scène
`s08-suivi` où apparaît la tasse. Les images binaires de ce job ne sont pas
embarquées dans le dépôt. `src/core/mediaProvenance.js` compare les nouveaux
assets et des frames réellement extraites du MP4 aux empreintes enregistrées;
un match exact ou perceptuel bloque la production.

L'exemple `exemple-01-chambre-inquiet.png` est tronqué : son chemin source est
donc toujours bloqué, et son index garde le SHA-256 exact ainsi qu'un pHash
récupéré de la partie visible. Ce pHash partiel est une protection
complémentaire, pas une preuve visuelle complète.

## Fiche personnages (transcrite depuis bible-personnages-samuel-marc.jpg)

### SAMUEL — Le chercheur d'emploi ambitieux
- **Identite** : 22-24 ans, africain francophone, heros principal en quete
  d'opportunites, objectif : trouver un emploi et reussir sa carriere.
- **Personnalite** : determine et ambitieux, intelligent et curieux, humble
  et travailleur, parfois stresse ou decourage, toujours pret a apprendre.
- **Apparence** : visage jeune sympathique et expressif, yeux marron fonce,
  cheveux noirs courts coiffure moderne, peau noire traits africains
  authentiques, corps athletique moyen, posture droite.
- **Style vestimentaire** : chemise bleue claire manches retroussees, jean
  bleu fonce, chaussures en cuir marron, sac a dos pratique, style simple
  propre et accessible.
- **Role dans les videos** : partage ses difficultes et erreurs, pose des
  questions, apprend et applique les conseils, evolue au fil des episodes,
  represente le public cible.
- **Expressions de reference disponibles** : inquiet, determine, confiant.
- **Mots-cles** : Espoir, Perseverance, Progression, Transformation.

### MARC — Le recruteur et mentor
- **Identite** : 35-45 ans, africain francophone, recruteur experimente qui
  connait les coulisses du recrutement, objectif : aider les candidats a
  comprendre les attentes des entreprises.
- **Personnalite** : experimente et professionnel, calme patient et
  pedagogue, honnete et bienveillant, autoritaire mais accessible, passionne
  par le developpement des autres.
- **Apparence** : visage mature rassurant et professionnel, yeux marron
  fonce, cheveux noirs courts barbe bien entretenue, peau noire traits
  africains authentiques, corps athletique moyen, posture confiante.
- **Style vestimentaire** : costume bleu marine elegant, chemise bleue
  claire, ceinture et chaussures en cuir marron, montre classique, style
  professionnel et credible.
- **Role dans les videos** : explique le point de vue du recruteur, devoile
  les erreurs des candidats, donne des conseils professionnels, guide
  Samuel dans sa progression, inspire confiance et credibilite.
- **Expressions de reference disponibles** : bienveillant, explicatif, serieux.
- **Mots-cles** : Experience, Autorite, Confiance, Transmission.

### Relation Samuel / Marc
Marc est le mentor et guide Samuel. Samuel pose des questions, partage ses
difficultes et apprend. Marc apporte des reponses, des conseils et des
methodes concretes. Le duo represente le parcours de tout chercheur
d'emploi : comprendre le probleme, apprendre les bonnes methodes et
progresser vers le succes.

## Connexion au code

Ces chemins sont deja references par defaut dans `.env.example` :

```
CHARACTER_REF_SAMUEL=assets/personnages/samuel/samuel-reference-principale.jpeg
CHARACTER_REF_MARC=assets/personnages/marc/marc-reference-principale.jpg
LOGO_ASSET_ID=assets/logo/logo-savoir-utile-officiel.jpeg
```

Avec ces variables definies (elles le sont par defaut dans `.env.example`),
`src/core/visualContinuity.js` considere les references comme presentes et
ne bloque plus la continuite visuelle pour Samuel/Marc/logo — voir
`src/agents/base.js` (`brandContext()`) qui injecte desormais une
description textuelle complete des deux personnages dans chaque prompt
IA de generation de contenu, pour que les scenes/prompts d'images produits
restent fideles a ces references memes si l'IA ne "voit" pas directement le
fichier image (les fournisseurs texte utilises ne prennent pas d'image en
entree dans cette version).

## Limite honnête sur l'identité

Les références officielles de Samuel et Marc restent des références
d'identité et ne doivent pas servir de plans finaux par défaut. Le fournisseur
CPU Realistic Vision + LCM crée des images inédites, mais son contrat actuel
ne conditionne pas directement l'image sur les pixels de référence : une
description textuelle ne garantit donc pas une identité stable. Le fournisseur
Hugging Face peut accepter une image de référence lorsqu'il est explicitement
configuré; la disponibilité d'un modèle, d'un endpoint gratuit et d'un token
doit être vérifiée séparément. Pour une vidéo sans conditionnement d'identité
fiable, préférer un format faceless ou signaler les scènes de personnages à
réviser humainement plutôt que de promettre une ressemblance.
