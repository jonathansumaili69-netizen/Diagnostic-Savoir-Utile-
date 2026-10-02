'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const operationalState = require('../../src/core/operationalState');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const reviews = await operationalState.listVideoReviews({ limit: params.limit });
    return json(200, { revues: reviews, total: reviews.length });
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { erreur: 'Methode non autorisee, utiliser GET ou POST' });
  }
  const body = parseJsonBody(event.body);
  const review = await operationalState.saveVideoReview(body.revue || body.review || body, { taskId: body.task_id });
  return json(201, { revue: review, publication_autorisee: false });
});
