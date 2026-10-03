'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const diagnostics = require('../../src/core/diagnostics');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  }
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));

  const params = event.queryStringParameters || {};
  const verifierReseau = params.reseau === 'true';

  const result = await diagnostics.runDiagnostics({ verifierReseau });
  return json(200, result);
});
