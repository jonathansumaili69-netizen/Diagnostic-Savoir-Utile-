'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

function isInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (error) => reject(new Error(`ffprobe indisponible pour la voix locale: ${error.message}`)));
    proc.on('close', (code) => {
      const duration = Number(stdout.trim());
      if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
        reject(new Error(`Durée audio locale illisible pour ${path.basename(filePath)}: ${stderr.trim() || stdout.trim() || `ffprobe ${code}`}`));
        return;
      }
      resolve(duration);
    });
  });
}

async function loadTracks(scenes = [], suppliedTracks = [], { allowedRoot } = {}) {
  if (!allowedRoot) throw new Error('Voix locale bloquée: CONQUISTADOR_LOCAL_AUDIO_ROOT doit désigner un dossier de staging autorisé.');
  const realRoot = await fs.realpath(path.resolve(allowedRoot));
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('Voix locale: manifeste sans scènes.');
  if (!Array.isArray(suppliedTracks) || suppliedTracks.length !== scenes.length) {
    throw new Error(`Voix locale: ${scenes.length} piste(s) étaient attendues; ${Array.isArray(suppliedTracks) ? suppliedTracks.length : 0} fournie(s).`);
  }
  const byId = new Map(suppliedTracks.map((track) => [String(track.scene_id || ''), track]));
  if (byId.size !== scenes.length || [...byId.keys()].some((id) => !id)) throw new Error('Voix locale: identifiants de scène manquants ou dupliqués.');
  let cursor = 0;
  const tracks = [];
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index] || {};
    const sceneId = String(scene.id || scene.scene_id || `scene_${index + 1}`);
    const supplied = byId.get(sceneId);
    if (!supplied) throw new Error(`Voix locale: piste manquante pour ${sceneId}.`);
    const candidate = path.resolve(String(supplied.local_path || supplied.path || ''));
    if (!path.isAbsolute(candidate) || candidate === path.parse(candidate).root) throw new Error(`Voix locale: chemin invalide pour ${sceneId}.`);
    if (!AUDIO_EXTENSIONS.has(path.extname(candidate).toLowerCase())) throw new Error(`Voix locale: format non accepté pour ${sceneId}; formats audio locaux uniquement.`);
    const localPath = await fs.realpath(candidate);
    if (!isInside(localPath, realRoot)) throw new Error(`Voix locale: ${sceneId} est hors du dossier de staging autorisé.`);
    const stat = await fs.stat(localPath);
    if (!stat.isFile() || stat.size < 1024) throw new Error(`Voix locale: fichier absent ou trop petit pour ${sceneId}.`);
    const duration = await probeDuration(localPath);
    const text = String(supplied.text || scene.voix_off_scene || '').trim();
    if (!text) throw new Error(`Voix locale: texte de narration manquant pour ${sceneId}.`);
    tracks.push({
      scene_id: sceneId,
      text,
      source: 'local_generated_audio',
      local_path: localPath,
      provider: String(supplied.provider || 'local_audio_file'),
      voice: String(supplied.voice || 'Voix IA locale — licence à vérifier'),
      duration_estimated_seconds: duration,
      duration_measured_seconds: duration,
      start_seconds: cursor,
      end_seconds: cursor + duration,
      audio_source: 'local_file',
    });
    cursor += duration;
  }
  return {
    configured: true,
    provider: 'local_audio_files',
    voice: tracks[0] ? tracks[0].voice : 'local_audio_files',
    source: 'local_preview_user_supplied_tracks',
    reason: 'Pistes audio locales inspectées et durées mesurées par ffprobe; aucun endpoint vocal distant utilisé.',
    total_duration_estimated_seconds: cursor,
    total_duration_measured_seconds: cursor,
    tracks,
  };
}

module.exports = { AUDIO_EXTENSIONS, isInside, probeDuration, loadTracks };
