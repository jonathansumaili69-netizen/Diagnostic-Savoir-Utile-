'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-videopub-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const videoJobs = require('../src/core/videoJobs');
const schedulerBridge = require('../src/core/schedulerBridge');
const killswitch = require('../src/core/killswitch');
const operationalState = require('../src/core/operationalState');
const planner = require('../src/core/planner');
const memory = require('../src/core/memory');

async function activateCampaign(overrides = {}) {
  await operationalState.setSettings({
    mode: 'conquistador',
    campaign: {
      enabled: true,
      allowed_platforms: ['tiktok', 'youtube', 'facebook', 'instagram'],
      allowed_hours: [],
      max_publications_per_day: 20,
      quality_min_score: 85,
      requires_approval: false,
      timezone: 'Africa/Bujumbura',
      ...overrides,
    },
  });
  await killswitch.setStatus({ engage: false, raison: 'reset test', confirmation: true }).catch(() => {});
}

/** Cree un job RENDU (COMPLETED + output_url) comme le fait l'orchestrateur. */
async function makeRenderedJob(seed) {
  const { job } = await videoJobs.createJob({ sujet: `video ${seed}`, idempotency_seed: seed }, { idempotencyKey: `pub-${seed}` });
  for (const status of ['PREPARING', 'GENERATING_ASSETS', 'GENERATING_VOICE', 'COMPOSING', 'RENDERING', 'QUALITY_CHECK']) {
    // eslint-disable-next-line no-await-in-loop
    await videoJobs.transition(job.id, status, {});
  }
    await videoJobs.transition(job.id, 'COMPLETED', {
      // storage_ok: true — le contrat de stockage verifie est respecte (voir
      // videoJobs.transition : une output_url n'est jamais enregistree sans
      // preuve d'upload durable). Ce test simule le resultat de stepFinalize.
      storage_ok: true,
      output_url: `https://exemple.test/${seed}.mp4`,
    render: { outputPath: '/tmp/x.mp4', durationSeconds: 37, sceneCount: 6 },
    quality_check: { ok: true, checks: [] },
  });
  return job.id;
}

test('videoJobs: un job COMPLETED avec URL devient READY (jamais avant)', async () => {
  const id = await makeRenderedJob('ready-1');
  const ready = await videoJobs.markReady(id);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.ready_for_publication, true);
  assert.ok(ready.ready_at);
  // Idempotent : repromouvoir ne retrograde ni ne duplique.
  const again = await videoJobs.markReady(id);
  assert.equal(again.status, 'READY');
});

test('videoJobs: un job SANS url de sortie ne peut pas devenir READY (une video non recuperable n est pas prete)', async () => {
  const { job } = await videoJobs.createJob({ sujet: 'sans-url' });
  for (const status of ['PREPARING', 'GENERATING_ASSETS', 'GENERATING_VOICE', 'COMPOSING', 'RENDERING', 'QUALITY_CHECK']) {
    // eslint-disable-next-line no-await-in-loop
    await videoJobs.transition(job.id, status, {});
  }
  await videoJobs.transition(job.id, 'COMPLETED', { output_url: null });
  await assert.rejects(() => videoJobs.markReady(job.id), /URL de sortie/);
});

test('videoJobs: markPublished REFUSE de declarer publie sans confirmation du provider (external_post_id)', async () => {
  const id = await makeRenderedJob('noconfirm-1');
  await videoJobs.markReady(id);
  await videoJobs.markPublishing(id, { platform: 'tiktok' });
  await assert.rejects(
    () => videoJobs.markPublished(id, { platform: 'tiktok' }),
    /confirmation provider requise/,
  );
  const job = await videoJobs.getJob(id);
  assert.equal(job.status, 'PUBLISHING', 'un fichier cree n est jamais une video publiee');
});

test('schedulerBridge: publie un job video du et ecrit PUBLISHED seulement apres confirmation reelle', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('publish-1');
  await videoJobs.markReady(id);

  let calls = 0;
  const publishFn = async (params) => {
    if (params.content_key === id) calls += 1;
    return { output: { statut: 'PUBLIE', external_post_id: 'tt_post_12345' } };
  };
  const result = await schedulerBridge.processDueVideoJobs({ publishFn });
  const mine = result.publies.filter((p) => p.job_id === id);
  assert.equal(mine.length, 1, 'ce job precis doit avoir ete publie une seule fois');
  assert.equal(calls, 1);
  const job = await videoJobs.getJob(id);
  assert.equal(job.status, 'PUBLISHED');
  assert.equal(job.publication.external_post_id, 'tt_post_12345');
  assert.equal(job.publication.platform, 'tiktok');
  assert.ok(job.publication.published_at);
});

test('schedulerBridge: ne republie JAMAIS le meme job (idempotence persistante)', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('idem-1');
  await videoJobs.markReady(id);
  let calls = 0;
  const publishFn = async (params) => { if (params.content_key === id) calls += 1; return { output: { statut: 'PUBLIE', external_post_id: 'tt_1' } }; };

  const first = await schedulerBridge.processDueVideoJobs({ publishFn });
  assert.equal(first.publies.filter((p) => p.job_id === id).length, 1);
  assert.equal(calls, 1);

  const second = await schedulerBridge.processDueVideoJobs({ publishFn });
  assert.equal(second.publies.filter((p) => p.job_id === id).length, 0, 'le deuxieme cycle ne doit rien republier');
  assert.equal(calls, 1, 'le connecteur ne doit plus etre appele pour ce job');
});

test('schedulerBridge: une publication NON confirmee reste reessayable et n est jamais marquee publiee', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('unconfirmed-1');
  await videoJobs.markReady(id);
  const publishFn = async () => ({ output: { statut: 'CREATED' } }); // fichier cree, rien de confirme
  const result = await schedulerBridge.processDueVideoJobs({ publishFn });
  const mine = result.echecs.filter((e) => e.job_id === id);
  assert.equal(mine.length, 1);
  assert.match(mine[0].raison, /confirmation_provider_absente/);
  const job = await videoJobs.getJob(id);
  assert.notEqual(job.status, 'PUBLISHED');
  assert.equal(job.status, 'READY', 'un echec doit laisser le job reessayable');
  assert.equal(job.publication.state, 'RETRY_PENDING');
});

test('schedulerBridge: apres le nombre maximal de tentatives, le job passe FAILED avec la raison exacte', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('exhaust-1');
  await videoJobs.markReady(id);
  const publishFn = async () => { throw new Error('panne fournisseur simulee'); };
  for (let i = 0; i < schedulerBridge.maxPublishAttempts(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await schedulerBridge.processDueVideoJobs({ publishFn });
  }
  const job = await videoJobs.getJob(id);
  assert.equal(job.status, 'FAILED');
  assert.match(job.error, /panne fournisseur simulee/);
  assert.equal(job.error_step, 'PUBLISHING');
});

test('schedulerBridge: KILL SWITCH engage bloque toute diffusion (priorite absolue, jamais contournee)', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('kill-1');
  await videoJobs.markReady(id);
  await killswitch.setStatus({ engage: true, raison: 'test kill switch' });

  let calls = 0;
  const publishFn = async (params) => { if (params.content_key === id) calls += 1; return { output: { statut: 'PUBLIE', external_post_id: 'x' } }; };
  const result = await schedulerBridge.processDueVideoJobs({ publishFn });
  assert.equal(calls, 0, 'aucun appel connecteur ne doit avoir lieu kill switch engage');
  assert.equal(result.publies.filter((p) => p.job_id === id).length, 0);
  const blocked = result.bloques.filter((b) => b.job_id === id);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].raison, /Kill switch engage/);
  const job = await videoJobs.getJob(id);
  assert.notEqual(job.status, 'PUBLISHED');

  await killswitch.setStatus({ engage: false, raison: 'fin test', confirmation: true });
});

test('schedulerBridge: le mode non-conquistador bloque la diffusion autonome', async () => {
  await activateCampaign();
  await operationalState.setSettings({ mode: 'copilot', campaign: { enabled: true, allowed_platforms: ['tiktok'], allowed_hours: [], max_publications_per_day: 20, timezone: 'Africa/Bujumbura' } });
  const id = await makeRenderedJob('mode-1');
  await videoJobs.markReady(id);
  let calls = 0;
  const result = await schedulerBridge.processDueVideoJobs({ publishFn: async () => { calls += 1; return { output: { statut: 'PUBLIE', external_post_id: 'x' } }; } });
  assert.equal(calls, 0);
  const mine = result.bloques.filter((b) => b.job_id === id);
  assert.equal(mine.length, 1, 'ce job precis doit etre bloque en mode copilot');
  await activateCampaign();
});

test('videoJobs: une diffusion PROGRAMMEE dans le futur n est pas due avant l echeance', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('sched-1');
  await videoJobs.markReady(id);
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const scheduled = await videoJobs.schedulePublication(id, { scheduled_for: future, platform: 'youtube' });
  assert.equal(scheduled.status, 'SCHEDULED');
  assert.equal(scheduled.publication.platform, 'youtube');
  const due = await schedulerBridge.listDueVideoJobs();
  assert.equal(due.filter((d) => d.job_id === id).length, 0, 'un job programme dans le futur ne doit pas etre du maintenant');

  const past = new Date(Date.now() - 1000).toISOString();
  await videoJobs.schedulePublication(id, { scheduled_for: past, platform: 'youtube' });
  const dueNow = await schedulerBridge.listDueVideoJobs();
  const mineNow = dueNow.filter((d) => d.job_id === id);
  assert.equal(mineNow.length, 1);
  assert.equal(mineNow[0].platform, 'youtube');
});

test('videoJobs: la machine a etats expose tous les etats de production ET de diffusion exiges', () => {
  for (const s of ['QUEUED', 'PREPARING', 'GENERATING_SCRIPT', 'PREPARING_REFERENCES', 'GENERATING_ASSETS', 'GENERATING_VOICE', 'BUILDING_TIMELINE', 'COMPOSING', 'RENDERING', 'QUALITY_CHECK', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED']) {
    assert.ok(videoJobs.STATUSES.includes(s), `etat manquant : ${s}`);
  }
  assert.ok(videoJobs.TERMINAL_STATUSES.has('PUBLISHED'));
  assert.deepEqual(videoJobs.PUBLICATION_STATUSES, ['READY', 'SCHEDULED', 'PUBLISHING']);
});

test('schedulerBridge: journalise chaque tentative dans le journal de decisions (observabilite)', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('log-1');
  await videoJobs.markReady(id);
  await schedulerBridge.processDueVideoJobs({ publishFn: async () => ({ output: { statut: 'PUBLIE', external_post_id: 'tt_log' } }) });
  // Lecture directe de la collection de decisions (limite large) : on exige une
  // trace EXPLICITE pour ce job, quelle que soit son issue reelle (success,
  // blocked par quota/mode, ou error). L observabilite ne doit jamais mentir.
  const rows = await memory.list(memory.COLLECTIONS.DECISIONS, { limit: 2000 });
  const entries = rows
    .filter((r) => r && r.data && r.data.kind === 'planner_action' && r.data.action === 'video_publish' && r.data.content_key === id)
    .map((r) => r.data);
  assert.ok(entries.length >= 1, 'chaque tentative de publication doit etre journalisee');
  const e = entries[entries.length - 1];
  assert.equal(e.plateforme, 'tiktok');
  assert.ok(['success', 'blocked', 'error', 'not_confirmed'].includes(e.status), `statut de journal explicite attendu, recu: ${e.status}`);
  assert.ok(e.at, 'chaque entree journalisee porte un horodatage');
  const executions = await memory.list(memory.COLLECTIONS.EXECUTIONS, { limit: 50 });
  assert.ok(Array.isArray(executions), 'la collection executions reste lisible');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
