'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-orchestrator-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const videoOrchestrator = require('../src/core/videoOrchestrator');
const videoJobs = require('../src/core/videoJobs');

function sampleManifest() {
  return {
    idee: 'test',
    scenes: [
      { id: 'scene_01', description: 'Samuel stresse', personnage: 'Samuel', style: 'realiste', prompt_final: 'Samuel worried', logo_requis: false, voix_off_scene: 'Texte de la scene un.' },
      { id: 'scene_02', description: 'Statistiques', personnage: 'aucun', style: 'realiste', prompt_final: 'stat card', logo_requis: true, voix_off_scene: 'Texte de la scene deux.' },
    ],
    timeline: [
      { scene_id: 'scene_01', start_seconds: 0, end_seconds: 1.2 },
      { scene_id: 'scene_02', start_seconds: 1.2, end_seconds: 2.4 },
    ],
  };
}

test('videoOrchestrator.createVideo: pipeline complet reel avec manifeste fourni — chaque etape produit des donnees reelles', async () => {
  const { job, created } = await videoOrchestrator.createVideo({
    manifest: sampleManifest(),
    format: { width: 320, height: 568, ratio: '9:16' },
    idempotency_seed: 'test-full-pipeline-1',
  });
  assert.equal(created, true);
  // Sans stockage durable configure dans cet environnement de test, le job
  // ne peut honnetement pas atteindre COMPLETED (voir stepFinalize) — mais
  // TOUT le reste du pipeline doit avoir reellement fonctionne.
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error_step, 'COMPLETED');
  assert.match(job.error, /stockage durable/);

  assert.equal(job.manifest.source, 'fourni_par_utilisateur');
  assert.equal(job.assets.reussis, 2);
  assert.equal(job.assets.echecs, 0);
  assert.equal(job.voice.statut_voix, 'VOICE_UNAVAILABLE');
  assert.ok(job.render);
  assert.ok(fs.existsSync(job.render.outputPath), 'le fichier MP4 doit reellement exister sur disque');
  assert.equal(job.quality_check.ok, true, 'le fichier rendu doit passer le controle qualite reel (ffprobe)');
});

test('videoOrchestrator.createVideo: idempotent — meme idempotency_key ne relance jamais un second job/rendu', async () => {
  const first = await videoOrchestrator.createVideo({ manifest: sampleManifest(), format: { width: 320, height: 568 }, idempotency_key: 'meme-cle-video' });
  const second = await videoOrchestrator.createVideo({ manifest: sampleManifest(), format: { width: 320, height: 568 }, idempotency_key: 'meme-cle-video' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.job.id, second.job.id);
});

test('videoOrchestrator.createVideo: sans manifeste ni sujet, echec explicite des la premiere etape (jamais un plantage silencieux)', async () => {
  const { job } = await videoOrchestrator.createVideo({ format: { width: 320, height: 568 }, idempotency_seed: 'no-input-test' });
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error_step, 'PREPARING');
  assert.match(job.error, /sujet.*manifeste|manifeste.*sujet/i);
});

test('videoOrchestrator.processJob: sur un job deja terminal, ne fait rien et ne leve pas', async () => {
  const { job } = await videoOrchestrator.createVideo({ format: { width: 320, height: 568 }, idempotency_seed: 'terminal-noop-test' });
  assert.equal(job.status, 'FAILED');
  const again = await videoOrchestrator.processJob(job.id);
  assert.equal(again.status, 'FAILED');
  assert.equal(again.updated_at, job.updated_at, 'un job terminal ne doit plus jamais etre modifie par processJob');
});

test('videoOrchestrator: chaque etape d un job a sa propre idempotence (regression du bug corrige avant livraison — voir en-tete videoOrchestrator.js)', async () => {
  // Reproduction directe : si la cle d'idempotence ne distinguait pas les
  // etapes, le pipeline s'arretait apres la toute premiere etape sans
  // aucune erreur. Ce test verifie que toutes les etapes ont bien ete
  // executees (manifest ET assets ET voice ET render ET quality_check tous
  // renseignes), pas seulement la premiere.
  const { job } = await videoOrchestrator.createVideo({
    manifest: sampleManifest(),
    format: { width: 320, height: 568 },
    idempotency_seed: 'regression-multi-step',
  });
  assert.ok(job.manifest, 'etape PREPARING doit avoir produit un manifest');
  assert.ok(job.assets, 'etape GENERATING_ASSETS doit avoir produit des assets');
  assert.ok(job.voice, 'etape GENERATING_VOICE doit avoir produit un resultat voix');
  assert.ok(job.subtitles !== undefined, 'etape COMPOSING doit avoir produit un resultat sous-titres');
  assert.ok(job.render, 'etape RENDERING doit avoir produit un resultat de rendu');
  assert.ok(job.quality_check, 'etape QUALITY_CHECK doit avoir produit un resultat de controle qualite');
});

test('videoJobs et videoOrchestrator restent coherents : un job recupere via getJob reflete le meme etat', async () => {
  const { job } = await videoOrchestrator.createVideo({ manifest: sampleManifest(), format: { width: 320, height: 568 }, idempotency_seed: 'coherence-test' });
  const reloaded = await videoJobs.getJob(job.id);
  assert.equal(reloaded.status, job.status);
  assert.equal(reloaded.error_step, job.error_step);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
