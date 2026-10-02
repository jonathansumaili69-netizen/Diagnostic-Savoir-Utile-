'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CONQUISTADOR_API_KEY = 'cle-de-test-1234';

const {
  requireString,
  optionalString,
  requireOneOf,
  parseJsonBody,
  assertApiKey,
  checkRateLimit,
  ValidationError,
} = require('../src/core/validation');

test('requireString rejette une valeur vide', () => {
  assert.throws(() => requireString('  ', 'champ'), ValidationError);
});

test('requireString accepte et nettoie une chaine valide', () => {
  assert.equal(requireString('  bonjour  ', 'champ'), 'bonjour');
});

test('requireString rejette un depassement de longueur', () => {
  assert.throws(() => requireString('a'.repeat(10), 'champ', { maxLength: 5 }), ValidationError);
});

test('optionalString renvoie undefined si absent', () => {
  assert.equal(optionalString(undefined, 'champ'), undefined);
  assert.equal(optionalString('', 'champ'), undefined);
});

test('requireOneOf rejette une valeur hors liste', () => {
  assert.throws(() => requireOneOf('violet', 'couleur', ['rouge', 'vert']), ValidationError);
});

test('parseJsonBody rejette un JSON invalide', () => {
  assert.throws(() => parseJsonBody('{invalide'), ValidationError);
});

test('parseJsonBody renvoie un objet vide si le corps est absent', () => {
  assert.deepEqual(parseJsonBody(undefined), {});
});

test('assertApiKey rejette une cle incorrecte', () => {
  assert.throws(() => assertApiKey({ 'x-conquistador-key': 'mauvaise-cle' }));
});

test('assertApiKey accepte la bonne cle', () => {
  const result = assertApiKey({ 'x-conquistador-key': 'cle-de-test-1234' });
  assert.equal(result.ok, true);
});

test('checkRateLimit leve une erreur au dela de la limite', () => {
  const id = 'test-rate-limit-' + Date.now();
  for (let i = 0; i < 30; i += 1) {
    checkRateLimit(id);
  }
  assert.throws(() => checkRateLimit(id));
});
