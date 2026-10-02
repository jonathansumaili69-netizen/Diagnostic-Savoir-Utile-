'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const { config } = require('../../src/core/config');
const metaStore = require('../../src/core/metaStore');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const row = await metaStore.getActiveConnection();
  return json(200, {
    fournisseur: 'meta',
    configuration_serveur: {
      app_id: Boolean(config.meta.appId),
      app_secret: Boolean(config.meta.appSecret),
      redirect_uri: Boolean(config.meta.redirectUri),
      token_encryption_key: Boolean(config.meta.tokenEncryptionKey),
      webhook_verify_token: Boolean(config.meta.webhookVerifyToken),
    },
    connexion: row ? metaStore.publicConnection(row) : null,
    statut: row ? 'connecte' : 'non_connecte',
  });
});
