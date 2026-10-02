'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-killswitch-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.KILL_SWITCH_DEFAULT;

const killswitch = require('../src/core/killswitch');

test('killswitch.EXTERNAL_ACTION_TYPES : REPLY_COMMENT est bien couvert (audit priorite kill switch)', () => {
  // AUDIT : REPLY_COMMENT manquait de cet ensemble alors que taskEngine.js
  // le traite comme une action externe automatique au meme titre que
  // SEND_MESSAGE/PUBLISH_POST/UPDATE_DATA. Sans cette entree, une reponse
  // a un commentaire n'etait JAMAIS bloquee par le kill switch, meme en
  // mode securise - une violation directe de la regle "priorite absolue".
  assert.ok(killswitch.EXTERNAL_ACTION_TYPES.has('REPLY_COMMENT'));
  assert.ok(killswitch.EXTERNAL_ACTION_TYPES.has('SEND_MESSAGE'));
  assert.ok(killswitch.EXTERNAL_ACTION_TYPES.has('PUBLISH_POST'));
  assert.ok(killswitch.EXTERNAL_ACTION_TYPES.has('UPDATE_DATA'));
});

test('killswitch.isBlocked : REPLY_COMMENT est bloque quand le kill switch est engage', async () => {
  await killswitch.setStatus({ engage: true, raison: 'test regression reply_comment' });
  assert.equal(await killswitch.isBlocked('REPLY_COMMENT'), true);
  await killswitch.setStatus({ engage: false, raison: 'fin du test', confirmation: true });
  assert.equal(await killswitch.isBlocked('REPLY_COMMENT'), false);
});

test('killswitch.isBlocked : une analyse/preparation (hors liste) n’est jamais bloquee', async () => {
  await killswitch.setStatus({ engage: true, raison: 'test analyses non bloquees' });
  assert.equal(await killswitch.isBlocked('ANALYZE'), false);
  assert.equal(await killswitch.isBlocked('PREPARE_RESPONSE'), false);
  await killswitch.setStatus({ engage: false, raison: 'fin du test', confirmation: true });
});

test('killswitch.setStatus : desengager exige une confirmation explicite', async () => {
  await killswitch.setStatus({ engage: true, raison: 'test confirmation' });
  await assert.rejects(() => killswitch.setStatus({ engage: false, raison: 'sans confirmation' }), /confirmation/i);
  await killswitch.setStatus({ engage: false, raison: 'fin du test', confirmation: true });
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
