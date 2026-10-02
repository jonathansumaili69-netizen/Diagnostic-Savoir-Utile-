'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const { config } = require('../../src/core/config');
const tiktokStore = require('../../src/core/tiktokStore');
const tiktokApi = require('../../src/core/tiktokApi');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const row = await tiktokStore.getActiveConnection();
  return json(200, {
    fournisseur: 'tiktok',
    configuration_serveur: {
      client_key: Boolean(config.tiktok.clientKey),
      client_secret: Boolean(config.tiktok.clientSecret),
      redirect_uri: Boolean(config.tiktok.redirectUri),
      token_encryption_key: Boolean(config.tiktok.tokenEncryptionKey),
      scopes: tiktokApi.normalizeScopes(config.tiktok.oauthScope),
    },
    connexion: row ? tiktokStore.publicConnection(row) : null,
    statut: row ? 'connecte' : 'non_connecte',
  });
});
