'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Isole ce test dans un repertoire de donnees temporaire et force le fallback
// JSON (aucune cle Supabase) pour ne jamais toucher aux vraies donnees locales.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const memory = require('../src/core/memory');

test('memory.insert cree un enregistrement avec id et horodatage', async () => {
  const record = await memory.insert('events', { type: 'test.event', payload: { a: 1 } });
  assert.ok(record.id);
  assert.ok(record.created_at);
  assert.equal(record.data.type, 'test.event');
});

test('memory.list renvoie les enregistrements du plus recent au plus ancien', async () => {
  await memory.insert('events', { type: 'first' });
  await memory.insert('events', { type: 'second' });
  const rows = await memory.list('events');
  assert.ok(rows.length >= 2);
  assert.ok(new Date(rows[0].created_at) >= new Date(rows[1].created_at));
});

test('memory.get renvoie null pour un id inexistant', async () => {
  const row = await memory.get('events', 'id-qui-n-existe-pas');
  assert.equal(row, null);
});

test('memory.update fusionne les champs sans ecraser les autres', async () => {
  const record = await memory.insert('tasks', { status: 'pending', type: 'content.idea' });
  const updated = await memory.update('tasks', record.id, { status: 'done' });
  assert.equal(updated.data.status, 'done');
  assert.equal(updated.data.type, 'content.idea');
});

test('memory.remove supprime bien l\'enregistrement', async () => {
  const record = await memory.insert('errors', { message: 'a supprimer' });
  const ok = await memory.remove('errors', record.id);
  assert.equal(ok, true);
  const gone = await memory.get('errors', record.id);
  assert.equal(gone, null);
});

test('memory.currentBackend renvoie "json" sans configuration Supabase', () => {
  assert.equal(memory.currentBackend(), 'json');
});

test('memory.recordExecution persiste statut_sortie (audit : ce champ etait silencieusement perdu a l’ecriture)', async () => {
  // AUDIT Phase 2 : recordExecution() avait un whitelist d'insertion qui
  // omettait `statut_sortie`, alors que taskEngine.js et
  // scheduler-tick.js le fournissent systematiquement. Toute lecture
  // ulterieure de row.data.statut_sortie (quota de campagne dans
  // taskEngine.js, "contenus_publies" dans statistiques.js) voyait donc
  // toujours `undefined`, sans aucune erreur visible.
  const record = await memory.recordExecution({
    workflow: 'test.workflow',
    declencheur: 'campaign',
    agent: 'system',
    action: 'PUBLISH_POST',
    statut_sortie: 'PUBLIE',
    resultat: 'succes',
    duree_ms: 5,
  });
  assert.equal(record.data.statut_sortie, 'PUBLIE');
  const reloaded = await memory.get('executions', record.id);
  assert.equal(reloaded.data.statut_sortie, 'PUBLIE');
});

test('memory.recordExecution: statut_sortie absent devient explicitement null (jamais undefined silencieux)', async () => {
  const record = await memory.recordExecution({
    workflow: 'test.workflow',
    declencheur: 'manuel',
    agent: 'system',
    action: 'ANALYZE',
    resultat: 'succes',
    duree_ms: 5,
  });
  assert.equal(record.data.statut_sortie, null);
});

// --- Idempotence en deux temps (CLAIM / CONFIRM / RELEASE) ---------------
// AUDIT (bug critique corrige) : l'ancienne version marquait un evenement
// comme definitivement traite des sa premiere reclamation, avant tout
// traitement. Un lot {A, B} ou seul A reussissait laissait B marque "deja
// vu" pour toujours : un retry ne le retraitait jamais. Voir
// src/core/memory.js et CONQUISTADOR_PROGRESS.md pour le detail.

test('idempotence 1/6 : nouvel evenement -> traitement -> confirmation (TERMINE)', async () => {
  const claimed = await memory.claimIdempotencyEvent('idem.scope1', 'evt-1');
  assert.equal(claimed.doublon, false);
  assert.equal(claimed.statut, 'EN_COURS');
  const confirmed = await memory.confirmIdempotencyEvent('idem.scope1', 'evt-1');
  assert.equal(confirmed, true);
  const after = await memory.claimIdempotencyEvent('idem.scope1', 'evt-1');
  assert.equal(after.doublon, true);
  assert.equal(after.statut, 'TERMINE');
});

test('idempotence 2/6 : meme evenement reclame deux fois -> une seule execution', async () => {
  const first = await memory.claimIdempotencyEvent('idem.scope2', 'evt-2');
  assert.equal(first.doublon, false);
  const second = await memory.claimIdempotencyEvent('idem.scope2', 'evt-2');
  assert.equal(second.doublon, true, 'la deuxieme reclamation ne doit jamais declencher un second traitement');
});

test('idempotence 3/6 : echec (release) -> retry immediat possible', async () => {
  const first = await memory.claimIdempotencyEvent('idem.scope3', 'evt-3');
  assert.equal(first.doublon, false);
  const released = await memory.releaseIdempotencyEvent('idem.scope3', 'evt-3');
  assert.equal(released, true);
  const retry = await memory.claimIdempotencyEvent('idem.scope3', 'evt-3');
  assert.equal(retry.doublon, false, 'apres liberation, un nouvel essai doit demarrer immediatement, sans attendre le TTL');
});

test('idempotence 4/6 : A reussit (confirm) / B echoue (release) dans le meme lot -> retry ne retraite que B', async () => {
  await memory.claimIdempotencyEvent('idem.lot', 'A');
  await memory.confirmIdempotencyEvent('idem.lot', 'A');
  await memory.claimIdempotencyEvent('idem.lot', 'B');
  await memory.releaseIdempotencyEvent('idem.lot', 'B');

  const retryA = await memory.claimIdempotencyEvent('idem.lot', 'A');
  assert.equal(retryA.doublon, true);
  assert.equal(retryA.statut, 'TERMINE', 'A deja termine -> ignore au retry, jamais retraite deux fois');

  const retryB = await memory.claimIdempotencyEvent('idem.lot', 'B');
  assert.equal(retryB.doublon, false, 'B recuperable -> retraite au retry (c\'est exactement le bug corrige)');
});

test('idempotence 5/6 : evenement EN_COURS non expire -> pas de double traitement concurrent', async () => {
  const first = await memory.claimIdempotencyEvent('idem.scope5', 'evt-5', { ttlMs: 60000 });
  assert.equal(first.doublon, false);
  const concurrent = await memory.claimIdempotencyEvent('idem.scope5', 'evt-5', { ttlMs: 60000 });
  assert.equal(concurrent.doublon, true);
  assert.equal(concurrent.statut, 'EN_COURS');
});

test('idempotence 6/6 : evenement EN_COURS expire (crash sans liberation) -> reprise raisonnable', async () => {
  const first = await memory.claimIdempotencyEvent('idem.scope6', 'evt-6', { ttlMs: 10 });
  assert.equal(first.doublon, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const reclaimed = await memory.claimIdempotencyEvent('idem.scope6', 'evt-6', { ttlMs: 10 });
  assert.equal(reclaimed.doublon, false, 'un EN_COURS expire doit redevenir reclamable (reprise raisonnable)');
  assert.equal(reclaimed.statut, 'EN_COURS');
});

test('idempotence : release ne touche jamais un evenement deja TERMINE (succes confirme = definitif)', async () => {
  await memory.claimIdempotencyEvent('idem.scope7', 'evt-7');
  await memory.confirmIdempotencyEvent('idem.scope7', 'evt-7');
  const released = await memory.releaseIdempotencyEvent('idem.scope7', 'evt-7');
  assert.equal(released, false, 'un succes confirme ne doit jamais pouvoir etre annule a posteriori');
  const stillDone = await memory.claimIdempotencyEvent('idem.scope7', 'evt-7');
  assert.equal(stillDone.statut, 'TERMINE');
});

// AUDIT (bug pre-existant corrige, decouvert pendant le developpement du
// Video Engine) : mediaStorage.js appelle memory.getSupabaseClient(), mais
// cette fonction n'etait jamais exportee — TypeError des que Supabase est
// reellement configure (production). Regression test.
test('memory.getSupabaseClient est bien exporte (regression : mediaStorage.js en depend)', () => {
  assert.equal(typeof memory.getSupabaseClient, 'function');
  assert.equal(memory.getSupabaseClient(), null, 'sans SUPABASE_URL/SUPABASE_SERVICE_KEY, doit renvoyer null plutot que lever');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
