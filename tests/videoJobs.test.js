'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-videojobs-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const videoJobs = require('../src/core/videoJobs');

test('videoJobs.createJob: cree un job QUEUED avec progress 0', async () => {
  const { job, created } = await videoJobs.createJob({ sujet: 'test' });
  assert.equal(created, true);
  assert.equal(job.status, 'QUEUED');
  assert.equal(job.progress, 0);
  assert.ok(job.id);
  assert.ok(job.timestamps.queued_at);
});

test('videoJobs.createJob: idempotent — meme cle renvoie le job existant, n en cree pas un second', async () => {
  const first = await videoJobs.createJob({ sujet: 'a' }, { idempotencyKey: 'clef-fixe-1' });
  const second = await videoJobs.createJob({ sujet: 'b (devrait etre ignore)' }, { idempotencyKey: 'clef-fixe-1' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.job.id, second.job.id);
  assert.equal(second.job.input.sujet, 'a', 'le contenu du premier job ne doit pas etre ecrase par le second appel');
});

test('videoJobs.transition: fait progresser le statut et le progress associe', async () => {
  const { job } = await videoJobs.createJob({ sujet: 'progress-test' });
  const updated = await videoJobs.transition(job.id, 'PREPARING', { manifest: { scenes: [] } });
  assert.equal(updated.status, 'PREPARING');
  assert.equal(updated.progress, videoJobs.PROGRESS_BY_STATUS.PREPARING);
  assert.deepEqual(updated.manifest, { scenes: [] });
  assert.ok(updated.timestamps.started_at);
});

test('videoJobs.transition: refuse de faire transitionner un job deja dans un statut terminal', async () => {
  const { job } = await videoJobs.createJob({ sujet: 'terminal-test' });
  await videoJobs.markFailed(job.id, { step: 'PREPARING', error: new Error('echec simule') });
  await assert.rejects(() => videoJobs.transition(job.id, 'GENERATING_ASSETS', {}), /statut terminal/);
});

test('videoJobs.markFailed: enregistre l etape et le message d erreur, statut FAILED', async () => {
  const { job } = await videoJobs.createJob({ sujet: 'fail-test' });
  const failed = await videoJobs.markFailed(job.id, { step: 'RENDERING', error: new Error('ffmpeg indisponible') });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error_step, 'RENDERING');
  assert.match(failed.error, /ffmpeg indisponible/);
  assert.ok(failed.timestamps.failed_at);
});

test('videoJobs.markFailed: n ecrase jamais un job deja termine avec succes', async () => {
  const { job } = await videoJobs.createJob({ sujet: 'no-overwrite-test' });
  await videoJobs.transition(job.id, 'PREPARING', {});
  await videoJobs.transition(job.id, 'GENERATING_ASSETS', {});
  await videoJobs.transition(job.id, 'GENERATING_VOICE', {});
  await videoJobs.transition(job.id, 'COMPOSING', {});
  await videoJobs.transition(job.id, 'RENDERING', {});
  await videoJobs.transition(job.id, 'QUALITY_CHECK', {});
  const completed = await videoJobs.transition(job.id, 'COMPLETED', { storage_ok: true, output_url: 'https://example.test/v.mp4' });
  assert.equal(completed.status, 'COMPLETED');
  const attempted = await videoJobs.markFailed(job.id, { step: 'COMPLETED', error: new Error('ne devrait jamais s appliquer') });
  assert.equal(attempted.status, 'COMPLETED', 'un succes deja enregistre ne doit jamais etre transforme en echec');
});

test('videoJobs.listJobs: filtre par statut', async () => {
  await videoJobs.createJob({ sujet: 'list-a' });
  const { job } = await videoJobs.createJob({ sujet: 'list-b' });
  await videoJobs.markFailed(job.id, { step: 'PREPARING', error: new Error('x') });
  const failedOnly = await videoJobs.listJobs({ status: 'FAILED' });
  assert.ok(failedOnly.every((j) => j.status === 'FAILED'));
  assert.ok(failedOnly.some((j) => j.id === job.id));
});

test('videoJobs.cancelJob: annule un job non terminal, n a aucun effet sur un job deja termine', async () => {
  const { job } = await videoJobs.createJob({ sujet: 'cancel-test' });
  const cancelled = await videoJobs.cancelJob(job.id);
  assert.equal(cancelled.status, 'CANCELLED');
  const again = await videoJobs.cancelJob(job.id);
  assert.equal(again.status, 'CANCELLED');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
