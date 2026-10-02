const { askAI, safeJsonParse } = require('./base');
const { config, int } = require('../core/config');

/**
 * Agent de contrôle qualité vidéo séparé.
 *
 * Il ne prétend pas analyser un fichier binaire ou des images auxquelles la
 * fonction Netlify n'a pas accès. Il contrôle les métadonnées et le manifeste
 * textuel réellement fournis (script, scènes, texte à l'écran, CTA, source,
 * durée, dimensions), puis demande un second avis IA optionnel sur ces preuves.
 * Une vidéo dépourvue de preuves suffisantes reste NON_VALIDEE et ne doit pas
 * être envoyée vers une publication.
 */

const SYSTEM = [
  'Tu es AGENT_VIDEO_QUALITE, un contrôleur de conformité avant publication.',
  'Tu dois être strict, factuel et conservateur : ne déclare jamais avoir vu des images, entendu un audio ou lu un fichier vidéo si ces éléments ne sont pas fournis.',
  'Analyse uniquement les métadonnées et le manifeste textuel transmis.',
  'Signale les preuves manquantes comme limites, pas comme des faits inventés.',
  'Une recommandation de conformité ne remplace pas les règles de la plateforme ; l’approbation humaine est requise en modes Silencio/Copilot, et optionnelle en mode Conquistador si tous les garde-fous sont respectés.',
].join('\n');

const MAX_MANIFEST_CHARS = 24000;

function qualityMinScore() {
  const n = Number(process.env.QUALITY_MIN_SCORE);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : 85;
}
const ALLOWED_VIDEO_SCHEMES = new Set(['https:']);
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const VIDEO_REVIEW_TIMEOUT_MS = int(process.env.VIDEO_REVIEW_TIMEOUT_MS, 15000);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedKey(value) {
  return normalizedText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function readNumber(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function normalizeTimeline(video) {
  const raw = Array.isArray(video.timeline) ? video.timeline : [];
  return raw.map((item, index) => {
    const entry = asObject(item);
    const voice = asObject(entry.voice || entry.voix || entry.audio);
    const subtitles = entry.subtitles || entry.captions || entry.sous_titres || entry.subtitle_segments;
    return {
      scene_id: normalizedText(entry.scene_id || entry.sceneId || entry.id) || `segment_${index + 1}`,
      start_seconds: readNumber(entry.start_seconds, entry.start, entry.debut_seconds),
      end_seconds: readNumber(entry.end_seconds, entry.end, entry.fin_seconds),
      image_ref: normalizedText(entry.image_ref || entry.visual_ref || entry.image_url || entry.prompt_final),
      voice_start_seconds: readNumber(entry.voice_start_seconds, voice.start_seconds, voice.start),
      voice_end_seconds: readNumber(entry.voice_end_seconds, voice.end_seconds, voice.end),
      subtitles: Array.isArray(subtitles) ? subtitles.map((caption) => {
        const value = asObject(caption);
        return {
          start_seconds: readNumber(value.start_seconds, value.start, value.debut_seconds),
          end_seconds: readNumber(value.end_seconds, value.end, value.fin_seconds),
          text: normalizedText(value.text || value.caption || value.texte),
        };
      }) : [],
    };
  });
}

function timelineChecks(video, duration) {
  const timeline = normalizeTimeline(video);
  const blocking = [];
  const warnings = [];
  const checks = [];
  const missingEvidence = [];
  if (!timeline.length) {
    warnings.push('Timeline absente : la synchronisation scènes, voix et sous-titres ne peut pas être vérifiée.');
    missingEvidence.push('Manifeste timeline requis avec start/end, image_ref, voix et sous-titres minutés.');
    checks.push({ id: 'timeline', status: 'missing' }, { id: 'voice_image_sync', status: 'unknown' }, { id: 'subtitles_sync', status: 'unknown' });
    return { timeline, blocking, warnings, checks, missingEvidence, ready: false };
  }

  let timelineValid = true;
  let syncValid = true;
  let subtitlesValid = true;
  let previousEnd = null;
  for (const segment of timeline) {
    const { start_seconds: start, end_seconds: end } = segment;
    if (start === null || end === null || end <= start) {
      blocking.push(`Timeline ${segment.scene_id} invalide : start_seconds et end_seconds doivent encadrer une durée positive.`);
      timelineValid = false;
      continue;
    }
    if (previousEnd !== null && start < previousEnd - 0.25) {
      blocking.push(`Timeline ${segment.scene_id} chevauche la scène précédente.`);
      timelineValid = false;
    }
    previousEnd = end;
    if (duration !== null && end > duration + 0.25) {
      blocking.push(`Timeline ${segment.scene_id} dépasse la durée vidéo déclarée.`);
      timelineValid = false;
    }
    if (!segment.image_ref) {
      blocking.push(`Timeline ${segment.scene_id} sans image_ref : la correspondance voix-image n’est pas vérifiable.`);
      syncValid = false;
    }
    if (segment.voice_start_seconds === null || segment.voice_end_seconds === null || segment.voice_end_seconds <= segment.voice_start_seconds) {
      blocking.push(`Timeline ${segment.scene_id} sans intervalle de voix off valide.`);
      syncValid = false;
    } else if (Math.abs(segment.voice_start_seconds - start) > 0.25 || Math.abs(segment.voice_end_seconds - end) > 0.25) {
      blocking.push(`Timeline ${segment.scene_id} : l’intervalle de voix ne couvre pas exactement la scène image.`);
      syncValid = false;
    }
    if (!segment.subtitles.length) {
      blocking.push(`Timeline ${segment.scene_id} sans sous-titres minutés.`);
      subtitlesValid = false;
    } else {
      for (const caption of segment.subtitles) {
        if (!caption.text || caption.start_seconds === null || caption.end_seconds === null || caption.end_seconds <= caption.start_seconds) {
          blocking.push(`Timeline ${segment.scene_id} contient un sous-titre sans texte ou sans intervalle valide.`);
          subtitlesValid = false;
          continue;
        }
        if (caption.start_seconds < start - 0.25 || caption.end_seconds > end + 0.25) {
          blocking.push(`Un sous-titre de ${segment.scene_id} sort de l’intervalle de la scène.`);
          subtitlesValid = false;
        }
      }
    }
  }
  checks.push({ id: 'timeline', status: timelineValid ? 'pass' : 'fail', segments: timeline.length });
  checks.push({ id: 'voice_image_sync', status: syncValid ? 'pass' : 'fail' });
  checks.push({ id: 'subtitles_sync', status: subtitlesValid ? 'pass' : 'fail' });
  if (previousEnd !== null && duration !== null && Math.abs(previousEnd - duration) > 0.75) {
    warnings.push('La timeline ne couvre pas exactement toute la durée vidéo : vérifier les blancs ou le générique final.');
  }
  return { timeline, blocking, warnings, checks, missingEvidence, ready: timelineValid && syncValid && subtitlesValid };
}

function additionalManifestChecks(video) {
  const blocking = [];
  const warnings = [];
  const checks = [];
  const platform = normalizedKey(video.platform || video.plateforme || video.target_platform);
  const cta = normalizedText(video.cta || video.call_to_action);
  const ctaWords = /(abonne|suis|commente|clique|lien|profil|bio|decouvre|regarde|partage|follow|comment|link|visit)/i;
  if (platform === 'tiktok' || platform === 'instagram' || platform === 'youtube' || platform === 'facebook') {
    if (!cta) {
      blocking.push(`CTA absent pour la plateforme ${platform}.`);
      checks.push({ id: 'cta_platform', status: 'fail', platform });
    } else if (!ctaWords.test(normalizedKey(cta))) {
      blocking.push(`CTA présent mais non actionnable pour ${platform} : reformuler avec une action claire.`);
      checks.push({ id: 'cta_platform', status: 'fail', platform });
    } else {
      checks.push({ id: 'cta_platform', status: 'pass', platform });
    }
  } else {
    warnings.push('Plateforme cible non fournie : le CTA spécifique au canal reste à vérifier.');
    checks.push({ id: 'cta_platform', status: 'unknown' });
  }

  const effects = Array.isArray(video.transitions) ? video.transitions : (Array.isArray(video.zooms_transitions) ? video.zooms_transitions : null);
  if (!effects) {
    warnings.push('Aucun zoom ou transition minuté fourni : le rythme et les changements visuels restent à vérifier.');
    checks.push({ id: 'zooms_transitions', status: 'unknown' });
  } else {
    let valid = true;
    for (const effect of effects) {
      const item = asObject(effect);
      const at = readNumber(item.at_seconds, item.start_seconds, item.time_seconds);
      if (at === null || (finiteNumber(video.duration_seconds || video.duration) !== null && at > finiteNumber(video.duration_seconds || video.duration) + 0.25)) valid = false;
    }
    checks.push({ id: 'zooms_transitions', status: valid ? 'pass' : 'fail' });
    if (!valid) blocking.push('Un zoom ou une transition sort de la timeline ou n’a pas de position temporelle valide.');
  }

  const brandStyle = normalizedText(video.brand_style || video.style_reference || video.style_marque);
  if (!brandStyle) {
    warnings.push('Référence de style de marque absente : la cohérence visuelle Savoir Utile doit être confirmée avec l’asset officiel.');
    checks.push({ id: 'brand_style', status: 'unknown' });
  } else {
    checks.push({ id: 'brand_style', status: 'pass' });
  }
  return { blocking, warnings, checks };
}

function collectText(video) {
  const fields = [
    video.title,
    video.description,
    video.script,
    video.hook,
    video.cta,
    video.voice_over,
    video.voix_off,
  ];
  const lists = [video.captions, video.texte_ecran, video.hashtags];
  for (const list of lists) {
    if (Array.isArray(list)) fields.push(...list);
  }
  if (Array.isArray(video.scenes)) {
    for (const scene of video.scenes) {
      if (scene && typeof scene === 'object') {
        fields.push(scene.description, scene.prompt_final, scene.personnage, scene.decor);
      } else {
        fields.push(scene);
      }
    }
  }
  return fields.filter((item) => typeof item === 'string').join(' ').trim();
}

function deterministicChecks(input) {
  const video = asObject(input.video || input.content || input);
  const blocking = [];
  const warnings = [];
  const checks = [];

  const sourceUrl = normalizedText(video.source_url || video.video_url || input.source_url);
  if (!sourceUrl) {
    blocking.push('URL vidéo HTTPS absente : la source durable n’est pas fournie.');
    checks.push({ id: 'source_url', status: 'missing' });
  } else {
    try {
      const parsed = new URL(sourceUrl);
      if (!ALLOWED_VIDEO_SCHEMES.has(parsed.protocol)) {
        blocking.push('La source vidéo doit utiliser HTTPS.');
        checks.push({ id: 'source_url', status: 'fail', detail: 'scheme_non_https' });
      } else {
        checks.push({ id: 'source_url', status: 'pass' });
      }
    } catch (err) {
      blocking.push('URL vidéo invalide.');
      checks.push({ id: 'source_url', status: 'fail', detail: 'url_invalide' });
    }
  }

  const duration = finiteNumber(video.duration_seconds || video.duration);
  if (duration !== null) {
    if (duration <= 0) {
      blocking.push('La durée vidéo doit être supérieure à zéro.');
      checks.push({ id: 'duration', status: 'fail' });
    } else {
      checks.push({ id: 'duration', status: 'pass', value: duration });
    }
  } else {
    warnings.push('Durée non fournie : la vérification de la longueur reste incomplète.');
    checks.push({ id: 'duration', status: 'unknown' });
  }

  const width = finiteNumber(video.width);
  const height = finiteNumber(video.height);
  if (width !== null && height !== null) {
    if (width <= 0 || height <= 0) {
      blocking.push('Les dimensions vidéo doivent être positives.');
      checks.push({ id: 'dimensions', status: 'fail' });
    } else {
      checks.push({ id: 'dimensions', status: 'pass', width, height });
      if (width >= height) {
        // Toutes les plateformes ciblees par Conquistador OS (TikTok, Reels,
        // Shorts) sont du format court vertical : un format paysage/carre
        // n'y est jamais correctement adapte. Bloquant plutot que simple
        // avertissement - "je veux que le systeme soit capable de bloquer
        // une video manifestement mauvaise avant publication" (cahier des
        // charges qualite video).
        blocking.push('Format non vertical (9:16 attendu pour TikTok/Reels/Shorts) : ce format n’est adapté à aucune des plateformes ciblées.');
      }
    }
  } else {
    warnings.push('Dimensions non fournies : le format d’image n’a pas été vérifié.');
    checks.push({ id: 'dimensions', status: 'unknown' });
  }

  const mime = normalizedText(video.mime_type || video.mime).toLowerCase();
  if (mime) {
    if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(mime)) {
      warnings.push(`Type MIME vidéo non confirmé pour TikTok : ${mime}.`);
      checks.push({ id: 'mime', status: 'warning', value: mime });
    } else {
      checks.push({ id: 'mime', status: 'pass', value: mime });
    }
  } else {
    warnings.push('Type MIME non fourni : le format de fichier reste à vérifier.');
    checks.push({ id: 'mime', status: 'unknown' });
  }

  const text = collectText(video);
  if (!text) {
    blocking.push('Manifeste textuel absent : script, scènes ou texte à l’écran nécessaires pour la revue IA.');
    checks.push({ id: 'text_manifest', status: 'missing' });
  } else {
    checks.push({ id: 'text_manifest', status: 'pass', characters: text.length });
  }

  if (!video.captions && !video.texte_ecran) {
    warnings.push('Aucun texte à l’écran ou sous-titre fourni : l’accessibilité n’a pas été vérifiée.');
  }
  if (!video.audio_transcript && !video.voice_over && !video.voix_off) {
    warnings.push('Aucune transcription ou indication audio fournie : l’audio n’a pas été vérifié.');
  }

  const timeline = timelineChecks(video, duration);
  const manifestChecks = additionalManifestChecks(video);
  blocking.push(...timeline.blocking, ...manifestChecks.blocking);
  warnings.push(...timeline.warnings, ...manifestChecks.warnings);
  checks.push(...timeline.checks, ...manifestChecks.checks);

  const contentResult = input.contentReview && typeof input.contentReview === 'object' ? input.contentReview : null;
  if (contentResult && contentResult.output && contentResult.output.conforme === false) {
    blocking.push('La revue éditoriale existante signale des problèmes.');
  }

  return {
    video,
    blocking,
    warnings,
    checks,
    text,
    timeline: timeline.timeline,
    timelineReady: timeline.ready,
    missingEvidence: timeline.missingEvidence,
    evidenceScope: ['metadata', text ? 'textual_manifest' : null].filter(Boolean),
  };
}

function buildAiPrompt(result) {
  const evidence = {
    metadata: {
      source_url: result.video.source_url || result.video.video_url || null,
      duration_seconds: result.video.duration_seconds || result.video.duration || null,
      width: result.video.width || null,
      height: result.video.height || null,
      mime_type: result.video.mime_type || result.video.mime || null,
    },
    textual_manifest: result.text.slice(0, MAX_MANIFEST_CHARS),
    deterministic_blocking_issues: result.blocking,
          deterministic_warnings: result.warnings,
      timeline: result.timeline,
      timeline_ready: result.timelineReady,

  };
  return [
    'Évalue les preuves fournies pour une vidéo éducative destinée à TikTok.',
    'Tu n’as pas accès aux pixels, à la piste audio ni au fichier vidéo lui-même : ne prétends pas les avoir inspectés.',
    'Vérifie aussi la pertinence narrative si le manifeste le permet : pour chaque scène décrite, la description/l’image prévue doit réellement illustrer ce que dit le script à ce moment précis (pas une scène simplement esthétique sans lien direct). Si une scène semble hors sujet ou purement décorative par rapport au texte qu’elle accompagne, signale-le comme un avertissement (ou un bloquant si c’est manifeste et répété).',
    'Vérifie que Samuel et/ou Marc ne sont jamais remplacés par un autre personnage principal ; un personnage secondaire est acceptable uniquement s’il a une fonction narrative claire.',
    'Retourne uniquement ce JSON :',
    '{"decision":"APPROUVER_REVUE|CORRIGER|PREUVES_INSUFFISANTES","bloquants":["..."],"avertissements":["..."],"preuves_manquantes":["..."]}',
    'APPROUVER_REVUE signifie seulement que les preuves fournies ne révèlent pas de problème ; cela ne signifie pas que le fichier binaire est conforme.',
    JSON.stringify(evidence),
  ].join('\n');
}

function extractGeminiText(json) {
  if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text;
  if (Array.isArray(json?.outputs)) {
    const text = json.outputs
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
    if (text.trim()) return text;
  }
  if (Array.isArray(json?.candidates)) {
    const text = json.candidates
      .flatMap((candidate) => candidate?.content?.parts || [])
      .map((part) => part?.text || '')
      .join('');
    if (text.trim()) return text;
  }
  return '';
}

async function reviewWithGeminiVideo(deterministic) {
  if (!config.ai.geminiApiKey) {
    return { skipped: true, reason: 'GEMINI_API_KEY non configuree' };
  }
  const sourceUrl = deterministic.video.source_url || deterministic.video.video_url;
  if (!sourceUrl) return { skipped: true, reason: 'URL vidéo absente' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VIDEO_REVIEW_TIMEOUT_MS);
  const prompt = [
    'Inspecte réellement cette vidéo éducative avant publication TikTok.',
    'Évalue les images, le texte visible, le rythme général, la lisibilité, l’audio si disponible, la cohérence avec le manifeste fourni, les risques de contenu trompeur ou non conforme et les éléments manquants.',
    'Vérifie particulièrement la pertinence narrative de chaque scène par rapport à ce qui est dit à ce moment précis (rejette une belle scène qui n’illustre rien de concret), la continuité visuelle de Samuel et Marc (jamais remplacés), et l’usage justifié d’un éventuel personnage secondaire.',
    'Ne donne pas de conseil de publication automatique. Retourne uniquement ce JSON :',
    '{"decision":"APPROUVER_REVUE|CORRIGER|PREUVES_INSUFFISANTES","bloquants":["..."],"avertissements":["..."],"preuves_manquantes":["..."]}',
    'Le mot APPROUVER_REVUE signifie que l’inspection audiovisuelle ne révèle pas de problème bloquant ; en mode Conquistador, la publication automatique devient possible si tous les garde-fous (connexion, quotas, horaires, kill switch) sont respectés.',
    `Manifeste textuel associé : ${deterministic.text.slice(0, MAX_MANIFEST_CHARS)}`,
  ].join('\n');
  try {
    const response = await fetch(GEMINI_INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.ai.geminiApiKey,
      },
      body: JSON.stringify({
        model: config.ai.geminiModel,
        input: [
          {
            type: 'video',
            uri: sourceUrl,
            mime_type: normalizedText(deterministic.video.mime_type || deterministic.video.mime) || 'video/mp4',
          },
          { type: 'text', text: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      return { failed: true, reason: `Gemini vidéo HTTP ${response.status}: ${body.slice(0, 200)}` };
    }
    const json = await response.json();
    const text = extractGeminiText(json);
    const parsed = safeJsonParse(text);
    if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
      return { failed: true, reason: 'Gemini vidéo a renvoyé une réponse non structurée' };
    }
    return { ok: true, data: parsed.data, provider: 'gemini', model: config.ai.geminiModel };
  } catch (err) {
    return { failed: true, reason: `Inspection Gemini vidéo indisponible: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function review(input = {}) {
  const deterministic = deterministicChecks(input);
  const useAi = input.use_ai !== false;
  const useMediaAi = input.use_media_ai !== false;
  let ai = null;
  let mediaAi = null;
  let provider = null;
  let model = null;

  if (useMediaAi && deterministic.text && deterministic.blocking.length === 0) {
    mediaAi = await reviewWithGeminiVideo(deterministic);
    if (mediaAi.ok) {
      provider = mediaAi.provider;
      model = mediaAi.model;
    } else if (mediaAi.failed) {
      deterministic.warnings.push(mediaAi.reason);
    }
  }

  if (!mediaAi?.ok && useAi && deterministic.text) {
    const aiResult = await askAI({
      system: SYSTEM,
      prompt: buildAiPrompt(deterministic),
      expectJson: true,
      temperature: 0.1,
      maxTokens: 1200,
      profile: 'reasoning',
    });
    provider = provider || aiResult.provider;
    model = model || aiResult.model;
    ai = aiResult.parsed;
  }

  const aiData = ai && ai.ok === true && ai.data && typeof ai.data === 'object' ? ai.data : null;
  const mediaData = mediaAi?.ok && mediaAi.data && typeof mediaAi.data === 'object' ? mediaAi.data : null;
  const selectedData = mediaData || aiData;
  const selectedBlocking = Array.isArray(selectedData?.bloquants) ? selectedData.bloquants.filter(Boolean).map(String) : [];
  const selectedWarnings = Array.isArray(selectedData?.avertissements) ? selectedData.avertissements.filter(Boolean).map(String) : [];
  const missingEvidence = [
    ...(Array.isArray(deterministic.missingEvidence) ? deterministic.missingEvidence : []),
    ...(Array.isArray(selectedData?.preuves_manquantes) ? selectedData.preuves_manquantes.filter(Boolean).map(String) : []),
  ];
  const blocking = [...deterministic.blocking, ...selectedBlocking];
  const warnings = [...deterministic.warnings, ...selectedWarnings];
  const aiDecision = selectedData?.decision || 'PREUVES_INSUFFISANTES';
  const mediaInspected = Boolean(mediaData);
  const passedChecks = deterministic.checks.filter((check) => check.status === 'pass').map((check) => check.id);
  const explicitPreserved = Array.isArray(deterministic.video.elements_a_preserver) ? deterministic.video.elements_a_preserver.filter(Boolean).map(String) : [];
  const correctionsRequested = [...blocking, ...missingEvidence].filter(Boolean).map((item) => `Corriger ou fournir : ${item}`);
  const howToCorrect = [
    'Fournir une URL vidéo HTTPS durable et accessible au contrôleur.',
    'Ajouter une timeline par scène avec start/end, image_ref, intervalle de voix et sous-titres minutés.',
    'Aligner les débuts et fins voix-image à une tolérance maximale de 0,25 seconde et garder chaque sous-titre dans sa scène.',
    'Conserver les éléments déjà validés listés dans elements_a_preserver pendant la révision.',
  ];
  const declaredDuration = finiteNumber(deterministic.video.duration_seconds || deterministic.video.duration);
  const evidenceSource = normalizedText(deterministic.video.source_url || deterministic.video.video_url);
  const evidenceSufficient = Boolean(
    deterministic.text &&
      evidenceSource &&
      declaredDuration !== null &&
      deterministic.timelineReady === true &&
      mediaInspected,
  );

  return {
    type: 'video.review',
    provider,
    model,
    output: {
      score_qualite: Math.max(0, 100 - (blocking.length * 30) - (warnings.length * 5) - (missingEvidence.length * 8) - (mediaInspected ? 0 : 20)),
      seuil_minimum: qualityMinScore(),
      conforme: blocking.length === 0 && evidenceSufficient && aiDecision === 'APPROUVER_REVUE',
      publication_autorisee: blocking.length === 0 && evidenceSufficient && aiDecision === 'APPROUVER_REVUE',
      decision: blocking.length > 0 ? 'CORRIGER' : aiDecision,
      problemes: blocking,
      problemes_identifies: blocking,
      corrections_demandees: correctionsRequested,
      comment_corriger: howToCorrect,
      elements_a_preserver: [...explicitPreserved, ...passedChecks.map((id) => `Contrôle déjà réussi : ${id}`)],
      avertissements: warnings,
      preuves_manquantes: mediaInspected ? missingEvidence : [...missingEvidence, 'Inspection audiovisuelle Gemini réussie requise.'],
      timeline_manifest: deterministic.timeline,
      timeline_synchronisee: deterministic.timelineReady === true,
      verifie_le: new Date().toISOString(),
      evidence_scope: [...deterministic.evidenceScope, ...(mediaInspected ? ['media_binaire_externe'] : [])],
      media_binaire_inspecte: mediaInspected,
      note: 'Cette revue est une condition de publication, pas une garantie : les contrôles de la plateforme s’appliquent toujours. Une revue non inspectée ne vaut pas conformité.',
      checks: deterministic.checks,
      ai: aiData,
      media_ai: mediaData,
    },
  };
}

async function handle(task) {
  if (task.subtype !== 'review') {
    throw new Error(`AGENT_VIDEO_QUALITE: sous-type de tache inconnu "${task.subtype}"`);
  }
  return review(task.input || {});
}

module.exports = { handle, review, deterministicChecks, buildAiPrompt };
