'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const imageProviders = require('../src/core/imageProviders');
const existingAssetProvider = require('../src/core/imageProviders/existingAssetProvider');
const graphicProvider = require('../src/core/imageProviders/graphicProvider');

test('imageProviders.buildProviderOrder: privilegie existing_asset pour Samuel/Marc/logo', () => {
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Samuel' }), ['existing_asset', 'graphic_engine']);
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Marc' }), ['existing_asset', 'graphic_engine']);
  assert.deepEqual(imageProviders.buildProviderOrder({ logo_requis: true }), ['existing_asset', 'graphic_engine']);
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

test('imageProviders.generateAsset: chaine de repli complete — reussit toujours meme sans reseau', async () => {
  // Scene Samuel : existing_asset doit reussir directement (pas besoin de reseau).
  const forSamuel = await imageProviders.generateAsset({ scene: { personnage: 'Samuel' }, width: 200, height: 300 });
  assert.equal(forSamuel.asset_type, 'EXISTING_ASSET');
  assert.equal(forSamuel.provider_attempts[0].provider, 'existing_asset');
  assert.equal(forSamuel.provider_attempts[0].ok, true);

  // Scene generique : selon la disponibilite reseau de l'environnement
  // d'execution, pollinations peut reussir (AI_IMAGE) ou echouer — dans ce
  // dernier cas (pas de reseau, comme dans ce bac a sable), le repli reel
  // et fonctionnel sur graphic_engine garantit malgre tout un asset valide,
  // jamais un succes fictif.
  const generic = await imageProviders.generateAsset({ scene: { description: 'Astuce carriere' }, width: 200, height: 300 });
  assert.ok(['AI_IMAGE', 'GENERATED_GRAPHIC'].includes(generic.asset_type));
  assert.ok(Buffer.isBuffer(generic.buffer) && generic.buffer.length > 0);
  const successfulAttempt = generic.provider_attempts.find((a) => a.ok === true);
  assert.ok(successfulAttempt, 'au moins une tentative doit reussir');
  assert.equal(successfulAttempt.provider, generic.provider);
});
