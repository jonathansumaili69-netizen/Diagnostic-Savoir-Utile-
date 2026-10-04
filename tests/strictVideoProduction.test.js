'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-strict-production-'));
const oldDataDir = process.env.CONQUISTADOR_DATA_DIR;
const oldSupabaseUrl = process.env.SUPABASE_URL;
const oldSupabaseKey = process.env.SUPABASE_SERVICE_KEY;
const oldNetlify = process.env.NETLIFY;
const oldLambda = process.env.LAMBDA_TASK_ROOT;
const oldToken = process.env.HF_TOKEN;
const oldModel = process.env.HF_TEXT_TO_IMAGE_MODEL;
process.env.CONQUISTADOR_DATA_DIR = path.join(tempRoot, 'data');
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.HF_TOKEN;

const imageProvider = require('../src/core/imageProviders/huggingFaceTextToImageProvider');
const imageProviders = require('../src/core/imageProviders');
const videoOrchestrator = require('../src/core/videoOrchestrator');
const qualityCheck = require('../src/core/videoFileQualityCheck');

function makeManifest(sceneCount = 6) {
  return {
    title: 'Six gestes pour mieux préparer sa recherche d’emploi',
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      id: `strict-scene-${String(i + 1).padStart(2, '0')}`,
      numero: i + 1,
      personnage: 'aucun',
      description: `Illustration originale de recherche d’emploi, scène ${i + 1}, décor et action différents.`,
      prompt_final: `Scène verticale originale ${i + 1} : ${[
        'carnet de candidature ouvert sur un bureau en bois clair avec une plante',
        'jeune diplômé qui organise son CV dans un espace de coworking lumineux',
        'ordinateur portable montrant une interface abstraite sans texte lisible',
        'poignée de main professionnelle dans un hall moderne baigné de lumière',
        'salle d’entretien avec deux fauteuils et une fenêtre donnant sur la ville',
        'personne qui célèbre une réussite après un appel téléphonique encourageant',
      ][i % 6]}; illustration éditoriale semi-réaliste, palette bleu et ivoire, sans texte, sans logo.`,
      voix_off_scene: `Conseil ${i + 1} : prépare une action concrète pour rendre ta candidature plus claire et plus convaincante.`,
    })),
  };
}

function fakeFfprobeJson({ duration = '60.2', codec = 'h264', audioCodec = 'aac', width = 720, height = 1280, fps = '30/1' } = {}) {
  return JSON.stringify({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration },
    streams: [
      { codec_type: 'video', codec_name: codec, width, height, avg_frame_rate: fps, duration },
      { codec_type: 'audio', codec_name: audioCodec, channels: 2, duration },
    ],
  });
}

async function withFakeFfprobe(fixture, callback) {
  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'ffprobe');
  fs.writeFileSync(binPath, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffprobe test fixture"; exit 0; fi\nprintf "%s" "$FFPROBE_FIXTURE_JSON"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldFixture = process.env.FFPROBE_FIXTURE_JSON;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ''}`;
  process.env.FFPROBE_FIXTURE_JSON = JSON.stringify(fixture);
  const filePath = path.join(tempRoot, 'fixture.mp4');
  fs.writeFileSync(filePath, Buffer.alloc(2048, 7));
  try {
    return await callback(filePath);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldFixture === undefined) delete process.env.FFPROBE_FIXTURE_JSON; else process.env.FFPROBE_FIXTURE_JSON = oldFixture;
  }
}

test('HF text-to-image: configuration par défaut et prompt de scène spécifique', () => {
  assert.equal(imageProvider.DEFAULT_MODEL, 'Qwen/Qwen-Image');
  assert.equal(imageProvider.PROVIDER, 'fal-ai');
  const prompt = imageProvider.buildPrompt({ id: 's1', prompt_final: 'Un entretien dans une pièce claire', personnage: 'Samuel' });
  assert.match(prompt, /entretien dans une pièce claire/i);
  assert.match(prompt, /personnage officiel Samuel/i);
  assert.match(prompt, /aucun texte lisible/i);
});

test('HF text-to-image: sans HF_TOKEN, échec explicite avant réseau', async () => {
  delete process.env.HF_TOKEN;
  assert.equal(imageProvider.status().configured, false);
  await assert.rejects(
    () => imageProvider.generate({ scene: { id: 'missing-token', prompt_final: 'Un carnet bleu sur un bureau' }, width: 720, height: 1280 }),
    /HF_TOKEN absent/,
  );
});

test('HF text-to-image: appel provider réel simulé, image PNG originale et hash mesuré', async () => {
  let capturedArgs;
  const oldLogToken = process.env.HF_TOKEN;
  const oldLogModel = process.env.HF_TEXT_TO_IMAGE_MODEL;
  const png = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#3478ae' } }).png().toBuffer();
  const restoreTextToImage = imageProvider.setTextToImageForTest(async (args) => {
    capturedArgs = args;
    return new Blob([png], { type: 'image/png' });
  });
  process.env.HF_TOKEN = 'test-token-not-a-real-secret';
  process.env.HF_TEXT_TO_IMAGE_MODEL = 'Qwen/Qwen-Image';
  try {
    const asset = await imageProvider.generate({
      scene: { id: 'scene-7', prompt_final: 'Un bureau lumineux et un carnet bleu' },
      width: 720,
      height: 1280,
    });
    assert.equal(capturedArgs.provider, 'fal-ai');
    assert.equal(capturedArgs.model, 'Qwen/Qwen-Image');
    assert.equal(capturedArgs.parameters.width, 720);
    assert.equal(capturedArgs.parameters.height, 1280);
    assert.equal(capturedArgs.parameters.num_inference_steps, 30);
    assert.equal(capturedArgs.parameters.guidance_scale, 2.5);
    assert.equal(capturedArgs.parameters.negative_prompt, 'blurry, low detail, unreadable text, watermark, logo');
    assert.equal(asset.asset_type, 'AI_IMAGE_GENERATED');
    assert.equal(asset.width, 720);
    assert.equal(asset.height, 1280);
    assert.match(asset.content_sha256, /^[a-f0-9]{64}$/);
    assert.equal((await sharp(asset.buffer).metadata()).format, 'png');
  } finally {
    restoreTextToImage();
    if (oldLogToken === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = oldLogToken;
    if (oldLogModel === undefined) delete process.env.HF_TEXT_TO_IMAGE_MODEL; else process.env.HF_TEXT_TO_IMAGE_MODEL = oldLogModel;
  }
});

test('profil strict: une panne HF fait échouer le job sans asset existant, fallback ou succès fictif', async () => {
  delete process.env.HF_TOKEN;
  const { job, created } = await videoOrchestrator.createVideo({
    manifest: makeManifest(),
    production_profile: 'strict_multiscene',
    target_duration_seconds: 60,
    format: { ratio: '9:16', width: 720, height: 1280 },
    idempotency_key: 'strict-hf-missing-token-test',
  });
  assert.equal(created, true);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error_step, 'GENERATING_ASSETS');
  assert.match(job.error, /HF_TOKEN absent/);
  assert.equal(job.output_url, undefined);
  assert.equal(job.render, null);
  assert.equal(job.assets, null);
  assert.ok(job.manifest.scenes.length >= 6);
  // Un appel direct en profil strict doit aussi court-circuiter toute la chaîne de fallback.
  await assert.rejects(
    () => imageProviders.generateAsset({ scene: { id: 'strict-no-token', prompt_final: 'Un bureau moderne' }, width: 720, height: 1280, requireAiGeneration: true }),
    /HF_TOKEN absent/,
  );
});

test('ffprobe strict: accepte H.264/AAC MP4 vertical 720×1280 en 30 fps entre 45 et 90 s', async () => {
  await withFakeFfprobe(JSON.parse(fakeFfprobeJson()), async (filePath) => {
    const result = await qualityCheck.check(filePath, { expected: {
      width: 720,
      height: 1280,
      ratio: 9 / 16,
      requireMp4Container: true,
      requireH264: true,
      requireAAC: true,
      expectedFps: 30,
      minWidth: 720,
      minHeight: 1280,
      minDurationSecondsStrict: 45,
      maxDurationSeconds: 90,
      expectedSceneCount: 8,
      assetsUsed: new Array(8).fill({ ok: true }),
    } });
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((check) => check.status === 'fail')));
  });
});

test('ffprobe strict: refuse codec, résolution, cadence et durée hors contrat', async () => {
  const bad = JSON.parse(fakeFfprobeJson({ duration: '40', codec: 'hevc', audioCodec: 'opus', width: 480, height: 854, fps: '25/1' }));
  await withFakeFfprobe(bad, async (filePath) => {
    const result = await qualityCheck.check(filePath, { expected: {
      requireMp4Container: true,
      requireH264: true,
      requireAAC: true,
      expectedFps: 30,
      minWidth: 720,
      minHeight: 1280,
      minDurationSecondsStrict: 45,
      maxDurationSeconds: 90,
    } });
    assert.equal(result.ok, false);
    const failingIds = result.checks.filter((check) => check.status === 'fail').map((check) => check.id);
    for (const id of ['codec_video_h264', 'codec_audio_aac', 'resolution_minimale', 'fps_attendu', 'duree_minimale_stricte']) {
      assert.ok(failingIds.includes(id), `le contrôle ${id} doit être bloquant`);
    }
  });
});

test.after(() => {
  if (oldDataDir === undefined) delete process.env.CONQUISTADOR_DATA_DIR; else process.env.CONQUISTADOR_DATA_DIR = oldDataDir;
  if (oldSupabaseUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldSupabaseUrl;
  if (oldSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = oldSupabaseKey;
  if (oldNetlify === undefined) delete process.env.NETLIFY; else process.env.NETLIFY = oldNetlify;
  if (oldLambda === undefined) delete process.env.LAMBDA_TASK_ROOT; else process.env.LAMBDA_TASK_ROOT = oldLambda;
  if (oldToken === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = oldToken;
  if (oldModel === undefined) delete process.env.HF_TEXT_TO_IMAGE_MODEL; else process.env.HF_TEXT_TO_IMAGE_MODEL = oldModel;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
