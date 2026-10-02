'use strict';

/**
 * SCRIPT DE VERIFICATION DES VIDEOS LONGUES (diagnostic executable, hors suite
 * de tests) : rend de VRAIS MP4 de 37 / 45 / 60 / 90 s avec FFmpeg, les
 * analyse avec ffprobe et ecrit un rapport de preuve JSON.
 *
 * Usage : node scripts/verify-long-videos.js [--keep]
 * Sortie : docs/evidence/long-video-tests.json + resume console.
 *
 * Aucun appel reseau, aucun secret, aucun faux succes : si ffmpeg n'est pas
 * disponible, le script le dit explicitement et sort en code 2.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');

const sharp = require('sharp');
const videoRenderer = require('../src/core/videoRenderer');
const videoFileQualityCheck = require('../src/core/videoFileQualityCheck');
const videoTimeline = require('../src/core/videoTimeline');
const subtitles = require('../src/core/subtitles');

const ASSETS = path.join(__dirname, '..', 'assets');
const EVIDENCE_DIR = path.join(__dirname, '..', 'docs', 'evidence');
const WIDTH = 240;
const HEIGHT = 426;
const FPS = 30;
const TARGETS = [
  { seconds: 37, scenes: 7 },
  { seconds: 45, scenes: 8 },
  { seconds: 60, scenes: 9 },
  { seconds: 90, scenes: 10 },
];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function buildVisuals(dir, count) {
  const sources = [
    path.join(ASSETS, 'personnages', 'samuel', 'samuel-reference-principale.jpeg'),
    path.join(ASSETS, 'personnages', 'marc', 'marc-reference-principale.jpg'),
    path.join(ASSETS, 'logo', 'logo-savoir-utile-officiel.jpeg'),
  ];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const p = path.join(dir, `visual-${i}.jpg`);
    // eslint-disable-next-line no-await-in-loop
    await sharp(sources[i % sources.length]).resize(WIDTH, HEIGHT, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(p);
    out.push(p);
  }
  return out;
}

async function verifyOne({ seconds, scenes }, keep) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `conquistador-verify-${seconds}s-`));
  const plan = videoTimeline.planTargetDuration({ targetSeconds: seconds, sceneCount: scenes });
  const sceneList = plan.scenes.map((s, i) => ({
    id: `scene_${String(i + 1).padStart(2, '0')}`,
    voix_off_scene: `Narration reelle de la scene ${i + 1} pour la video de ${seconds} secondes.`,
  }));
  const visuals = await buildVisuals(dir, sceneList.length);

  let cursor = 0;
  const tracks = plan.scenes.map((s, i) => {
    const t = {
      scene_id: sceneList[i].id,
      text: sceneList[i].voix_off_scene,
      start_seconds: Number(cursor.toFixed(3)),
      end_seconds: Number((cursor + s.duration_seconds).toFixed(3)),
    };
    cursor += s.duration_seconds;
    return t;
  });

  const timeline = videoTimeline.buildTimeline({ scenes: sceneList, voiceTracks: tracks, fps: FPS });
  const timelineValidation = videoTimeline.validateTimeline(timeline, { expectedDurationSeconds: seconds });
  const subs = subtitles.build(tracks);
  const srtPath = path.join(dir, 'subtitles.srt');
  fs.writeFileSync(srtPath, subs.srt, 'utf8');

  const outputPath = path.join(dir, 'output.mp4');
  const startedAt = Date.now();
  const render = await videoRenderer.renderManifest({
    scenes: timeline.scenes.map((s, i) => ({ scene_id: s.scene_id, duration_seconds: s.duration_seconds, image_path: visuals[i] })),
    audioSegments: {},
    subtitlesSrtPath: srtPath,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    outputPath,
    workDir: path.join(dir, 'render'),
  });
  const renderMs = Date.now() - startedAt;

  const qc = await videoFileQualityCheck.check(outputPath, {
    expected: {
      width: WIDTH,
      height: HEIGHT,
      ratio: WIDTH / HEIGHT,
      minDurationSeconds: seconds,
      expectedSceneCount: timeline.scene_count,
      assetsUsed: visuals.map((v, i) => ({ scene_id: `scene_${i}`, ok: true })),
    },
  });
  const probe = await videoFileQualityCheck.runFfprobe(outputPath);
  const videoStream = (probe.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (probe.streams || []).find((s) => s.codec_type === 'audio');

  const report = {
    cible_secondes: seconds,
    scenes: timeline.scene_count,
    timeline_total_secondes: timeline.total_duration_seconds,
    timeline_valide: timelineValidation.ok,
    timeline_controle_limite_artificielle: timelineValidation.checks.find((c) => c.id === 'limite_duree_artificielle').status,
    temps_rendu_ms: renderMs,
    mp4: outputPath,
    taille_octets: fs.statSync(outputPath).size,
    duration: qc.duration_seconds,
    ffprobe: {
      format_name: probe.format.format_name,
      duration: probe.format.duration,
      size: probe.format.size,
      video_codec: videoStream ? videoStream.codec_name : null,
      width: videoStream ? videoStream.width : null,
      height: videoStream ? videoStream.height : null,
      avg_frame_rate: videoStream ? videoStream.avg_frame_rate : null,
      audio_codec: audioStream ? audioStream.codec_name : null,
      audio_sample_rate: audioStream ? audioStream.sample_rate : null,
      has_video: Boolean(videoStream),
      has_audio: Boolean(audioStream),
    },
    sous_titres: { entries: subs.entry_count, brules: render.subtitlesBurned },
    qc_ok: qc.ok,
    qc_checks: qc.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
    ecart_secondes: Number(Math.abs((qc.duration_seconds || 0) - seconds).toFixed(3)),
  };
  if (keep) {
    const kept = path.join(EVIDENCE_DIR, `video-${seconds}s.mp4`);
    await fsp.mkdir(EVIDENCE_DIR, { recursive: true });
    await fsp.copyFile(outputPath, kept);
    report.mp4_conserve = kept;
  }
  await fsp.rm(dir, { recursive: true, force: true });
  return report;
}

async function main() {
  const keep = process.argv.includes('--keep');
  log('=== VERIFICATION VIDEOS LONGUES — CONQUISTADOR OS ===');
  const ffmpegOk = await videoRenderer.isAvailable();
  const ffprobeOk = await videoFileQualityCheck.ffprobeAvailable();
  log(`ffmpeg: ${ffmpegOk ? 'disponible' : 'ABSENT'} | ffprobe: ${ffprobeOk ? 'disponible' : 'ABSENT'}`);
  if (!ffmpegOk || !ffprobeOk) {
    log('RENDU IMPOSSIBLE dans cet environnement : ffmpeg/ffprobe indisponibles. Aucun resultat ne sera simule.');
    process.exit(2);
  }

  const reports = [];
  for (const t of TARGETS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await verifyOne(t, keep);
    reports.push(r);
    log(`[${t.seconds}s] duree_ffprobe=${r.duration}s | scenes=${r.scenes} | ${r.ffprobe.width}x${r.ffprobe.height} | ${r.ffprobe.video_codec}/${r.ffprobe.audio_codec} | fps=${r.ffprobe.avg_frame_rate} | taille=${r.taille_octets} | QC=${r.qc_ok ? 'OK' : 'ECHEC'} | ecart=${r.ecart_secondes}s | rendu=${r.temps_rendu_ms}ms`);
  }

  const summary = {
    genere_le: new Date().toISOString(),
    environnement: { ffmpeg: ffmpegOk, ffprobe: ffprobeOk, resolution_test: `${WIDTH}x${HEIGHT}`, fps: FPS },
    resultats: reports,
    conclusion: reports.every((r) => r.qc_ok) ? 'TOUS les rendus 37/45/60/90 s sont valides et verifies par ffprobe.' : 'AU MOINS UN RENDU A ECHOUE au controle qualite : voir qc_checks.',
  };
  await fsp.mkdir(EVIDENCE_DIR, { recursive: true });
  const dest = path.join(EVIDENCE_DIR, 'long-video-tests.json');
  await fsp.writeFile(dest, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  log(`\nRapport ecrit : ${dest}`);
  log(summary.conclusion);
  process.exit(reports.every((r) => r.qc_ok) ? 0 : 1);
}

main().catch((err) => {
  log(`ECHEC: ${err.message}`);
  process.exit(1);
});
