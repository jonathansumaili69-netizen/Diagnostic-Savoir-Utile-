'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const { config } = require('../../src/core/config');
const tiktokStore = require('../../src/core/tiktokStore');
const tiktokApi = require('../../src/core/tiktokApi');
const { generateOAuthState } = require('../../src/core/tiktokSecurity');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });

  const state = generateOAuthState();
  const authorizationUrl = tiktokApi.buildAuthorizeUrl(state);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await tiktokStore.saveOAuthState({
    state,
    redirectUri: config.tiktok.redirectUri,
    scopes: tiktokApi.normalizeScopes(config.tiktok.oauthScope),
    expiresAt,
  });
  return json(200, {
    fournisseur: 'tiktok',
    authorization_url: authorizationUrl,
    redirect_uri: config.tiktok.redirectUri || null,
    scope: tiktokApi.normalizeScopes(config.tiktok.oauthScope),
    state_expire_dans_secondes: 600,
  });
});
