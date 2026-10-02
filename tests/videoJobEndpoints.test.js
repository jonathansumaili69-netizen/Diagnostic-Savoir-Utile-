'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-videoendpoints-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.CONQUISTADOR_API_KEY;

const videoJobsFn = require('../netlify/functions/video-jobs');
const videoJobGetFn = require('../netlify/functions/video-job-get');
const videoJobProcessFn = require('../netlify/functions/video-job-process');

function event({ method = 'GET', body, query = {} } = {}) {
  return { httpMethod: method, headers: {}, body: body ? JSON.stringify(body) : undefined, queryStringParameters: query };
}

function parsed(response) { return JSON.parse(response.body || '{}'); }

function sampleManifest() {
  return {
    scenes: [{ id: 's1', description: 'test', personnage: 'aucun', style: 'realiste', prompt_final: 'graphic test', logo_requis: false }],
    timeline: [{ scene_id: 's1', start_seconds: 0, end_seconds: 1 }],
  };
}

test('POST /api/video/jobs: cree un job reel et le fait avancer (run_synchronously par defaut)', async () => {
  const response = await videoJobsFn.handler(event({
    method: 'POST',
    body: { manifest: sampleManifest(), format: { width: 320, height: 568 }, idempotency_key: 'endpoint-test-1' },
  }));
  assert.equal(response.statusCode, 201);
  const data = parsed(response);
  assert.equal(data.created, true);
  assert.ok(data.job.id);
  // Sans stockage configure, le job echoue honnetement a la toute derniere
  // etape (voir videoOrchestrator.stepFinalize) — mais toutes les etapes
  // intermediaires doivent avoir reellement tourne.
  assert.ok(['FAILED', 'COMPLETED'].includes(data.job.status));
  assert.ok(data.job.assets);
  assert.ok(data.job.render);
});

test('POST /api/video/jobs: sans sujet ni manifest -> 400 explicite', async () => {
  const response = await videoJobsFn.handler(event({ method: 'POST', body: {} }));
  assert.equal(response.statusCode, 400);
});

test('GET /api/video/jobs: liste les jobs crees', async () => {
  await videoJobsFn.handler(event({ method: 'POST', body: { manifest: sampleManifest(), format: { width: 320, height: 568 }, idempotency_key: 'endpoint-test-list' } }));
  const response = await videoJobsFn.handler(event({ method: 'GET' }));
  assert.equal(response.statusCode, 200);
  const data = parsed(response);
  assert.ok(data.total >= 1);
  assert.ok(Array.isArray(data.jobs));
});

test('GET /api/video/jobs/:id: recupere un job precis, 404 si inconnu', async () => {
  const created = await videoJobsFn.handler(event({ method: 'POST', body: { manifest: sampleManifest(), format: { width: 320, height: 568 }, idempotency_key: 'endpoint-test-get' } }));
  const jobId = parsed(created).job.id;
  const found = await videoJobGetFn.handler(event({ query: { id: jobId } }));
  assert.equal(found.statusCode, 200);
  assert.equal(parsed(found).job.id, jobId);

  const notFound = await videoJobGetFn.handler(event({ query: { id: 'does-not-exist' } }));
  assert.equal(notFound.statusCode, 404);
});

test('POST /api/video/jobs/:id/process: sur un job deja termine, ne relance rien (avance=false)', async () => {
  const created = await videoJobsFn.handler(event({ method: 'POST', body: { manifest: sampleManifest(), format: { width: 320, height: 568 }, idempotency_key: 'endpoint-test-process' } }));
  const jobId = parsed(created).job.id;
  const processed = await videoJobProcessFn.handler(event({ method: 'POST', query: { id: jobId } }));
  assert.equal(processed.statusCode, 200);
  assert.equal(parsed(processed).avance, false);
});

test('POST /api/video/jobs/:id/process: 404 sur un id inconnu', async () => {
  const response = await videoJobProcessFn.handler(event({ method: 'POST', query: { id: 'nope' } }));
  assert.equal(response.statusCode, 404);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
