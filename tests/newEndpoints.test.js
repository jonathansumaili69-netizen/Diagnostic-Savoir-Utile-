'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join('/tmp', `conquistador-endpoints-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.CONQUISTADOR_DATA_DIR = dataDir;
process.env.CONQUISTADOR_API_KEY = 'endpoint-test-key';
process.env.REQUIRE_WEBHOOK_SIGNATURE = 'true';
process.env.MAX_HTTP_BODY_BYTES = '1048576';
process.env.ALLOWED_ORIGIN = 'http://localhost:8890';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.VOICE_STUDIO_API_URL;

const settings = require('../netlify/functions/settings');
const knowledge = require('../netlify/functions/knowledge');
const voiceHealth = require('../netlify/functions/voice-health');
const voiceGenerate = require('../netlify/functions/voice-generate');
const tiktokPublishStatus = require('../netlify/functions/tiktok-publish-status');

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { origin: 'http://localhost:8890' },
    body: null,
    queryStringParameters: {},
    ...overrides,
  };
}

function body(response) {
  return JSON.parse(response.body || '{}');
}

const authHeaders = { origin: 'http://localhost:8890', 'x-conquistador-key': 'endpoint-test-key' };


test('settings GET reste non sensible et settings PUT exige la clé', async () => {
  const publicResponse = await settings.handler(event());
  assert.equal(publicResponse.statusCode, 200);
  assert.equal(JSON.stringify(body(publicResponse)).includes('endpoint-test-key'), false);
  assert.equal(JSON.stringify(body(publicResponse)).includes('service_role'), false);

  const refused = await settings.handler(event({ httpMethod: 'PUT', body: JSON.stringify({ mode: 'copilot' }) }));
  assert.equal(refused.statusCode, 401);

  const saved = await settings.handler(event({ httpMethod: 'PUT', headers: authHeaders, body: JSON.stringify({ mode: 'copilot' }) }));
  assert.equal(saved.statusCode, 200);
  assert.equal(body(saved).settings.mode, 'copilot');
});

test('knowledge GET et POST exigent la clé et ne renvoient pas de secrets', async () => {
  const refused = await knowledge.handler(event());
  assert.equal(refused.statusCode, 401);

  const created = await knowledge.handler(event({
    httpMethod: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ title: 'Référence de test', content: 'Fait fourni par le test', source_url: 'https://example.test/source', asset_type: 'image', official: true }),
  }));
  assert.equal(created.statusCode, 201);
  const createdBody = body(created);
  assert.equal(createdBody.reference.data.kind, 'knowledge_asset');
  assert.equal(createdBody.reference.data.asset_type, 'image');
  assert.equal(createdBody.reference.data.official, true);
  assert.equal(JSON.stringify(createdBody).includes('endpoint-test-key'), false);
  assert.equal(JSON.stringify(createdBody).includes('service_role'), false);

  const listed = await knowledge.handler(event({ headers: authHeaders }));
  assert.equal(listed.statusCode, 200);
  assert.equal(listedBodyHas(listed, 'Référence de test'), true);
});

function listedBodyHas(response, title) {
  return body(response).references.some((row) => row.data && row.data.title === title);
}

test('voice-health exige la clé et signale honnêtement le studio non configuré', async () => {
  const refused = await voiceHealth.handler(event());
  assert.equal(refused.statusCode, 401);

  const response = await voiceHealth.handler(event({ headers: authHeaders }));
  assert.equal(response.statusCode, 200);
  const output = body(response);
  assert.equal(output.voix.configured, false);
  assert.equal(output.voix.available, false);
  assert.equal(JSON.stringify(output).includes('endpoint-test-key'), false);
  assert.equal(JSON.stringify(output).includes('service_role'), false);
});

test('tiktok-publish-status protège la correspondance publish_id et ne fabrique pas un statut', async () => {
  const refused = await tiktokPublishStatus.handler(event({ queryStringParameters: { publication_id: 'publish-unknown' } }));
  assert.equal(refused.statusCode, 401);

  const missing = await tiktokPublishStatus.handler(event({ headers: authHeaders }));
  assert.equal(missing.statusCode, 400);

  const unknown = await tiktokPublishStatus.handler(event({ headers: authHeaders, queryStringParameters: { publication_id: 'publish-unknown' } }));
  assert.equal(unknown.statusCode, 404);
  assert.equal(JSON.stringify(body(unknown)).includes('endpoint-test-key'), false);
  assert.equal(JSON.stringify(body(unknown)).includes('service_role'), false);
});

test('voice-generate exige la clé puis refuse sans URL de studio', async () => {
  const refused = await voiceGenerate.handler(event({ httpMethod: 'POST', body: JSON.stringify({ text: 'Bonjour' }) }));
  assert.equal(refused.statusCode, 401);

  const unavailable = await voiceGenerate.handler(event({
    httpMethod: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ text: 'Bonjour' }),
  }));
  assert.equal(unavailable.statusCode, 500);
  assert.equal(JSON.stringify(body(unavailable)).includes('endpoint-test-key'), false);
});
