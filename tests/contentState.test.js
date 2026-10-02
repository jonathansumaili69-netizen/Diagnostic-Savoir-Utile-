'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join('/tmp', `conquistador-content-state-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.CONQUISTADOR_DATA_DIR = dataDir;
process.env.CONQUISTADOR_API_KEY = 'test-content-key';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

const operationalState = require('../src/core/operationalState');

function task(id, status, input, output, created_at) {
  return {
    id,
    created_at,
    updated_at: created_at,
    data: { type: 'pipeline.video', status, input, result: output ? { output } : null },
  };
}

test('summarizeContentStates: consolide la dernière revue avec la tâche correspondante', () => {
  const summary = operationalState.summarizeContentStates({
    tasks: [
      task('task-ready', 'done', { content_key: 'video-1', sujet: 'Entretien' }, { statut: 'PRET_POUR_APPROBATION', conforme: true }, '2026-08-25T10:00:00.000Z'),
      task('task-waiting', 'waiting_approval', { content_key: 'video-2', sujet: 'CV' }, null, '2026-08-25T10:05:00.000Z'),
      task('task-running', 'running', { content_key: 'video-3', sujet: 'Réseau' }, null, '2026-08-25T10:06:00.000Z'),
    ],
    videoReviews: [
      {
        id: 'review-1',
        created_at: '2026-08-25T10:10:00.000Z',
        data: { kind: 'video_review', content_key: 'video-1', content_title: 'Entretien', review: { conforme: true } },
      },
    ],
  });
  assert.equal(summary.total, 3);
  assert.equal(summary.par_etat.validee, 1);
  assert.equal(summary.par_etat.en_attente_approbation, 1);
  assert.equal(summary.par_etat.en_controle, 1);
  assert.equal(summary.contenus.find((item) => item.key === 'video-1').label, 'Validée');
});

test('summarizeContentStates: expose corrections et erreurs sans inventer de contenu', () => {
  const summary = operationalState.summarizeContentStates({
    tasks: [
      task('task-corrections', 'done', { content_id: 'video-4', sujet: 'Tests' }, { statut: 'CORRECTIONS_REQUISES', conforme: false }, '2026-08-25T11:00:00.000Z'),
      task('task-error', 'error', { content_key: 'video-5', sujet: 'Erreur réelle' }, null, '2026-08-25T11:01:00.000Z'),
      { id: 'ignored', created_at: '2026-08-25T11:02:00.000Z', data: { type: 'stats.summary', status: 'done' } },
    ],
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.par_etat.corrections_requises, 1);
  assert.equal(summary.par_etat.erreur, 1);
  assert.equal(summary.contenus.some((item) => item.key === 'ignored'), false);
});

test('saveVideoReview: persiste la clé et le titre du contenu', async () => {
  const row = await operationalState.saveVideoReview({ conforme: false, statut: 'CORRECTIONS_REQUISES' }, {
    taskId: 'task-6',
    contentKey: 'video-6',
    contentTitle: 'Titre réel',
  });
  assert.equal(row.data.content_key, 'video-6');
  assert.equal(row.data.content_title, 'Titre réel');
  assert.equal(row.data.task_id, 'task-6');
});
