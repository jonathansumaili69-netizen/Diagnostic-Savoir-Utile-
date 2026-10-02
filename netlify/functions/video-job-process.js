'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { requireString, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const videoJobs = require('../../src/core/videoJobs');
const videoOrchestrator = require('../../src/core/videoOrchestrator');

/**
 * Fait avancer un job existant. C'est l'endpoint que le worker externe
 * (scripts/render-worker.js) ou un simple bouton "Continuer" du frontend
 * appelle de facon repetee pour des jobs dont le rendu depasse le temps
 * d'execution d'un appel Netlify standard (voir docs/VIDEO_ENGINE.md).
 * Idempotent par construction (voir videoOrchestrator.advanceOneStep) :
 * appeler cet endpoint plusieurs fois pour un job deja a jour ne refait
 * jamais le travail deux fois.
 */
exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));
  const params = event.queryStringParameters || {};
  const id = requireString(params.id, 'id');

  const existing = await videoJobs.getJob(id);
  if (!existing) return json(404, { erreur: `Aucun job video trouve pour l'id "${id}"` });
  if (videoJobs.TERMINAL_STATUSES.has(existing.status)) {
    return json(200, { job: existing, avance: false, raison: `Le job est deja dans un statut terminal (${existing.status}).` });
  }

  const mode = (params.mode || 'step').toLowerCase();
  const job = mode === 'complete'
    ? await videoOrchestrator.runToCompletion(id)
    : await videoOrchestrator.processJob(id);
  return json(200, { job, avance: true });
});
