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
  const format = body.format && typeof body.format === 'object' ? body.format : { ratio: '9:16', width: 1080, height: 1920 };
  const runSynchronously = body.run_synchronously !== false;

  const { job, created } = await videoOrchestrator.createVideo({
    sujet: sujet || undefined,
    manifest: hasManifest ? body.manifest : undefined,
    plateforme: optionalString(body.plateforme, 'plateforme'),
    format,
    idempotency_key: optionalString(body.idempotency_key, 'idempotency_key'),
  }, { runSynchronously });

  return json(created ? 201 : 200, { job, created });
}

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod === 'GET') return handleList(event);
  if (event.httpMethod === 'POST') return handleCreate(event);
  return json(405, { erreur: 'Methode non autorisee, utiliser GET ou POST' });
});
