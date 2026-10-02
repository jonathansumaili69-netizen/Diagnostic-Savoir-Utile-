'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey, parseJsonBody } = require('../../src/core/validation');
const youtubeStore = require('../../src/core/youtubeStore');
const youtubeApi = require('../../src/core/youtubeApi');
const { safeErrorMessage } = require('../../src/core/youtubeSecurity');
const memory = require('../../src/core/memory');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  const body = parseJsonBody(event);
  if (body.confirmation !== true) return json(400, { erreur: 'confirmation=true est obligatoire pour deconnecter YouTube' });
  const row = await youtubeStore.getActiveConnection();
  if (!row) return json(404, { succes: false, raison: 'Aucune connexion YouTube active' });

  let revokedRemotely = false;
  try {
    const connection = await youtubeStore.getDecryptedConnection(row);
    revokedRemotely = await youtubeApi.revokeToken(connection && (connection.refreshToken || connection.accessToken));
  } catch (err) {
    await memory.recordEvent('youtube.connection.revoke_failed', { connectionId: row.id, raison: safeErrorMessage(err) }).catch(() => undefined);
  }
  const disconnected = await youtubeStore.disconnect(row.id);
  await memory.recordEvent('youtube.connection.disconnected', {
    connectionId: row.id,
    revocation_google_confirmee: revokedRemotely,
  });
  return json(200, {
    succes: true,
    revocation_google_confirmee: revokedRemotely,
    connexion: youtubeStore.publicConnection(disconnected),
  });
});
