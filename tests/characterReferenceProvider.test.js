'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-charref-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.IMAGE_IMG2IMG_PROVIDER;
delete process.env.STABILITY_API_KEY;
delete process.env.FAL_API_KEY;
delete process.env.REPLICATE_API_TOKEN;
delete process.env.IMAGE_IMG2IMG_API_KEY;

const characterReferenceProvider = require('../src/core/imageProviders/characterReferenceProvider');
const providerAdapter = require('../src/core/imageProviders/providerAdapter');
const imageProviders = require('../src/core/imageProviders');
const registry = require('../src/core/characterRegistry');

test('providerAdapter: AUCUN provider image-to-image n est obligatoire — etat honnete par defaut', () => {
  assert.equal(providerAdapter.configured(), false);
  const st = providerAdapter.status();
  assert.equal(st.configure, false);
  assert.equal(st.provider, null);
  assert.match(st.raison, /Aucun provider image-to-image/);
  assert.deepEqual(st.providers_disponibles.sort(), ['fal', 'generic', 'huggingface', 'replicate', 'stability']);
});

test('providerAdapter: un provider sans cle API reste NON configure (jamais un faux etat connecte)', () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'fal';
  try {
    assert.equal(providerAdapter.configured(), false);
    const st = providerAdapter.status();
    assert.equal(st.cle_detectee, false);
    assert.match(st.raison, /FAL_API_KEY/);
  } finally {
    delete process.env.IMAGE_IMG2IMG_PROVIDER;
  }
});

test('providerAdapter: un provider configure expose ses capacites reelles (sans exposer la cle)', () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'generic';
  process.env.IMAGE_IMG2IMG_ENDPOINT = 'https://exemple.test/img2img';
  process.env.IMAGE_IMG2IMG_API_KEY = 'cle-de-test-non-secrete';
  try {
    assert.equal(providerAdapter.configured(), true);
    const st = providerAdapter.status();
    assert.equal(st.configure, true);
    assert.equal(st.capabilities.multi_reference, true);
    assert.equal(JSON.stringify(st).includes('cle-de-test-non-secrete'), false, 'la cle ne doit jamais apparaitre dans un etat expose');
  } finally {
    delete process.env.IMAGE_IMG2IMG_PROVIDER;
    delete process.env.IMAGE_IMG2IMG_ENDPOINT;
    delete process.env.IMAGE_IMG2IMG_API_KEY;
  }
});

test('characterReferenceProvider: non applicable (jamais un succes) si aucun provider image-to-image n est configure', async () => {
  await assert.rejects(
    () => characterReferenceProvider.generate({ scene: { personnage: 'Samuel', description: 'bureau' }, width: 200, height: 300 }),
    (err) => err.notApplicable === true && /provider image-to-image non configure/.test(err.message),
  );
});

test('characterReferenceProvider: REFUSE un personnage non officiel (aucun personnage generique fabrique)', async () => {
  await assert.rejects(
    () => characterReferenceProvider.generate({ scene: { personnage: 'Kevin le stagiaire' }, width: 200, height: 300 }),
    (err) => err.notApplicable === true && /pas un personnage officiel/.test(err.message),
  );
});

test('characterReferenceProvider: le prompt d identite impose la REFERENCE officielle (jamais "un africain dans un bureau")', () => {
  const character = registry.getCharacter('samuel');
  const prompt = characterReferenceProvider.buildIdentityPrompt({ personnage: 'Samuel', description: 'assise dans un bureau' }, character);
  assert.match(prompt, /PERSONNAGE OFFICIEL "Samuel"/);
  assert.match(prompt, /character_id: samuel/);
  assert.match(prompt, /images de reference fournies/);
  assert.match(prompt, /Ne pas substituer un autre visage/);
  assert.match(prompt, /assise dans un bureau/);
  assert.ok(!/africain dans un bureau/i.test(prompt));
});

test('characterReferenceProvider: strategie declarable sans provider (repli officiel explicite)', () => {
  const strategy = characterReferenceProvider.strategyFor({ personnage: 'Marc' });
  assert.equal(strategy.character_id, 'marc');
  assert.equal(strategy.strategy, 'CHARACTER_REFERENCE');
  assert.equal(characterReferenceProvider.isEnabled(), false);
});

test('imageProviders: sans provider image-to-image, un portrait officiel ne devient jamais un plan final par fallback', () => {
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Samuel' }), ['pollinations', 'graphic_engine']);
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Marc' }), ['pollinations', 'graphic_engine']);
  assert.deepEqual(imageProviders.buildProviderOrder({ logo_requis: true }), ['existing_asset']);
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'aucun' }), ['pollinations', 'graphic_engine']);
});

test('imageProviders: avec un provider image-to-image configure, la reference conditionne une image neuve sans portrait de secours', () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'fal';
  process.env.FAL_API_KEY = 'cle-de-test-non-secrete';
  try {
    assert.equal(characterReferenceProvider.isEnabled(), true);
    assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Samuel' }), ['character_reference', 'pollinations', 'graphic_engine']);
    // Le logo officiel n'est JAMAIS regenere par IA, meme provider configure.
    assert.deepEqual(imageProviders.buildProviderOrder({ logo_requis: true }), ['existing_asset']);
    const st = imageProviders.referenceProviderStatus();
    assert.equal(st.configure, true);
  } finally {
    delete process.env.IMAGE_IMG2IMG_PROVIDER;
    delete process.env.FAL_API_KEY;
  }
});

test('characterReferenceProvider: une generation reelle est tente puis echoue proprement hors ligne (jamais de buffer fabrique)', async () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'generic';
  process.env.IMAGE_IMG2IMG_ENDPOINT = 'https://exemple.invalide.test/img2img';
  process.env.IMAGE_IMG2IMG_API_KEY = 'cle-de-test-non-secrete';
  process.env.CHARACTER_REFERENCE_MAX_ATTEMPTS = '1';
  try {
    await assert.rejects(
      () => characterReferenceProvider.generate({ scene: { personnage: 'Samuel', description: 'bureau' }, width: 120, height: 200 }),
      (err) => /echouee|HTTP|fetch|ENOTFOUND|abort/i.test(err.message) || Array.isArray(err.attempts),
    );
  } finally {
    delete process.env.IMAGE_IMG2IMG_PROVIDER;
    delete process.env.IMAGE_IMG2IMG_ENDPOINT;
    delete process.env.IMAGE_IMG2IMG_API_KEY;
    delete process.env.CHARACTER_REFERENCE_MAX_ATTEMPTS;
  }
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
