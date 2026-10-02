'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const youtubeStore = require('../../src/core/youtubeStore');
const youtubeService = require('../../src/core/youtubeService');
const { safeErrorMessage } = require('../../src/core/youtubeSecurity');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const row = await youtubeStore.getActiveConnection();
  if (!row) return json(404, { succes: false, raison: 'Aucune connexion YouTube active' });
  const operation = String((event.queryStringParameters || {}).operation || 'channel').toLowerCase();
  if (operation !== 'channel') return json(400, { erreur: 'Operation YouTube non autorisee. Utiliser operation=channel' });
  try {
    const { inspected } = await youtubeService.inspectWithRefresh(await youtubeStore.getDecryptedConnection(row));
    const updated = await youtubeStore.updateVerification(row.id, {
      channel: inspected.channel,
      permissions: inspected.permissions,
      capabilities: inspected.capabilities,
      lastError: null,
    });
    return json(200, {
      succes: true,
      operation,
      chaine: youtubeStore.publicConnection(updated).chaine,
      capacites: youtubeStore.publicConnection(updated).capacites,
      permissions: youtubeStore.publicConnection(updated).permissions,
    });
  } catch (err) {
    const message = safeErrorMessage(err);
    await youtubeStore.updateVerification(row.id, { lastError: message }).catch(() => undefined);
    return json(err.statusCode || 502, { succes: false, raison: message });
  }
});
