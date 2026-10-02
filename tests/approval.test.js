'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-approval-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.APPROVAL_POLICY_OVERRIDE;

const approval = require('../src/core/approval');
const memory = require('../src/core/memory');

test('levelFor: analyses/idees/rapports sont AUTO', () => {
  assert.equal(approval.levelFor('ANALYZE'), approval.AUTO);
  assert.equal(approval.levelFor('GENERATE_IDEA'), approval.AUTO);
  assert.equal(approval.levelFor('GENERATE_REPORT'), approval.AUTO);
  assert.equal(approval.levelFor('GENERATE'), approval.AUTO);
  assert.equal(approval.levelFor('UPDATE_MEMORY'), approval.AUTO);
});

test('levelFor: preparation de reponse est AUTO', () => {
  assert.equal(approval.levelFor('PREPARE_RESPONSE'), approval.AUTO);
  assert.equal(approval.levelFor('PREPARE_POST'), approval.AUTO);
});

test('levelFor: envoi/publication/suppression exigent une approbation', () => {
  assert.equal(approval.levelFor('SEND_MESSAGE'), approval.APPROVAL_REQUIRED);
  assert.equal(approval.levelFor('PUBLISH_POST'), approval.APPROVAL_REQUIRED);
  assert.equal(approval.levelFor('DELETE'), approval.APPROVAL_REQUIRED);
  assert.equal(approval.levelFor('COMMERCIAL_SENSITIVE'), approval.APPROVAL_REQUIRED);
  assert.equal(approval.levelFor('UPDATE_DATA'), approval.APPROVAL_REQUIRED);
});

test('levelFor: type inconnu est traite par prudence comme APPROVAL_REQUIRED', () => {
  assert.equal(approval.levelFor('TYPE_JAMAIS_VU'), approval.APPROVAL_REQUIRED);
});

test('requestApproval: une action AUTO est auto-approuvee immediatement', async () => {
  const record = await approval.requestApproval({
    actionType: 'ANALYZE',
    summary: 'test auto',
  });
  assert.equal(record.data.status, 'auto_approved');
  assert.equal(record.data.decidedBy, 'system');
});

test('requestApproval: une action sensible reste en attente', async () => {
  const record = await approval.requestApproval({
    actionType: 'SEND_MESSAGE',
    summary: 'test pending',
  });
  assert.equal(record.data.status, 'pending');
  assert.equal(record.data.decidedBy, null);
});

test('decide: approuver une demande met a jour son statut', async () => {
  const record = await approval.requestApproval({ actionType: 'PUBLISH_POST', summary: 'x' });
  const decided = await approval.decide(record.id, { approve: true, decidedBy: 'testeur' });
  assert.equal(decided.data.status, 'approved');
  assert.equal(decided.data.decidedBy, 'testeur');
});

test('decide: rejeter une demande met a jour son statut', async () => {
  const record = await approval.requestApproval({ actionType: 'DELETE', summary: 'x' });
  const decided = await approval.decide(record.id, { approve: false, decidedBy: 'testeur' });
  assert.equal(decided.data.status, 'rejected');
});

test('requestApproval: une action APPROVAL_REQUIRED recoit une date d\'expiration future', async () => {
  const record = await approval.requestApproval({ actionType: 'SEND_MESSAGE', summary: 'x' });
  assert.ok(record.data.expiresAt);
  assert.ok(new Date(record.data.expiresAt) > new Date());
});

test('requestApproval: une action AUTO n\'a pas de date d\'expiration (deja decidee)', async () => {
  const record = await approval.requestApproval({ actionType: 'ANALYZE', summary: 'x' });
  assert.equal(record.data.expiresAt, null);
});

test('decide: une approbation expiree ne peut jamais etre approuvee, meme si demande', async () => {
  const record = await approval.requestApproval({ actionType: 'SEND_MESSAGE', summary: 'x' });
  await memory.update(memory.COLLECTIONS.APPROVALS, record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const decided = await approval.decide(record.id, { approve: true, decidedBy: 'testeur' });
  assert.equal(decided.data.status, 'expired');
  assert.notEqual(decided.data.status, 'approved');
});

test('pending: exclut automatiquement les approbations expirees (expiration paresseuse)', async () => {
  const record = await approval.requestApproval({ actionType: 'PUBLISH_POST', summary: 'x' });
  await memory.update(memory.COLLECTIONS.APPROVALS, record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const rows = await approval.pending();
  assert.ok(!rows.some((r) => r.id === record.id));
  const refreshed = await memory.get(memory.COLLECTIONS.APPROVALS, record.id);
  assert.equal(refreshed.data.status, 'expired');
});

test('pending: ne renvoie que les demandes en attente', async () => {
  await approval.requestApproval({ actionType: 'SEND_MESSAGE', summary: 'toujours en attente' });
  const rows = await approval.pending();
  assert.ok(rows.every((r) => r.data.status === 'pending'));
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
