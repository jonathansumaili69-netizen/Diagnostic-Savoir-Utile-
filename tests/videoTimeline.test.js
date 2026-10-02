'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timeline = require('../src/core/videoTimeline');

function scenes(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `scene_${String(i + 1).padStart(2, '0')}`,
    description: `scene ${i + 1}`,
    personnage: i % 2 ? 'Marc' : 'Samuel',
    voix_off_scene: `Narration de la scene ${i + 1}.`,
    style: 'realiste',
  }));
}

/** Pistes voix "reellement mesurees" (comme voiceStudio les produit). */
function tracks(list, durations) {
  let cursor = 0;
  return list.map((s, i) => {
    const d = durations[i];
    const t = {
      scene_id: s.id,
      text: s.voix_off_scene,
      start_seconds: Number(cursor.toFixed(3)),
      end_seconds: Number((cursor + d).toFixed(3)),
      duration_estimated_seconds: d,
    };
    cursor += d;
    return t;
  });
}

test('videoTimeline: une video de 37 secondes est une VRAIE timeline de ~37 s (aucun plafond a 10 s)', () => {
  const s = scenes(7);
  const durations = [4, 6, 5, 6, 6, 5, 5]; // somme = 37
  const t = timeline.buildTimeline({ scenes: s, voiceTracks: tracks(s, durations) });
  // Le dernier end inclut la marge anti-coupure de voix (0.35 s).
  assert.ok(t.total_duration_seconds >= 37, `duree trop courte : ${t.total_duration_seconds}`);
  // Chaque scene recoit une marge anti-coupure de voix (0.35 s) : la duree
  // finale peut donc depasser legerement la duree de narration mesuree.
  assert.ok(t.total_duration_seconds <= 37 + t.scene_count * timeline.VOICE_SAFETY_SECONDS + 0.5, `duree excessive : ${t.total_duration_seconds}`);
  assert.equal(t.scene_count, 7);
  assert.equal(t.contrainte_duree_maximale_appliquee, null);
  assert.equal(t.source_principale, 'voix_mesuree');
  const validation = timeline.validateTimeline(t, { expectedDurationSeconds: 37 });
  assert.equal(validation.ok, true, JSON.stringify(validation.checks));
  assert.equal(validation.checks.find((c) => c.id === 'limite_duree_artificielle').status, 'pass');
});

test('videoTimeline: 45 s, 60 s et 90 s sont construites et validees sans ecretage', () => {
  for (const target of [45, 60, 90]) {
    const n = Math.ceil(target / 8);
    const s = scenes(n);
    const per = target / n;
    const t = timeline.buildTimeline({ scenes: s, voiceTracks: tracks(s, new Array(n).fill(per)) });
    assert.ok(t.total_duration_seconds >= target, `${target}s : duree obtenue ${t.total_duration_seconds}`);
    assert.ok(
      t.total_duration_seconds <= target + t.scene_count * timeline.VOICE_SAFETY_SECONDS + 0.5,
      `${target}s : duree obtenue ${t.total_duration_seconds}`,
    );
    const v = timeline.validateTimeline(t, { expectedDurationSeconds: target });
    assert.equal(v.ok, true, `${target}s : ${JSON.stringify(v.checks)}`);
    assert.equal(v.checks.find((c) => c.id === 'aucun_ecran_vide').status, 'pass');
    assert.equal(v.checks.find((c) => c.id === 'aucun_trou').status, 'pass');
  }
});

test('videoTimeline: une scene longue (37 s) n est jamais decoupee artificiellement', () => {
  const s = scenes(1);
  const t = timeline.buildTimeline({ scenes: s, voiceTracks: tracks(s, [37]) });
  assert.ok(t.scenes[0].duration_seconds >= 37);
  assert.equal(t.scenes[0].duration_source, 'voix_mesuree');
  assert.equal(t.total_duration_seconds, t.scenes[0].end_seconds);
});

test('videoTimeline: repli explicite sur le manifeste puis sur une duree par defaut (jamais silencieux)', () => {
  const s = scenes(2);
  const fromManifest = timeline.buildTimeline({
    scenes: s,
    voiceTracks: [],
    manifestTimeline: [
      { scene_id: 'scene_01', start_seconds: 0, end_seconds: 3 },
      { scene_id: 'scene_02', start_seconds: 3, end_seconds: 7 },
    ],
  });
  assert.equal(fromManifest.source_principale, 'manifeste');
  assert.ok(fromManifest.warnings.some((w) => w.type === 'VOIX_NON_MESUREE'));
  assert.equal(fromManifest.total_duration_seconds, 7);

  const byDefault = timeline.buildTimeline({ scenes: s, voiceTracks: [], manifestTimeline: [] });
  assert.equal(byDefault.source_principale, 'defaut');
  assert.ok(byDefault.warnings.some((w) => w.type === 'DUREE_PAR_DEFAUT'));
  assert.ok(byDefault.total_duration_seconds > 0);
});

test('videoTimeline: chaque scene porte toutes les metadonnees exigees (start/end/asset/refs/narration/subtitle/transition/statut)', () => {
  const s = scenes(3);
  const t = timeline.buildTimeline({ scenes: s, voiceTracks: tracks(s, [2, 3, 2]) });
  for (const sc of t.scenes) {
    assert.ok(typeof sc.scene_id === 'string');
    assert.ok(Number.isFinite(sc.start_seconds));
    assert.ok(Number.isFinite(sc.end_seconds));
    assert.ok(sc.duration_seconds > 0);
    assert.ok(Array.isArray(sc.character_references) && sc.character_references.length === 1);
    assert.ok(typeof sc.narration_segment === 'string' && sc.narration_segment.length > 0);
    assert.equal(sc.subtitle_segment, null, 'rempli ensuite par subtitles.js (source unique)');
    assert.ok(typeof sc.transition === 'string');
    assert.equal(sc.quality_status, 'PENDING');
    assert.ok(sc.metadata && 'style' in sc.metadata);
    assert.ok(sc.frames > 0);
  }
});

test('videoTimeline: une timeline incoherente est REJETEE (trou, scene de duree nulle)', () => {
  const broken = {
    scene_count: 2,
    total_duration_seconds: 8,
    contrainte_duree_maximale_appliquee: null,
    scenes: [
      { scene_id: 'a', start_seconds: 0, end_seconds: 0, duration_seconds: 0, audio_track: true, quality_status: 'PENDING' },
      { scene_id: 'b', start_seconds: 4, end_seconds: 8, duration_seconds: 4, audio_track: true, quality_status: 'PENDING' },
    ],
  };
  const v = timeline.validateTimeline(broken);
  assert.equal(v.ok, false);
  assert.equal(v.checks.find((c) => c.id === 'aucun_ecran_vide').status, 'fail');
  assert.equal(v.checks.find((c) => c.id === 'aucun_trou').status, 'fail');
});

test('videoTimeline: la synchronisation sous-titres / scenes est verifiee reellement', () => {
  const s = scenes(2);
  const t = timeline.buildTimeline({ scenes: s, voiceTracks: tracks(s, [3, 3]) });
  const entries = [
    { scene_id: 'scene_01', text: 'Premier', start_seconds: 0, end_seconds: 1.4 },
    { scene_id: 'scene_02', text: 'Deuxieme', start_seconds: 3, end_seconds: 4.4 },
  ];
  const withSubs = timeline.attachSubtitleSegments(t, entries);
  assert.equal(withSubs.scenes[0].subtitle_segment.length, 1);
  const okSync = timeline.validateSynchronization(withSubs, entries);
  assert.equal(okSync.ok, true);
  assert.equal(okSync.entry_count, 2);

  const late = [{ scene_id: 'scene_01', text: 'Trop tard', start_seconds: 99, end_seconds: 100 }];
  const badSync = timeline.validateSynchronization(withSubs, late);
  assert.equal(badSync.ok, false);
  assert.equal(badSync.checks.find((c) => c.id === 'sous_titres_non_en_retard').status, 'fail');
});

test('videoTimeline: planTargetDuration respecte exactement la duree cible demandee', () => {
  for (const target of timeline.TARGET_DURATIONS) {
    const plan = timeline.planTargetDuration({ targetSeconds: target, sceneCount: 7 });
    assert.equal(plan.scene_count, 7);
    const sum = plan.scenes.reduce((a, s) => a + s.duration_seconds, 0);
    assert.ok(Math.abs(sum - target) < 0.05, `${target}s : somme obtenue ${sum}`);
    assert.ok(plan.scenes.every((s) => s.duration_seconds >= timeline.MIN_SCENE_SECONDS));
  }
  assert.deepEqual(timeline.TARGET_DURATIONS, [20, 30, 37, 45, 60, 75, 90]);
});
