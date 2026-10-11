'use strict';

/**
 * POSE LEXICON — catalogue declaratif de poses canoniques pour les
 * personnages officiels de Savoir Utile (Samuel, Marc).
 *
 * Objectif : donner au moteur video un vocabulaire de poses STABLE et
 * DESCRIT, utilisable pour construire des prompts de generation
 * conditionnee par reference (img2img / Tiny-SD / tout backend futur)
 * SANS inventer de pose non cataloguee et SANS dependance reseau.
 *
 * Ce module est volontairement PUR (aucun require externe, aucune I/O) :
 * il peut etre teste par `node --test` sans npm install et importe par
 * n'importe quelle etape du pipeline (orchestrateur, visualEngine,
 * providers d'image) sans risque de regression.
 *
 * LIMITES HONNETES :
 *   - Ce module DECrit des poses ; il ne genere PAS d'image et ne cree
 *     PAS de nouvelle pose : c'est un LEXIQUE, pas un generateur.
 *   - La coherence visuelle de Samuel/Marc reste garantie par les
 *     references officielles (characterRegistry + visualContinuity) ;
 *     ce lexique est un complement de VOCABULAIRE, pas un substitut.
 *   - Aucune pose n'est "extraite" d'une planche : chaque entree est
 *     une description textuelle ecrite pour servir de prompt stable.
 *
 * COMPATIBILITE : les character_id ("samuel", "marc") sont strictement
 * alignes sur src/core/characterRegistry.js (CHARACTER_IDS). Aucun
 * require vers le registre (couplage volontairement nul pour garder ce
 * module 100% testable sans systeme de fichiers).
 */

const OFFICIAL_CHARACTERS = ['samuel', 'marc'];

const POSES = {
  samuel: [
    { id: 'samuel_debout_confiant', libelle: 'Debout confiant', emotion: 'determination', cadrage: 'plan_americain', description: 'Samuel debout, epaules droites, regard franc vers l\'objectif, mains relachees le long du corps, sourire leger et determine.' },
    { id: 'samuel_reflechi_assis', libelle: 'Assis reflechi', emotion: 'reflexion', cadrage: 'plan_moyen', description: 'Samuel assis a une table, menton pose sur la main, sourcils legerement fronces, regard penche vers le bas puis vers l\'horizon.' },
    { id: 'samuel_marche_avant', libelle: 'Marche vers l\'avant', emotion: 'elan', cadrage: 'plan_americain', description: 'Samuel en pleine marche dynamique vers l\'avant, bras en balancement naturel, foulnee resolue, regard droit devant.' },
    { id: 'samuel_explique_tableau', libelle: 'Explique devant tableau', emotion: 'enthousiasme', cadrage: 'plan_moyen', description: 'Samuel de trois-quarts, un bras tendu vers un tableau, doigt pointant une idee cle, sourire pedagogue.' },
    { id: 'samuel_ecoute_mentor', libelle: 'Ecoute son mentor', emotion: 'attention', cadrage: 'plan_rapproche', description: 'Samuel de profil, buste legerement penche vers son interlocuteur, mains croisees devant lui, ecoute active et respectueuse.' },
    { id: 'samuel_tend_la_main', libelle: 'Salue / tend la main', emotion: 'ouverture', cadrage: 'plan_moyen', description: 'Samuel de face, sourire franc, main droite tendue pour une poignee de main ou une presentation chaleureuse.' },
    { id: 'samuel_hesite_carrefour', libelle: 'Hesite a un carrefour', emotion: 'doute', cadrage: 'plan_ensemble', description: 'Samuel immobile a un croisement, regard tournant entre deux directions, mains dans les poches, hesitation visible mais digne.' },
    { id: 'samuel_travaille_nuit', libelle: 'Travaille de nuit', emotion: 'concentration', cadrage: 'plan_rapproche', description: 'Samuel penche sur un ordinateur dans une lumiere chaude de lampe de bureau, traits concentres, ambiance nocturne calme.' },
    { id: 'samuel_celebre_victoire', libelle: 'Celebre une victoire', emotion: 'joie', cadrage: 'plan_americain', description: 'Samuel poing leve vers le ciel, sourire eclatant, demarche triomphante, energie de victoire.' },
    { id: 'samuel_face_obstacle', libelle: 'Face a l\'obstacle', emotion: 'courage', cadrage: 'plan_ensemble', description: 'Samuel de dos puis de trois-quarts face a un obstacle imposant, poings serres, posture ancree, refus d\'abandonner.' },
    { id: 'samuel_presente_produit', libelle: 'Presente le produit', emotion: 'conviction', cadrage: 'plan_moyen', description: 'Samuel tenant le guide de la methode a deux mains face a la camera, regard direct, posture de vendeur honnete et convaincu.' },
    { id: 'samuel_note_idees', libelle: 'Note ses idees', emotion: 'methode', cadrage: 'plan_rapproche', description: 'Samuel ecrivant dans un carnet, stylo en main, pages couvertes de notes, expression appliquee.' }
  ],
  marc: [
    { id: 'marc_mentor_debout', libelle: 'Mentor debout, bras croises', emotion: 'autorite_well', cadrage: 'plan_americain', description: 'Marc debout, bras croises avec assurance bienveillante, sourcil leve, sourire discret, presence de mentor serain.' },
    { id: 'marc_explique_conseil', libelle: 'Explique un conseil', emotion: 'pedagogie', cadrage: 'plan_moyen', description: 'Marc assis en face de son eleve, mains ouvertes articulant un concept, regard chaleureux et appuyant chaque mot.' },
    { id: 'marc_tap_epaule', libelle: 'Tape l\'epaule', emotion: 'encouragement', cadrage: 'plan_rapproche', description: 'Marc posant une main ferme et affectueuse sur l\'epaule de Samuel, contact visuel direct, transmission de confiance.' },
    { id: 'marc_medite_bureau', libelle: 'Medite a son bureau', emotion: 'sagesse', cadrage: 'plan_moyen', description: 'Marc assis a son bureau dans une bibliotheque, lunettes legerement baissees, main sur une page, silence penseur.' },
    { id: 'marc_point_horizon', libelle: 'Pointe l\'horizon', emotion: 'vision', cadrage: 'plan_ensemble', description: 'Marc de profil, bras tendu designant un point eloigne de l\'horizon, attitude de guide montrant la direction.' },
    { id: 'marc_ecouteprobleme', libelle: 'Ecoute un probleme', emotion: 'empathie', cadrage: 'plan_rapproche', description: 'Marc penche en avant, menton fronce, regard attentif sans jugement, pleine ecoute du probleme expose.' },
    { id: 'marc_conference', libelle: 'Animer une conference', emotion: 'leadership', cadrage: 'plan_ensemble', description: 'Marc debout devant un public, silhouettes floues au premier plan, gestes amples et voix projettee, aisance oratoire.' },
    { id: 'marc_pense_critique', libelle: 'Pense de facon critique', emotion: 'analyse', cadrage: 'plan_rapproche', description: 'Marc les doigts jointifs devant la bouche, regard montant vers le coin, evaluation mentale rigoureuse.' },
    { id: 'marc_ecrit_tableau_blanc', libelle: 'Ecrit au tableau blanc', emotion: 'structuration', cadrage: 'plan_moyen', description: 'Marc ecrivant un schema simple au tableau blanc, marqueur en main, tournant legerement vers son auditoire.' },
    { id: 'marc_fete_reussite', libelle: 'Celebre la reussite de son eleve', emotion: 'fierte', cadrage: 'plan_americain', description: 'Marc applaudissant avec fierte discrete, sourire large, regard brillant de satisfaction pour son eleve.' },
    { id: 'marc_avertit_danger', libelle: 'Avertit d\'un danger', emotion: 'gravite', cadrage: 'plan_rapproche', description: 'Marc main levee paume ouverte dans un geste d\'arret solennel, front marque, regard insistant et protecteur.' },
    { id: 'marc_marche_cote', libelle: 'Marche aux cotes de Samuel', emotion: 'accompagnement', cadrage: 'plan_ensemble', description: 'Marc marchant aux cotes de Samuel, demi-tour vers lui en pleine conversation, complicite de mentor actif.' }
  ]
};

/** Identifiants officiels acceptes (alignes sur characterRegistry.CHARACTER_IDS, sans couplage). */
function isOfficialCharacter(characterId) {
  return OFFICIAL_CHARACTERS.includes(String(characterId || '').trim().toLowerCase());
}

/** Liste les poses cataloguees pour un personnage officiel (copie defensive). */
function listPoses(characterId) {
  const id = String(characterId || '').trim().toLowerCase();
  if (!isOfficialCharacter(id)) return [];
  return (POSES[id] || []).map((pose) => ({ ...pose, character_id: id }));
}

/** Retourne une pose par identifiant exact, sinon null (jamais d'invention). */
function getPose(characterId, poseId) {
  const id = String(characterId || '').trim().toLowerCase();
  const pid = String(poseId || '').trim().toLowerCase();
  if (!isOfficialCharacter(id) || !pid) return null;
  const pose = (POSES[id] || []).find((p) => String(p.id).toLowerCase() === pid);
  return pose ? { ...pose, character_id: id } : null;
}

/** Recherche souple par mot-cle (id, libelle ou emotion) ; null si aucune correspondance. */
function resolvePose(characterId, wanted) {
  const id = String(characterId || '').trim().toLowerCase();
  const needle = String(wanted || '').trim().toLowerCase();
  if (!isOfficialCharacter(id) || !needle) return null;
  const direct = getPose(id, needle);
  if (direct) return direct;
  const catalog = POSES[id] || [];
  const scored = catalog
    .map((pose) => {
      const haystack = `${pose.id} ${pose.libelle} ${pose.emotion} ${pose.description}`.toLowerCase();
      const words = needle.split(/\s+/).filter(Boolean);
      const hits = words.filter((w) => haystack.includes(w)).length;
      return { pose, score: hits === 0 ? 0 : hits / words.length };
    })
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0) return null;
  return { ...scored[0].pose, character_id: id, match_confiance: Number(scored[0].score.toFixed(2)) };
}

/**
 * Construit un fragment de prompt DETERMINISTE pour une pose cataloguee,
 * utilisable par tout backend de generation d'image (conditionne par
 * reference ou non). Retourne null pour toute pose inconnue : le
 * systeme appelant doit echouer honnetement, jamais inventer.
 */
function buildPosePromptFragment(characterId, poseId, options = {}) {
  const pose = getPose(characterId, poseId);
  if (!pose) return null;
  const nom = pose.character_id === 'samuel' ? 'Samuel' : 'Marc';
  const inclureEmotion = options.inclure_emotion !== false;
  const inclureCadrage = options.inclure_cadrage !== false;
  const parts = [
    `${nom} : pose "${pose.libelle}" (${pose.id}).`,
    pose.description,
  ];
  if (inclureEmotion) parts.push(`Emotion dominante : ${pose.emotion}.`);
  if (inclureCadrage) parts.push(`Cadrage recommande : ${pose.cadrage}.`);
  parts.push('Conserver strictement l\'identite visuelle officielle du personnage (references du Character Registry).');
  return parts.join(' ');
}

/** Coherence interne du catalogue (utilise par les tests ; jamais silencieux si incoherent). */
function validateLexicon() {
  const problems = [];
  const seenByCharacter = {};
  for (const characterId of OFFICIAL_CHARACTERS) {
    const catalog = POSES[characterId] || [];
    seenByCharacter[characterId] = new Set();
    catalog.forEach((pose, index) => {
      const where = `${characterId}[${index}]`;
      if (!pose.id || typeof pose.id !== 'string') problems.push(`${where}: id manquant`);
      else if (seenByCharacter[characterId].has(pose.id)) problems.push(`${where}: id duplique "${pose.id}"`);
      else seenByCharacter[characterId].add(pose.id);
      if (!pose.libelle || typeof pose.libelle !== 'string') problems.push(`${where}: libelle manquant`);
      if (!pose.description || typeof pose.description !== 'string' || pose.description.length < 20) {
        problems.push(`${where}: description trop courte ou absente`);
      }
      if (!pose.emotion || typeof pose.emotion !== 'string') problems.push(`${where}: emotion manquante`);
      if (!pose.cadrage || typeof pose.cadrage !== 'string') problems.push(`${where}: cadrage manquant`);
    });
    if (catalog.length === 0) problems.push(`${characterId}: catalogue vide`);
  }
  return { ok: problems.length === 0, problems, total: OFFICIAL_CHARACTERS.reduce((sum, c) => sum + (POSES[c] || []).length, 0) };
}

module.exports = {
  OFFICIAL_CHARACTERS,
  POSES,
  isOfficialCharacter,
  listPoses,
  getPose,
  resolvePose,
  buildPosePromptFragment,
  validateLexicon
};
