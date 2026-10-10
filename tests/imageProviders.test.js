'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const imageProviders = require('../src/core/imageProviders');
const existingAssetProvider = require('../src/core/imageProviders/existingAssetProvider');
const graphicProvider = require('../src/core/imageProviders/graphicProvider');
const realFetch = global.fetch;

test.before(() => {
  global.fetch = async () => { throw new Error('Réseau désactivé dans ce test déterministe.'); };
});

test('imageProviders.buildProviderOrder: les portraits officiels ne deviennent jamais des plans par défaut', () => {
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Samuel' }), ['pollinations', 'graphic_engine']);
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Marc' }), ['pollinations', 'graphic_engine']);
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Samuel', allow_official_reference_frame: true }), ['existing_asset']);
  assert.deepEqual(imageProviders.buildProviderOrder({ logo_requis: true }), ['existing_asset']);
  assert.deepEqual(imageProviders.buildProviderOrder({ official_asset_id: 'guide_8c_cover' }), ['existing_asset']);
});

test('imageProviders.buildProviderOrder: tente une image IA d abord pour une scene generique', () => {
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'aucun' }), ['pollinations', 'graphic_engine']);
});

test('existingAssetProvider: resout un fichier bundle reel pour Samuel et le redimensionne exactement', async () => {
  const resolved = existingAssetProvider.resolveAsset({ personnage: 'Samuel' });
  assert.ok(resolved);
  assert.equal(resolved.key, 'samuel');
  const asset = await existingAssetProvider.generate({ scene: { personnage: 'Samuel' }, width: 300, height: 500 });
  assert.equal(asset.width, 300);
  assert.equal(asset.height, 500);
  assert.equal(asset.asset_type, 'EXISTING_ASSET');
  assert.ok(Buffer.isBuffer(asset.buffer) && asset.buffer.length > 0);
});

test('existingAssetProvider: la couverture du guide exige son identifiant officiel explicite', async () => {
  assert.equal(existingAssetProvider.resolveAsset({ official_asset_id: 'guide_8c_cover' }).key, 'guide_8c_cover');
  assert.equal(existingAssetProvider.resolveAsset({}), null);
  const asset = await existingAssetProvider.generate({ scene: { official_asset_id: 'guide_8c_cover' }, width: 360, height: 640 });
  assert.equal(asset.asset_type, 'OFFICIAL_PRODUCT_COVER');
  assert.equal(asset.provenance.category, 'OFFICIAL_PRODUCT_COVER');
  assert.ok(Buffer.isBuffer(asset.buffer) && asset.buffer.length > 0);
});

test('existingAssetProvider: non applicable (leve, sans crash) pour une scene sans personnage officiel ni logo', async () => {
  await assert.rejects(
    () => existingAssetProvider.generate({ scene: { personnage: 'inconnu' }, width: 100, height: 100 }),
    (err) => err.notApplicable === true
  );
});

test('graphicProvider: genere toujours un asset reel (aucune dependance reseau)', async () => {
  const asset = await graphicProvider.generate({ scene: { description: 'Un titre quelconque' }, width: 200, height: 300, mode: 'copilot' });
  assert.equal(asset.asset_type, 'GENERATED_GRAPHIC');
  assert.ok(Buffer.isBuffer(asset.buffer) && asset.buffer.length > 0);
});

test('imageProviders.generateAsset: référence personnage explicite; aucun portrait final par fallback', async () => {
  const explicitReference = await imageProviders.generateAsset({ scene: { personnage: 'Samuel', allow_official_reference_frame: true }, width: 200, height: 300 });
  assert.equal(explicitReference.asset_type, 'EXISTING_ASSET');

  // Sans opt-in, le portrait officiel ne doit pas devenir un plan final.
  const forSamuel = await imageProviders.generateAsset({ scene: { personnage: 'Samuel' }, width: 200, height: 300 });
  assert.notEqual(forSamuel.asset_type, 'EXISTING_ASSET');

  // Scene generique : reseau eventuellement indisponible, mais fallback graphique réel.
  const generic = await imageProviders.generateAsset({ scene: { description: 'Astuce carrière' }, width: 200, height: 300 });
  assert.ok(['AI_IMAGE', 'AI_IMAGE_GENERATED', 'GENERATED_GRAPHIC'].includes(generic.asset_type));
  assert.ok(Buffer.isBuffer(generic.buffer) && generic.buffer.length > 0);
  const successfulAttempt = generic.provider_attempts.find((attempt) => attempt.ok === true);
  assert.ok(successfulAttempt, 'au moins une tentative doit réussir');
  assert.equal(successfulAttempt.provider, generic.provider);
});

test.after(() => {
  global.fetch = realFetch;
});
