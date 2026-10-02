'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

/**
 * VIDEO RENDERER — le "RENDER WORKER" reel de l'architecture (voir mission
 * Video Engine, section renderer). Compose des images fixes + une bande son
 * (voix reelle ou silence explicite) + des sous-titres en un vrai fichier
 * MP4 via FFmpeg (deja present dans cet environnement).
 *
 * SEPARATION ORCHESTRATOR / RENDER WORKER (mission) : ce module ne fait
 * QUE de la composition locale a partir de fichiers deja sur disque — il ne
 * telecharge rien, n'appelle aucune API, ne connait ni les jobs ni Supabase.
 * C'est deliberement le SEUL point du pipeline qui a besoin d'executer
 * FFmpeg, ce qui permet de l'extraire tel quel dans un worker externe
 * (process autonome, petite machine toujours active, tache planifiee) sans
 * toucher au reste de Conquistador OS — voir scripts/render-worker.js et
 * docs/VIDEO_ENGINE.md (limite connue : les fonctions Netlify standard ont
 * un timeout d'execution, voir netlify.toml, incompatible avec un rendu
 * FFmpeg de plusieurs dizaines de secondes ; ce module fonctionne
 * neanmoins de facon identique, en local ou dans un worker externe).
 */

const DEFAULT_FPS = 30;
const AUDIO_SAMPLE_RATE = 44100;

function which(bin) {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

async function isAvailable() {
  const [ffmpeg] = await Promise.all([which('ffmpeg')]);
  return ffmpeg;
}

function runFfmpeg(args, { timeoutMs = 120000, label = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${label}: delai de rendu depasse (${timeoutMs}ms) — voir docs/VIDEO_ENGINE.md sur les limites d'execution en environnement serverless.`));
    }, timeoutMs);
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`${label}: ffmpeg introuvable ou non executable : ${err.message}`)); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`${label}: ffmpeg a echoue (code ${code}) : ${stderr.trim().slice(0, 600)}`)); return; }
      resolve({ stderr });
    });
  });
}

/** Segment video muet a partir d'une image fixe, duree et dimensions exactes. */
async function renderStillClip({ imagePath, durationSeconds, width, height, outputPath, fps = DEFAULT_FPS }) {
  const duration = Math.max(0.34, Number(durationSeconds) || 1);
  await runFfmpeg([
    '-loop', '1', '-i', imagePath,
    '-t', duration.toFixed(3),
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    outputPath,
  ], { label: `renderStillClip(${path.basename(outputPath)})` });
  return { outputPath, durationSeconds: duration };
}

/** Concatene des clips video (memes parametres d'encodage) sans reencodage. */
async function concatClips(clipPaths, outputPath, workDir) {
  const listPath = path.join(workDir, `concat-${Date.now()}.txt`);
  const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listPath, listContent, 'utf8');
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath], { label: 'concatClips' });
  return outputPath;
}

/** Normalise un segment audio a une duree EXACTE (silence si absent, pad/trim sinon) — garantit que la piste audio combinee a exactement la meme duree que la piste video combinee. */
async function normalizeAudioSegment({ sourcePath, durationSeconds, outputPath }) {
  const duration = Math.max(0.34, Number(durationSeconds) || 1);
  if (!sourcePath) {
    await runFfmpeg([
      '-f', 'lavfi', '-i', `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`,
      '-t', duration.toFixed(3), '-c:a', 'aac',
      outputPath,
    ], { label: 'normalizeAudioSegment(silence)' });
    return { outputPath, source: 'silence', durationSeconds: duration };
  }
  await runFfmpeg([
    '-i', sourcePath,
    '-af', `apad=whole_dur=${duration.toFixed(3)}`,
    '-t', duration.toFixed(3),
    '-ar', String(AUDIO_SAMPLE_RATE), '-c:a', 'aac',
    outputPath,
  ], { label: 'normalizeAudioSegment(voice)' });
  return { outputPath, source: 'voice', durationSeconds: duration };
}

/** Brule les sous-titres (.srt, libass) sur une video deja composee. */
async function burnSubtitles({ videoPath, srtPath, outputPath, fontSizePx, marginVPx }) {
  const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const style = `FontName=IBM Plex Sans,FontSize=${fontSizePx || 20},PrimaryColour=&H00ece4d3,OutlineColour=&H00101a2e,BorderStyle=1,Outline=2,Shadow=0,MarginV=${marginVPx || 90},Alignment=2`;
  await runFfmpeg([
    '-i', videoPath,
    '-vf', `subtitles='${escapedSrt}':force_style='${style}'`,
    '-c:a', 'copy',
    outputPath,
  ], { label: 'burnSubtitles' });
  return outputPath;
}

/**
 * Point d'entree principal. `scenes` = liste ORDONNEE {scene_id,
 * duration_seconds, image_path} correspondant exactement a la timeline du
 * manifeste. `audioSegments` (optionnel) = Map/objet scene_id -> chemin
 * audio LOCAL deja resolu par l'appelant (le Renderer ne telecharge jamais
 * rien lui-meme - separation orchestrator/render worker). Une scene sans
 * segment audio recoit du silence explicite pour cette duree (jamais de
 * voix inventee).
 */
async function renderManifest({
  scenes = [],
  audioSegments = {},
  subtitlesSrtPath = null,
  width = 1080,
  height = 1920,
  fps = DEFAULT_FPS,
  outputPath,
  workDir,
} = {}) {
  if (!outputPath) throw new Error('videoRenderer.renderManifest: "outputPath" est requis');
  if (!workDir) throw new Error('videoRenderer.renderManifest: "workDir" est requis');
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('videoRenderer.renderManifest: au moins une scene est requise');

  const available = await isAvailable();
  if (!available) {
    const err = new Error('videoRenderer: ffmpeg indisponible dans cet environnement (BLOCKED_BY_EXTERNAL_INFRASTRUCTURE) — voir docs/VIDEO_ENGINE.md pour deployer un worker de rendu avec ffmpeg installe.');
    err.blockedByInfrastructure = true;
    throw err;
  }

  await fs.mkdir(workDir, { recursive: true });

  const videoClips = [];
  const audioClips = [];
  let audioSourcesUsed = new Set();
  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i];
    if (!scene.image_path) throw new Error(`videoRenderer.renderManifest: scene "${scene.scene_id || i}" n'a pas d'asset image resolu (image_path manquant) — le rendu ne peut pas inventer un visuel manquant.`);
    const duration = Number(scene.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`videoRenderer.renderManifest: duree invalide pour la scene "${scene.scene_id || i}".`);

    // eslint-disable-next-line no-await-in-loop
    const clip = await renderStillClip({
      imagePath: scene.image_path,
      durationSeconds: duration,
      width, height, fps,
      outputPath: path.join(workDir, `clip-${String(i).padStart(3, '0')}.mp4`),
    });
    videoClips.push(clip.outputPath);

    const audioSourcePath = audioSegments && audioSegments[scene.scene_id] ? audioSegments[scene.scene_id] : null;
    // eslint-disable-next-line no-await-in-loop
    const audioSegment = await normalizeAudioSegment({
      sourcePath: audioSourcePath,
      durationSeconds: duration,
      outputPath: path.join(workDir, `audio-${String(i).padStart(3, '0')}.m4a`),
    });
    audioClips.push(audioSegment.outputPath);
    audioSourcesUsed.add(audioSegment.source);
  }

  const silentVideoPath = path.join(workDir, 'video-silent.mp4');
  await concatClips(videoClips, silentVideoPath, workDir);

  const combinedAudioPath = path.join(workDir, 'audio-combined.m4a');
  await concatClips(audioClips, combinedAudioPath, workDir);

  const withAudioPath = path.join(workDir, 'video-with-audio.mp4');
  await runFfmpeg([
    '-i', silentVideoPath, '-i', combinedAudioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest',
    withAudioPath,
  ], { label: 'muxAudio' });

  let finalPath = withAudioPath;
  if (subtitlesSrtPath) {
    finalPath = path.join(workDir, 'video-final.mp4');
    // Valeurs calibrees empiriquement dans cet environnement (voir
    // CONQUISTADOR_PROGRESS.md) : libass applique une mise a l'echelle
    // interne au rendu SRT qui rend FontSize non directement proportionnel
    // aux pixels video ; ratios verifies visuellement sur un rendu reel
    // 1080x1920 (sous-titre lisible, bas de l'ecran, ne couvre pas le
    // visage).
    await burnSubtitles({
      videoPath: withAudioPath,
      srtPath: subtitlesSrtPath,
      outputPath: finalPath,
      fontSizePx: Math.max(11, Math.round(width / 72)),
      marginVPx: Math.round(height / 32),
    });
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(finalPath, outputPath);

  const totalDurationSeconds = scenes.reduce((sum, s) => sum + (Number(s.duration_seconds) || 0), 0);
  return {
    outputPath,
    durationSeconds: totalDurationSeconds,
    sceneCount: scenes.length,
    audioSource: audioSourcesUsed.has('voice') && audioSourcesUsed.has('silence')
      ? 'mixed'
      : (audioSourcesUsed.has('voice') ? 'voice' : 'silence'),
    subtitlesBurned: Boolean(subtitlesSrtPath),
  };
}

module.exports = { isAvailable, renderStillClip, concatClips, normalizeAudioSegment, burnSubtitles, renderManifest };
