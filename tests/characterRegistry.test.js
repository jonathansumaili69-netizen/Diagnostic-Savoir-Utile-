'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const registry = require('../src/core/characterRegistry');

const ASSETS = path.join(__dirname, '..', 'assets');

function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('characterRegistry: Samuel et Marc sont les personnages officiels ; un nom inconnu est refuse', () => {
  assert.equal(registry.resolveCharacterId('Samuel'), 'samuel');
  assert.equal(registry.resolveCharacterId('samuel'), 'samuel');
  assert.equal(registry.resolveCharacterId('Marc'), 'marc');
  assert.equal(registry.resolveCharacterId('Marc D.'), 'marc');
  assert.equal(registry.resolveCharacterId('un recruteur africain'), null);
  assert.equal(registry.resolveCharacterId('aucun'), null);
  assert.equal(registry.resolveCharacterId(''), null);
  // Un personnage non officiel ne peut JAMAIS etre resolu silencieusement.
  assert.throws(() => registry.assertOfficialCharacter('Kevin'), (err) => err.code === 'CHARACTER_NOT_OFFICIAL');
});

test('characterRegistry: la reference PRINCIPALE existe, est hashee et n a pas ete remplacee', () => {
  const samuel = registry.primaryReference('samuel');
  const marc = registry.primaryReference('marc');
  assert.equal(samuel.disponible, true);
  assert.equal(marc.disponible, true);
  assert.equal(samuel.rel_path, 'personnages/samuel/samuel-reference-principale.jpeg');
  assert.equal(marc.rel_path, 'personnages/marc/marc-reference-principale.jpg');
  assert.ok(/^[0-9a-f]{64}$/.test(samuel.content_sha256));
  assert.ok(/^[0-9a-f]{64}$/.test(marc.content_sha256));
  // Hash recalcule independamment depuis le disque : le registre doit dire la verite.
  assert.equal(samuel.content_sha256, sha(path.join(ASSETS, samuel.rel_path)));
  assert.equal(marc.content_sha256, sha(path.join(ASSETS, marc.rel_path)));
});

test('characterRegistry: les 17 images officielles ajoutees sont enregistrees comme references SECONDAIRES versionnees', () => {
  const samuel = registry.getCharacter('samuel');
  const marc = registry.getCharacter('marc');
  // 14 fichiers cote Samuel (10 scenes solo + 4 scenes a deux personnages), 7 cote Marc.
  assert.equal(samuel.references_secondaires.length, 14);
  assert.equal(marc.references_secondaires.length, 7);
  const hashes = new Set([
    ...samuel.references_secondaires.map((r) => r.content_sha256),
    ...marc.references_secondaires.map((r) => r.content_sha256),
  ]);
  assert.equal(hashes.size, 17, 'les 17 images officielles distinctes doivent etre toutes referencees');
  for (const ref of [...samuel.references_secondaires, ...marc.references_secondaires]) {
    assert.equal(ref.role, 'SECONDARY');
    assert.equal(ref.versionne, true);
    assert.ok(/^[0-9a-f]{16}$/.test(ref.reference_id), 'chaque reference doit avoir un identifiant stable');
    assert.ok(ref.size_bytes > 0, `fichier de reference vide : ${ref.rel_path}`);
    assert.ok(fs.existsSync(ref.abs_path), `fichier de reference absent : ${ref.rel_path}`);
  }
});

test('characterRegistry: la reference principale reste PRIORITAIRE dans la selection envoyee au provider', () => {
  const selection = registry.selectReferenceImages('samuel', { max: 3 });
  assert.equal(selection.character_id, 'samuel');
  assert.equal(selection.references.length, 3);
  assert.equal(selection.references[0].role, 'PRIMARY', 'la reference principale doit etre la premiere source');
  assert.equal(selection.references[0].filename, 'samuel-reference-principale.jpeg');
  assert.equal(selection.raison, null);
});

test('characterRegistry: aucune reference n est inventee pour un personnage inconnu', () => {
  const selection = registry.selectReferenceImages('inconnu', { max: 4 });
  assert.equal(selection.character_id, null);
  assert.deepEqual(selection.references, []);
  assert.match(selection.raison, /non officiel/);
});

test('characterRegistry: strategie de reference explicite selon les capacites du provider', () => {
  assert.equal(registry.referenceStrategyFor('samuel', { providerCapabilities: { multi_reference: true } }).strategy, 'MULTI_REFERENCE');
  assert.equal(registry.referenceStrategyFor('samuel', { providerCapabilities: { reference_image: true } }).strategy, 'SINGLE_REFERENCE');
  assert.equal(registry.referenceStrategyFor('samuel', { providerCapabilities: { image_to_image: true } }).strategy, 'IMAGE_TO_IMAGE');
  const fallback = registry.referenceStrategyFor('samuel', { providerCapabilities: {} });
  assert.equal(fallback.strategy, 'FALLBACK_OFFICIAL_ASSET');
  assert.match(fallback.raison, /asset OFFICIEL/);
  assert.equal(registry.referenceStrategyFor('inconnu', { providerCapabilities: {} }).strategy, 'REFUSED');
});

test('characterRegistry: integrity complete du registre (aucune reference manquante ou illisible)', () => {
  const integrity = registry.verifyIntegrity();
  assert.deepEqual(integrity.problems, []);
  assert.equal(integrity.ok, true);
  const samuel = integrity.characters.find((c) => c.character_id === 'samuel');
  assert.equal(samuel.references_principales, 1);
  assert.equal(samuel.references_secondaires, 14);
  assert.equal(samuel.statut_reference, 'PRIMARY_AND_SECONDARY');
});

test('characterRegistry: une scene a deux personnages est detectee (samuel + marc ensemble)', () => {
  assert.equal(registry.involvesBoth('Samuel et Marc'), true);
  assert.equal(registry.involvesBoth('Marc et Samuel'), true);
  assert.equal(registry.involvesBoth('Samuel'), false);
  const both = registry.selectReferenceImages('Samuel et Marc', { max: 2, preferBoth: true });
  assert.equal(both.references.length, 2);
});

test('characterRegistry: le registre complet est serialisable et contient la bible visuelle', () => {
  const full = registry.loadRegistry();
  assert.equal(full.version, registry.REGISTRY_VERSION);
  assert.equal(full.character_count, 2);
  for (const id of registry.CHARACTER_IDS) {
    const c = full.characters[id];
    assert.ok(c.description_visuelle.length > 40);
    assert.ok(c.caracteristiques_visage.length > 20);
    assert.ok(c.coiffure.length > 10);
    assert.ok(c.vetements_style.length > 20);
    assert.ok(c.elements_distinctifs.length > 10);
    assert.ok(c.style_visuel.length > 20);
    assert.ok(c.metadata && c.metadata.age);
    assert.ok(/^[0-9a-f]{16}$/.test(c.reference_principale.reference_id));
  }
});
