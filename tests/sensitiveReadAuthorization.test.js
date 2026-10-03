'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-read-auth-'));
process.env.CONQUISTADOR_DATA_DIR = dataDir;
process.env.CONQUISTADOR_API_KEY = 'read-auth-test-key';
process.env.NETLIFY = 'true';
process.env.CONTEXT = 'production';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

const protectedReads = [
  ['tasks list', require('../netlify/functions/tasks').handler],
  ['legacy task list', require('../netlify/functions/task-list').handler],
  ['legacy task get', require('../netlify/functions/task-get').handler],
  ['approval list', require('../netlify/functions/approval-list').handler],
  ['dashboard data', require('../netlify/functions/dashboard-data').handler],
  ['settings', require('../netlify/functions/settings').handler],
  ['connectors', require('../netlify/functions/connectors').handler],
  ['video jobs list', require('../netlify/functions/video-jobs').handler],
  ['video job get', require('../netlify/functions/video-job-get').handler],
  ['weekly objectives', require('../netlify/functions/weekly-objectives').handler],
  ['daily report', require('../netlify/functions/report-daily').handler],
  ['AI provider configuration', require('../netlify/functions/ai-providers').handler],
  ['detailed diagnostics', require('../netlify/functions/diagnostics').handler],
];

function event({ headers = {}, method = 'GET', query = {} } = {}) {
  return {
    httpMethod: method,
    headers,
    body: null,
    queryStringParameters: { id: 'missing-test-id', limit: '1', ...query },
  };
}

test('les lectures métier sensibles refusent tout appel sans x-conquistador-key en production', async () => {
  for (const [name, handler] of protectedReads) {
    const response = await handler(event());
    assert.equal(response.statusCode, 401, `${name} doit refuser une requête anonyme`);
  }
});

test('une clé invalide ne permet pas de lire les jobs vidéo', async () => {
  const handler = require('../netlify/functions/video-jobs').handler;
  const response = await handler(event({ headers: { 'x-conquistador-key': 'wrong-key' } }));
  assert.equal(response.statusCode, 401);
});

test('une clé valide conserve l’accès aux endpoints protégés et health reste public', async () => {
  const headers = { 'x-conquistador-key': process.env.CONQUISTADOR_API_KEY };
  const tasks = await require('../netlify/functions/tasks').handler(event({ headers }));
  assert.equal(tasks.statusCode, 200);
  assert.ok(Array.isArray(JSON.parse(tasks.body).taches));

  const jobs = await require('../netlify/functions/video-jobs').handler(event({ headers }));
  assert.equal(jobs.statusCode, 200);
  assert.ok(Array.isArray(JSON.parse(jobs.body).jobs));

  const health = await require('../netlify/functions/health').handler(event());
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).statut, 'operationnel');
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
