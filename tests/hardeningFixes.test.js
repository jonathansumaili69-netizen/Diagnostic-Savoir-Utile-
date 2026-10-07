'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-hardeningfix-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const videoJobs = require('../src/core/videoJobs');
const videoOrchestrator = require('../src/core/videoOrchestrator');
const videoTimeline = require('../src/core/videoTimeline');
const videoRenderer = require('../src/core/videoRenderer');
const videoFileQualityCheck = require('../src/core/videoFileQualityCheck');
const subtitles = require('../src/core/subtitles');
const visualConsistency = require('../src/core/visualConsistency');
const schedulerBridge = require('../src/core/schedulerBridge');
const operationalState = require('../src/core/operationalState');
const killswitch = require('../src/core/killswitch');
const providerAdapter = require('../src/core/imageProviders/providerAdapter');
const characterReferenceProvider = require('../src/core/imageProviders/characterReferenceProvider');
const sharp = require('sharp');

const ASSETS = path.join(__dirname, '..', 'assets');
const SAMUEL = path.join(ASSETS, 'personnages', 'samuel', 'samuel-reference-principale.jpeg');
const MARC = path.join(ASSETS, 'personnages', 'marc', 'marc-reference-principale.jpg');

async function activateCampaign() {
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
    },
  });
  await killswitch.setStatus({ engage: false, raison: 'reset test', confirmation: true }).catch(() => {});
}

async function makeRenderedJob(seed) {
  const { job } = await videoJobs.createJob({ sujet: `video ${seed}`, idempotency_seed: seed }, { idempotencyKey: `fix-${seed}` });
  for (const status of ['PREPARING', 'GENERATING_ASSETS', 'GENERATING_VOICE', 'COMPOSING', 'RENDERING', 'QUALITY_CHECK']) {
    // eslint-disable-next-line no-await-in-loop
    await videoJobs.transition(job.id, status, {});
  }
  await videoJobs.transition(job.id, 'COMPLETED', {
    storage_ok: true,
    output_url: `https://exemple.test/${seed}.mp4`,
    render: { outputPath: '/tmp/x.mp4', durationSeconds: 37, sceneCount: 6 },
    quality_check: { ok: true, checks: [] },
  });
  return job.id;
}

/* ---- C3 : output_url verrouillee derriere storage_ok (mission sections 9/19) ---- */

test('ANTI-FAUX-SUCCES: output_url sans storage_ok=true est REFUSEE (transition et patchJob)', async () => {
  const { job } = await videoJobs.createJob({ sujet: 'guard', idempotency_seed: 'guard-1' }, { idempotencyKey: 'guard-1' });
  await videoJobs.transition(job.id, 'PREPARING', {});
  await assert.rejects(
    () => videoJobs.transition(job.id, 'RENDERING', { output_url: 'https://exemple.test/non-verifie.mp4' }),
    /storage_ok: true/,
  );
  await assert.rejects(
    () => videoJobs.patchJob(job.id, { output_url: 'https://exemple.test/non-verifie.mp4' }),
    /storage_ok: true/,
  );
  const fresh = await videoJobs.getJob(job.id);
  assert.equal(fresh.output_url, undefined, 'aucune URL non verifiee ne doit avoir ete enregistree');
});

/* ---- C1 : la provider character_reference n'accepte JAMAIS un FAIL (mission section 3) ----
 * Le chemin "provider configure + FAIL persistant => echec explicite (jamais le meilleur
 * FAIL retourne)" est verifie par les tests simules de characterReferenceProvider.test.js
 * (generateInjected/factory). Ici on verifie le garde-fou d'entree : une image invalide
 * n'est jamais acceptee comme visuel comparable. */

test('ANTI-FAUX-SUCCES: un buffer non image jamais accepte comme visuel genere (isImage garde-fou)', async () => {
  assert.equal(await visualConsistency.isImage(Buffer.from('ceci n est pas une image')), false);
  assert.equal(await visualConsistency.isImage(fs.readFileSync(SAMUEL)), true);
});

test('ANTI-FAUX-SUCCES: provider configuree + endpoint injoignable => echec explicite journalise (aucun buffer fabrique)', async () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'generic';
  process.env.IMAGE_IMG2IMG_ENDPOINT = 'http://127.0.0.1:9/img2img';
  process.env.IMAGE_IMG2IMG_API_KEY = 'cle-de-test-non-secrete';
  try {
    assert.equal(characterReferenceProvider.isEnabled(), true);
    const scene = { id: 'scene_01', personnage: 'Samuel', description: 'bureau', prompt_final: 'Samuel dans un bureau' };
    await assert.rejects(
      () => characterReferenceProvider.generate({ scene, width: 512, height: 512 }),
      (err) => {
        assert.match(err.message, /echouee apres|n'a jamais atteint le seuil|fetch failed/);
        return true;
      },
    );
  } finally {
    delete process.env.IMAGE_IMG2IMG_PROVIDER;
    delete process.env.IMAGE_IMG2IMG_ENDPOINT;
    delete process.env.IMAGE_IMG2IMG_API_KEY;
  }
}, { timeout: 120000 });

/* ---- C4 : durees reelles (mission section 7) — cause de l'ecart corrigee ---- */

test('DUREES: la marge anti-coupure ne s applique QU A LA DERNIERE scene (cause de l ecart +2,4..+3,5 s corrigee)', () => {
  const n = 7;
  const s = Array.from({ length: n }, (_, i) => ({ id: `scene_${String(i + 1).padStart(2, '0')}`, voix_off_scene: `N${i + 1}.` }));
  const durations = [5.4, 6.0, 5.9, 6.0, 6.1, 5.0, 2.6]; // somme = 37
  let cursor = 0;
  const tracks = s.map((sc, i) => {
    const t = { scene_id: sc.id, text: sc.voix_off_scene, start_seconds: Number(cursor.toFixed(3)), end_seconds: Number((cursor + durations[i]).toFixed(3)) };
    cursor += durations[i];
    return t;
  });
  const t = videoTimeline.buildTimeline({ scenes: s, voiceTracks: tracks, fps: 30 });
  // Apres correction : 37 exactement + UNE SEULE marge finale.
  assert.ok(t.total_duration_seconds >= 37, `duree trop courte : ${t.total_duration_seconds}`);
  assert.ok(t.total_duration_seconds <= 37 + videoTimeline.voiceSafetySeconds() + 0.02,
    `la marge ne doit etre ajoutee qu une fois (obtenu ${t.total_duration_seconds}, attendu <= ${37 + videoTimeline.voiceSafetySeconds() + 0.02})`);
  // Les scenes intermediaires se terminent EXACTEMENT a la fin de leur voix.
  for (let i = 0; i < n - 1; i += 1) {
    assert.ok(Math.abs(t.scenes[i].end_seconds - (t.scenes[i].start_seconds + durations[i])) < 0.01,
      `scene ${i + 1} intermediaire : la marge ne doit pas gonfler sa duree`);
  }
  // Repli manifeste : aucune marge non plus.
  const declared = videoTimeline.buildTimeline({
    scenes: s,
    voiceTracks: [],
    manifestTimeline: [{ scene_id: 'scene_01', start_seconds: 0, end_seconds: 37 }],
  });
  // (une seule scene declaree : les autres tombent en defaut — on teste surtout
  // que le chemin manifeste n'ajoute jamais de marge cachee)
  assert.equal(declared.scenes[0].duration_seconds, 37);
});

test('DUREES: rendu MP4 reel ~37 s mesure par ffprobe, ecart contenu (marge finale incluse)', async () => {
  const fsp = require('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'conquistador-fix-duree-37-'));
  const plan = [5.4, 6.0, 5.9, 6.0, 6.1, 5.0, 2.6]; // somme = 37
  const visuals = [];
  for (let i = 0; i < plan.length; i += 1) {
    const p = path.join(dir, `visual-${i}.jpg`);
    // eslint-disable-next-line no-await-in-loop
    await sharp(i % 2 ? MARC : SAMUEL).resize(240, 426, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(p);
    visuals.push(p);
  }
  const sceneList = plan.map((_, i) => ({ id: `scene_${String(i + 1).padStart(2, '0')}`, voix_off_scene: `Narration ${i + 1}.` }));
  let cursor = 0;
  const tracks = sceneList.map((s, i) => {
    const t = { scene_id: s.id, text: s.voix_off_scene, start_seconds: Number(cursor.toFixed(3)), end_seconds: Number((cursor + plan[i]).toFixed(3)) };
    cursor += plan[i];
    return t;
  });
  const timeline = videoTimeline.buildTimeline({ scenes: sceneList, voiceTracks: tracks, fps: 30 });
  assert.ok(timeline.total_duration_seconds <= 37.4, `timeline : ${timeline.total_duration_seconds}`);
  const subs = subtitles.build(tracks);
  const srtPath = path.join(dir, 'subs.srt');
  if (subs.srt) fs.writeFileSync(srtPath, subs.srt, 'utf8');
  const outputPath = path.join(dir, 'output.mp4');
  const render = await videoRenderer.renderManifest({
    scenes: timeline.scenes.map((s, i) => ({ scene_id: s.scene_id, duration_seconds: s.duration_seconds, image_path: visuals[i] })),
    audioSegments: {},
    subtitlesSrtPath: subs.srt ? srtPath : null,
    width: 240,
    height: 426,
    fps: 30,
    outputPath,
    workDir: path.join(dir, 'render'),
  });
  const qc = await videoFileQualityCheck.check(outputPath, {
    expected: { width: 240, height: 426, ratio: 240 / 426, minDurationSeconds: 36.5, expectedSceneCount: plan.length, assetsUsed: visuals.map((v, i) => ({ scene_id: `scene_${i}`, ok: true })) },
  });
  assert.equal(qc.ok, true, JSON.stringify(qc.checks));
  const delta = Math.abs(qc.duration_seconds - timeline.total_duration_seconds);
  assert.ok(delta <= 0.5, `l ecart ffprobe vs timeline doit rester marginal (obtenu ${delta}s)`);
  await fsp.rm(dir, { recursive: true, force: true });
}, { timeout: 120000 });

/* ---- C5 : SCENE_TROP_COURTE corrige immediatement ---- */

test('DUREES: une derniere scene trop breve est ETENDUE dans la timeline (pas seulement signalee)', () => {
  const s = [{ id: 'scene_01', voix_off_scene: 'A.' }, { id: 'scene_02', voix_off_scene: 'B.' }];
  const t = videoTimeline.buildTimeline({ scenes: s, voiceTracks: [
    { scene_id: 'scene_01', text: 'A.', start_seconds: 0, end_seconds: 2 },
    { scene_id: 'scene_02', text: 'B.', start_seconds: 2, end_seconds: 2.2 },
  ] });
  const last = t.scenes[t.scenes.length - 1];
  assert.ok(last.duration_seconds >= videoTimeline.CLOSING_MIN_SECONDS, `derniere scene etendue : ${last.duration_seconds}`);
  assert.ok(Math.abs(t.total_duration_seconds - last.end_seconds) < 0.01);
});

/* ---- C2 : publication confirmee uniquement ---- */

test('PUBLICATION: statut PUBLIE SANS external_post_id n est JAMAIS marque PUBLISHED (etat explicite conserve)', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('noconfirm-fix');
  await videoJobs.markReady(id);
  const result = await schedulerBridge.processDueVideoJobs({ publishFn: async () => ({ output: { statut: 'PUBLIE' } }) });
  assert.equal(result.publies.filter((p) => p.job_id === id).length, 0);
  const job = await videoJobs.getJob(id);
  assert.notEqual(job.status, 'PUBLISHED');
  assert.match(job.publication.last_error, /Confirmation provider insuffisante/);
});

test('IDEMPOTENCE: cycle 1 publie, cycles 2 et 3 => aucun nouvel appel provider, aucun doublon', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('idem-fix');
  await videoJobs.markReady(id);
  let calls = 0;
  const publishFn = async (params) => {
    if (params.content_key === id) calls += 1;
    return { output: { statut: 'PUBLIE', external_post_id: 'idem-proof-1' } };
  };
  const first = await schedulerBridge.processDueVideoJobs({ publishFn });
  assert.equal(first.publies.filter((p) => p.job_id === id).length, 1);
  const published = await videoJobs.getJob(id);
  assert.equal(published.status, 'PUBLISHED');
  const second = await schedulerBridge.processDueVideoJobs({ publishFn });
  const third = await schedulerBridge.processDueVideoJobs({ publishFn });
  assert.equal(calls, 1, 'le provider ne doit etre appele QU UNE SEULE fois pour ce job sur trois cycles');
  assert.equal(second.publies.filter((p) => p.job_id === id).length + third.publies.filter((p) => p.job_id === id).length, 0);
  assert.equal(second.doublons.filter((d) => d.job_id === id).length + third.doublons.filter((d) => d.job_id === id).length, 0, 'un job PUBLISHED n est plus un candidat');
  const stillPublished = await videoJobs.getJob(id);
  assert.equal(stillPublished.status, 'PUBLISHED');
  assert.equal(stillPublished.publication.external_post_id, 'idem-proof-1');
});

test('KILL SWITCH: engagement => aucun appel provider, job intact (rejouable apres coupure)', async () => {
  await activateCampaign();
  const id = await makeRenderedJob('kill-fix');
  await videoJobs.markReady(id);
  await killswitch.setStatus({ engage: true, raison: 'test fix' });
  let calls = 0;
  const result = await schedulerBridge.processDueVideoJobs({ publishFn: async (params) => { if (params.content_key === id) calls += 1; return { output: { statut: 'PUBLIE', external_post_id: 'x' } }; } });
  assert.equal(calls, 0);
  assert.equal(result.bloques.filter((b) => b.job_id === id).length, 1);
  const job = await videoJobs.getJob(id);
  assert.notEqual(job.status, 'PUBLISHED');
  await killswitch.setStatus({ engage: false, raison: 'fin test fix', confirmation: true });
});

/* ---- Provider adapter : erreurs explicites (mission section 4) ---- */

test('PROVIDER ADAPTER: endpoint injoignable => erreur explicite apres retries (aucun buffer fabrique)', async () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'generic';
  process.env.IMAGE_IMG2IMG_ENDPOINT = 'http://127.0.0.1:9/img2img';
  process.env.IMAGE_IMG2IMG_API_KEY = 'cle-de-test-non-secrete';
  try {
    const refBuffer = fs.readFileSync(SAMUEL);
    await assert.rejects(
      () => providerAdapter.generate({ prompt: 'test', referenceBuffers: [refBuffer], width: 256, height: 256, retries: 0, timeoutMs: 3000 }),
      (err) => {
        assert.ok(err.attempts, 'les tentatives doivent etre journalisees');
        assert.equal(err.attempts.length, 1);
        return true;
      },
    );
  } finally {
    delete process.env.IMAGE_IMG2IMG_PROVIDER;
    delete process.env.IMAGE_IMG2IMG_ENDPOINT;
    delete process.env.IMAGE_IMG2IMG_API_KEY;
  }
}, { timeout: 60000 });

test('PROVIDER ADAPTER: aucune reference officielle => refus explicite (aucune generation non conditionnee)', async () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'generic';
  process.env.IMAGE_IMG2IMG_ENDPOINT = 'https://exemple.invalid/img2img';
  process.env.IMAGE_IMG2IMG_API_KEY = 'cle-de-test-non-secrete';
  try {
    await assert.rejects(
      () => providerAdapter.generate({ prompt: 'test', referenceBuffers: [], width: 256, height: 256 }),
      /au moins une image de reference/,
    );
  } finally {
    delete process.env.IMAGE_IMG2IMG_PROVIDER;
    delete process.env.IMAGE_IMG2IMG_ENDPOINT;
    delete process.env.IMAGE_IMG2IMG_API_KEY;
  }
});

test('PROVIDER ADAPTER: extractImage couvre les 4 formes de reponse du contrat documente', () => {
  assert.deepEqual(providerAdapter.extractImage({ image_url: 'https://a/b' }), { url: 'https://a/b' });
  assert.deepEqual(providerAdapter.extractImage({ url: 'https://a/c' }), { url: 'https://a/c' });
  const b64 = 'a'.repeat(200);
  assert.deepEqual(providerAdapter.extractImage({ b64_json: b64 }), { base64: b64 });
  assert.deepEqual(providerAdapter.extractImage({ images: [{ url: 'https://a/d' }] }), { url: 'https://a/d' });
  assert.equal(providerAdapter.extractImage({ rien: true }), null);
});

/* ---- Frontend : contrats d'affichage corriges (mission sections 14-15) ---- */

test('FRONTEND: le ton du job video vient du statut reel, PUBLISHED affiche son identifiant externe, le champ duree cible est branche', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(appJs, /function videoJobStatusTone\(job\)/, 'le ton doit venir du statut reel du job');
  assert.match(appJs, /PUBLISHED: 'Publié \(confirmé\)'/);
  assert.match(appJs, /external_post_id \? ` \(post \$\{escapeHtml\(job\.publication\.external_post_id\)\}\)`/);
  assert.match(appJs, /body\.target_duration_seconds = targetDuration/);
  assert.match(html, /id="videoJobTargetDuration"/);
  // Aucun lien MP4 affiche pour un job sans stockage verifie (storage_ok).
  assert.match(appJs, /job\.storage_ok === true && job\.output_url/);
});

test('FRONTEND: charte preserve (Fraunces + IBM Plex) et aucun secret dans le bundle public', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fonts = html + css;
  assert.match(fonts, /Fraunces/);
  assert.match(fonts, /IBM Plex Sans/);
  assert.match(fonts, /IBM Plex Mono/);
  const publicDir = path.join(__dirname, '..', 'public');
  const files = ['app.js', 'index.html', 'style.css', 'privacy.html', 'terms.html'].map((f) => fs.readFileSync(path.join(publicDir, f), 'utf8')).join('\n');
  assert.equal(/SUPABASE_SERVICE_KEY\s*[:=]\s*['"][^'"]+['"]/.test(files), false);
  assert.equal(/(sk|pk)-[A-Za-z0-9]{20,}/.test(files), false);
  assert.equal(/Bearer\s+[A-Za-z0-9_-]{20,}/.test(files), false);
});

test('TikTok review: les liens Privacy et Terms sont visibles depuis la page officielle', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<a href="\/privacy">Politique de confidentialité<\/a>/);
  assert.match(html, /<a href="\/terms">Conditions d’utilisation<\/a>/);
});

/* ---- Manifeste sans scene : rejet explicite ---- */

test('MANIFESTE: aucune scene exploitable => echec explicite (jamais un job vide avance)', async () => {
  const { job } = await videoOrchestrator.createVideo({
    manifest: { scenes: [] },
    format: { width: 240, height: 426 },
    idempotency_seed: 'empty-manifest-fix',
  });
  assert.equal(job.status, 'FAILED');
  assert.match(job.error, /aucune scene exploitable/i);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
