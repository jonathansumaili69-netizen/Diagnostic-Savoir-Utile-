'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.VOICE_STUDIO_API_URL = 'https://voice.example.test';
process.env.VOICE_STUDIO_TIMEOUT_MS = '1000';
process.env.CONQUISTADOR_API_KEY = 'test-voice-key';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const voiceStudio = require('../src/core/voiceStudio');
const { config } = require('../src/core/config');

test('voiceStudio.synthesize: refuse une URL de studio non HTTPS', async () => {
  const previous = config.brand.voiceApiUrl;
  config.brand.voiceApiUrl = 'http://voice.example.test';
  await assert.rejects(() => voiceStudio.synthesize({ text: 'Bonjour' }), /doit utiliser HTTPS/);
  config.brand.voiceApiUrl = previous;
});

test('voiceStudio.synthesize: envoie le contrat Rémy Neural et retourne l’audio', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(Buffer.from('mp3-test'), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };
  try {
    const result = await voiceStudio.synthesize({ text: 'Texte de test', rate: '+10%' });
    assert.equal(request.url, 'https://voice.example.test/generate');
    const body = JSON.parse(request.options.body);
    assert.equal(body.edge_voice, 'fr-FR-RemyMultilingualNeural');
    assert.equal(body.rate, '+10%');
    assert.equal(body.text, 'Texte de test');
    assert.equal(result.contentType, 'audio/mpeg');
    assert.equal(result.buffer.toString(), 'mp3-test');
  } finally {
    global.fetch = originalFetch;
  }
});

test('voiceStudio.health: indisponibilité distante reste honnêtement signalée', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ neural: false }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await voiceStudio.health();
    assert.equal(request.url, 'https://voice.example.test/health');
    assert.equal(request.options.method, 'POST');
    assert.equal(result.configured, true);
    assert.equal(result.available, false);
    assert.match(result.reason, /aucun moteur disponible/);
  } finally {
    global.fetch = originalFetch;
  }
});
