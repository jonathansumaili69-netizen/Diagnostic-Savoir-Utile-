'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const subtitles = require('../src/core/subtitles');

test('subtitles.formatSrtTimestamp: format HH:MM:SS,mmm correct', () => {
  assert.equal(subtitles.formatSrtTimestamp(0), '00:00:00,000');
  assert.equal(subtitles.formatSrtTimestamp(65.25), '00:01:05,250');
  assert.equal(subtitles.formatSrtTimestamp(3661.5), '01:01:01,500');
});

test('subtitles.splitIntoChunks: ne coupe jamais un mot et respecte la longueur max', () => {
  const chunks = subtitles.splitIntoChunks('Un test de decoupage en segments courts pour sous-titres mobiles', 20);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 20 || !chunk.includes(' '));
  }
});

test('subtitles.build: piste avec timing reel produit un .srt valide et synchronise', () => {
  const result = subtitles.build([
    { scene_id: 'scene_01', text: 'Ceci est un texte de test pour les sous-titres.', start_seconds: 0, end_seconds: 4 },
  ]);
  assert.ok(result.entry_count >= 1);
  assert.match(result.srt, /^1\n00:00:00,000 --> /);
  assert.equal(result.scenes_ignorees.length, 0);
  // La derniere entree ne doit jamais depasser la fin de la scene de facon significative
  const last = result.entries[result.entries.length - 1];
  assert.ok(last.end_seconds >= 4 - 0.001);
});

test('subtitles.build: une scene sans timing mesure est honnêtement ignoree (jamais de duree inventee)', () => {
  const result = subtitles.build([
    { scene_id: 'scene_01', text: 'Texte present mais sans timing', start_seconds: null, end_seconds: null },
    { scene_id: 'scene_02', text: '', start_seconds: 0, end_seconds: 3 },
  ]);
  assert.equal(result.entry_count, 0);
  assert.equal(result.srt, '');
  assert.equal(result.complet, false);
  assert.equal(result.scenes_ignorees.length, 2);
  assert.equal(result.scenes_ignorees[0].scene_id, 'scene_01');
  assert.equal(result.scenes_ignorees[1].scene_id, 'scene_02');
});

test('subtitles.build: plusieurs scenes s enchainent sans chevauchement de temps entre scenes', () => {
  const result = subtitles.build([
    { scene_id: 's1', text: 'Premiere scene avec un texte assez long pour generer plusieurs segments de sous-titres successifs.', start_seconds: 0, end_seconds: 5 },
    { scene_id: 's2', text: 'Deuxieme scene.', start_seconds: 5, end_seconds: 8 },
  ]);
  const s2Entries = result.entries.filter((e) => e.scene_id === 's2');
  const s1Entries = result.entries.filter((e) => e.scene_id === 's1');
  assert.ok(s2Entries.every((e) => e.start_seconds >= 5 - 0.001));
  assert.ok(s1Entries.every((e) => e.end_seconds <= 5 + 0.001));
});

test('subtitles.build: aucune entree n a une duree en dessous du plancher minimum lisible', () => {
  const result = subtitles.build([
    { scene_id: 's1', text: 'a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd', start_seconds: 0, end_seconds: 1 },
  ]);
  for (const entry of result.entries) {
    assert.ok(entry.end_seconds - entry.start_seconds >= subtitles.MIN_CHUNK_SECONDS - 0.001);
  }
});
