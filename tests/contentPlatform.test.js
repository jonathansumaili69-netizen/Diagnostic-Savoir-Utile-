'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const contenu = require('../src/agents/contenu');
const agents = require('../src/agents');

test('content.adapt_platforms: prépare des variantes distinctes sans appel externe', () => {
  const result = contenu.adaptPlatformContent({
    title: 'Conseil CV',
    description: 'Un conseil réel pour structurer sa candidature.',
    cta: 'Découvre la suite dans le profil.',
    hashtags: ['#emploi', '#CV', '#Afrique'],
  });
  assert.equal(result.statut, 'PACK_MULTIPLATEFORME_PREPARE');
  assert.equal(result.publication_autorisee, false);
  assert.deepEqual(result.plateformes.map((item) => item.plateforme), ['tiktok', 'instagram', 'facebook', 'youtube']);
  assert.ok(result.plateformes.every((item) => item.statut === 'PREPARE_NON_PUBLIE'));
  assert.ok(result.plateformes.every((item) => item.format_recommande === 'vertical_9_16'));
  assert.equal(result.plateformes.find((item) => item.plateforme === 'tiktok').cta_adapte, 'Découvre la suite dans le profil TikTok.');
  assert.equal(result.plateformes.find((item) => item.plateforme === 'instagram').cta_adapte, 'Découvre la suite dans la bio Instagram.');
});

test('content.adapt_platforms: est enregistré et disponible dans le registre', () => {
  assert.ok(agents.listTaskTypes().includes('content.adapt_platforms'));
  const resolved = agents.resolve('content.adapt_platforms');
  assert.equal(resolved.actionType, 'PREPARE_POST');
  assert.equal(typeof resolved.module.handle, 'function');
});
