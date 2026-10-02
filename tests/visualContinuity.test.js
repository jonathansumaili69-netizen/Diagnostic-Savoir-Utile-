'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.CHARACTER_REF_SAMUEL;
delete process.env.CHARACTER_REF_MARC;
delete process.env.LOGO_ASSET_ID;

const visualContinuity = require('../src/core/visualContinuity');

test('checkCharacter: signale un personnage non officiel (interdiction absolue d\'invention)', () => {
  const problems = visualContinuity.checkCharacter('Jean-Michel');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'personnage_non_officiel');
});

test('checkCharacter: personnage officiel SANS reference configuree bloque la continuite', () => {
  const problems = visualContinuity.checkCharacter('Samuel');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'reference_manquante');
});

test('checkCharacter: aucune scene ni "aucun" personnage ne genere aucun probleme', () => {
  assert.deepEqual(visualContinuity.checkCharacter(null), []);
  assert.deepEqual(visualContinuity.checkCharacter('aucun'), []);
  assert.deepEqual(visualContinuity.checkCharacter(''), []);
});

test('checkLogo: logo requis sans asset configure bloque la continuite', () => {
  const problems = visualContinuity.checkLogo(true);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'logo_non_configure');
});

test('checkLogo: logo non requis ne genere aucun probleme', () => {
  assert.deepEqual(visualContinuity.checkLogo(false), []);
});

test('checkStyleContinuity: signale un ecart de style par rapport a la premiere scene (avertissement non bloquant)', () => {
  const problems = visualContinuity.checkStyleContinuity(
    { style: 'cartoon' },
    [{ style: 'realiste' }]
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'incoherence_style');
});

test('checkStyleContinuity: aucun probleme si le style correspond', () => {
  const problems = visualContinuity.checkStyleContinuity(
    { style: 'realiste' },
    [{ style: 'realiste' }]
  );
  assert.deepEqual(problems, []);
});

test('evaluateScene: continuite_garantie est false si une reference bloquante manque', () => {
  const result = visualContinuity.evaluateScene({ id: 'scene_01', personnage: 'Samuel', logo_requis: false });
  assert.equal(result.continuite_garantie, false);
  assert.equal(result.problemes_bloquants.length, 1);
});

test('evaluateScene: continuite_garantie est true quand aucune reference obligatoire manquante', () => {
  const result = visualContinuity.evaluateScene({ id: 'scene_01', personnage: null, logo_requis: false });
  assert.equal(result.continuite_garantie, true);
  assert.deepEqual(result.problemes_bloquants, []);
});

test('evaluateScenes: continuite_garantie globale est false si au moins une scene echoue', () => {
  const result = visualContinuity.evaluateScenes([
    { id: 'scene_01', personnage: null, style: 'realiste' },
    { id: 'scene_02', personnage: 'Personnage Invente', style: 'realiste' },
  ]);
  assert.equal(result.continuite_garantie, false);
  assert.equal(result.scenes.length, 2);
  assert.equal(result.scenes[0].continuite_garantie, true);
  assert.equal(result.scenes[1].continuite_garantie, false);
});

test('evaluateScenes: tableau vide ou invalide ne fait jamais planter et reste honnete', () => {
  assert.deepEqual(visualContinuity.evaluateScenes([]), { continuite_garantie: true, scenes: [] });
  assert.deepEqual(visualContinuity.evaluateScenes(null), { continuite_garantie: true, scenes: [] });
});

test('OFFICIAL_CHARACTERS: expose exactement Samuel et Marc, jamais un autre personnage', () => {
  assert.deepEqual(visualContinuity.OFFICIAL_CHARACTERS, ['Samuel', 'Marc']);
});

test('checkCharacter: un personnage secondaire combine a Samuel ou Marc ne bloque pas la continuite (cahier des charges "personnage secondaire autorise")', () => {
  // "Samuel et un recruteur" contient bien "samuel" -> reconnu comme
  // personnage officiel present ; le recruteur est un personnage secondaire
  // libre (verifie separement via le champ personnage_secondaire, jamais
  // valide contre OFFICIAL_CHARACTERS puisqu'il n'est par definition pas
  // une reference officielle).
  const problems = visualContinuity.checkCharacter('Samuel et un recruteur');
  const nonOfficialProblems = problems.filter((p) => p.type === 'personnage_non_officiel');
  assert.deepEqual(nonOfficialProblems, []);
});

test('checkCharacter: un personnage secondaire seul (sans Samuel ni Marc mentionne) reste rejete comme non officiel', () => {
  // Le champ "personnage" reste la reference officielle : un personnage
  // secondaire ne doit jamais s'y substituer completement a Samuel/Marc.
  const problems = visualContinuity.checkCharacter('un recruteur');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'personnage_non_officiel');
});
