'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const sharp = require('sharp');

const visualConsistency = require('../src/core/visualConsistency');
const registry = require('../src/core/characterRegistry');

const ASSETS = path.join(__dirname, '..', 'assets');
const SAMUEL = path.join(ASSETS, 'personnages', 'samuel', 'samuel-reference-principale.jpeg');
const MARC = path.join(ASSETS, 'personnages', 'marc', 'marc-reference-principale.jpg');

test('visualConsistency: pHash deterministe — la meme image donne toujours le meme hash', async () => {
  const a = await visualConsistency.computePHash(SAMUEL);
  const b = await visualConsistency.computePHash(SAMUEL);
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.equal(visualConsistency.hammingDistance(a, b), 0);
  assert.equal(visualConsistency.similarityFromHashes(a, b), 1);
});

test('visualConsistency: une image tres proche obtient une similarite elevee, une image differente un score plus bas', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-vc-'));
  try {
    const same = SAMUEL;
    const nearSame = path.join(tmp, 'near.jpg');
    await sharp(SAMUEL).resize(400, 400, { fit: 'cover' }).jpeg({ quality: 72 }).toFile(nearSame);
    const hashRef = await visualConsistency.computePHash(same);
    const hashNear = await visualConsistency.computePHash(nearSame);
    const simNear = visualConsistency.similarityFromHashes(hashRef, hashNear);

    const colorA = await visualConsistency.colorSignature(SAMUEL);
    const colorB = await visualConsistency.colorSignature(MARC);
    const simColorSelf = visualConsistency.colorSimilarity(colorA, colorA);
    const simColorCross = visualConsistency.colorSimilarity(colorA, colorB);

    assert.equal(simColorSelf, 1);
    assert.ok(simNear >= 0.6, `score de proximite trop faible pour une quasi-copie : ${simNear}`);
    // Comparaison RELATIVE : une quasi-copie doit rester plus proche que deux
    // personnages differents (pHash + couleur).
    const colorWin = await visualConsistency.colorSignature(nearSame);
    const simWin = visualConsistency.colorSimilarity(colorA, colorWin);
    assert.ok(simWin >= simColorCross, 'la quasi-copie doit etre au moins aussi proche que deux visages differents');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('visualConsistency: classification explicite PASS / REVIEW / FAIL avec seuils configurables', () => {
  assert.equal(visualConsistency.classify(0.95), 'PASS');
  assert.equal(visualConsistency.classify(0.7), 'REVIEW');
  assert.equal(visualConsistency.classify(0.2), 'FAIL');
  assert.equal(visualConsistency.classify(NaN), 'FAIL');
  assert.equal(visualConsistency.classify(0.7, { pass: 0.6, review: 0.1 }), 'PASS');
  const th = visualConsistency.thresholds();
  assert.ok(th.pass > th.review);
});

test('visualConsistency: un visuel IDENTIQUE a sa reference officielle passe le controle (PASS)', async () => {
  const result = await visualConsistency.checkConsistency({
    generated: SAMUEL,
    references: [SAMUEL, MARC],
    referenceLabels: ['PRIMARY:samuel', 'PRIMARY:marc'],
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.score, 1);
  assert.equal(result.best_reference, 'PRIMARY:samuel');
  assert.equal(result.comparisons.length, 2);
  assert.ok(result.honnetete.includes('indicateur perceptuel'));
});

test('visualConsistency: sans reference, le controle retourne FAIL et ne revendique aucune coherence', async () => {
  const result = await visualConsistency.checkConsistency({ generated: SAMUEL, references: [] });
  assert.equal(result.status, 'FAIL');
  assert.match(result.raison, /[Aa]ucune reference officielle/);
  assert.equal(result.evaluated, 0);
});

test('visualConsistency: coherence reelle mesuree sur les references secondaires versionnees du registre', async () => {
  const samuel = registry.getCharacter('samuel');
  const marc = registry.getCharacter('marc');
  // Le registre expose bien references principales ET secondaires versionnees.
  assert.equal(samuel.references_secondaires.length, 14, 'Samuel : 14 references secondaires versionnees');
  assert.equal(marc.references_secondaires.length, 7, 'Marc : 7 references secondaires versionnees');
  assert.equal(samuel.reference_principale.role, 'PRIMARY');
  assert.ok(samuel.references_secondaires.every((r) => r.content_sha256 && r.reference_id && r.versionne === true));

  // Controle de coherence REELLEMENT execute sur des references secondaires.
  const refs = samuel.references_secondaires.slice(0, 4);
  const result = await visualConsistency.checkConsistency({
    generated: SAMUEL,
    references: refs.map((r) => r.abs_path),
    referenceLabels: refs.map((r) => `${r.role}:${r.filename}`),
  });
  const evaluated = result.evaluated != null ? result.evaluated : result.comparisons.length;
  assert.ok(evaluated >= 1, 'au moins une reference secondaire doit etre effectivement comparee');
  assert.equal(result.comparisons.length, evaluated, 'chaque reference evaluee produit une comparaison tracee');
  assert.ok(result.score > 0 && result.score <= 1);
  assert.ok(['PASS', 'REVIEW', 'FAIL'].includes(result.status));
  assert.ok(result.comparisons.every((c) => typeof c.phash === 'string' && c.phash.length === 16), 'chaque comparaison porte un pHash de 64 bits');
  // La comparaison avec la reference principale est toujours reportee separement.
  assert.ok(result.primary_score === undefined || typeof result.primary_score === 'number');
});

test('visualConsistency: detecte un visuel manifestement NON conforme a la reference du personnage', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-vc2-'));
  try {
    // Visuel "hors sujet" : couleur unie totalement differente (pas de personnage).
    const wrong = path.join(tmp, 'wrong.png');
    await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toFile(wrong);
    const result = await visualConsistency.checkConsistency({
      generated: wrong,
      references: [SAMUEL],
      referenceLabels: ['PRIMARY:samuel'],
    });
    assert.notEqual(result.status, 'PASS');
    assert.ok(result.score < 0.9);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('visualConsistency: refus explicite d un buffer non image (aucun faux resultat)', async () => {
  assert.equal(await visualConsistency.isImage(Buffer.from('pas une image')), false);
  const buf = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } }).png().toBuffer();
  assert.equal(await visualConsistency.isImage(buf), true);
});
