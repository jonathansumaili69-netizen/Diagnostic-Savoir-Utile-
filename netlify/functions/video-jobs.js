'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, requireString, optionalString, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const videoJobs = require('../../src/core/videoJobs');
const videoOrchestrator = require('../../src/core/videoOrchestrator');

/**
 * /api/video/jobs — point d'entree unifie GET (liste)/POST (creation), meme
 * motif que tasks.js. Voir docs/VIDEO_ENGINE.md pour le contrat complet.
 */

async function handleList(event) {
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));
  const params = event.queryStringParameters || {};
  const limit = params.limit ? parseInt(params.limit, 10) : 50;
  const status = params.status;
  const jobs = await videoJobs.listJobs({ status, limit });
  return json(200, { jobs, total: jobs.length });
}

async function handleCreate(event) {
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));
  const body = parseJsonBody(event.body);

  const hasManifest = body.manifest && typeof body.manifest === 'object';
  const sujet = hasManifest ? optionalString(body.sujet, 'sujet') : requireString(body.sujet, 'sujet');
  if (!hasManifest && !sujet) {
    return json(400, { erreur: 'Fournir soit "sujet" (generation IA), soit "manifest" (manifeste deja pret) — voir docs/VIDEO_ENGINE.md.' });
  }
  const productionProfile = optionalString(body.production_profile, 'production_profile');
  if (productionProfile && productionProfile !== 'strict_multiscene') {
    return json(400, { erreur: 'production_profile non reconnu; valeur autorisée : strict_multiscene.' });
  }
  const strict = productionProfile === 'strict_multiscene';
  const targetDuration = body.target_duration_seconds == null ? (strict ? 60 : null) : Number(body.target_duration_seconds);
  if (strict && (!Number.isFinite(targetDuration) || targetDuration < 45 || targetDuration > 90)) {
    return json(400, { erreur: 'Le profil strict exige target_duration_seconds entre 45 et 90.' });
  }
  const format = body.format && typeof body.format === 'object'
    ? body.format
    : (strict ? { ratio: '9:16', width: 720, height: 1280 } : { ratio: '9:16', width: 1080, height: 1920 });
  if (strict) {
    const width = Number(format.width);
    const height = Number(format.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 720 || height < 1280 || width % 2 !== 0 || height % 2 !== 0 || Math.abs((width / height) - (9 / 16)) > 0.01) {
      return json(400, { erreur: 'Le profil strict exige un format vertical 9:16 d’au moins 720×1280.' });
    }
  }
  const runSynchronously = body.run_synchronously !== false;

  const { job, created } = await videoOrchestrator.createVideo({
    sujet: sujet || undefined,
    manifest: hasManifest ? body.manifest : undefined,
    plateforme: optionalString(body.plateforme, 'plateforme'),
    format,
    production_profile: productionProfile || null,
    target_duration_seconds: targetDuration,
    idempotency_key: optionalString(body.idempotency_key, 'idempotency_key'),
  }, { runSynchronously });

  return json(created ? 201 : 200, { job, created });
}

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod === 'GET') return handleList(event);
  if (event.httpMethod === 'POST') return handleCreate(event);
  return json(405, { erreur: 'Methode non autorisee, utiliser GET ou POST' });
});
