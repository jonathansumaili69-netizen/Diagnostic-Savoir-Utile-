'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ISOLATION (voir tests/chariow.test.js pour l'explication complete) :
// jamais le dossier data/ du depot lui-meme. Meme si ce fichier ne touche
// pas directement la memoire aujourd'hui, l'isolation par defaut evite
// toute regression future si une dependance venait a en ecrire.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-voiceover-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

process.env.VOICE_STUDIO_API_URL = 'https://voice.example.test';
process.env.VOICE_STUDIO_TIMEOUT_MS = '1000';
process.env.CONQUISTADOR_API_KEY = 'test-voice-key';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const voiceStudio = require('../src/core/voiceStudio');
const mediaStorage = require('../src/core/mediaStorage');
const voiceOver = require('../src/agents/voiceOver');
const pipeline = require('../src/agents/pipeline');
const { config } = require('../src/core/config');

/**
 * Construit un buffer MP3 synthétique valide (MPEG1 Layer III, 128 kbps,
 * 44100 Hz, sans padding) composé de `frameCount` frames, chacune de 418
 * octets (4 d'en-tête + 414 de remplissage). Permet de tester
 * estimateMp3DurationSeconds() sur une durée exacte et connue à l'avance,
 * sans dépendre d'un vrai fichier audio externe.
 */
function buildSyntheticMp3(frameCount) {
  const FRAME_SIZE = 418; // floor(1152/8 * 128000/44100) = 418
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frame = Buffer.concat([header, Buffer.alloc(FRAME_SIZE - header.length, 0)]);
  return Buffer.concat(new Array(frameCount).fill(frame));
}

test('voiceStudio.estimateMp3DurationSeconds: mesure une durée exacte sur un MP3 synthétique valide', () => {
  const buffer = buildSyntheticMp3(10);
  const duration = voiceStudio.estimateMp3DurationSeconds(buffer);
  const expected = (1152 / 44100) * 10;
  assert.ok(duration !== null);
  assert.ok(Math.abs(duration - expected) < 0.001, `attendu ~${expected}, obtenu ${duration}`);
});

test('voiceStudio.estimateMp3DurationSeconds: renvoie null sur des données non-MP3', () => {
  assert.equal(voiceStudio.estimateMp3DurationSeconds(Buffer.from('pas un mp3')), null);
  assert.equal(voiceStudio.estimateMp3DurationSeconds(null), null);
});

test('mediaStorage.upload: honnête quand Supabase n’est pas configuré', async () => {
  const result = await mediaStorage.upload({ path: 'test/x.mp3', buffer: Buffer.from('x') });
  assert.equal(result.configured, false);
  assert.equal(result.url, null);
  assert.match(result.raison, /SUPABASE_URL/);
});

test('voiceStudio.synthesizeScenes: mesure la durée réelle par scène et construit une timeline cumulative', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(buildSyntheticMp3(5), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
  try {
    const result = await voiceStudio.synthesizeScenes([
      { scene_id: 'scene_01', text: 'Bonjour, ceci est un test.' },
      { scene_id: 'scene_02', text: '' }, // texte vide : doit rester honnête, pas de génération
    ]);
    assert.equal(result.configured, true);
    assert.equal(result.tracks.length, 2);
    const [first, second] = result.tracks;
    assert.equal(first.scene_id, 'scene_01');
    assert.ok(first.duration_estimated_seconds > 0);
    assert.equal(first.start_seconds, 0);
    assert.ok(Math.abs(first.end_seconds - first.duration_estimated_seconds) < 0.0001);
    // Pas de Supabase configuré : pas d'URL durable, mais la durée reste mesurée.
    assert.equal(first.audio_url, null);

    assert.equal(second.scene_id, 'scene_02');
    assert.equal(second.duration_estimated_seconds, null);
    assert.match(second.raison, /Aucun texte/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('voiceOver.generateForContent: extrait voix_off_scene et reste honnête sans scènes structurées', async () => {
  const withoutScenes = await voiceOver.generateForContent({});
  assert.equal(withoutScenes.tracks.length, 0);
  assert.match(withoutScenes.raison, /Aucune scène/);

  const originalFetch = global.fetch;
  global.fetch = async () => new Response(buildSyntheticMp3(3), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
  try {
    const result = await voiceOver.generateForContent({
      scenes: [
        { id: 'scene_01', voix_off_scene: 'Une mauvaise réponse peut te coûter l’entretien.' },
        { id: 'scene_02', description: 'Pas de voix_off_scene fournie ici.' },
      ],
    });
    assert.equal(result.configured, true);
    assert.equal(result.tracks.length, 2);
    assert.equal(result.tracks[0].scene_id, 'scene_01');
    assert.ok(result.tracks[0].duration_estimated_seconds > 0);
    assert.equal(result.tracks[1].duration_estimated_seconds, null); // pas de texte -> honnête
  } finally {
    global.fetch = originalFetch;
  }
});

test('pipeline.run: fusionne la voix off réelle dans la timeline quand le studio est configuré', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/generate')) {
      return new Response(buildSyntheticMp3(4), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    throw new Error(`fetch inattendu dans ce test: ${target}`);
  };
  try {
    const content = {
      script: 'Script de test',
      scenes: [{ id: 'scene_01', personnage: 'Samuel', voix_off_scene: 'Texte de voix off réel pour la scène.' }],
      cta: 'Découvre le guide dans le profil.',
      timeline: [{
        scene_id: 'scene_01',
        start_seconds: 0,
        end_seconds: 8,
        image_ref: 'https://cdn.example.test/scene01.png',
        voice_start_seconds: 0, // valeur devinée par l'IA rédactrice, doit être remplacée
        voice_end_seconds: 3.5, // idem
        subtitles: [{ start_seconds: 0, end_seconds: 8, text: 'Texte de voix off réel pour la scène.' }],
      }],
    };
    const inspection = await pipeline.inspect(content, { use_ai_quality: false, use_media_ai: false });
    assert.equal(inspection.voiceOver.configured, true);
    const mergedSegment = inspection.manifest.timeline[0];
    assert.equal(mergedSegment.voice_duration_source, 'remy_neural_mesure_reel');
    assert.notEqual(mergedSegment.voice_end_seconds, 3.5); // remplacé par la mesure reelle
    assert.ok(mergedSegment.voice_end_seconds > 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('pipeline.run: sans studio vocal configuré, le manifeste reste strictement inchangé (aucune régression)', async () => {
  const previousUrl = config.brand.voiceApiUrl;
  config.brand.voiceApiUrl = '';
  try {
    const content = {
      script: 'Script de test',
      scenes: [{ id: 'scene_01', personnage: 'Samuel' }],
      cta: 'Découvre le guide dans le profil.',
      timeline: [{
        scene_id: 'scene_01', start_seconds: 0, end_seconds: 5, image_ref: 'https://cdn.example.test/s1.png',
        voice_start_seconds: 0, voice_end_seconds: 5, subtitles: [],
      }],
    };
    const inspection = await pipeline.inspect(content, { use_ai_quality: false, use_media_ai: false });
    assert.equal(inspection.voiceOver.configured, false);
    assert.equal(inspection.manifest.timeline[0].voice_end_seconds, 5);
    assert.equal(inspection.manifest.timeline[0].voice_duration_source, undefined);
  } finally {
    config.brand.voiceApiUrl = previousUrl;
  }
});
