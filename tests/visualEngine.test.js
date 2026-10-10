'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-visualengine-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
const realFetch = global.fetch;
global.fetch = async () => { throw new Error('Réseau désactivé dans ce test déterministe.'); };

const visualEngine = require('../src/core/visualEngine');

test('visualEngine.resolveSceneAsset: écrit un visuel local neuf, jamais le portrait officiel par défaut', async () => {
  const workDir = path.join(tmpDir, 'assets-1');
  const resolved = await visualEngine.resolveSceneAsset(
    { id: 'scene_01', personnage: 'Samuel', description: 'test', style: 'realiste' },
    { width: 200, height: 300, mode: 'conquistador', workDir }
  );
  assert.ok(resolved.local_path);
  assert.ok(fs.existsSync(resolved.local_path));
  assert.ok(fs.statSync(resolved.local_path).size > 0);
  assert.equal(resolved.asset_type, 'GENERATED_GRAPHIC');
  assert.equal(resolved.source_path, null);
  assert.equal(resolved.needs_review, true, 'une scène Samuel non conditionnée sur son identité doit être marquée à vérifier');
});

test('visualEngine.resolveSceneAsset: sans stockage durable configuré, le rapporte honnêtement (jamais une URL inventée)', async () => {
  const resolved = await visualEngine.resolveSceneAsset(
    { id: 'scene_02', personnage: 'aucun', description: 'stat', style: 'realiste' },
    { width: 200, height: 300, mode: 'copilot', workDir: path.join(tmpDir, 'assets-2') }
  );
  assert.equal(resolved.storage.configured, false);
  assert.equal(resolved.url, null);
  assert.ok(resolved.storage.raison || resolved.storage.configured === false);
});

test('visualEngine.resolveVideoAssets: traite trois scènes distinctes et documente chaque succès', async () => {
  const scenes = [
    { id: 's1', personnage: 'Samuel', stat_value: '8C', description: 'Huit étapes', style: 'realiste' },
    { id: 's2', personnage: 'Marc', quote: 'Préparer son parcours', description: 'Une méthode structurée', style: 'realiste' },
    { id: 's3', personnage: 'aucun', logo_requis: true, description: 'Logo officiel', style: 'realiste' },
  ];
  const report = await visualEngine.resolveVideoAssets(scenes, { width: 150, height: 250, mode: 'silencio', workDir: path.join(tmpDir, 'assets-3') });
  assert.equal(report.total, 3);
  assert.equal(report.reussis, 3, JSON.stringify(report.provenance_audit));
  assert.equal(report.echecs, 0);
  assert.equal(report.scenes.length, 3);
  for (const scene of report.scenes) {
    assert.equal(scene.ok, true);
    assert.ok(fs.existsSync(scene.local_path));
  }
});

test.after(() => {
  global.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
