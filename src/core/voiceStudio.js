'use strict';

const { config, int } = require('./config');
const mediaStorage = require('./mediaStorage');
const { logger } = require('./logger');

const DEFAULT_VOICE_ID = 'fr-FR-RemyMultilingualNeural';
const TIMEOUT_MS = int(process.env.VOICE_STUDIO_TIMEOUT_MS, 15000);

// Tables MPEG standard (versions 1/2/2.5, layers I/II/III) utilisees par
// estimateMp3DurationSeconds() ci-dessous. Le studio Remy Neural (edge-tts)
// produit habituellement du MPEG audio a 24 kHz (version 2), mais ces tables
// couvrent aussi le cas MPEG1 44.1/48 kHz par prudence si le studio change
// de format un jour.
const MPEG_BITRATES_V1 = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const MPEG_BITRATES_V2 = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
const MPEG_SAMPLES_PER_FRAME = {
  1: { 1: 384, 2: 1152, 3: 1152 },
  2: { 1: 384, 2: 1152, 3: 576 },
  2.5: { 1: 384, 2: 1152, 3: 576 },
};

/**
 * Estimation honnête de la durée d'un MP3 par analyse réelle des en-têtes de
 * frame (MPEG version 1/2/2.5, layer I/II/III), sans dépendance externe.
 * Renvoie null (jamais une valeur inventée) si aucune frame valide n'est
 * trouvée. Utilisée pour construire une timeline voix/scènes exploitable par
 * l'agent de contrôle qualité vidéo (voir src/agents/videoQuality.js).
 */
function estimateMp3DurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  let offset = 0;
  if (buffer.length > 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size;
  }
  let totalSeconds = 0;
  let framesFound = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const b1 = buffer[offset + 1];
    const b2 = buffer[offset + 2];
    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    const version = { 0: 2.5, 2: 2, 3: 1 }[versionBits];
    const layer = { 1: 3, 2: 2, 3: 1 }[layerBits];
    if (version === undefined || layer === undefined) {
      offset += 1;
      continue;
    }
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const sampleRateIndex = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;
    if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 3) {
      offset += 1;
      continue;
    }
    const bitrateTable = (version === 1 ? MPEG_BITRATES_V1 : MPEG_BITRATES_V2)[layer];
    const bitrateKbps = bitrateTable ? bitrateTable[bitrateIndex] : undefined;
    const sampleRate = MPEG_SAMPLE_RATES[version] ? MPEG_SAMPLE_RATES[version][sampleRateIndex] : undefined;
    if (!bitrateKbps || !sampleRate) {
      offset += 1;
      continue;
    }
    const samplesPerFrame = MPEG_SAMPLES_PER_FRAME[version][layer];
    const frameSize = layer === 1
      ? (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;
    if (frameSize <= 0) {
      offset += 1;
      continue;
    }
    totalSeconds += samplesPerFrame / sampleRate;
    framesFound += 1;
    offset += frameSize;
  }
  return framesFound > 0 ? totalSeconds : null;
}

function studioBaseUrl() {
  return String(config.brand.voiceApiUrl || '').trim().replace(/\/$/, '');
}

function assertConfigured() {
  const base = studioBaseUrl();
  if (!base) throw new Error('VOICE_STUDIO_API_URL non configurée');
  let parsed;
  try { parsed = new URL(base); } catch (err) { throw new Error('VOICE_STUDIO_API_URL invalide'); }
  if (parsed.protocol !== 'https:') throw new Error('VOICE_STUDIO_API_URL doit utiliser HTTPS en production');
  return base;
}

async function request(path, options = {}) {
  const base = assertConfigured();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Studio vocal HTTP ${response.status}: ${body.slice(0, 180)}`);
    }
    return response;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Le studio vocal a dépassé le délai autorisé');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function health() {
  try {
    const response = await request('/health');
    const data = await response.json();
    const available = data.neural === true || data.edge === true;
    const reason = available
      ? null
      : String(data.reason || data.error || `Le endpoint /health répond mais n’annonce aucun moteur disponible (neural=${data.neural === true}, edge=${data.edge === true}).`);
    return { configured: true, available, provider: config.brand.voiceProvider, voice: config.brand.voiceName, reason };
  } catch (err) {
    return { configured: Boolean(studioBaseUrl()), available: false, provider: config.brand.voiceProvider, voice: config.brand.voiceName, reason: err.message };
  }
}

async function synthesize({ text, rate = '+0%', voiceId = DEFAULT_VOICE_ID } = {}) {
  const cleanText = typeof text === 'string' ? text.trim() : '';
  if (!cleanText) throw new Error('Le texte de voix off est requis');
  if (cleanText.length > 50000) throw new Error('Le texte de voix off dépasse 50000 caractères');
  if (voiceId !== DEFAULT_VOICE_ID) throw new Error('Cette voix Rémy Neural n’est pas autorisée');
  const safeRate = /^[-+]\d+%$/.test(String(rate)) ? String(rate) : '+0%';
  const response = await request('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: cleanText, edge_voice: DEFAULT_VOICE_ID, rate: safeRate }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Le studio vocal n’a renvoyé aucun audio');
  return { buffer, contentType: response.headers.get('content-type') || 'audio/mpeg', voice: config.brand.voiceName, provider: config.brand.voiceProvider };
}

/**
 * Genere la voix off d'une liste de scenes (pipeline video, cahier des
 * charges section "integration Remy Neural"). Chaque scene est envoyee
 * sequentiellement au studio vocal (une requete a la fois : le studio local
 * de l'utilisateur n'est pas dimensionne pour du parallele), sa duree reelle
 * est mesuree par analyse des frames MP3, puis le fichier est stocke de
 * facon durable via mediaStorage (Supabase Storage) s'il est configure.
 *
 * Ne pretend jamais qu'un enregistrement audio existe si le studio n'est pas
 * configure ou si une scene echoue : chaque piste renvoyee documente
 * honnetement son propre etat (voir `configured`, `audio_url: null` +
 * `raison`).
 */
async function synthesizeScenes(scenes = [], { rate = '+0%', uploadPathPrefix = 'voix-off' } = {}) {
  if (!studioBaseUrl()) {
    return {
      configured: false,
      raison: 'VOICE_STUDIO_API_URL non configurée : aucune voix off ne peut être générée automatiquement.',
      tracks: [],
      total_duration_estimated_seconds: null,
    };
  }
  const list = Array.isArray(scenes) ? scenes : [];
  const tracks = [];
  let cumulative = 0;
  for (let i = 0; i < list.length; i += 1) {
    const scene = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const sceneId = String(scene.scene_id || scene.id || `scene_${i + 1}`);
    const text = typeof scene.text === 'string' ? scene.text.trim() : (typeof scene.voix_off === 'string' ? scene.voix_off.trim() : '');
    if (!text) {
      tracks.push({
        scene_id: sceneId,
        text: '',
        audio_url: null,
        start_seconds: null,
        end_seconds: null,
        duration_estimated_seconds: null,
        raison: 'Aucun texte de narration fourni pour cette scène : voix off non générée.',
      });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const audio = await synthesize({ text, rate });
      const durationSeconds = estimateMp3DurationSeconds(audio.buffer);
      let audioUrl = null;
      let storageNote = null;
      if (durationSeconds !== null) {
        // eslint-disable-next-line no-await-in-loop
        const stored = await mediaStorage.upload({
          path: `${uploadPathPrefix}/${sceneId}-${Date.now()}.mp3`,
          buffer: audio.buffer,
          contentType: audio.contentType || 'audio/mpeg',
        });
        audioUrl = stored.url;
        if (!stored.url) storageNote = stored.raison;
      }
      const startSeconds = cumulative;
      const endSeconds = durationSeconds !== null ? cumulative + durationSeconds : null;
      if (durationSeconds !== null) cumulative = endSeconds;
      tracks.push({
        scene_id: sceneId,
        text,
        audio_url: audioUrl,
        start_seconds: startSeconds,
        end_seconds: endSeconds,
        duration_estimated_seconds: durationSeconds,
        duration_source: durationSeconds !== null ? 'analyse_frames_mp3' : null,
        raison: durationSeconds === null
          ? 'Audio généré mais durée non mesurable (format inattendu) : synchronisation non garantie.'
          : storageNote,
      });
    } catch (err) {
      logger.warn('voiceStudio.synthesizeScenes: echec sur une scene', { sceneId, error: err.message });
      tracks.push({
        scene_id: sceneId,
        text,
        audio_url: null,
        start_seconds: null,
        end_seconds: null,
        duration_estimated_seconds: null,
        raison: `Échec de génération vocale pour cette scène : ${err.message}`,
      });
    }
  }
  return {
    configured: true,
    provider: config.brand.voiceProvider,
    voice: config.brand.voiceName,
    tracks,
    total_duration_estimated_seconds: tracks.every((t) => t.duration_estimated_seconds !== null)
      ? cumulative
      : null,
  };
}

module.exports = {
  DEFAULT_VOICE_ID,
  studioBaseUrl,
  health,
  synthesize,
  estimateMp3DurationSeconds,
  synthesizeScenes,
};
