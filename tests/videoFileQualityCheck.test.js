'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const qc = require('../src/core/videoFileQualityCheck');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-qc-'));
const validMp4 = path.join(tmpDir, 'valid.mp4');
const brokenMp4 = path.join(tmpDir, 'broken.mp4');
const emptyMp4 = path.join(tmpDir, 'empty.mp4');

test.before(() => {
  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p',
    '-loglevel', 'error', validMp4,
  ]);
  assert.equal(result.status, 0, 'la fixture ffmpeg doit se generer correctement pour que ce test suite ait un sens');
  fs.writeFileSync(brokenMp4, 'ceci n est pas un fichier video valide');
  fs.writeFileSync(emptyMp4, Buffer.alloc(0));
});

test('videoFileQualityCheck.check: fichier valide -> ok=true avec toutes les proprietes mesurees', async () => {
  const result = await qc.check(validMp4, { expected: { width: 320, height: 240, ratio: 320 / 240, minDurationSeconds: 1 } });
  assert.equal(result.ok, true);
  assert.equal(result.has_video, true);
  assert.equal(result.has_audio, true);
  assert.ok(result.duration_seconds >= 0.9);
  const ids = result.checks.map((c) => c.id);
  assert.ok(ids.includes('resolution_attendue'));
  assert.ok(ids.includes('ratio'));
});

test('videoFileQualityCheck.check: fichier inexistant -> ok=false, jamais une exception', async () => {
  const result = await qc.check(path.join(tmpDir, 'nope.mp4'));
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].id, 'fichier_existe');
  assert.equal(result.checks[0].status, 'fail');
});

test('videoFileQualityCheck.check: fichier vide -> ok=false explicite', async () => {
  const result = await qc.check(emptyMp4);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.id === 'taille_fichier' && c.status === 'fail'));
});

test('videoFileQualityCheck.check: fichier corrompu -> ok=false, jamais declare valide', async () => {
  const result = await qc.check(brokenMp4);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.id === 'conteneur_valide' && c.status === 'fail'));
});

test('videoFileQualityCheck.ffprobeAvailable: detecte correctement ffprobe dans cet environnement', async () => {
  const available = await qc.ffprobeAvailable();
  assert.equal(available, true, 'ffprobe est attendu present dans cet environnement de developpement');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
