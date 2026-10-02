'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const memory = require('../../src/core/memory');
const approval = require('../../src/core/approval');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  }
  checkRateLimit(getRateLimitKey(event.headers));

  const params = event.queryStringParameters || {};
  if (params.all === 'true') {
    const all = await memory.list(memory.COLLECTIONS.APPROVALS, { limit: 100 });
    return json(200, { approbations: all, total: all.length });
  }

  const rows = await approval.pending();
  return json(200, { approbations: rows, total: rows.length });
});
