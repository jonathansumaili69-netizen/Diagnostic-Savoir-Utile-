'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const youtubeStore = require('../../src/core/youtubeStore');
const youtubeService = require('../../src/core/youtubeService');
const { safeErrorMessage } = require('../../src/core/youtubeSecurity');
const memory = require('../../src/core/memory');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  const row = await youtubeStore.getActiveConnection();
  if (!row) return json(404, { succes: false, raison: 'Aucune connexion YouTube active' });
  try {
    const { inspected } = await youtubeService.inspectWithRefresh(await youtubeStore.getDecryptedConnection(row));
    const updated = await youtubeStore.updateVerification(row.id, {
      channel: inspected.channel,
      permissions: inspected.permissions,
      capabilities: inspected.capabilities,
      lastError: null,
    });
    await memory.recordEvent('youtube.connection.verified', {
      connectionId: row.id,
      channelId: inspected.channel.id,
      permissions: inspected.permissions,
      capabilities: inspected.capabilities,
    });
    return json(200, { succes: true, connexion: youtubeStore.publicConnection(updated) });
  } catch (err) {
    const message = safeErrorMessage(err);
    await youtubeStore.updateVerification(row.id, { lastError: message }).catch(() => undefined);
    await memory.recordEvent('youtube.connection.verification_failed', { connectionId: row.id, raison: message }).catch(() => undefined);
    return json(err.statusCode || 502, {
      succes: false,
      raison: message,
      connexion: youtubeStore.publicConnection(await youtubeStore.getActiveConnection()),
    });
  }
});
