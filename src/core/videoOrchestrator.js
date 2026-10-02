'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');

const operationalState = require('./operationalState');
const killswitch = require('./killswitch');
const idempotency = require('./idempotency');
const videoJobs = require('./videoJobs');
const visualEngine = require('./visualEngine');
const subtitles = require('./subtitles');
const videoRenderer = require('./videoRenderer');
const videoFileQualityCheck = require('./videoFileQualityCheck');
const mediaStorage = require('./mediaStorage');
const characterRegistry = require('./characterRegistry');
const videoTimeline = require('./videoTimeline');
const { logger } = require('./logger');
const contenu = require('../agents/contenu');
const voiceOver = require('../agents/voiceOver');

/**
 * VIDEO ORCHESTRATOR — createVideo() relie REELLEMENT toutes les pieces du
 * Video Engine (voir mission, "Orchestration complete") :
 *   verifier mode -> verifier kill switch -> creer job -> generer script ->
 *   creer scenes -> generer/recuperer assets -> generer voix -> generer
 *   sous-titres -> composition -> render -> quality check -> stocker ->
 *   COMPLETED (ou FAILED avec cause explicite a la premiere etape en echec).
 *
 * CONVENTION D'ETAT (documentee ici une seule fois) : `job.status` reflete
 * la DERNIERE etape reussie (ex: "RENDERING" = le rendu ffmpeg est termine
 * avec succes, prochaine etape = QUALITY_CHECK), pas une etape en cours au
 * sens d'un systeme multi-thread. QUEUED = aucune etape encore executee.
 *
 * SECURITE (mission - jamais contournee) :
 *   - kill switch : consigne dans le job pour tracabilite, mais NE bloque
 *     PAS la creation/preparation elle-meme, exactement comme le reste du
 *     pipeline existant (src/agents/pipeline.js) qui prepare et controle
 *     sans jamais publier — seule une action de PUBLICATION externe est
 *     soumise au kill switch (voir src/core/killswitch.js
 *     EXTERNAL_ACTION_TYPES). createVideo() ne publie jamais rien.
 *   - approbation humaine : gerée au niveau transport (assertApiKey sur les
 *     endpoints Netlify, voir netlify/functions/video-jobs*.js), identique
 *     au reste des endpoints mutants (task-run.js). createVideo() ne
 *     publie jamais directement — la publication d'un rendu reste une
 *     action separee, manuelle, hors de ce module.
 *   - idempotence : creation de job dedupliquee par idempotency_key
 *     (videoJobs.createJob) + traitement dedupliqué par
 *     idempotency.claim/confirm/release (scope "video.job.process") pour
 *     eviter tout double rendu si processJob() est invoque deux fois pour le
 *     meme job (retry HTTP, worker concurrent).
 *
 * SEPARATION ORCHESTRATOR / RENDER WORKER : ce module orchestre ; seule
 * l'etape RENDERING delegue a videoRenderer.js (le seul point qui execute
 * ffmpeg). Voir docs/VIDEO_ENGINE.md et scripts/render-worker.js pour le
 * detail de cette separation et ses limites en environnement serverless.
 *
 * AJOUTS (sections 3-9 du prompt maitre) — ADDITIFS, ordre d'etapes INCHANGE :
 *   - PREPARING resout aussi l'identite officielle des personnages cites
 *     (Character Registry) et refuse explicitement un personnage non officiel ;
 *   - GENERATING_ASSETS transporte desormais `character` + `consistency`
 *     (PASS / REVIEW / FAIL) par scene ;
 *   - COMPOSING construit une TIMELINE GLOBALE reelle (videoTimeline.js)
 *     basee sur les durees REELLEMENT mesurees de la voix, validee avant
 *     rendu (aucun trou, aucun ecran vide, aucune limite a 10 s) ;
 *   - QUALITY_CHECK ajoute la validation de timeline et de synchronisation
 *     voix/sous-titres aux controles ffprobe existants.
 */

const ORDER = ['QUEUED', 'PREPARING', 'GENERATING_ASSETS', 'GENERATING_VOICE', 'COMPOSING', 'RENDERING', 'QUALITY_CHECK', 'COMPLETED'];
const MAX_STEPS_PER_RUN = ORDER.length + 2; // securite anti-boucle infinie

function jobWorkDir(jobId) {
  return path.join(os.tmpdir(), 'conquistador-video-jobs', String(jobId));
}

function sanitizeId(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_') || 'x';
}

/**
 * Resout l'identite officielle de chaque scene et REFUSE explicitement tout
 * personnage non officiel (aucun personnage generique n'est fabrique).
 */
function resolveCharacters(scenes = []) {
  const list = Array.isArray(scenes) ? scenes : [];
  const perScene = [];
  const blocking = [];
  for (let i = 0; i < list.length; i += 1) {
    const scene = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const sceneId = String(scene.id || scene.scene_id || `scene_${i + 1}`);
    const raw = scene.personnage || scene.character_id || '';
    const normalized = characterRegistry.normalizeName(raw);
    if (!normalized || characterRegistry.NON_CHARACTER.has(normalized)) {
      perScene.push({ scene_id: sceneId, personnage: raw || null, character_id: null, statut: 'SANS_PERSONNAGE' });
      continue;
    }
    const characterId = characterRegistry.resolveCharacterId(raw);
    if (!characterId) {
      blocking.push({
        scene_id: sceneId,
        type: 'personnage_non_officiel',
        detail: `Le personnage "${raw}" n'est pas officiel (officiels : ${characterRegistry.CHARACTER_IDS.join(', ')}). Aucun personnage generique ne sera fabrique : corriger le script.`,
      });
      perScene.push({ scene_id: sceneId, personnage: raw, character_id: null, statut: 'NON_OFFICIEL' });
      continue;
    }
    const character = characterRegistry.getCharacter(characterId);
    perScene.push({
      scene_id: sceneId,
      personnage: raw,
      character_id: characterId,
      nom: character.nom,
      statut: 'OFFICIEL',
      statut_reference: character.statut_reference,
      references_total: character.references.length,
      reference_principale: character.reference_principale.rel_path,
      references_secondaires: character.references_secondaires.map((r) => r.rel_path),
      deux_personnages: characterRegistry.involvesBoth(raw),
      strategie_reference: characterRegistry.referenceStrategyFor(characterId, {
        providerCapabilities: require('./imageProviders/characterReferenceProvider').CAPABILITIES,
      }).strategy,
    });
  }
  return {
    registry_version: characterRegistry.REGISTRY_VERSION,
    scenes: perScene,
    bloquants: blocking,
    personnages_utilises: [...new Set(perScene.filter((s) => s.character_id).map((s) => s.character_id))],
  };
}

/** QUEUED -> PREPARING : idee/script/scenes/manifest. Reutilise src/agents/contenu.js (fullVideo) tel quel ; n'invente rien s'il echoue. */
async function stepPrepare(job) {
  if (job.input && job.input.manifest && typeof job.input.manifest === 'object') {
    const manifest = job.input.manifest;
    if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
      throw new Error('Le manifeste fourni ne contient aucune scene exploitable.');
    }
    const characters = resolveCharacters(manifest.scenes);
    return { manifest: { ...manifest, source: 'fourni_par_utilisateur' }, characters };
  }
  const sujet = job.input && job.input.sujet;
  if (!sujet) {
    throw new Error('Aucun "sujet" fourni et aucun manifeste pre-rempli : impossible de generer un script sans l\'un des deux.');
  }
  const result = await contenu.fullVideo({ sujet });
  const output = result.output || {};
  if (!Array.isArray(output.scenes) || output.scenes.length === 0) {
    throw new Error("La generation IA (contenu.fullVideo) n'a produit aucune scene exploitable.");
  }
  const characters = resolveCharacters(output.scenes);
  return {
    manifest: {
      ...output,
      source: 'genere_ia',
      provider: result.provider,
      model: result.model,
      continuite_visuelle: result.continuite_visuelle,
    },
    characters,
  };
}

/** PREPARING -> GENERATING_ASSETS : Visual Engine par scene (voir visualEngine.js). */
async function stepAssets(job) {
  const format = job.format || { width: 1080, height: 1920 };
  const scenes = (job.manifest && job.manifest.scenes) || [];
  const report = await visualEngine.resolveVideoAssets(scenes, {
    width: format.width,
    height: format.height,
    mode: job.mode_at_creation,
    workDir: path.join(jobWorkDir(job.id), 'assets'),
  });
  if (report.reussis === 0) {
    throw new Error(`Aucune des ${report.total} scene(s) n'a pu obtenir d'asset visuel (tous les providers ont echoue pour chacune) — voir assets.scenes pour le detail par scene.`);
  }
  return { assets: report };
}

/** GENERATING_ASSETS -> GENERATING_VOICE : reutilise src/agents/voiceOver.js + voiceStudio.js tels quels. Ne fabrique jamais une voix : VOICE_READY / VOICE_UNAVAILABLE / VOICE_FAILED, honnetement distingues. */
async function stepVoice(job) {
  let voice;
  try {
    voice = await voiceOver.generateForContent(job.manifest, {});
  } catch (err) {
    voice = { configured: false, raison: err.message, tracks: [] };
  }
  const tracks = Array.isArray(voice.tracks) ? voice.tracks : [];
  const hasReadyTrack = tracks.some((t) => t.audio_url);
  const statutVoix = voice.configured === false
    ? 'VOICE_UNAVAILABLE'
    : (hasReadyTrack ? 'VOICE_READY' : 'VOICE_FAILED');
  return { voice: { ...voice, statut_voix: statutVoix } };
}

/**
 * GENERATING_VOICE -> COMPOSING : timeline GLOBALE reelle + sous-titres reels
 * (subtitles.js) + resolution locale des segments audio pour le renderer.
 *
 * La timeline est construite a partir des durees REELLEMENT mesurees de la
 * voix (source de verite), avec repli explicite sur le manifeste puis sur une
 * duree par defaut. Aucune limite de duree maximale n'est appliquee.
 */
async function stepCompose(job) {
  const workDir = jobWorkDir(job.id);
  const audioDir = path.join(workDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  const tracks = (job.voice && Array.isArray(job.voice.tracks)) ? job.voice.tracks : [];
  const scenes = (job.manifest && job.manifest.scenes) || [];
  const format = job.format || { width: 1080, height: 1920 };

  const audioSegments = {};
  const downloadIssues = [];
  for (const track of tracks) {
    if (!track.audio_url) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(track.audio_url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // eslint-disable-next-line no-await-in-loop
      const buffer = Buffer.from(await response.arrayBuffer());
      const localPath = path.join(audioDir, `${sanitizeId(track.scene_id)}.mp3`);
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(localPath, buffer);
      audioSegments[track.scene_id] = localPath;
    } catch (err) {
      downloadIssues.push({ scene_id: track.scene_id, erreur: err.message });
      logger.warn('videoOrchestrator: telechargement audio de scene impossible, silence utilise a sa place', { scene_id: track.scene_id, error: err.message });
    }
  }

  // TIMELINE GLOBALE (section 7-9) : duree dynamique, jamais plafonnee.
  const timeline = videoTimeline.buildTimeline({
    scenes,
    voiceTracks: tracks,
    manifestTimeline: (job.manifest && job.manifest.timeline) || [],
    fps: Number(process.env.VIDEO_FPS) || 30,
  });
  const timelineValidation = videoTimeline.validateTimeline(timeline, {
    expectedDurationSeconds: Number(job.input && job.input.target_duration_seconds) || null,
  });
  if (!timelineValidation.ok) {
    const failing = timelineValidation.checks.filter((c) => c.status === 'fail').map((c) => c.id).join(', ');
    throw new Error(`Timeline invalide (${failing}) : le rendu ne peut pas etre lance sur une timeline incoherente.`);
  }

  const subtitlesResult = subtitles.build(tracks);
  const timelineWithSubs = videoTimeline.attachSubtitleSegments(timeline, subtitlesResult.entries);
  const syncValidation = videoTimeline.validateSynchronization(timelineWithSubs, subtitlesResult.entries);

  let srtLocalPath = null;
  if (subtitlesResult.srt) {
    srtLocalPath = path.join(workDir, 'subtitles.srt');
    await fs.writeFile(srtLocalPath, subtitlesResult.srt, 'utf8');
  }

  return {
    subtitles: { ...subtitlesResult, local_path: srtLocalPath, synchronisation: syncValidation },
    timeline: timelineWithSubs,
    timeline_validation: timelineValidation,
    compose: { audio_segments: audioSegments, download_issues: downloadIssues },
  };
}

/**
 * Construit la timeline de rendu : priorite aux timings REELLEMENT mesures
 * de la voix (job.voice.tracks), repli sur la timeline estimee par l'IA
 * (job.manifest.timeline) si la voix est indisponible, repli final sur une
 * duree fixe par scene (rendu muet mais jamais un rendu impossible pour
 * cette seule raison).
 *
 * DEPUIS la V2, cette fonction delegue a videoTimeline.buildTimeline() pour
 * ne conserver QU'UNE source de verite de timeline, tout en conservant
 * exactement la meme forme de sortie qu'avant
 * ({ scene_id, start_seconds, end_seconds }) : aucun appelant existant n'est
 * casse.
 */
function buildRenderTimeline(job) {
  const scenes = (job.manifest && job.manifest.scenes) || [];
  const tracks = (job.voice && Array.isArray(job.voice.tracks)) ? job.voice.tracks : [];
  if (job.timeline && Array.isArray(job.timeline.scenes) && job.timeline.scenes.length) {
    return job.timeline.scenes.map((s) => ({
      scene_id: s.scene_id,
      start_seconds: s.start_seconds,
      end_seconds: s.end_seconds,
    }));
  }
  const timeline = videoTimeline.buildTimeline({
    scenes,
    voiceTracks: tracks,
    manifestTimeline: (job.manifest && job.manifest.timeline) || [],
    fps: Number(process.env.VIDEO_FPS) || 30,
  });
  return timeline.scenes.map((s) => ({
    scene_id: s.scene_id,
    start_seconds: s.start_seconds,
    end_seconds: s.end_seconds,
  }));
}

/** COMPOSING -> RENDERING : seule etape qui execute ffmpeg (videoRenderer.js). */
async function stepRender(job) {
  const format = job.format || { width: 1080, height: 1920 };
  const workDir = jobWorkDir(job.id);
  const timeline = buildRenderTimeline(job);
  const assetsBySceneId = {};
  for (const a of (job.assets && job.assets.scenes) || []) {
    if (a.ok) assetsBySceneId[String(a.scene_id)] = a;
  }
  const scenesForRender = timeline.map((seg) => {
    const asset = assetsBySceneId[seg.scene_id];
    if (!asset || !asset.local_path) {
      throw new Error(`Aucun asset visuel local resolu pour la scene "${seg.scene_id}" : le rendu ne peut pas inventer un visuel manquant.`);
    }
    return {
      scene_id: seg.scene_id,
      duration_seconds: Math.max(0.34, seg.end_seconds - seg.start_seconds),
      image_path: asset.local_path,
    };
  });
  const outputPath = path.join(workDir, 'output.mp4');
  const renderResult = await videoRenderer.renderManifest({
    scenes: scenesForRender,
    audioSegments: (job.compose && job.compose.audio_segments) || {},
    subtitlesSrtPath: job.subtitles && job.subtitles.local_path ? job.subtitles.local_path : null,
    width: format.width,
    height: format.height,
    fps: Number(process.env.VIDEO_FPS) || 30,
    outputPath,
    workDir: path.join(workDir, 'render'),
  });
  return { render: renderResult };
}

/** RENDERING -> QUALITY_CHECK : controle reel du fichier (videoFileQualityCheck.js, ffprobe) + timeline + synchronisation. */
async function stepQualityCheck(job) {
  const format = job.format || { width: 1080, height: 1920 };
  const result = await videoFileQualityCheck.check(job.render.outputPath, {
    expected: {
      width: format.width,
      height: format.height,
      ratio: format.width / format.height,
      minDurationSeconds: job.render.durationSeconds,
      expectedSceneCount: job.render.sceneCount,
      assetsUsed: ((job.assets && job.assets.scenes) || []).filter((s) => s.ok),
    },
  });

  const timelineValidation = job.timeline
    ? videoTimeline.validateTimeline(job.timeline)
    : { ok: false, checks: [{ id: 'timeline_presente', status: 'fail', detail: 'Aucune timeline attachee au job.' }] };
  const syncValidation = (job.subtitles && job.subtitles.synchronisation) || { ok: true, checks: [] };

  const characterQc = (job.assets && job.assets.personnages_officiels) || null;
  const scenesAverifier = (characterQc && characterQc.scenes_a_verifier) || [];

  // Verdict global : le fichier ET la timeline ET la synchronisation doivent
  // etre conformes. Un visuel de personnage officiel genere et non conforme
  // (FAIL sur un asset AI_IMAGE_REFERENCED) rend le job NEEDS_REVIEW.
  const ok = result.ok === true && timelineValidation.ok !== false && syncValidation.ok !== false;
  const needsReview = scenesAverifier.length > 0;

  return {
    quality_check: {
      ...result,
      ok,
      timeline: timelineValidation,
      synchronisation: syncValidation,
      personnages: characterQc,
      needs_review: needsReview,
      review_reason: needsReview
        ? `Scenes a verifier (coherence de personnage officiel insuffisante) : ${scenesAverifier.join(', ')}.`
        : null,
    },
  };
}

/** QUALITY_CHECK -> COMPLETED : jamais atteint si le controle qualite a echoue, jamais atteint si le stockage durable echoue (une video inaccessible n'est pas "terminee"). */
async function stepFinalize(job) {
  if (!job.quality_check || job.quality_check.ok !== true) {
    const failing = ((job.quality_check && job.quality_check.checks) || []).filter((c) => c.status !== 'pass').map((c) => c.id).join(', ') || 'raison inconnue';
    throw new Error(`Controle qualite du fichier rendu non conforme (${failing}) : la video ne peut pas etre marquee COMPLETED.`);
  }
  const buffer = await fs.readFile(job.render.outputPath);
  const storage = await mediaStorage.upload({ path: `video-jobs/${job.id}.mp4`, buffer, contentType: 'video/mp4' });
  if (!storage.url) {
    throw new Error(`Rendu valide mais stockage durable indisponible (${storage.raison || 'non configure'}) : une video que l'utilisateur ne peut pas recuperer n'est pas consideree terminee.`);
  }
  // PREUVE DE DUREE (mission, section 7) : target / actual / delta sont
  // enregistres sur le job. La duree reelle vient du controle ffprobe deja
  // execute (videoFileQualityCheck), jamais d'une valeur supposee.
  const targetDuration = Number(job.input && job.input.target_duration_seconds) || null;
  const actualDuration = Number(job.quality_check && job.quality_check.duration_seconds) || null;
  const durationDelta = targetDuration != null && actualDuration != null
    ? Number((actualDuration - targetDuration).toFixed(3))
    : null;
  return {
    storage: { ...storage, ok: true },
    // storage_ok est la preuve exploitable par videoJobs (un job ne porte une
    // output_url que si l'upload durable a reellement reussi et l'URL a ete
    // obtenue de Supabase Storage — voir mediaStorage.upload).
    storage_ok: true,
    output_url: storage.url,
    duration_proof: {
      target_duration_seconds: targetDuration,
      actual_duration_seconds: actualDuration,
      duration_delta_seconds: durationDelta,
      source: 'ffprobe (videoFileQualityCheck.check) — duree reellement mesuree, jamais supposee.',
    },
    // Le rendu est complet ET recuperable : il devient candidat a la
    // diffusion (READY). La promotion effective est faite par
    // videoJobs.markReady() / schedulerBridge, jamais automatiquement ici.
    ready_for_publication: true,
    ready_at: new Date().toISOString(),
  };
}

const STEP_WORK = Object.freeze({
  PREPARING: stepPrepare,
  GENERATING_ASSETS: stepAssets,
  GENERATING_VOICE: stepVoice,
  COMPOSING: stepCompose,
  RENDERING: stepRender,
  QUALITY_CHECK: stepQualityCheck,
  COMPLETED: stepFinalize,
});

/**
 * Fait avancer un job d'UNE etape, avec idempotence anti double-traitement
 * (voir en-tete de fichier). Jamais appele directement depuis l'exterieur
 * avec un statut terminal : videoJobs.transition le refuserait de toute
 * facon.
 *
 * AUDIT (bug corrige avant livraison) : la premiere version utilisait
 * `job.id` seul comme cle d'idempotence pour TOUTES les etapes d'un meme
 * job. Consequence reelle observee en test : des que la premiere etape
 * (PREPARING) etait confirmee (statut TERMINE, definitif — voir
 * idempotency.checkAndMark/claim), la reclamation de l'etape SUIVANTE pour
 * ce MEME job.id etait vue comme un doublon et ignoree silencieusement : le
 * pipeline s'arretait net apres une seule etape, sans aucune erreur
 * visible. Corrige en incluant l'etape visee dans la cle
 * (`${job.id}:${nextStatus}`) : chaque etape d'un job a sa propre
 * idempotence independante, tout en empechant toujours la double execution
 * de la MEME etape (deux appels concurrents pour la meme etape du meme job
 * sont toujours dedupliques correctement).
 */
async function advanceOneStep(job) {
  const currentIndex = ORDER.indexOf(job.status);
  const nextStatus = ORDER[currentIndex + 1];
  if (!nextStatus) {
    throw new Error(`Aucune etape suivante depuis le statut "${job.status}".`);
  }
  const idempotencyKey = `${job.id}:${nextStatus}`;
  const claimResult = await idempotency.claim('video.job.process', idempotencyKey);
  if (claimResult.doublon) {
    logger.info('videoOrchestrator: cette etape est deja en cours/terminee pour ce job, aucune action', { job_id: job.id, etape: nextStatus, statut_idempotence: claimResult.statut });
    return videoJobs.getJob(job.id);
  }
  const work = STEP_WORK[nextStatus];
  try {
    const patch = work ? await work(job) : {};
    const updated = await videoJobs.transition(job.id, nextStatus, patch || {});
    await idempotency.confirm('video.job.process', idempotencyKey);
    return updated;
  } catch (err) {
    await idempotency.release('video.job.process', idempotencyKey).catch(() => {});
    logger.error('videoOrchestrator: echec a une etape du pipeline video', { job_id: job.id, etape_visee: nextStatus, error: err.message });
    return videoJobs.markFailed(job.id, { step: nextStatus, error: err });
  }
}

/** Traite un job existant d'UNE etape (utilise par le worker externe, voir scripts/render-worker.js, ou par l'endpoint HTTP video-job-process). */
async function processJob(jobId) {
  const job = await videoJobs.getJob(jobId);
  if (!job) throw new Error(`videoOrchestrator.processJob: job "${jobId}" introuvable`);
  if (videoJobs.TERMINAL_STATUSES.has(job.status)) return job;
  return advanceOneStep(job);
}

/** Fait avancer un job jusqu'a un statut terminal (boucle synchrone dans CE process). En production, cette boucle peut depasser le temps d'execution d'une fonction Netlify standard pour un rendu reel — voir docs/VIDEO_ENGINE.md : utiliser plutot des appels repetes a processJob() depuis un worker externe (scripts/render-worker.js) des que le rendu depasse quelques secondes. */
async function runToCompletion(jobId) {
  let job = await videoJobs.getJob(jobId);
  let steps = 0;
  while (job && !videoJobs.TERMINAL_STATUSES.has(job.status) && steps < MAX_STEPS_PER_RUN) {
    // eslint-disable-next-line no-await-in-loop
    job = await advanceOneStep(job);
    steps += 1;
  }
  return job;
}

/**
 * Point d'entree principal (mission : createVideo()). Cree le job
 * (idempotent) puis tente de le mener a completion dans CE process. Ne
 * publie jamais rien ; ne contourne aucune verification existante (voir
 * en-tete de fichier).
 */
async function createVideo(input = {}, { runSynchronously = true } = {}) {
  const settings = await operationalState.getSettings();
  const killStatus = await killswitch.getStatus();
  const idempotencyKey = input.idempotency_key || idempotency.deriveKey({
    sujet: input.sujet || null,
    manifest_fourni: Boolean(input.manifest),
    plateforme: input.plateforme || null,
    seed: input.idempotency_seed || null,
  });

  const { job, created } = await videoJobs.createJob({
    ...input,
    mode_at_creation: settings.mode,
    kill_switch_engaged_at_creation: killStatus.engage === true,
  }, { idempotencyKey });

  if (!created) {
    logger.info('videoOrchestrator: job existant retrouve via idempotency_key, aucune creation/relance', { job_id: job.id, statut: job.status });
    return { job, created: false };
  }

  if (!runSynchronously) return { job, created: true };
  const finalJob = await runToCompletion(job.id);
  return { job: finalJob, created: true };
}

module.exports = {
  ORDER,
  createVideo,
  processJob,
  runToCompletion,
  jobWorkDir,
  buildRenderTimeline,
  resolveCharacters,
};
