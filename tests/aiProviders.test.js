'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.GROQ_ALLOW_PAID;

const aiProviders = require('../src/core/aiProviders');
const aiProvider = require('../src/core/aiProvider');
const { config } = require('../src/core/config');

test('PROVIDER_DEFINITIONS: chaque fournisseur a des scores justifies (1-5) sur toutes les dimensions requises', () => {
  const requiredDimensions = ['raisonnement', 'vitesse', 'fiabilite', 'contexte', 'quota_gratuit', 'disponibilite'];
  for (const def of aiProviders.PROVIDER_DEFINITIONS) {
    for (const dim of requiredDimensions) {
      assert.ok(
        typeof def.scores[dim] === 'number' && def.scores[dim] >= 1 && def.scores[dim] <= 5,
        `${def.id}.${dim} doit etre un score entre 1 et 5`
      );
    }
    assert.ok(typeof def.justification === 'string' && def.justification.length > 20, `${def.id} doit avoir une justification`);
  }
});

test('chainForProfile: ordre par defaut correspond a Gemini -> Groq -> OpenRouter -> Mock', () => {
  assert.deepEqual(aiProviders.chainForProfile(), ['gemini', 'groq', 'openrouter', 'mock']);
  assert.deepEqual(aiProviders.chainForProfile('default'), ['gemini', 'groq', 'openrouter', 'mock']);
});

test('chainForProfile: le profil "fast" priorise Groq (vitesse)', () => {
  const chain = aiProviders.chainForProfile('fast');
  assert.equal(chain[0], 'groq');
  assert.equal(chain[chain.length - 1], 'mock');
});

test('chainForProfile: mock est toujours en dernier, quel que soit le profil', () => {
  for (const profile of ['reasoning', 'fast', 'long_context', 'simple', 'default', 'profil_inconnu']) {
    const chain = aiProviders.chainForProfile(profile);
    assert.equal(chain[chain.length - 1], 'mock');
  }
});

test('chainForProfile: un profil inconnu retombe sur la chaine par defaut', () => {
  assert.deepEqual(aiProviders.chainForProfile('profil_qui_n_existe_pas'), aiProviders.chainForProfile('default'));
});

test('chainForProfile: strict_video exclut Groq payant et conserve Mock en dernier recours', () => {
  assert.deepEqual(aiProviders.chainForProfile('strict_video'), ['gemini', 'openrouter', 'mock']);
});

test('isConfigured: mock est toujours considere configure (aucune cle requise)', () => {
  assert.equal(aiProviders.isConfigured('mock'), true);
});

test('isConfigured: gemini/groq/openrouter ne sont pas configures sans cle', () => {
  assert.equal(aiProviders.isConfigured('gemini'), false);
  assert.equal(aiProviders.isConfigured('groq'), false);
  assert.equal(aiProviders.isConfigured('openrouter'), false);
});

test('recordAttempt + getRegistrySnapshot: un succes met le statut a "ok" et incremente les compteurs', () => {
  aiProviders.recordAttempt('mock', { success: true });
  const snap = aiProviders.getRegistrySnapshot().find((p) => p.id === 'mock');
  assert.equal(snap.statut, 'ok');
  assert.ok(snap.appels_total >= 1);
  assert.equal(snap.derniere_erreur, null);
});

test('recordAttempt + getRegistrySnapshot: un echec met le statut a "erreur" et conserve le message', () => {
  aiProviders.recordAttempt('groq', { success: false, error: 'panne simulee de test' });
  const snap = aiProviders.getRegistrySnapshot().find((p) => p.id === 'groq');
  assert.equal(snap.statut, 'erreur');
  assert.equal(snap.derniere_erreur.message, 'panne simulee de test');
});

test('generate(): sans aucune cle, la cascade a 3 fournisseurs reels echoue puis mock reussit', async () => {
  const result = await aiProvider.generate({ prompt: 'test cascade complete' });
  assert.equal(result.provider, 'mock');
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.attempts.map((a) => a.provider), ['gemini', 'groq', 'openrouter']);
});

test('generate(): respecte un profil de routage explicite dans la cascade tentee', async () => {
  const result = await aiProvider.generate({ prompt: 'test profil fast', profile: 'fast' });
  assert.equal(result.profile, 'fast');
  assert.deepEqual(result.attempts.map((a) => a.provider), ['groq', 'gemini', 'openrouter']);
});

test('generate(): saute Groq payant avec une clé présente mais sans opt-in explicite', async () => {
  const previousKey = config.ai.groqApiKey;
  const previousAllowPaid = config.ai.groqAllowPaid;
  config.ai.groqApiKey = 'test-placeholder-ne-pas-appeler';
  config.ai.groqAllowPaid = false;
  try {
    const result = await aiProvider.generate({ prompt: 'test opt-in facturation', profile: 'default' });
    assert.equal(result.provider, 'mock');
    const skipped = result.attempts.find((attempt) => attempt.provider === 'groq');
    assert.equal(skipped.errorType, 'payant_desactive');
    assert.match(skipped.error, /GROQ_ALLOW_PAID=false/);
    assert.equal(aiProviders.isConfigured('groq'), false);
  } finally {
    config.ai.groqApiKey = previousKey;
    config.ai.groqAllowPaid = previousAllowPaid;
  }
});

test('callOpenRouter: echoue proprement si OPENROUTER_API_KEY est absente', async () => {
  await assert.rejects(() => aiProvider.callOpenRouter({ prompt: 'test' }), /OPENROUTER_API_KEY/);
});

test('le fournisseur reellement utilise est toujours identifiable (jamais ambigu)', async () => {
  const result = await aiProvider.generate({ prompt: 'test identification' });
  assert.ok(['gemini', 'groq', 'openrouter', 'mock'].includes(result.provider));
});
