'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const operationalState = require('../../src/core/operationalState');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const references = await operationalState.listKnowledge({ limit: params.limit });
    return json(200, { references, total: references.length });
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { erreur: 'Methode non autorisee, utiliser GET ou POST' });
  }
  const body = parseJsonBody(event.body);
  const reference = await operationalState.addKnowledge(body, { actor: 'dashboard' });
  return json(201, { reference });
});
