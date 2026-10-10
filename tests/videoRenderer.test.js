'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const graphicEngine = require('../src/core/graphicEngine');
const videoRenderer = require('../src/core/videoRenderer');
const qc = require('../src/core/videoFileQualityCheck');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-renderer-'));

test.before(async () => {
  const img1 = await graphicEngine.render('title', { title: 'Scene un', width: 320, height: 568 });
  const img2 = await graphicEngine.render('stat', { value: '9', label: 'Scene deux', width: 320, height: 568 });
  await fsp.writeFile(path.join(tmpDir, 'scene1.png'), img1.buffer);
  await fsp.writeFile(path.join(tmpDir, 'scene2.png'), img2.buffer);
});

test('videoRenderer.isAvailable: detecte ffmpeg dans cet environnement', async () => {
  assert.equal(await videoRenderer.isAvailable(), true);
});

test('videoRenderer.renderManifest: produit un vrai MP4 valide (video muette + silence, 2 scenes)', async () => {
  const outputPath = path.join(tmpDir, 'out-silent.mp4');
  const result = await videoRenderer.renderManifest({
    scenes: [
      { scene_id: 's1', duration_seconds: 1, image_path: path.join(tmpDir, 'scene1.png') },
      { scene_id: 's2', duration_seconds: 1, image_path: path.join(tmpDir, 'scene2.png') },
    ],
    width: 320, height: 568,
    outputPath,
    workDir: path.join(tmpDir, 'work-silent'),
  });
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.audioSource, 'silence');
  assert.equal(result.motionEffect, 'ken_burns_slow_zoom');
  assert.equal(result.sceneTransition, 'clean_cut_with_motion');
  assert.equal(result.sceneCount, 2);
  assert.ok(fs.existsSync(outputPath));
  const check = await qc.check(outputPath, { expected: { width: 320, height: 568, minDurationSeconds: 2 } });
  assert.equal(check.ok, true, JSON.stringify(check.checks.filter((c) => c.status !== 'pass')));
});

test('videoRenderer.renderManifest: integre un vrai segment audio la ou fourni, silence ailleurs (mixed)', async () => {
  const voicePath = path.join(tmpDir, 'voice.m4a');
  const { spawnSync } = require('node:child_process');
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-loglevel', 'error', voicePath]);

  const outputPath = path.join(tmpDir, 'out-mixed.mp4');
  const result = await videoRenderer.renderManifest({
    scenes: [
      { scene_id: 's1', duration_seconds: 1, image_path: path.join(tmpDir, 'scene1.png') },
      { scene_id: 's2', duration_seconds: 1, image_path: path.join(tmpDir, 'scene2.png') },
    ],
    audioSegments: { s1: voicePath },
    width: 320, height: 568,
    outputPath,
    workDir: path.join(tmpDir, 'work-mixed'),
  });
  assert.equal(result.audioSource, 'mixed');
  const check = await qc.check(outputPath, { expected: { minDurationSeconds: 2 } });
  assert.equal(check.ok, true);
  assert.equal(check.has_audio, true);
});

test('videoRenderer.renderManifest: brule des sous-titres reels quand un .srt est fourni', async () => {
  const srtPath = path.join(tmpDir, 'subs.srt');
  await fsp.writeFile(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nSous-titre de test\n', 'utf8');
  const outputPath = path.join(tmpDir, 'out-subtitled.mp4');
  const result = await videoRenderer.renderManifest({
    scenes: [{ scene_id: 's1', duration_seconds: 1, image_path: path.join(tmpDir, 'scene1.png') }],
    subtitlesSrtPath: srtPath,
    width: 320, height: 568,
    outputPath,
    workDir: path.join(tmpDir, 'work-subtitled'),
  });
  assert.equal(result.subtitlesBurned, true);
  const check = await qc.check(outputPath);
  assert.equal(check.ok, true);
});

test('videoRenderer.buildTextOverlaySrt: conserve le CTA exact avec un timing valide', () => {
  const url = 'https://savoir-utile.mychariow.shop/prd_s33t0e';
  const srt = videoRenderer.buildTextOverlaySrt([{
    text: `DÉCOUVRE LE GUIDE\n${url}`,
    start_seconds: 27.25,
    end_seconds: 30,
  }]);
  assert.match(srt, /00:00:27,250 --> 00:00:30,000/);
  assert.ok(srt.includes('DÉCOUVRE LE GUIDE'));
  assert.ok(srt.includes(url));
  assert.throws(() => videoRenderer.buildTextOverlaySrt([{ text: 'x', start_seconds: 2, end_seconds: 1 }]), /texte superposé invalide/);
});

test('videoRenderer.renderManifest: brûle séparément le CTA visuel du sous-titre parlé', async () => {
  const outputPath = path.join(tmpDir, 'out-cta-overlay.mp4');
  const result = await videoRenderer.renderManifest({
    scenes: [{ scene_id: 's1', duration_seconds: 2, image_path: path.join(tmpDir, 'scene1.png') }],
    textOverlays: [{ text: 'DÉCOUVRE LE GUIDE\nhttps://savoir-utile.mychariow.shop/prd_s33t0e', start_seconds: 0.25, end_seconds: 2 }],
    width: 320, height: 568,
    outputPath,
    workDir: path.join(tmpDir, 'work-cta-overlay'),
  });
  assert.equal(result.textOverlaysBurned, true);
  assert.ok(fs.existsSync(outputPath));
  const check = await qc.check(outputPath);
  assert.equal(check.ok, true, JSON.stringify(check.checks.filter((c) => c.status !== 'pass')));
});

test('videoRenderer.renderManifest: refuse une scene sans image (n invente jamais un visuel)', async () => {
  await assert.rejects(
    () => videoRenderer.renderManifest({
      scenes: [{ scene_id: 's1', duration_seconds: 1, image_path: null }],
      width: 320, height: 568,
      outputPath: path.join(tmpDir, 'should-not-exist.mp4'),
      workDir: path.join(tmpDir, 'work-invalid'),
    }),
    /n'a pas d'asset image/
  );
});

test('videoRenderer.detectAbnormalSilence: détecte une plage continue de silence dans un fichier audio', async () => {
  const { spawnSync } = require('node:child_process');
  const silencePath = path.join(tmpDir, 'silence.wav');
  const generated = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '3', '-c:a', 'pcm_s16le', '-loglevel', 'error', silencePath,
  ]);
  assert.equal(generated.status, 0, 'la fixture audio silencieuse doit être générée par FFmpeg');
  const result = await videoRenderer.detectAbnormalSilence(silencePath, { minSilenceSeconds: 1, noiseDb: -42 });
  assert.equal(result.ok, false);
  assert.ok(result.abnormal_silence_count >= 1);
  assert.ok(result.silences[0].duration_seconds >= 1);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
