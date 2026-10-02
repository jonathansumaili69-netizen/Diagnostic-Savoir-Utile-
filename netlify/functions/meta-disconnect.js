'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const metaStore = require('../../src/core/metaStore');
const memory = require('../../src/core/memory');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  const body = parseJsonBody(event.body);
  if (body.confirmation !== true) return json(400, { erreur: 'confirmation=true est requis pour deconnecter Meta' });
  const row = await metaStore.getActiveConnection();
  if (!row) return json(404, { succes: false, raison: 'Aucune connexion Meta active' });
  const disconnected = await metaStore.disconnect(row.id);
  await memory.recordEvent('meta.connection.disconnected', { connectionId: row.id });
  return json(200, { succes: true, connexion: metaStore.publicConnection(disconnected) });
});
