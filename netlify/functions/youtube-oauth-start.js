'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const { config } = require('../../src/core/config');
const youtubeStore = require('../../src/core/youtubeStore');
const youtubeApi = require('../../src/core/youtubeApi');
const { generateOAuthState } = require('../../src/core/youtubeSecurity');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });

  const state = generateOAuthState();
  const authorizationUrl = youtubeApi.buildAuthorizeUrl(state);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await youtubeStore.saveOAuthState({
    state,
    redirectUri: config.youtube.redirectUri,
    scopes: youtubeApi.normalizeScopes(config.youtube.oauthScope),
    expiresAt,
  });
  return json(200, {
    fournisseur: 'youtube',
    authorization_url: authorizationUrl,
    redirect_uri: config.youtube.redirectUri || null,
    scope: youtubeApi.normalizeScopes(config.youtube.oauthScope),
    state_expire_dans_secondes: 600,
  });
});
