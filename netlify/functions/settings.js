'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey, requireOneOf } = require('../../src/core/validation');
const operationalState = require('../../src/core/operationalState');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  if (event.httpMethod === 'GET') {
    assertApiKey(event.headers);
    return json(200, {
      settings: await operationalState.getSettings(),
      modes: operationalState.MODES,
      publication_policy: 'SILENCIO_COPILOT_APPROBATION_OBLIGATOIRE__CONQUISTADOR_AUTONOMIE_REGLEE__KILL_SWITCH_TOUJOURS_ACTIF',
    });
  }
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'PUT') {
    return json(405, { erreur: 'Methode non autorisee, utiliser GET, POST ou PUT' });
  }

  assertApiKey(event.headers);
  const body = parseJsonBody(event.body);
  if (body.mode !== undefined) requireOneOf(body.mode, 'mode', operationalState.MODES);
  const settings = await operationalState.setSettings(body, {
    actor: 'dashboard',
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
  });
  return json(200, {
    settings,
    publication_policy: 'SILENCIO_COPILOT_APPROBATION_OBLIGATOIRE__CONQUISTADOR_AUTONOMIE_REGLEE__KILL_SWITCH_TOUJOURS_ACTIF',
  });
});
