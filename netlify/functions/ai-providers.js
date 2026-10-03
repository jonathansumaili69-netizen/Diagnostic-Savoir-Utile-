'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const aiProviders = require('../../src/core/aiProviders');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  }
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));

  const fournisseurs = aiProviders.getRegistrySnapshot();
  return json(200, {
    fournisseurs,
    ordre_par_defaut: aiProviders.chainForProfile('default'),
    profils_routage: Object.keys(aiProviders.TASK_PROFILES).filter((p) => p !== 'default'),
  });
});
