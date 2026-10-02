'use strict';

/**
 * SOUS-TITRES — construit un fichier .srt reel (format standard exploitable
 * par FFmpeg, voir src/core/videoRenderer.js) a partir des pistes vocales
 * REELLEMENT mesurees par voiceStudio.synthesizeScenes() (start_seconds/
 * end_seconds/duration_estimated_seconds issus d'une analyse de frames MP3,
 * jamais d'une estimation devinee - voir src/core/voiceStudio.js).
 *
 * Honnetete : une scene sans timing mesure (voix off non generee/echouee)
 * n'est jamais sous-titree par une duree inventee ; elle est simplement
 * absente du .srt, et signalee dans le rapport renvoye par build() pour que
 * l'appelant (orchestrateur) puisse decider d'un fallback.
 */

const DEFAULT_MAX_CHARS_PER_CHUNK = 42; // courts segments (style "gros sous-titres" video verticale courte), une ligne large plutot qu'un paragraphe empile
const MIN_CHUNK_SECONDS = 0.9; // sous-titre minimum lisible, evite un flash illisible sur mobile

function formatSrtTimestamp(totalSeconds) {
  const clamped = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(millis)}`;
}

/**
 * Decoupe un texte en segments lisibles (<= maxChars), sans jamais couper un
 * mot. Distinct de graphicEngine.wrapText (celui-ci decoupe en LIGNES pour
 * affichage simultane ; celui-ci decoupe en SEGMENTS successifs dans le
 * temps).
 */
function splitIntoChunks(text, maxChars = DEFAULT_MAX_CHARS_PER_CHUNK) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Repartit une plage [start, end] entre des chunks au prorata de leur
 * longueur en caracteres (approximation raisonnable du temps de lecture),
 * avec une duree plancher MIN_CHUNK_SECONDS pour rester lisible sur mobile
 * meme si cela deborde legerement au-dela de `end` pour le dernier chunk
 * d'une scene tres courte (mieux vaut un leger chevauchement qu'un
 * sous-titre illisible).
 */
function distributeTiming(chunks, start, end) {
  const totalDuration = Math.max(0, end - start);
  const totalChars = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
  let cursor = start;
  return chunks.map((chunk, i) => {
    const isLast = i === chunks.length - 1;
    const share = (chunk.length / totalChars) * totalDuration;
    const chunkDuration = Math.max(MIN_CHUNK_SECONDS, share);
    const chunkStart = cursor;
    const chunkEnd = isLast ? Math.max(start + totalDuration, chunkStart + chunkDuration) : chunkStart + chunkDuration;
    cursor = chunkEnd;
    return { text: chunk, start: chunkStart, end: chunkEnd };
  });
}

/**
 * Construit les entrees de sous-titres (avant serialisation .srt) a partir
 * des pistes vocales. Renvoie aussi un rapport honnete des scenes ignorees
 * (pas de timing mesure) plutot que d'echouer silencieusement.
 */
function buildEntries(tracks = [], { maxCharsPerChunk = DEFAULT_MAX_CHARS_PER_CHUNK } = {}) {
  const entries = [];
  const skipped = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const sceneId = track && (track.scene_id || track.sceneId) ? String(track.scene_id || track.sceneId) : null;
    const text = track && typeof track.text === 'string' ? track.text.trim() : '';
    const start = track ? Number(track.start_seconds) : NaN;
    const end = track ? Number(track.end_seconds) : NaN;
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      skipped.push({ scene_id: sceneId, raison: !text ? 'Aucun texte de narration pour cette scene.' : 'Timing vocal non mesure (voix off non generee ou echouee) : impossible de synchroniser un sous-titre pour cette scene sans inventer une duree.' });
      continue;
    }
    const chunks = splitIntoChunks(text, maxCharsPerChunk);
    for (const timed of distributeTiming(chunks, start, end)) {
      entries.push({ scene_id: sceneId, text: timed.text, start_seconds: timed.start, end_seconds: timed.end });
    }
  }
  return { entries, skipped };
}

function serializeSrt(entries) {
  return entries.map((entry, i) => (
    `${i + 1}\n${formatSrtTimestamp(entry.start_seconds)} --> ${formatSrtTimestamp(entry.end_seconds)}\n${entry.text}\n`
  )).join('\n');
}

/**
 * Point d'entree principal. `tracks` = voiceOverResult.tracks (voir
 * src/agents/voiceOver.js / src/core/voiceStudio.js).
 */
function build(tracks, options = {}) {
  const { entries, skipped } = buildEntries(tracks, options);
  return {
    format: 'srt',
    srt: entries.length ? serializeSrt(entries) : '',
    entry_count: entries.length,
    entries,
    scenes_ignorees: skipped,
    complet: skipped.length === 0 && entries.length > 0,
  };
}

module.exports = {
  DEFAULT_MAX_CHARS_PER_CHUNK,
  MIN_CHUNK_SECONDS,
  formatSrtTimestamp,
  splitIntoChunks,
  distributeTiming,
  buildEntries,
  serializeSrt,
  build,
};
