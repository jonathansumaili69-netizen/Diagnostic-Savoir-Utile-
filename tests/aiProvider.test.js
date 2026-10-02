'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Sans cles configurees, le systeme doit basculer automatiquement sur le mode
// MOCK et ne jamais tenter un appel reseau reel (important dans cet
// environnement de test sans acces internet).
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

const aiProvider = require('../src/core/aiProvider');

test('generate() bascule sur le mode mock sans cles configurees', async () => {
  const result = await aiProvider.generate({ prompt: 'Dis bonjour' });
  assert.equal(result.provider, 'mock');
  assert.ok(result.text.includes('MODE MOCK'));
});

test('generate() rejette un prompt manquant', async () => {
  await assert.rejects(() => aiProvider.generate({}), /prompt/);
});

test('callMock ne leve jamais d\'erreur et reste deterministe dans sa structure', async () => {
  const result = await aiProvider.callMock({ prompt: 'test', system: 'contexte' });
  assert.equal(result.provider, 'mock');
  assert.equal(result.model, 'mock-v1');
  assert.ok(typeof result.text === 'string' && result.text.length > 0);
});

test('callGroq echoue proprement si GROQ_API_KEY est absente', async () => {
  await assert.rejects(() => aiProvider.callGroq({ prompt: 'test' }), /GROQ_API_KEY/);
});

test('callGemini echoue proprement si GEMINI_API_KEY est absente', async () => {
  await assert.rejects(() => aiProvider.callGemini({ prompt: 'test' }), /GEMINI_API_KEY/);
});
