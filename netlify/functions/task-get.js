'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, requireString, checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const taskEngine = require('../../src/core/taskEngine');

exports.handler = wrapHandler(async (event) => {
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));
  const params = event.queryStringParameters || {};
  const id = requireString(params.id, 'id');

  const task = await taskEngine.getTask(id);
  if (!task) {
    return json(404, { erreur: `Aucune tache trouvee pour l'id "${id}"` });
  }
  return json(200, { tache: task });
});
