'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const tiktokStore = require('../../src/core/tiktokStore');
const tiktokApi = require('../../src/core/tiktokApi');
const { safeErrorMessage } = require('../../src/core/tiktokSecurity');
const { config } = require('../../src/core/config');
const memory = require('../../src/core/memory');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const query = event.queryStringParameters || {};
  if (query.error) return json(400, { erreur: 'Autorisation TikTok refusee', detail: query.error_description || query.error });
  if (!query.code || !query.state) return json(400, { erreur: 'Le callback TikTok exige code et state' });

  const state = await tiktokStore.consumeOAuthState(query.state);
  if (!state) return json(400, { erreur: 'State OAuth TikTok invalide, expire ou deja utilise' });
  if (state.redirect_uri !== config.tiktok.redirectUri) {
    return json(400, { erreur: 'Redirect URI OAuth TikTok incoherente' });
  }

  try {
    const tokens = await tiktokApi.exchangeCode(query.code);
    if (!tokens.access_token || !tokens.refresh_token) {
      const error = new Error('TikTok doit renvoyer un access token et un refresh token');
      error.statusCode = 502;
      throw error;
    }
    const permissions = tiktokApi.normalizeGrantedScopes(tokens, state.scopes);
    const userPayload = await tiktokApi.getUserInfo({ accessToken: tokens.access_token });
    const user = tiktokApi.normalizeUser(userPayload);
    if (!user.openId) {
      const error = new Error('TikTok n’a pas renvoyé l’identifiant du compte autorisé');
      error.statusCode = 502;
      throw error;
    }
    const capabilities = tiktokApi.capabilityForScopes(permissions);
    const now = new Date().toISOString();
    const row = await tiktokStore.saveConnection({
      tokenResponse: tokens,
      user,
      permissions,
      capabilities,
    });
    await memory.recordEvent('tiktok.connection.created', {
      connectionId: row.id,
      openId: user.openId,
      permissions,
      capabilities,
    });
    return {
      statusCode: 302,
      headers: { Location: '/?tiktok=connected', 'Cache-Control': 'no-store' },
      body: '',
    };
  } catch (err) {
    const message = safeErrorMessage(err);
    await memory.recordEvent('tiktok.connection.failed', { raison: message }).catch(() => undefined);
    const error = new Error(message);
    error.statusCode = err.statusCode || 502;
    throw error;
  }
});
