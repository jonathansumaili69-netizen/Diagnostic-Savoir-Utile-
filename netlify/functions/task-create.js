'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, requireString, assertApiKey, checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const taskEngine = require('../../src/core/taskEngine');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  }
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));

  const body = parseJsonBody(event.body);
  const type = requireString(body.type, 'type');
  const priority = body.priority;
  const declencheur = body.declencheur || 'api';
  const executeNow = body.executeNow !== false; // par defaut, on execute tout de suite.

  const task = await taskEngine.createTask({
    type,
    input: body.input || {},
    priority,
    declencheur,
  });

  if (!executeNow) {
    return json(201, { tache: task });
  }

  const executed = await taskEngine.runTask(task.id);
  return json(201, { tache: executed });
});
