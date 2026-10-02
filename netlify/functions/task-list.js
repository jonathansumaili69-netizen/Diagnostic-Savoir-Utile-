'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const taskEngine = require('../../src/core/taskEngine');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  }
  checkRateLimit(getRateLimitKey(event.headers));

  const params = event.queryStringParameters || {};
  const limit = params.limit ? parseInt(params.limit, 10) : 50;
  const status = params.status;

  const tasks = await taskEngine.listTasks({
    limit,
    filter: status ? (data) => data.status === status : undefined,
  });

  return json(200, { taches: tasks, total: tasks.length });
});
