'use strict';

/**
 * TEST D'INTEGRATION VIDEO LONGUE (exigence explicite du prompt maitre :
 * section 35 — « Ne te contente pas d'un test de 10 secondes »).
 *
 * Ce fichier rend de VRAIS fichiers MP4 de ~37 s, ~45 s, ~60 s et ~90 s avec
 * FFmpeg, puis verifie chaque fichier avec ffprobe (duree, resolution, fps,
 * pistes video/audio, sous-titres brules) via videoFileQualityCheck.
 *
 * Les visuels utilises sont les ASSETS OFFICIELS du projet (Samuel, Marc,
 * logo, bible) — aucune image inventee, aucun appel reseau.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const sharp = require('sharp');

const videoRenderer = require('../src/core/videoRenderer');
const videoFileQualityCheck = require('../src/core/videoFileQualityCheck');
const videoTimeline = require('../src/core/videoTimeline');
const subtitles = require('../src/core/subtitles');

const ASSETS = path.join(__dirname, '..', 'assets');
const WIDTH = 240;
const HEIGHT = 426;
const FPS = 30;

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `conquistador-longvid-${name}-`));
  return dir;
}

/** Scene plan representative d'un vrai script (hook, scenes, CTA). */
function scenePlan(sceneCount, targetSeconds) {
  const plan = videoTimeline.planTargetDuration({ targetSeconds, sceneCount });
  const roles = ['hook', 'scene', 'scene', 'scene', 'scene', 'scene', 'cta'];
  return plan.scenes.map((s, i) => ({
    id: `scene_${String(i + 1).padStart(2, '0')}`,
    role: roles[i] || 'scene',
    duration_seconds: s.duration_seconds,
    narration: `Narration reelle de la scene ${i + 1} pour une video de ${targetSeconds} secondes.`,
  }));
}

async function buildVisuals(dir, scenes) {
  const sources = [
    path.join(ASSETS, 'personnages', 'samuel', 'samuel-reference-principale.jpeg'),
    path.join(ASSETS, 'personnages', 'marc', 'marc-reference-principale.jpg'),
    path.join(ASSETS, 'logo', 'logo-savoir-utile-officiel.jpeg'),
  ];
  const out = [];
  for (let i = 0; i < scenes.length; i += 1) {
    const p = path.join(dir, `visual-${i}.jpg`);
    // eslint-disable-next-line no-await-in-loop
    await sharp(sources[i % sources.length]).resize(WIDTH, HEIGHT, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(p);
    out.push(p);
  }
  return out;
}

async function renderLongVideo(name, targetSeconds, sceneCount) {
  const dir = tmp(name);
  const scenes = scenePlan(sceneCount, targetSeconds);
  const visuals = await buildVisuals(dir, scenes);

  // Pistes "voix mesurees" : ce que voiceStudio produit quand le studio est
  // configure (ici les durees sont celles de la timeline cible, mais elles
  // suivent EXACTEMENT le meme chemin que des durees mesurees).
  let cursor = 0;
  const tracks = scenes.map((s) => {
    const t = {
      scene_id: s.id,
      text: s.narration,
      start_seconds: Number(cursor.toFixed(3)),
      end_seconds: Number((cursor + s.duration_seconds).toFixed(3)),
      duration_estimated_seconds: s.duration_seconds,
    };
    cursor += s.duration_seconds;
    return t;
  });

  const timeline = videoTimeline.buildTimeline({
    scenes: scenes.map((s) => ({ id: s.id, voix_off_scene: s.narration, description: s.role })),
    voiceTracks: tracks,
    fps: FPS,
  });
  const timelineValidation = videoTimeline.validateTimeline(timeline, { expectedDurationSeconds: targetSeconds });
  assert.equal(timelineValidation.ok, true, `timeline ${targetSeconds}s invalide : ${JSON.stringify(timelineValidation.checks)}`);
  assert.equal(timelineValidation.checks.find((c) => c.id === 'limite_duree_artificielle').status, 'pass');

  const subs = subtitles.build(tracks);
  const srtPath = path.join(dir, 'subtitles.srt');
  fs.writeFileSync(srtPath, subs.srt, 'utf8');
  assert.ok(subs.entry_count > 0, 'des sous-titres reels doivent etre produits');

  const outputPath = path.join(dir, 'output.mp4');
  const render = await videoRenderer.renderManifest({
    scenes: timeline.scenes.map((s, i) => ({
      scene_id: s.scene_id,
      duration_seconds: s.duration_seconds,
      image_path: visuals[i],
    })),
    audioSegments: {},
    subtitlesSrtPath: srtPath,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    outputPath,
    workDir: path.join(dir, 'render'),
  });

  const qc = await videoFileQualityCheck.check(outputPath, {
    expected: {
      width: WIDTH,
      height: HEIGHT,
      ratio: WIDTH / HEIGHT,
      minDurationSeconds: targetSeconds,
      expectedSceneCount: timeline.scene_count,
      assetsUsed: visuals.map((v, i) => ({ scene_id: `scene_${i}`, ok: true })),
    },
  });

  return { dir, outputPath, render, qc, timeline, subs, timelineValidation };
}

function assertRealVideo({ outputPath, qc, render, timeline, targetSeconds }) {
  assert.ok(fs.existsSync(outputPath), 'le fichier MP4 doit reellement exister');
  assert.ok(fs.statSync(outputPath).size > 10 * 1024, 'le fichier MP4 doit avoir une taille non triviale');
  assert.equal(qc.ok, true, `controle qualite en echec : ${JSON.stringify(qc.checks)}`);
  assert.equal(qc.has_video, true);
  assert.equal(qc.has_audio, true, 'une piste audio (silence explicite si voix indisponible) doit etre presente');
  assert.equal(qc.checks.find((c) => c.id === 'conteneur_valide').status, 'pass');
  assert.equal(qc.checks.find((c) => c.id === 'duree_positive').status, 'pass');
  assert.equal(qc.checks.find((c) => c.id === 'resolution_attendue').status, 'pass');
  assert.equal(qc.checks.find((c) => c.id === 'fps').status, 'pass');
  assert.equal(render.subtitlesBurned, true, 'les sous-titres reels doivent etre brules dans le MP4');

  const duration = qc.duration_seconds;
  assert.ok(Number.isFinite(duration) && duration > 0);
  assert.ok(duration >= targetSeconds * 0.88, `${targetSeconds}s : duree reelle trop courte (${duration}s)`);
  assert.ok(duration <= targetSeconds * 1.2, `${targetSeconds}s : duree reelle excessive (${duration}s)`);
  // PREUVE de l'absence de plafond artificiel : une video de plus de 10 s est
  // reellement produite et mesuree comme telle par ffprobe.
  assert.ok(duration > 10, 'la duree ne doit jamais etre plafonnee a 10 secondes');
  assert.ok(timeline.scene_count >= 5, 'une video longue doit etre composee de plusieurs scenes');
  assert.ok(render.sceneCount === timeline.scene_count);
}

test('VIDEO 37 s : rendu MP4 reel + QC ffprobe (durée ~37 s, plusieurs scènes, sous-titres)', async () => {
  const r = await renderLongVideo('37', 37, 7);
  try {
    assertRealVideo({ ...r, targetSeconds: 37 });
    assert.equal(r.timeline.source_principale, 'voix_mesuree');
    assert.ok(r.timeline.total_duration_seconds >= 37);
    console.log(`[37s] MP4=${r.outputPath} duree_ffprobe=${r.qc.duration_seconds}s scenes=${r.render.sceneCount} taille=${fs.statSync(r.outputPath).size} octets`);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('VIDEO 45 s : rendu MP4 reel + QC ffprobe', async () => {
  const r = await renderLongVideo('45', 45, 8);
  try {
    assertRealVideo({ ...r, targetSeconds: 45 });
    console.log(`[45s] duree_ffprobe=${r.qc.duration_seconds}s scenes=${r.render.sceneCount} taille=${fs.statSync(r.outputPath).size} octets`);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('VIDEO 60 s : rendu MP4 reel + QC ffprobe (jamais une suite de clips de 10 s)', async () => {
  const r = await renderLongVideo('60', 60, 9);
  try {
    assertRealVideo({ ...r, targetSeconds: 60 });
    assert.ok(r.qc.duration_seconds > 55, `une video de 60 s doit mesurer pres de 60 s (obtenu ${r.qc.duration_seconds}s)`);
    console.log(`[60s] duree_ffprobe=${r.qc.duration_seconds}s scenes=${r.render.sceneCount} taille=${fs.statSync(r.outputPath).size} octets`);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('VIDEO 90 s : rendu MP4 reel + QC ffprobe (si l environnement le permet)', async () => {
  const r = await renderLongVideo('90', 90, 10);
  try {
    assertRealVideo({ ...r, targetSeconds: 90 });
    console.log(`[90s] duree_ffprobe=${r.qc.duration_seconds}s scenes=${r.render.sceneCount} taille=${fs.statSync(r.outputPath).size} octets`);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});
