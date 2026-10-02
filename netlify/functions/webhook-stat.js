'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, assertWebhookSignature, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const taskEngine = require('../../src/core/taskEngine');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  }
  assertApiKey(event.headers);
  assertWebhookSignature(event.headers, event.body);
  checkRateLimit(getRateLimitKey(event.headers));

  const body = parseJsonBody(event.body);

  const task = await taskEngine.createTask({
    type: 'stats.record',
    input: body,
    declencheur: 'webhook',
  });
  const result = await taskEngine.runTask(task.id);

  return json(200, { tache: result });
});
