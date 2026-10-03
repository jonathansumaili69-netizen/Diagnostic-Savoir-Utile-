'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWorkerPreflight } = require('../scripts/worker-preflight');

function run(env) {
  const messages = [];
  const logger = Object.fromEntries(['log', 'warn', 'error'].map((level) => [
    level,
    (message) => messages.push({ level, message: String(message) }),
  ]));
  const exitCode = runWorkerPreflight({ env, logger });
  return { exitCode, messages, text: messages.map((item) => item.message).join('\n') };
}

test('worker preflight: bloque le traitement réel et ne nomme que les secrets Supabase absents', () => {
  const secretSentinel = 'do-not-log-this-service-key';
  const result = run({
    SUPABASE_SERVICE_KEY: secretSentinel,
    IMAGE_IMG2IMG_PROVIDER: 'huggingface',
    HF_TOKEN: 'do-not-log-this-hf-token',
    VOICE_STUDIO_API_URL: 'https://voice.example.test',
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.text, /Missing required GitHub Actions secret: SUPABASE_URL/);
  assert.doesNotMatch(result.text, /SUPABASE_SERVICE_KEY/);
  assert.doesNotMatch(result.text, /do-not-log-this/);
});

test('worker preflight: les secrets IA, HF et Voice Studio restent optionnels pour la file de jobs', () => {
  const result = run({
    SUPABASE_URL: 'https://project.example.test',
    SUPABASE_SERVICE_KEY: 'test-service-key',
    IMAGE_IMG2IMG_PROVIDER: 'huggingface',
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /HF_TOKEN/);
  assert.match(result.text, /VOICE_STUDIO_API_URL/);
  assert.doesNotMatch(result.text, /test-service-key/);
});

test('worker preflight: validate_only accepte l’absence de Supabase sans lancer le Worker', () => {
  const result = run({ WORKER_VALIDATE_ONLY: 'true' });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /SUPABASE_URL/);
  assert.match(result.text, /SUPABASE_SERVICE_KEY/);
  assert.match(result.text, /Validation-only mode/);
});

test('worker preflight: refuse une URL Supabase non HTTPS sans afficher sa valeur', () => {
  const unsafeUrl = 'http://private-host-with-sensitive-path.example.test';
  const result = run({
    SUPABASE_URL: unsafeUrl,
    SUPABASE_SERVICE_KEY: 'test-service-key',
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.text, /SUPABASE_URL/);
  assert.doesNotMatch(result.text, /private-host-with-sensitive-path/);
  assert.doesNotMatch(result.text, /test-service-key/);
});
