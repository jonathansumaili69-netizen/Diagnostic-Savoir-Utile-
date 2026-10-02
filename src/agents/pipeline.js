'use strict';

const contenu = require('./contenu');
const qualite = require('./qualite');
const videoQuality = require('./videoQuality');
const voiceOver = require('./voiceOver');

const MAX_REVISION_CYCLES = 2;
const NON_REVISION_BLOCKERS = new Set(['source_url', 'text_manifest']);

function payloadOf(result) {
  if (!result || typeof result !== 'object') return {};
  if (result.output && typeof result.output === 'object' && !Array.isArray(result.output)) {
    if (result.output.ok === true && result.output.data && typeof result.output.data === 'object') {
      return result.output.data;
    }
    return result.output;
  }
  return result;
}

function normalizedFeedback(editorialReview, videoReview) {
  const editorial = editorialReview && editorialReview.output ? editorialReview.output : {};
  const video = videoReview && videoReview.output ? videoReview.output : {};
  return {
    editorial: Array.isArray(editorial.problemes) ? editorial.problemes : [],
    video: Array.isArray(video.problemes_identifies) ? video.problemes_identifies : (Array.isArray(video.problemes) ? video.problemes : []),
    corrections: Array.isArray(video.corrections_demandees) ? video.corrections_demandees : [],
    howToCorrect: Array.isArray(video.comment_corriger) ? video.comment_corriger : [],
    preserve: Array.isArray(video.elements_a_preserver) ? video.elements_a_preserver : [],
    warnings: Array.isArray(video.avertissements) ? video.avertissements : [],
    missingEvidence: Array.isArray(video.preuves_manquantes) ? video.preuves_manquantes : [],
  };
}

function hasActionableRevisionFeedback(feedback) {
  const checks = feedback.videoReview && Array.isArray(feedback.videoReview.checks)
    ? feedback.videoReview.checks
    : [];
  const hasOperationalBlocker = checks.some((check) => NON_REVISION_BLOCKERS.has(check.id) && ['missing', 'fail'].includes(check.status));
  return !hasOperationalBlocker && (feedback.editorial.length > 0 || feedback.video.length > 0);
}

function buildManifest(content, input) {
  const suppliedVideo = input.video && typeof input.video === 'object' ? input.video : {};
  return { ...suppliedVideo, ...content };
}

/**
 * Remplace les valeurs voice_start_seconds/voice_end_seconds *devinées* par
 * l'IA rédactrice dans manifest.timeline par les valeurs *réellement
 * mesurées* sur l'audio Rémy Neural généré (voir voiceOver.js). N'invente
 * jamais une entrée de timeline : si aucune timeline n'existe déjà (l'IA ou
 * l'utilisateur n'en a pas fourni), on n'en fabrique pas une à partir de la
 * seule voix off - image_ref et subtitles restent hors de portée de cet
 * agent. Si la génération vocale n'est pas configurée ou échoue, le
 * manifeste ressort strictement inchangé (aucune régression).
 */
function mergeVoiceOverIntoManifest(manifest, voiceOverResult) {
  if (!voiceOverResult || voiceOverResult.configured !== true || !Array.isArray(manifest.timeline) || !manifest.timeline.length) {
    return manifest;
  }
  const bySceneId = new Map();
  for (const track of voiceOverResult.tracks || []) {
    if (track && track.scene_id && track.duration_estimated_seconds !== null && track.start_seconds !== null) {
      bySceneId.set(String(track.scene_id), track);
    }
  }
  if (!bySceneId.size) return manifest;
  const timeline = manifest.timeline.map((segment) => {
    const sceneId = String(segment.scene_id || segment.sceneId || segment.id || '');
    const track = bySceneId.get(sceneId);
    if (!track) return segment;
    return {
      ...segment,
      voice_start_seconds: track.start_seconds,
      voice_end_seconds: track.end_seconds,
      audio_url: track.audio_url || segment.audio_url || null,
      voice_duration_source: 'remy_neural_mesure_reel',
    };
  });
  return { ...manifest, timeline };
}

async function inspect(content, input) {
  const editorialReview = qualite.review({ content });
  let manifest = buildManifest(content, input);
  let voiceOverResult = null;
  if (input.generate_voice_over !== false) {
    voiceOverResult = await voiceOver.generateForContent(content, { rate: input.voice_rate }).catch((err) => ({
      configured: false,
      raison: `Génération vocale interrompue par une erreur : ${err.message}`,
      tracks: [],
      total_duration_estimated_seconds: null,
    }));
    manifest = mergeVoiceOverIntoManifest(manifest, voiceOverResult);
  }
  const videoReview = await videoQuality.review({
    video: manifest,
    contentReview: editorialReview,
    use_ai: input.use_ai_quality !== false,
    use_media_ai: input.use_media_ai !== false,
  });
  return { editorialReview, videoReview, manifest, voiceOver: voiceOverResult };
}

async function run(input = {}) {
  const requestedRevisions = input.max_revisions === undefined || input.max_revisions === null || input.max_revisions === ''
    ? 1
    : Number(input.max_revisions);
  const maxRevisions = Math.max(0, Math.min(MAX_REVISION_CYCLES, Number.isFinite(requestedRevisions) ? requestedRevisions : 1));
  const autoRevise = input.auto_revise !== false;
  const revisions = [];
  let creativeResult = await contenu.fullVideo(input);
  let content = payloadOf(creativeResult);
  let inspection = await inspect(content, input);

  for (let cycle = 0; cycle < maxRevisions; cycle += 1) {
    const feedback = normalizedFeedback(inspection.editorialReview, inspection.videoReview);
    const conforming = inspection.editorialReview.output?.conforme === true && inspection.videoReview.output?.conforme === true;
    if (conforming || !autoRevise) break;
    const revisionInput = {
      ...input,
      previous_content: content,
      revision_feedback: feedback,
    };
    if (!hasActionableRevisionFeedback({ ...feedback, videoReview: inspection.videoReview.output })) break;

    const revised = await contenu.revise(revisionInput);
    const revisedContent = payloadOf(revised);
    revisions.push({
      cycle: cycle + 1,
      feedback_transmis_a_agent_creatif: true,
      fournisseur_ia: revised.provider || null,
      model: revised.model || null,
    });
    creativeResult = revised;
    content = revisedContent;
    inspection = await inspect(content, input);
  }

  const editorialOutput = inspection.editorialReview.output || {};
  const videoOutput = inspection.videoReview.output || {};
  const conforme = editorialOutput.conforme === true && videoOutput.conforme === true;
  const feedbackFinal = normalizedFeedback(inspection.editorialReview, inspection.videoReview);

  return {
    type: 'pipeline.video',
    provider: creativeResult.provider || inspection.videoReview.provider || null,
    model: creativeResult.model || inspection.videoReview.model || null,
    output: {
      statut: conforme ? 'PRET_POUR_APPROBATION' : 'CORRECTIONS_REQUISES',
      conforme,
      publication_autorisee: false,
      contenu: content,
      revue_editoriale: editorialOutput,
      revue_video: videoOutput,
      voix_off: inspection.voiceOver || { configured: false, raison: 'Génération de voix off désactivée pour cette exécution (generate_voice_over: false).', tracks: [] },
      revisions,
      communication_agent_creatif: {
        active: revisions.length > 0,
        dernier_feedback: feedbackFinal,
        prochaine_etape: conforme
          ? 'Approbation humaine requise avant toute publication.'
          : 'Corriger les éléments bloquants puis fournir une nouvelle preuve vidéo durable.',
      },
      note: 'Le pipeline prépare et contrôle le contenu. Il ne publie jamais directement et ne transforme pas une revue incomplète en feu vert.',
    },
  };
}

async function handle(task) {
  if (task.subtype !== 'video') {
    throw new Error(`AGENT_PIPELINE: sous-type de tache inconnu "${task.subtype}"`);
  }
  return run(task.input || {});
}

module.exports = { handle, run, inspect, payloadOf, normalizedFeedback };
