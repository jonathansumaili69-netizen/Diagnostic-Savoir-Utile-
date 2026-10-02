'use strict';

/**
 * Tests du worker de rendu externe (scripts/render-worker.js) — le point
 * d'entree reutilise par le workflow GitHub Actions conqueror-worker.yml.
 * Verifie : parsing des arguments, comportement "aucun job" (cas nominal
 * d'un runner ephemere), et que processOnce ne fabrique jamais de travail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isoler le stockage JSON de secours dans un dossier temporaire dedie pour
// ne jamais toucher aux donnees reelles pendant les tests.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-worker-test-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDataDir;

const renderWorker = require('../scripts/render-worker');

test('parseArgs: valeurs par defaut ephemeres sures', () => {
  const args = renderWorker.parseArgs([]);
  assert.equal(args.once, false);
  assert.equal(args.interval, 15000);
  assert.equal(args.job, null);
});

test('parseArgs: --once (mode GitHub Actions)', () => {
  const args = renderWorker.parseArgs(['--once']);
  assert.equal(args.once, true);
});

test('parseArgs: --job=<id> cible un job unique', () => {
  const args = renderWorker.parseArgs(['--job=abc-123']);
  assert.equal(args.job, 'abc-123');
});

test('parseArgs: intervalle borne (jamais sous 2000ms)', () => {
  assert.equal(renderWorker.parseArgs(['--interval=500']).interval, 2000);
  assert.equal(renderWorker.parseArgs(['--interval=30000']).interval, 30000);
});

test('findWork: aucun job en attente sur un stockage vide', async () => {
  const jobs = await renderWorker.findWork();
  assert.deepEqual(jobs, []);
});

test('processOnce: aucun job -> 0 job avance, aucune erreur, aucune invention', async () => {
  const advanced = await renderWorker.processOnce();
  assert.equal(advanced, 0);
});

test('double lancement consecutif sans job: idempotent (0 puis 0)', async () => {
  const first = await renderWorker.processOnce();
  const second = await renderWorker.processOnce();
  assert.equal(first, 0);
  assert.equal(second, 0);
});
