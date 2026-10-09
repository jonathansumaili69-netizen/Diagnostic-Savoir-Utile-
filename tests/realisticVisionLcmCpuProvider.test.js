'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const provider = require('../src/core/imageProviders/realisticVisionLcmCpuProvider');
const imageProviders = require('../src/core/imageProviders');
const registry = require('../src/core/characterRegistry');
const root = path.join(__dirname, '..');

test('routeur strict: trois variantes exactes dans l’ordre demandé, V4 canonique puis V5.1', () => {
  assert.deepEqual(provider.MODEL_ORDER.map((x) => [x.id, x.repo, x.revision, x.steps]), [
    ['rv4-lcm8', 'SG161222/Realistic_Vision_V4.0_noVAE', '1685907c0283c7278ba26c5fe561506f564b48d3', 8],
    ['rv4-lcm6', 'SG161222/Realistic_Vision_V4.0_noVAE', '1685907c0283c7278ba26c5fe561506f564b48d3', 6],
    ['rv51-lcm4', 'SG161222/Realistic_Vision_V5.1_noVAE', '1e9f017a7b1eaefb63a1900ea6c5953d2739fd21', 4],
  ]);
  assert.equal(provider.LORA.revision, 'cf2fced511dbe7e26c8d1d397e728fbab875db4b');
  assert.equal(provider.status().scheduler, 'LCMScheduler');
});

test('routeur strict n’autorise pas Tiny-SD ni autre générateur automatique', async () => {
  const previous = process.env.IMAGE_TEXT_TO_IMAGE_BACKEND;
  process.env.IMAGE_TEXT_TO_IMAGE_BACKEND = 'tiny_sd_cpu';
  try {
    await assert.rejects(() => imageProviders.generateAsset({ scene: { description: 'test' }, width: 504, height: 896, requireAiGeneration: true }), /Backend strict.*non autorisé/);
  } finally {
    if (previous === undefined) delete process.env.IMAGE_TEXT_TO_IMAGE_BACKEND;
    else process.env.IMAGE_TEXT_TO_IMAGE_BACKEND = previous;
  }
});

test('bascule séquentielle après timeout et erreur mémoire, puis succès V5.1; PNG invalide est une erreur technique', async () => {
  const calls = [];
  const outcome = await provider.runOrderedVariants(async (variant) => {
    calls.push(variant.id);
    if (variant.id === 'rv4-lcm8') throw new Error('timeout: délai dépassé');
    if (variant.id === 'rv4-lcm6') throw new Error('CUDA out of memory: cannot allocate memory');
    return { image: 'valid PNG after decoder check' };
  });
  assert.deepEqual(calls, ['rv4-lcm8', 'rv4-lcm6', 'rv51-lcm4']);
  assert.equal(outcome.variant.id, 'rv51-lcm4');
  assert.equal(outcome.attempts[0].timeout, true);
  assert.equal(outcome.attempts[1].oom, true);
  await assert.rejects(() => provider.runOrderedVariants(async () => { throw new Error('fichier image PNG invalide'); }), /trois variantes.*échoué techniquement/);
});

test('bascule ordonnée jusqu’au succès et ne traite pas la qualité visuelle comme échec technique', async () => {
  const calls = [];
  const outcome = await provider.runOrderedVariants(async (variant) => {
    calls.push(variant.id);
    if (variant.id === 'rv4-lcm8') throw new Error('timeout');
    return { image: 'valid', quality: 'not assessed' };
  });
  assert.deepEqual(calls, ['rv4-lcm8', 'rv4-lcm6']);
  assert.equal(outcome.variant.id, 'rv4-lcm6');
  assert.equal(outcome.attempts[0].timeout, true);
  assert.equal(outcome.attempts[1].ok, true);
});

test('les trois erreurs techniques sont conservées précisément et la chaîne s’arrête proprement', async () => {
  const calls = [];
  await assert.rejects(() => provider.runOrderedVariants(async (variant) => {
    calls.push(variant.id);
    if (variant.id === 'rv4-lcm8') throw new Error('timeout réseau');
    if (variant.id === 'rv4-lcm6') throw new Error('MemoryError: cannot allocate memory');
    throw new Error('invalid PNG file');
  }), (error) => {
    assert.equal(error.attempts.length, 3);
    assert.deepEqual(error.attempts.map((a) => a.provider), ['rv4-lcm8', 'rv4-lcm6', 'rv51-lcm4']);
    assert.equal(error.attempts[0].timeout, true);
    assert.equal(error.attempts[1].oom, true);
    assert.match(error.attempts[2].error, /invalid PNG/);
    return true;
  });
  assert.deepEqual(calls, ['rv4-lcm8', 'rv4-lcm6', 'rv51-lcm4']);
});

test('dimensions invalides et prompt vide sont refusés avant de démarrer le runtime', async () => {
  await assert.rejects(() => provider.generate({ scene: {}, width: 504, height: 896 }), /Prompt d’image absent/);
  await assert.rejects(() => provider.generate({ scene: { description: 'ok' }, width: 500, height: 896 }), /dimensions.*9:16/i);
});

test('Samuel et Marc conservent les références officielles exactes et leurs hashes du registre', () => {
  const known = [
    ['samuel', 'personnages/samuel/samuel-reference-principale.jpeg', 'ef4a1704941de4e6f2085725859db0a3273a35e622f44cfdb2ad8d93ea56d252'],
    ['marc', 'personnages/marc/marc-reference-principale.jpg', '8c38e2baa720e57bd7f6fd025284848f1d42bd3d4cd8a7bb363e66e12966f354'],
  ];
  for (const [id, relative, expected] of known) {
    const character = registry.getCharacter(id);
    const absolute = path.join(root, 'assets', relative);
    assert.equal(character.reference_principale.rel_path, relative);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    assert.equal(actual, expected);
    assert.equal(character.reference_principale.content_sha256, expected);
  }
});
