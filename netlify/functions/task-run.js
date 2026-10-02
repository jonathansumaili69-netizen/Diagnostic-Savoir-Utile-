'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { requireString, parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const taskEngine = require('../../src/core/taskEngine');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  }
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));

  const body = parseJsonBody(event.body);
  const params = event.queryStringParameters || {};
  const id = requireString(body.id || params.id, 'id');

  const task = await taskEngine.getTask(id);
  if (!task) {
    return json(404, { erreur: `Aucune tache trouvee pour l'id "${id}"` });
  }

  const executed = await taskEngine.runTask(id);
  return json(200, { tache: executed });
});
