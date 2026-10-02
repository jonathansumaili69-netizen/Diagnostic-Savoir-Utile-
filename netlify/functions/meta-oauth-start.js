'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const { config } = require('../../src/core/config');
const metaStore = require('../../src/core/metaStore');
const metaGraph = require('../../src/core/metaGraph');
const { generateOAuthState } = require('../../src/core/metaSecurity');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });

  const state = generateOAuthState();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await metaStore.saveOAuthState({ state, redirectUri: config.meta.redirectUri, expiresAt });
  const authorizationUrl = metaGraph.buildAuthorizeUrl(state);
  return json(200, {
    fournisseur: 'meta',
    authorization_url: authorizationUrl,
    redirect_uri: config.meta.redirectUri || null,
    scope: config.meta.oauthScope.split(',').filter(Boolean),
    state_expire_dans_secondes: 600,
  });
});
