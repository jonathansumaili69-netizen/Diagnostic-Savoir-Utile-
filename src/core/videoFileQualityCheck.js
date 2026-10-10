'use strict';

const fs = require('fs/promises');
const { spawn } = require('child_process');
const mediaProvenance = require('./mediaProvenance');

/**
 * VIDEO FILE QUALITY CHECK — controle reel du FICHIER MP4 produit par le
 * Video Renderer (voir videoRenderer.js), via ffprobe (analyse du
 * conteneur/des flux reels, aucune estimation). DISTINCT de
 * src/agents/videoQuality.js, qui revoit le MANIFESTE (plan de la video,
 * avant tout rendu) — les deux existent et se completent : le manifeste
 * doit etre conforme AVANT le rendu, le fichier doit etre valide APRES.
 *
 * Principe absolu (mission) : une video invalide n'est JAMAIS declaree
 * COMPLETED. Ce module ne fait que constater des faits verifiables sur le
 * fichier ; c'est l'orchestrateur (videoOrchestrator.js) qui decide du
 * statut final du job a partir de `ok`.
 */

function ffprobeAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (err) => reject(new Error(`ffprobe introuvable ou non executable : ${err.message}`)));
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe a echoue (code ${code}) : ${stderr.trim().slice(0, 400)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Sortie ffprobe illisible (JSON invalide) : ${err.message}`));
      }
    });
  });
}

/**
 * Analyse un fichier video et renvoie une liste de controles individuels
 * (chacun avec id/statut/detail), plus `ok` = tous les controles bloquants
 * ont reussi. Ne leve jamais pour un fichier invalide (ce n'est pas une
 * exception, c'est le resultat attendu d'un controle) ; leve uniquement si
 * ffprobe lui-meme est indisponible (INFRASTRUCTURE, pas une propriete du
 * fichier) - voir `blocked_by_infrastructure` dans le resultat.
 */
async function check(filePath, { expected = {} } = {}) {
  const checks = [];
  const push = (id, status, detail) => checks.push({ id, status, detail });

  let fileStat;
  try {
    fileStat = await fs.stat(filePath);
  } catch (err) {
    push('fichier_existe', 'fail', `Fichier introuvable a "${filePath}" : ${err.message}`);
    return finalize(checks, { blocked: false });
  }
  push('fichier_existe', 'pass', `Fichier present (${fileStat.size} octets).`);
  if (fileStat.size === 0) {
    push('taille_fichier', 'fail', 'Le fichier existe mais est vide (0 octet).');
    return finalize(checks, { blocked: false });
  }
  push('taille_fichier', fileStat.size < 1024 ? 'warn' : 'pass', `Taille du fichier : ${fileStat.size} octets.`);

  const probeAvailable = await ffprobeAvailable();
  if (!probeAvailable) {
    push('ffprobe_disponible', 'blocked', "ffprobe n'est pas installe/accessible dans cet environnement : le contenu du fichier ne peut pas etre verifie ici. BLOCKED_BY_EXTERNAL_INFRASTRUCTURE, pas une propriete du fichier lui-meme.");
    return finalize(checks, { blocked: true });
  }

  let probe;
  try {
    probe = await runFfprobe(filePath);
  } catch (err) {
    push('conteneur_valide', 'fail', `ffprobe n'a pas pu lire ce fichier comme un conteneur video valide : ${err.message}`);
    return finalize(checks, { blocked: false });
  }
  push('conteneur_valide', 'pass', 'Conteneur lisible par ffprobe.');

  const format = probe.format || {};
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const durationSeconds = Number(format.duration) || (videoStream ? Number(videoStream.duration) : NaN);

  if (expected.requireMp4Container) {
    const isMp4 = String(format.format_name || '').split(',').some((name) => ['mp4', 'mov'].includes(name));
    push('conteneur_mp4', isMp4 ? 'pass' : 'fail', isMp4
      ? `Conteneur MP4/MOV vérifié (${format.format_name}).`
      : `Conteneur non MP4/MOV (${format.format_name || 'inconnu'}).`);
  }

  push('duree_positive', Number.isFinite(durationSeconds) && durationSeconds > 0 ? 'pass' : 'fail',
    Number.isFinite(durationSeconds) && durationSeconds > 0 ? `Duree mesuree : ${durationSeconds.toFixed(2)}s.` : 'Duree nulle, negative ou non mesurable.');

  push('piste_video', videoStream ? 'pass' : 'fail', videoStream ? `Piste video presente (codec ${videoStream.codec_name || 'inconnu'}).` : 'Aucune piste video dans le fichier.');
  push('piste_audio', audioStream ? 'pass' : 'fail', audioStream ? `Piste audio presente (codec ${audioStream.codec_name || 'inconnu'}).` : 'Aucune piste audio dans le fichier.');

  if (expected.minDurationSecondsStrict != null) {
    const minimumOk = Number.isFinite(durationSeconds) && durationSeconds >= Number(expected.minDurationSecondsStrict);
    push('duree_minimale_stricte', minimumOk ? 'pass' : 'fail', minimumOk
      ? `Durée ffprobe ${durationSeconds.toFixed(2)} s ≥ ${expected.minDurationSecondsStrict} s.`
      : `Durée ffprobe ${Number.isFinite(durationSeconds) ? durationSeconds.toFixed(2) : 'non mesurée'} s < ${expected.minDurationSecondsStrict} s.`);
  }
  if (expected.maxDurationSeconds != null) {
    const maximumOk = Number.isFinite(durationSeconds) && durationSeconds <= Number(expected.maxDurationSeconds);
    push('duree_maximale_stricte', maximumOk ? 'pass' : 'fail', maximumOk
      ? `Durée ffprobe ${durationSeconds.toFixed(2)} s ≤ ${expected.maxDurationSeconds} s.`
      : `Durée ffprobe ${Number.isFinite(durationSeconds) ? durationSeconds.toFixed(2) : 'non mesurée'} s > ${expected.maxDurationSeconds} s.`);
  }

  if (expected.requireH264) {
    const h264 = Boolean(videoStream && String(videoStream.codec_name).toLowerCase() === 'h264');
    push('codec_video_h264', h264 ? 'pass' : 'fail', h264 ? 'Codec vidéo H.264 vérifié.' : `Codec vidéo attendu H.264, mesuré ${videoStream && videoStream.codec_name || 'absent'}.`);
  }
  if (expected.requireAAC) {
    const aac = Boolean(audioStream && String(audioStream.codec_name).toLowerCase() === 'aac');
    push('codec_audio_aac', aac ? 'pass' : 'fail', aac ? 'Codec audio AAC vérifié.' : `Codec audio attendu AAC, mesuré ${audioStream && audioStream.codec_name || 'absent'}.`);
  }

  if (videoStream) {
    const width = Number(videoStream.width) || 0;
    const height = Number(videoStream.height) || 0;
    push('resolution', width > 0 && height > 0 ? 'pass' : 'fail', width > 0 && height > 0 ? `Resolution : ${width}x${height}.` : 'Resolution non determinee.');
    if (expected.minWidth != null || expected.minHeight != null) {
      const minWidth = Number(expected.minWidth) || 0;
      const minHeight = Number(expected.minHeight) || 0;
      const enough = width >= minWidth && height >= minHeight;
      push('resolution_minimale', enough ? 'pass' : 'fail', enough
        ? `Résolution ${width}×${height} respecte le minimum ${minWidth}×${minHeight}.`
        : `Résolution ${width}×${height} inférieure au minimum ${minWidth}×${minHeight}.`);
    }
    if (expected.width && expected.height && width > 0 && height > 0) {
      const matches = width === expected.width && height === expected.height;
      push('resolution_attendue', matches ? 'pass' : 'warn', matches
        ? `Resolution conforme au format demande (${expected.width}x${expected.height}).`
        : `Resolution ${width}x${height} differente de celle demandee (${expected.width}x${expected.height}).`);
    }
    if (expected.ratio && width > 0 && height > 0) {
      const actualRatio = width / height;
      const ratioDelta = Math.abs(actualRatio - expected.ratio) / expected.ratio;
      push('ratio', ratioDelta < 0.02 ? 'pass' : 'warn', `Ratio mesure ${actualRatio.toFixed(3)} (attendu ~${expected.ratio.toFixed(3)}).`);
    }
    const fps = videoStream.avg_frame_rate && videoStream.avg_frame_rate !== '0/0'
      ? Number(videoStream.avg_frame_rate.split('/')[0]) / Number(videoStream.avg_frame_rate.split('/')[1] || 1)
      : NaN;
    push('fps', Number.isFinite(fps) && fps > 0 ? 'pass' : 'warn', Number.isFinite(fps) && fps > 0 ? `${fps.toFixed(2)} images/seconde.` : 'FPS non determinable.');
    if (expected.expectedFps != null) {
      const fpsOk = Number.isFinite(fps) && Math.abs(fps - Number(expected.expectedFps)) < 0.1;
      push('fps_attendu', fpsOk ? 'pass' : 'fail', fpsOk
        ? `${fps.toFixed(2)} fps conforme à la cible ${expected.expectedFps}.`
        : `Fréquence attendue ${expected.expectedFps} fps, mesurée ${Number.isFinite(fps) ? fps.toFixed(2) : 'inconnue'}.`);
    }
  }

  if (expected.minDurationSeconds && Number.isFinite(durationSeconds)) {
    const okDuration = durationSeconds >= expected.minDurationSeconds * 0.9;
    push('duree_coherente', okDuration ? 'pass' : 'warn', `Duree ${durationSeconds.toFixed(2)}s vs attendue ~${expected.minDurationSeconds}s (timeline du manifeste).`);
  }

  if (expected.expectedSceneCount && Array.isArray(expected.assetsUsed)) {
    const missing = expected.expectedSceneCount - expected.assetsUsed.length;
    push('assets_presents', missing <= 0 ? 'pass' : 'fail', missing <= 0
      ? `Les ${expected.expectedSceneCount} scene(s) attendue(s) ont toutes un asset associe.`
      : `${missing} scene(s) sur ${expected.expectedSceneCount} sans asset associe.`);
  }

  if (Array.isArray(expected.sceneAssets)) {
    const audit = await mediaProvenance.auditAssetCollection(expected.sceneAssets, { exampleRoot: expected.styleExampleRoot });
    push('assets_provenance_distincts', audit.ok ? 'pass' : 'fail', audit.ok
      ? `${audit.assets_checked} asset(s) source audité(s); aucun exemple de style ni quasi-doublon détecté.`
      : `Audit de provenance refusé (${audit.rejected.length} asset(s) rejeté(s), ${audit.duplicates.length} doublon(s), ${audit.examples_available} exemple(s) indexé(s)).`);
  }

  if (Array.isArray(expected.renderedSceneFrames)) {
    const frameAudit = await mediaProvenance.auditRenderedVideo(filePath, expected.renderedSceneFrames, { exampleRoot: expected.styleExampleRoot });
    push('frames_rendues_sans_exemples', frameAudit.ok ? 'pass' : 'fail', frameAudit.ok
      ? `${frameAudit.frames_checked} frame(s) du MP4 échantillonnée(s) et comparée(s) aux ${frameAudit.examples_available} exemple(s); aucun match.`
      : `Audit des frames échoué ou bloqué : ${frameAudit.reason || `${frameAudit.rejected.length} frame(s) correspondante(s); ${frameAudit.examples_available} exemple(s) indexé(s).`}`);
  }

  return finalize(checks, { blocked: false, format, videoStream, audioStream, durationSeconds });
}

function finalize(checks, { blocked, format, videoStream, audioStream, durationSeconds } = {}) {
  const hasFailure = checks.some((c) => c.status === 'fail');
  const hasBlocked = checks.some((c) => c.status === 'blocked');
  return {
    ok: !blocked && !hasFailure && !hasBlocked,
    blocked_by_infrastructure: blocked || hasBlocked,
    checks,
    duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    has_video: Boolean(videoStream),
    has_audio: Boolean(audioStream),
    format_name: format ? format.format_name : null,
  };
}

module.exports = { check, ffprobeAvailable, runFfprobe };
