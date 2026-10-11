'use strict';

/**
 * Tests du POSE LEXICON (src/core/poseLexicon.js).
 * Suite 100% locale : node --test, aucune dependance, aucun reseau.
 * ATTENTION (honetete) : ce fichier utilise le module pur poseLexicon.js ;
 * aucune image n'est generee ni verifiee ici — le lexique est un vocabulaire.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const poseLexicon = require('../src/core/poseLexicon');

test('le lexique ne declare que les personnages officiels Samuel et Marc', () => {
  assert.deepStrictEqual(poseLexicon.OFFICIAL_CHARACTERS, ['samuel', 'marc']);
  assert.strictEqual(poseLexicon.isOfficialCharacter('samuel'), true);
  assert.strictEqual(poseLexicon.isOfficialCharacter('Marc'), true); // insensible a la casse
  assert.strictEqual(poseLexicon.isOfficialCharacter('inconnu'), false);
  assert.strictEqual(poseLexicon.isOfficialCharacter(''), false);
  assert.strictEqual(poseLexicon.isOfficialCharacter(null), false);
});

test('le lexique est coherent en interne (ids uniques, champs obligatoires)', () => {
  const report = poseLexicon.validateLexicon();
  assert.strictEqual(report.ok, true, `Problemes detectes : ${JSON.stringify(report.problems)}`);
  assert.ok(report.total >= 24, `Catalogue trop petit : ${report.total} poses`);
});

test('chaque personnage officiel possede un catalogue non vide et coherent', () => {
  for (const characterId of poseLexicon.OFFICIAL_CHARACTERS) {
    const poses = poseLexicon.listPoses(characterId);
    assert.ok(poses.length >= 10, `${characterId} devrait avoir au moins 10 poses (${poses.length})`);
    for (const pose of poses) {
      assert.strictEqual(pose.character_id, characterId);
      assert.ok(pose.id && pose.libelle && pose.description && pose.emotion && pose.cadrage);
    }
  }
});

test('listPoses retourne une copie defensive (mutation sans effet de bord)', () => {
  const poses = poseLexicon.listPoses('samuel');
  const before = poses.length;
  poses.push({ id: 'intrus', description: 'x'.repeat(40) });
  assert.strictEqual(poseLexicon.listPoses('samuel').length, before);
});

test('getPose trouve une pose exacte et refuse proprement l\'inconnu', () => {
  const pose = poseLexicon.getPose('samuel', 'samuel_debout_confiant');
  assert.ok(pose);
  assert.strictEqual(pose.character_id, 'samuel');
  assert.strictEqual(pose.libelle, 'Debout confiant');
  assert.strictEqual(poseLexicon.getPose('samuel', 'pose_inexistante'), null);
  assert.strictEqual(poseLexicon.getPose('inconnu', 'samuel_debout_confiant'), null);
  assert.strictEqual(poseLexicon.getPose('', ''), null);
});

test('resolvePose retrouve une pose par mot-cle et rend null sans invention', () => {
  const pose = poseLexicon.resolvePose('marc', 'epaule');
  assert.ok(pose, 'le mot-cle "epaule" devrait retrouver la pose de mentorat de Marc');
  assert.strictEqual(pose.id, 'marc_tap_epaule');
  assert.strictEqual(poseLexicon.resolvePose('samuel', 'xyzabc123rien'), null);
  assert.strictEqual(poseLexicon.resolvePose('inconnu', 'debout'), null);
});

test('buildPosePromptFragment produit un prompt deterministe et complet', () => {
  const fragment = poseLexicon.buildPosePromptFragment('samuel', 'samuel_explique_tableau');
  assert.ok(fragment);
  assert.ok(fragment.includes('Samuel'));
  assert.ok(fragment.includes('samuel_explique_tableau'));
  assert.ok(fragment.includes('Emotion dominante'));
  assert.ok(fragment.includes('Cadrage recommande'));
  assert.ok(fragment.includes('identite visuelle officielle'));
  const fragment2 = poseLexicon.buildPosePromptFragment('samuel', 'samuel_explique_tableau');
  assert.strictEqual(fragment, fragment2, 'le fragment doit etre deterministe');
});

test('buildPosePromptFragment respecte les options et echoue honnetement sur pose inconnue', () => {
  const compact = poseLexicon.buildPosePromptFragment('marc', 'marc_medite_bureau', { inclure_emotion: false, inclure_cadrage: false });
  assert.ok(compact);
  assert.ok(!compact.includes('Emotion dominante'));
  assert.ok(!compact.includes('Cadrage recommande'));
  assert.strictEqual(poseLexicon.buildPosePromptFragment('samuel', 'pose_inconnue'), null);
});

test('un personnage non officiel ne peut obtenir aucune pose ni aucun prompt', () => {
  assert.deepStrictEqual(poseLexicon.listPoses('robot_anonyme'), []);
  assert.strictEqual(poseLexicon.getPose('robot_anonyme', 'samuel_debout_confiant'), null);
  assert.strictEqual(poseLexicon.resolvePose('robot_anonyme', 'confiant'), null);
  assert.strictEqual(poseLexicon.buildPosePromptFragment('robot_anonyme', 'samuel_debout_confiant'), null);
});
