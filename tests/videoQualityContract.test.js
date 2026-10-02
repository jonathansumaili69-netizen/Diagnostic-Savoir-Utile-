'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const videoQuality = require('../src/agents/videoQuality');
const contenu = require('../src/agents/contenu');

test('videoQuality: une timeline voix-image-sous-titres désynchronisée est bloquante', () => {
  const result = videoQuality.deterministicChecks({
    video: {
      source_url: 'https://cdn.example.test/video.mp4',
      duration_seconds: 10,
      script: 'Conseil éducatif.',
      platform: 'tiktok',
      cta: 'Découvre la suite dans le profil.',
      timeline: [{
        scene_id: 'scene_01',
        start_seconds: 0,
        end_seconds: 10,
        image_ref: 'image-01',
        voice_start_seconds: 2,
        voice_end_seconds: 10,
        subtitles: [{ start_seconds: 0, end_seconds: 12, text: 'Conseil éducatif' }],
      }],
    },
  });
  assert.equal(result.timelineReady, false);
  assert.equal(result.checks.find((check) => check.id === 'voice_image_sync').status, 'fail');
  assert.equal(result.checks.find((check) => check.id === 'subtitles_sync').status, 'fail');
  assert.ok(result.blocking.some((item) => item.includes('voix')));
  assert.ok(result.blocking.some((item) => item.includes('sous-titre')));
});

test('videoQuality: le contrat de rapport contient les quatre rubriques explicites', async () => {
  const result = await videoQuality.review({ use_ai: false, use_media_ai: false, video: {} });
  assert.ok(Array.isArray(result.output.problemes_identifies));
  assert.ok(Array.isArray(result.output.corrections_demandees));
  assert.ok(Array.isArray(result.output.comment_corriger));
  assert.ok(Array.isArray(result.output.elements_a_preserver));
  assert.ok(Array.isArray(result.output.timeline_manifest));
  assert.equal(result.output.publication_autorisee, false);
});

test('contenu: une révision partielle préserve les champs corrects existants', () => {
  const previous = {
    hook: 'Hook validé',
    description: 'Description validée',
    hashtags: ['#emploi', '#conseil'],
    scenes: [{ id: 'scene_01', personnage: 'Samuel' }],
    timeline: [{ scene_id: 'scene_01', start_seconds: 0, end_seconds: 5 }],
  };
  const revised = contenu.mergeRevisionContent(previous, {
    ok: true,
    data: { hook: 'Hook corrigé', hashtags: [], scenes: [] },
  });
  assert.equal(revised.data.hook, 'Hook corrigé');
  assert.deepEqual(revised.data.hashtags, previous.hashtags);
  assert.deepEqual(revised.data.scenes, previous.scenes);
  assert.equal(revised.data.description, previous.description);
  assert.deepEqual(revised.data.timeline, previous.timeline);
});

test('videoQuality: un format non vertical (paysage/carré) est bloquant, jamais un simple avertissement (cahier des charges qualité vidéo)', () => {
  const paysage = videoQuality.deterministicChecks({
    video: { source_url: 'https://cdn.example.test/v.mp4', duration_seconds: 20, script: 'x', width: 1920, height: 1080 },
  });
  assert.ok(paysage.blocking.some((b) => /vertical/i.test(b)), 'un format paysage doit être bloquant');

  const carre = videoQuality.deterministicChecks({
    video: { source_url: 'https://cdn.example.test/v.mp4', duration_seconds: 20, script: 'x', width: 1080, height: 1080 },
  });
  assert.ok(carre.blocking.some((b) => /vertical/i.test(b)), 'un format carré (width>=height) doit être bloquant');

  const vertical = videoQuality.deterministicChecks({
    video: { source_url: 'https://cdn.example.test/v.mp4', duration_seconds: 20, script: 'x', width: 1080, height: 1920 },
  });
  assert.ok(!vertical.blocking.some((b) => /vertical/i.test(b)), 'un format vertical correct ne doit jamais être bloqué pour ce motif');
});
