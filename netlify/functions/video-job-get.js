'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { requireString, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const videoJobs = require('../../src/core/videoJobs');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  const params = event.queryStringParameters || {};
  const id = requireString(params.id, 'id');
  const job = await videoJobs.getJob(id);
  if (!job) return json(404, { erreur: `Aucun job video trouve pour l'id "${id}"` });
  return json(200, { job });
});
