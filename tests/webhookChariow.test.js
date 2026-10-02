'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-webhookchariow-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const webhookChariow = require('../netlify/functions/webhook-chariow');
const memory = require('../src/core/memory');

function event(body) {
  return { httpMethod: 'POST', headers: {}, body: JSON.stringify(body) };
}

function parsed(response) {
  return JSON.parse(response.body || '{}');
}

/*
 * AUDIT (bug critique corrige) : ce handler importait `claimIdempotencyEvent`
 * depuis src/core/idempotency, module qui n'exporte que `checkAndMark` et
 * `deriveKey` - tout appel avec un `id` present levait
 * `TypeError: claimIdempotencyEvent is not a function`. Meme corrige,
 * l'appel original passait scope+cle combines en une seule chaine et
 * traitait l'objet de retour comme un booleen (toujours truthy), ce qui
 * aurait desactive silencieusement la deduplication.
 */

test('webhook-chariow: une notification avec id ne leve plus d exception (regression du bug claimIdempotencyEvent)', async () => {
  const response = await webhookChariow.handler(event({
    id: 'pulse-1',
    type: 'new_subscriber',
    email: 'client@example.com',
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(parsed(response).statut, 'RECU');
});

test('webhook-chariow: la meme notification (meme id) recue deux fois est bien ignoree comme doublon', async () => {
  const body = { id: 'pulse-2', type: 'new_subscriber', email: 'dup@example.com' };
  const first = await webhookChariow.handler(event(body));
  assert.equal(parsed(first).statut, 'RECU');

  const second = await webhookChariow.handler(event(body));
  assert.equal(parsed(second).statut, 'DOUBLON_IGNORE');
  assert.equal(parsed(second).event_id, 'pulse-2');

  const stored = await memory.list(memory.COLLECTIONS.CONTENT, {
    filter: (d) => d.kind === 'chariow_pulse' && d.event_id === 'pulse-2',
  });
  assert.equal(stored.length, 1, 'le doublon ne doit pas creer un second enregistrement');
});

test('webhook-chariow: une vente reussie (successful_sale) journalise bien un evenement chariow.sale', async () => {
  const response = await webhookChariow.handler(event({
    id: 'pulse-vente-1',
    type: 'successful_sale',
    amount: 5000,
  }));
  assert.equal(parsed(response).statut, 'RECU');

  const sales = await memory.list(memory.COLLECTIONS.EVENTS, {
    filter: (d) => d.type === 'chariow.sale' && d.payload && d.payload.event_id === 'pulse-vente-1',
  });
  assert.equal(sales.length, 1);
  assert.equal(sales[0].data.payload.amount, 5000);
});

test('webhook-chariow: notification sans id est acceptee sans idempotence (pas de cle disponible)', async () => {
  const response = await webhookChariow.handler(event({ type: 'unknown_event' }));
  assert.equal(response.statusCode, 200);
  assert.equal(parsed(response).statut, 'RECU');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
