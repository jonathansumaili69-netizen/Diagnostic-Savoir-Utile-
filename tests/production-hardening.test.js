'use strict';

const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, { concurrency: false }, fn);
test.after = nodeTest.after.bind(nodeTest);
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-production-hardening-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
process.env.CONQUISTADOR_API_KEY = 'production-test-key';
process.env.CONQUISTADOR_WEBHOOK_SECRET = 'webhook-test-secret';
delete process.env.NETLIFY;
delete process.env.CONTEXT;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.REQUIRE_WEBHOOK_SIGNATURE;

const { config } = require('../src/core/config');
const validation = require('../src/core/validation');
const { json, wrapHandler, SAME_ORIGIN_MODE } = require('../src/utils/http');
const memory = require('../src/core/memory');
const idempotency = require('../src/core/idempotency');
const approval = require('../src/core/approval');
const taskEngine = require('../src/core/taskEngine');
const taskRunHandler = require('../netlify/functions/task-run').handler;

function resetData() {
  for (const file of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, file), { force: true });
}

test('assertApiKey refuse en production si la clé serveur est absente', () => {
  const savedKey = config.apiKey;
  const savedProduction = config.isProduction;
  config.apiKey = '';
  config.isProduction = true;
  assert.throws(
    () => validation.assertApiKey({}),
    (error) => error.statusCode === 503 && error.message.includes('CONQUISTADOR_API_KEY')
  );
  config.apiKey = savedKey;
  config.isProduction = savedProduction;
});

test('parseJsonBody rejette un corps trop grand avec HTTP 413', () => {
  assert.throws(
    () => validation.parseJsonBody('x'.repeat(101), { maxBytes: 100 }),
    (error) => error.statusCode === 413
  );
});

test('assertWebhookSignature accepte HMAC valide et rejette la signature falsifiée', () => {
  const body = JSON.stringify({ event: 'sale', amount: 10 });
  const signature = crypto.createHmac('sha256', 'webhook-test-secret').update(body).digest('hex');
  assert.equal(validation.assertWebhookSignature({ 'x-conquistador-signature': `sha256=${signature}` }, body).ok, true);
  assert.throws(
    () => validation.assertWebhookSignature({ 'x-conquistador-signature': `sha256=${'0'.repeat(64)}` }, body),
    (error) => error.statusCode === 401
  );
});

test('wrap HTTP ajoute les en-têtes de sécurité attendus', () => {
  const response = json(200, { ok: true });
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.headers['X-Frame-Options'], 'DENY');
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('CORS temporaire strict puis origine exacte : autorise la bonne origine et refuse les autres', async () => {
  const previousOrigin = config.http.allowedOrigin;
  const previousProduction = config.isProduction;
  const handler = wrapHandler(async () => json(200, { ok: true }));
  try {
    config.isProduction = false;
    config.http.allowedOrigin = SAME_ORIGIN_MODE;
    const sameOrigin = await handler({
      httpMethod: 'GET',
      headers: { Origin: 'http://localhost:8888', Host: 'localhost:8888' },
    });
    assert.equal(sameOrigin.statusCode, 200);
    assert.equal(sameOrigin.headers['Access-Control-Allow-Origin'], undefined);
    const foreignOrigin = await handler({
      httpMethod: 'GET',
      headers: { Origin: 'https://evil.example', Host: 'localhost:8888' },
    });
    assert.equal(foreignOrigin.statusCode, 403);

    config.http.allowedOrigin = 'https://conquistador-os.netlify.app';
    const exactOrigin = await handler({
      httpMethod: 'GET',
      headers: { Origin: 'https://conquistador-os.netlify.app', Host: 'localhost:8888' },
    });
    assert.equal(exactOrigin.statusCode, 200);
    assert.equal(exactOrigin.headers['Access-Control-Allow-Origin'], 'https://conquistador-os.netlify.app');
    const wrongOrigin = await handler({
      httpMethod: 'GET',
      headers: { Origin: 'https://other.example', Host: 'localhost:8888' },
    });
    assert.equal(wrongOrigin.statusCode, 403);
  } finally {
    config.http.allowedOrigin = previousOrigin;
    config.isProduction = previousProduction;
  }
});

test('endpoint task-run rejette un JSON invalide via le parseur partagé', async () => {
  const response = await taskRunHandler({
    httpMethod: 'POST',
    headers: { 'x-conquistador-key': 'production-test-key' },
    body: '{invalid',
  });
  assert.equal(response.statusCode, 400);
});

test('idempotence locale concurrente : une seule requête revendique la clé', async () => {
  resetData();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => idempotency.checkAndMark('test.concurrent', 'same-key'))
  );
  assert.equal(results.filter((result) => result.doublon === false).length, 1);
  assert.equal(results.filter((result) => result.doublon === true).length, 11);
});

test('verrou de tâche : deux runTask simultanés ne créent qu’un journal de succès', async () => {
  resetData();
  const task = await taskEngine.createTask({ type: 'quality.review', input: { content: {} } });
  const results = await Promise.all([taskEngine.runTask(task.id), taskEngine.runTask(task.id)]);
  assert.equal(results[0].data.status, 'done');
  assert.equal(results[1].data.status, 'done');
  const executions = await memory.list(memory.COLLECTIONS.EXECUTIONS);
  assert.equal(executions.filter((row) => row.data.workflow === 'quality.review').length, 1);
});

test('double approbation concurrente : une seule transition pending gagne', async () => {
  resetData();
  const record = await approval.requestApproval({
    actionType: 'SEND_MESSAGE',
    taskId: 'task-double-approval',
    agent: 'system',
    summary: 'test',
    payload: {},
  });
  const results = await Promise.all([
    approval.decide(record.id, { approve: true, decidedBy: 'a' }),
    approval.decide(record.id, { approve: false, decidedBy: 'b' }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const final = await memory.get(memory.COLLECTIONS.APPROVALS, record.id);
  assert.ok(['approved', 'rejected'].includes(final.data.status));
});

test('approbation expirée : resumeAfterApproval refuse toute exécution', async () => {
  resetData();
  const task = await taskEngine.createTask({
    type: 'system.send_message',
    input: { canal: 'whatsapp', destinataire: 'x', message: 'test' },
  });
  const waiting = await taskEngine.runTask(task.id);
  const record = await memory.update(memory.COLLECTIONS.APPROVALS, waiting.data.approvalId, {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const expired = await approval.decide(record.id, { approve: true, decidedBy: 'test' });
  assert.equal(expired.data.status, 'expired');
  await assert.rejects(
    () => taskEngine.resumeAfterApproval(task.id, record.id),
    (error) => error.statusCode === 409
  );
  const unchanged = await taskEngine.getTask(task.id);
  assert.equal(unchanged.data.status, 'waiting_approval');
});

test('kill switch bloque les actions externes mais laisse les analyses', async () => {
  resetData();
  const killswitch = require('../src/core/killswitch');
  await killswitch.setStatus({ engage: true, raison: 'test', changePar: 'test' });
  const external = await taskEngine.createTask({ type: 'system.send_message', input: { canal: 'x', message: 'test' } });
  const waiting = await taskEngine.runTask(external.id);
  const approvalRecord = await memory.get(memory.COLLECTIONS.APPROVALS, waiting.data.approvalId);
  await approval.decide(approvalRecord.id, { approve: true, decidedBy: 'test' });
  const blocked = await taskEngine.resumeAfterApproval(external.id, approvalRecord.id);
  assert.equal(blocked.data.status, 'blocked');
  const analysis = await taskEngine.createTask({ type: 'quality.review', input: { content: {} } });
  const completed = await taskEngine.runTask(analysis.id);
  assert.equal(completed.data.status, 'done');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
