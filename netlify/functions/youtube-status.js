'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const { config } = require('../../src/core/config');
const youtubeStore = require('../../src/core/youtubeStore');
const youtubeApi = require('../../src/core/youtubeApi');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const row = await youtubeStore.getActiveConnection();
  return json(200, {
    fournisseur: 'youtube',
    configuration_serveur: {
      client_id: Boolean(config.youtube.clientId),
      client_secret: Boolean(config.youtube.clientSecret),
      redirect_uri: Boolean(config.youtube.redirectUri),
      token_encryption_key: Boolean(config.youtube.tokenEncryptionKey),
      scopes: youtubeApi.normalizeScopes(config.youtube.oauthScope),
    },
    connexion: row ? youtubeStore.publicConnection(row) : null,
    statut: row ? (row.data && row.data.lastError ? 'erreur' : 'connecte') : 'non_connecte',
  });
});
