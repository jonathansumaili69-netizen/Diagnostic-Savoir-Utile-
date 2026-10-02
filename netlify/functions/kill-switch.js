'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const killswitch = require('../../src/core/killswitch');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));

  if (event.httpMethod === 'GET') {
    const status = await killswitch.getStatus();
    return json(200, status);
  }

  if (event.httpMethod === 'POST') {
    assertApiKey(event.headers);
    const body = parseJsonBody(event.body);
    const status = await killswitch.setStatus({
      engage: body.engage === true,
      raison: body.raison,
      changePar: body.changePar || 'dashboard',
      confirmation: body.confirmation === true,
    });
    return json(200, status);
  }

  return json(405, { erreur: 'Methode non autorisee, utiliser GET ou POST' });
});
