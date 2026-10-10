'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const localVoice = require('../src/core/localVoice');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-local-voice-'));
const allowedRoot = path.join(root, 'allowed');
const outsideRoot = path.join(root, 'outside');
const validAudio = path.join(allowedRoot, 'scene-1.wav');
const outsideAudio = path.join(outsideRoot, 'outside.wav');

test.before(() => {
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  for (const output of [validAudio, outsideAudio]) {
    const result = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.7',
      '-c:a', 'pcm_s16le', output,
    ]);
    assert.equal(result.status, 0, `la fixture audio doit être générée: ${result.stderr || ''}`);
  }
});

test('charge exactement les pistes locales demandées et mesure leur durée réelle', async () => {
  const result = await localVoice.loadTracks(
    [{ id: 'scene-1', voix_off_scene: 'Prépare ton CV avec des faits précis.' }],
    [{ scene_id: 'scene-1', local_path: validAudio, voice: 'Voix locale de test' }],
    { allowedRoot },
  );
  assert.equal(result.configured, true);
  assert.equal(result.provider, 'local_audio_files');
  assert.equal(result.tracks.length, 1);
  assert.ok(result.tracks[0].duration_measured_seconds > 0.6);
  assert.ok(result.tracks[0].duration_measured_seconds < 0.8);
  assert.equal(result.tracks[0].text, 'Prépare ton CV avec des faits précis.');
});

test('refuse les chemins hors du dossier de staging même si le fichier audio est valide', async () => {
  await assert.rejects(
    () => localVoice.loadTracks(
      [{ id: 'scene-1', voix_off_scene: 'Texte de test.' }],
      [{ scene_id: 'scene-1', local_path: outsideAudio }],
      { allowedRoot },
    ),
    /hors du dossier de staging autorisé/,
  );
});

test('refuse les pistes locales si aucun dossier autorisé n’est configuré', async () => {
  await assert.rejects(
    () => localVoice.loadTracks(
      [{ id: 'scene-1', voix_off_scene: 'Texte de test.' }],
      [{ scene_id: 'scene-1', local_path: validAudio }],
    ),
    /CONQUISTADOR_LOCAL_AUDIO_ROOT/,
  );
});

test('refuse le nombre de pistes différent du nombre de scènes', async () => {
  await assert.rejects(
    () => localVoice.loadTracks(
      [{ id: 'scene-1' }, { id: 'scene-2' }],
      [{ scene_id: 'scene-1', local_path: validAudio }],
      { allowedRoot },
    ),
    /2 piste\(s\) étaient attendues/,
  );
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
