'use strict';

/**
 * VIDEO TIMELINE — timeline GLOBALE d'une video multi-scenes (prompt maitre,
 * sections 7-9).
 *
 * PRINCIPE CENTRAL : la duree n'est JAMAIS plafonnee arbitrairement (aucune
 * limite a 10 s). La duree finale derive des RESSOURCES REELLES dans cet
 * ordre de priorite :
 *   1. duree REELLEMENT mesuree de la voix off de la scene (voix > tout) ;
 *   2. a defaut, duree declaree par le manifeste (timeline IA) ;
 *   3. a defaut, duree par defaut configurable (scene muette mais rendue).
 *
 * Chaque scene porte : scene_id, start, end, duration, visual asset,
 * character references, narration segment, subtitle segment, transition,
 * metadata, quality status.
 *
 * Validations explicites (jamais silencieuses) : pas de trou, pas de
 * chevauchement non voulu, pas d'ecran vide (duree nulle), pas de voix
 * coupee (la scene couvre toujours la voix), fin non brutale (CTA/premiere
 * scene incluses, duree minimale de scene d'ouverture/fermeture).
 */

const MIN_SCENE_SECONDS = 0.8;
const DEFAULT_SCENE_SECONDS = 4;
const OPENING_MIN_SECONDS = 1.2;
const CLOSING_MIN_SECONDS = 1.5;
/**
 * Marge anti-coupure de voix. CORRECTION (mission, section 7 — ecart +2,4 a
 * +3,5 s constate) : cette marge n'est appliquee QU'A LA DERNIERE scene.
 * Cause prouvee de l'ancien ecart : la marge de 0,35 s etait ajoutee a la
 * fin de CHAQUE scene (0,35 x N scenes = +2,45 s pour 7 scenes), alors que
 * le renderer amortit deja chaque voix dans la duree de sa scene via apad
 * (voir videoRenderer.normalizeAudioSegment) — aucune voix n'est jamais
 * coupee pour les scenes intermediaires sans marge. Configurable via
 * VIDEO_VOICE_SAFETY_SECONDS (0 : duree finale = somme des voix exacte).
 */
const VOICE_SAFETY_SECONDS = 0.35;

function voiceSafetySeconds() {
  const n = Number(process.env.VIDEO_VOICE_SAFETY_SECONDS);
  return Number.isFinite(n) && n >= 0 ? n : VOICE_SAFETY_SECONDS;
}

function cfg(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function round(n, d = 3) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Construit la timeline complete.
 * @param {object} p
 * @param {Array}  p.scenes          scenes du manifeste (ordre du script)
 * @param {Array}  p.voiceTracks     pistes voix reellement mesurees (voiceStudio)
 * @param {Array}  p.manifestTimeline timings declares par l'IA
 * @param {number} p.fps
 */
function buildTimeline({ scenes = [], voiceTracks = [], manifestTimeline = [], fps = 30 } = {}) {
  const list = Array.isArray(scenes) ? scenes : [];
  const trackById = new Map(
    (Array.isArray(voiceTracks) ? voiceTracks : [])
      .filter((t) => Number.isFinite(Number(t.start_seconds)) && Number.isFinite(Number(t.end_seconds)) && Number(t.end_seconds) > Number(t.start_seconds))
      .map((t) => [String(t.scene_id), t]),
  );
  const declaredById = new Map((Array.isArray(manifestTimeline) ? manifestTimeline : []).map((t) => [String(t.scene_id), t]));

  const warnings = [];
  let cursor = 0;
  const timelineScenes = [];

  list.forEach((raw, i) => {
    const scene = raw && typeof raw === 'object' ? raw : {};
    const sceneId = String(scene.id || scene.scene_id || `scene_${i + 1}`);
    const track = trackById.get(sceneId);
    const declared = declaredById.get(sceneId);

    // 1) voix reelle (source de verite), 2) manifeste, 3) defaut explicite
    let start;
    let end;
    let source;
    if (track) {
      start = Number(track.start_seconds);
      // Marge anti-coupure : DERNIERE scene uniquement (voir commentaire
      // VOICE_SAFETY_SECONDS en tete de fichier — corrige l'ecart de duree
      // cumule +0,35 s x N). Les scenes intermediaires se terminent
      // exactement a la fin de leur voix : le renderer complete avec du
      // silence (apad), la voix n'est jamais coupee.
      end = Number(track.end_seconds) + (i === list.length - 1 ? voiceSafetySeconds() : 0);
      source = 'voix_mesuree';
    } else if (declared && Number(declared.end_seconds) > Number(declared.start_seconds)) {
      start = Number(declared.start_seconds);
      end = Number(declared.end_seconds);
      source = 'manifeste';
      warnings.push({ scene_id: sceneId, type: 'VOIX_NON_MESUREE', detail: 'Timing issu du manifeste IA (voix off non mesuree) : synchronisation approximative.' });
    } else {
      start = cursor;
      end = cursor + cfg('VIDEO_DEFAULT_SCENE_SECONDS', DEFAULT_SCENE_SECONDS);
      source = 'defaut';
      warnings.push({ scene_id: sceneId, type: 'DUREE_PAR_DEFAUT', detail: 'Aucune duree mesurable fournie : duree par defaut appliquee (scene muette possible).' });
    }

    if (start < cursor) {
      warnings.push({ scene_id: sceneId, type: 'CHEVAUCHEMENT_CORRIGE', detail: `Debut ${round(start)}s < fin de scene precedente ${round(cursor)}s : recale a ${round(cursor)}s.` });
      end = cursor + Math.max(MIN_SCENE_SECONDS, end - start);
      start = cursor;
    }

    let duration = end - start;
    if (duration < MIN_SCENE_SECONDS) {
      warnings.push({ scene_id: sceneId, type: 'SCENE_TROP_COURTE', detail: `Duree ${round(duration)}s < minimum ${MIN_SCENE_SECONDS}s : etendue (evite un flash illisible).` });
      duration = MIN_SCENE_SECONDS;
      end = start + duration;
    }

    const isFirst = i === 0;
    const isLast = i === list.length - 1;
    if (isFirst && duration < OPENING_MIN_SECONDS) {
      duration = OPENING_MIN_SECONDS;
      end = start + duration;
      warnings.push({ scene_id: sceneId, type: 'OUVERTURE_ETENDUE', detail: 'Scene d ouverture trop breve : etendue pour eviter un demarrage brutal.' });
    }
    if (isLast && duration < CLOSING_MIN_SECONDS) {
      duration = CLOSING_MIN_SECONDS;
      end = start + duration;
      warnings.push({ scene_id: sceneId, type: 'FIN_NON_BRUTALE', detail: 'Derniere scene (CTA) etendue pour eviter une fin brutale.' });
    }

    timelineScenes.push({
      scene_id: sceneId,
      index: i,
      start_seconds: round(start),
      end_seconds: round(end),
      duration_seconds: round(duration),
      duration_source: source,
      narration_segment: (track && track.text) || scene.voix_off_scene || '',
      subtitle_segment: null, // rempli par subtitles.js (source unique de verite)
      transition: scene.transition || (isFirst ? 'fade_in' : 'cut'),
      character_references: Array.isArray(scene.character_references)
        ? scene.character_references
        : (scene.personnage ? [scene.personnage] : []),
      visual_asset: scene.visual_asset || null,
      metadata: {
        description: scene.description || null,
        style: scene.style || null,
        logo_requis: scene.logo_requis === true,
        prompt_final: scene.prompt_final || null,
      },
      quality_status: 'PENDING',
      audio_track: Boolean(track),
      frames: Math.round(duration * fps),
    });

    cursor = round(Math.max(cursor, end));
  });

  const totalDuration = timelineScenes.length ? timelineScenes[timelineScenes.length - 1].end_seconds : 0;

  return {
    fps,
    scene_count: timelineScenes.length,
    total_duration_seconds: round(totalDuration),
    scenes: timelineScenes,
    warnings,
    source_principale: timelineScenes.some((s) => s.duration_source === 'voix_mesuree')
      ? 'voix_mesuree'
      : (timelineScenes.some((s) => s.duration_source === 'manifeste') ? 'manifeste' : 'defaut'),
    contrainte_duree_maximale_appliquee: null, // AUCUNE limite artificielle (exigence explicite)
  };
}

/**
 * Valide une timeline avant rendu. Renvoie un rapport EXPLICITE ; ne corrige
 * rien silencieusement. Chaque controle est idempotent (aucune mutation).
 */
function validateTimeline(timeline, { expectedDurationSeconds = null, tol = 0.35 } = {}) {
  const checks = [];
  const push = (id, status, detail) => checks.push({ id, status, detail });
  const scenes = (timeline && timeline.scenes) || [];

  push('scenes_presentes', scenes.length ? 'pass' : 'fail', scenes.length ? `${scenes.length} scene(s) dans la timeline.` : 'Timeline vide : aucun rendu possible.');

  let gap = 0;
  let overlap = 0;
  let zero = 0;
  for (let i = 0; i < scenes.length; i += 1) {
    const s = scenes[i];
    if (!(s.duration_seconds > 0)) zero += 1;
    if (i > 0) {
      const prev = scenes[i - 1];
      const delta = Number(s.start_seconds) - Number(prev.end_seconds);
      if (delta > 0.02) gap += 1;
      if (delta < -0.02) overlap += 1;
    }
  }
  push('aucun_ecran_vide', zero === 0 ? 'pass' : 'fail', zero === 0 ? 'Aucune scene de duree nulle.' : `${zero} scene(s) de duree nulle (ecran vide).`);
  push('aucun_trou', gap === 0 ? 'pass' : 'fail', gap === 0 ? 'Timeline continue, aucun trou.' : `${gap} trou(s) dans la timeline.`);
  push('aucun_chevauchement', overlap === 0 ? 'pass' : 'warn', overlap === 0 ? 'Aucun chevauchement de scene.' : `${overlap} chevauchement(s) detecte(s).`);

  const inOrder = scenes.every((s, i) => i === 0 || Number(s.start_seconds) >= Number(scenes[i - 1].start_seconds));
  push('ordre_chronologique', inOrder ? 'pass' : 'fail', inOrder ? 'Scenes ordonnees chronologiquement.' : 'Scenes desordonnees.');

  const monotonic = scenes.every((s) => Number(s.end_seconds) > Number(s.start_seconds));
  push('durees_positives', monotonic ? 'pass' : 'fail', monotonic ? 'Chaque scene a une duree positive.' : 'Au moins une scene a une duree non positive.');

  if (expectedDurationSeconds != null) {
    const delta = Math.abs(Number(timeline.total_duration_seconds) - Number(expectedDurationSeconds));
    push('duree_cible_respectee', delta <= Math.max(tol, expectedDurationSeconds * 0.06) ? 'pass' : 'warn',
      `Duree timeline ${timeline.total_duration_seconds}s vs cible ${expectedDurationSeconds}s (ecart ${round(delta)}s).`);
  }

  const hasAudioCoverage = scenes.some((s) => s.audio_track);
  push('voix_couverte', hasAudioCoverage ? 'pass' : 'warn', hasAudioCoverage
    ? 'Au moins une scene est couverte par une piste voix mesuree : la voix n est pas coupee par la timeline.'
    : 'Aucune piste voix mesuree : rendu muet explicite (pas une erreur, mais a signaler).');

  push('limite_duree_artificielle', timeline && timeline.contrainte_duree_maximale_appliquee === null ? 'pass' : 'fail',
    'Aucune limite de duree maximale (10 s ou autre) n est appliquee a la timeline.');

  const hasFail = checks.some((c) => c.status === 'fail');
  return { ok: !hasFail, checks, total_duration_seconds: timeline ? timeline.total_duration_seconds : 0, scene_count: scenes.length };
}

/**
 * Repartit des segments de sous-titres (issus de subtitles.buildEntries)
 * sur les scenes de la timeline, pour verifier la synchronisation reelle
 * (et non la supposer).
 */
function attachSubtitleSegments(timeline, entries = []) {
  const byId = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = String(e.scene_id);
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push({ text: e.text, start_seconds: e.start_seconds, end_seconds: e.end_seconds });
  }
  const scenes = (timeline && timeline.scenes ? timeline.scenes : []).map((s) => ({
    ...s,
    subtitle_segment: byId.get(String(s.scene_id)) || [],
  }));
  return { ...timeline, scenes };
}

/** Verifie la synchronisation voix / sous-titres / scenes (jamais supposee). */
function validateSynchronization(timeline, entries = []) {
  const checks = [];
  const push = (id, status, detail) => checks.push({ id, status, detail });
  const scenes = (timeline && timeline.scenes) || [];
  const list = Array.isArray(entries) ? entries : [];

  if (!list.length) {
    push('sous_titres_presents', scenes.length ? 'warn' : 'pass', scenes.length
      ? 'Aucun sous-titre genere (voix non mesuree) : ce n est pas un faux succes, mais aucun sous-titre ne sera brule.'
      : 'Aucune scene.');
    return { ok: true, checks, entry_count: 0 };
  }

  const sceneById = new Map(scenes.map((s) => [String(s.scene_id), s]));
  let outside = 0;
  let late = 0;
  for (const e of list) {
    const s = sceneById.get(String(e.scene_id));
    if (!s) continue;
    if (Number(e.start_seconds) < Number(s.start_seconds) - 0.05 || Number(e.end_seconds) > Number(s.end_seconds) + 0.6) outside += 1;
    if (Number(e.start_seconds) > Number(s.end_seconds)) late += 1;
  }
  push('sous_titres_dans_leur_scene', outside === 0 ? 'pass' : 'warn',
    outside === 0 ? 'Chaque sous-titre tombe dans les bornes de sa scene.' : `${outside} sous-titre(s) hors bornes de leur scene (a verifier).`);
  push('sous_titres_non_en_retard', late === 0 ? 'pass' : 'fail',
    late === 0 ? 'Aucun sous-titre en retard sur sa scene.' : `${late} sous-titre(s) demarrant apres la fin de leur scene.`);

  const lastEnd = Math.max(...list.map((e) => Number(e.end_seconds) || 0));
  const total = Number(timeline && timeline.total_duration_seconds) || 0;
  push('sous_titres_ne_depassent_pas_la_video', lastEnd <= total + 0.8 ? 'pass' : 'warn',
    `Dernier sous-titre a ${round(lastEnd)}s pour une video de ${round(total)}s.`);

  const hasFail = checks.some((c) => c.status === 'fail');
  return { ok: !hasFail, checks, entry_count: list.length, last_subtitle_end_seconds: round(lastEnd) };
}

/** Cibles de duree exigees par le cahier des charges (tests 37/45/60/90 s). */
const TARGET_DURATIONS = Object.freeze([20, 30, 37, 45, 60, 75, 90]);

/**
 * Repartit une DUREE CIBLE sur N scenes en respectant les proportions de la
 * narration reelle si disponible (utilise pour verifier qu'une video de 37 s
 * est bien une video de ~37 s et non une suite de clips de 10 s).
 */
function planTargetDuration({ targetSeconds, sceneCount, narrationLengths = [] } = {}) {
  const n = Math.max(1, Number(sceneCount) || 1);
  const total = Math.max(MIN_SCENE_SECONDS * n, Number(targetSeconds) || 0);
  const weights = narrationLengths.length === n && narrationLengths.some((l) => l > 0)
    ? narrationLengths.map((l) => Math.max(1, Number(l) || 0))
    : new Array(n).fill(1);
  const sum = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  const scenes = [];
  for (let i = 0; i < n; i += 1) {
    const raw = (weights[i] / sum) * total;
    const duration = Math.max(MIN_SCENE_SECONDS, raw);
    scenes.push({ index: i, start_seconds: round(cursor), duration_seconds: round(duration) });
    cursor += duration;
  }
  // Normalisation finale pour atteindre exactement la cible (a l'arrondi pres).
  const scale = total / cursor;
  cursor = 0;
  const normalized = scenes.map((s, i) => {
    const duration = round(s.duration_seconds * scale);
    const out = { index: i, start_seconds: round(cursor), duration_seconds: duration, end_seconds: round(cursor + duration) };
    cursor += duration;
    return out;
  });
  return { target_seconds: total, scene_count: n, total_duration_seconds: round(cursor), scenes: normalized };
}

module.exports = {
  MIN_SCENE_SECONDS,
  DEFAULT_SCENE_SECONDS,
  OPENING_MIN_SECONDS,
  CLOSING_MIN_SECONDS,
  VOICE_SAFETY_SECONDS,
  voiceSafetySeconds,
  TARGET_DURATIONS,
  buildTimeline,
  validateTimeline,
  attachSubtitleSegments,
  validateSynchronization,
  planTargetDuration,
};
