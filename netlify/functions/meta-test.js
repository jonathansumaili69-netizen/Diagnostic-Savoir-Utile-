'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const metaStore = require('../../src/core/metaStore');
const metaGraph = require('../../src/core/metaGraph');
const { safeErrorMessage } = require('../../src/core/metaSecurity');
const memory = require('../../src/core/memory');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  const row = await metaStore.getActiveConnection();
  if (!row) return json(404, { succes: false, raison: 'Aucune connexion Meta active' });
  const connection = await metaStore.getDecryptedConnection(row);
  try {
    const inspected = await metaGraph.inspectConnection({ userAccessToken: connection.userAccessToken });
    const updated = await metaStore.updateVerification(row.id, {
      facebook: inspected.user,
      pages: inspected.pages,
      instagram: inspected.instagram,
      permissions: inspected.permissions,
      capabilities: inspected.capabilities,
      userTokenExpiresAt: inspected.userTokenExpiresAt,
      lastError: null,
    });
    await memory.recordEvent('meta.connection.verified', {
      connectionId: row.id,
      pageIds: inspected.pages.map((page) => page.id),
      instagramId: inspected.instagram ? inspected.instagram.id : null,
      permissions: inspected.permissions,
    });
    return json(200, { succes: true, connexion: metaStore.publicConnection(updated) });
  } catch (err) {
    const message = safeErrorMessage(err);
    await metaStore.updateVerification(row.id, { lastError: message }).catch(() => undefined);
    await memory.recordEvent('meta.connection.verification_failed', { connectionId: row.id, raison: message }).catch(() => undefined);
    return json(err.statusCode || 502, { succes: false, raison: message, connexion: metaStore.publicConnection(await metaStore.getActiveConnection()) });
  }
});
