'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey, requireString } = require('../../src/core/validation');
const socialConnectors = require('../../src/core/socialConnectors');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));

  if (event.httpMethod === 'GET') {
    assertApiKey(event.headers);
    return json(200, { connecteurs: await socialConnectors.getDynamicSnapshot() });
  }

  if (event.httpMethod === 'POST') {
    // Bouton "Tester la connexion" (section 2). Ne simule jamais un succes :
    // sans connecteur reel enregistre, le test echoue honnetement.
    assertApiKey(event.headers);
    const body = parseJsonBody(event.body);
    const plateforme = requireString(body.plateforme, 'plateforme');
    const result = await socialConnectors.testConnection(plateforme);
    return json(200, result);
  }

  return json(405, { erreur: 'Methode non autorisee, utiliser GET ou POST' });
});
