'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const youtubeStore = require('../../src/core/youtubeStore');
const youtubeApi = require('../../src/core/youtubeApi');
const { safeErrorMessage } = require('../../src/core/youtubeSecurity');
const { config } = require('../../src/core/config');
const memory = require('../../src/core/memory');
const { tokenExpiryFromResponse } = require('../../src/core/youtubeService');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const query = event.queryStringParameters || {};
  if (query.error) return json(400, { erreur: 'Autorisation YouTube refusee', detail: query.error_description || query.error });
  if (!query.code || !query.state) return json(400, { erreur: 'Le callback YouTube exige code et state' });

  const state = await youtubeStore.consumeOAuthState(query.state);
  if (!state) return json(400, { erreur: 'State OAuth YouTube invalide, expire ou deja utilise' });
  if (state.redirect_uri !== config.youtube.redirectUri) {
    return json(400, { erreur: 'Redirect URI OAuth YouTube incoherente' });
  }

  try {
    const tokens = await youtubeApi.exchangeCode(query.code);
    if (!tokens.access_token || !tokens.refresh_token) {
      const error = new Error('YouTube doit renvoyer un access token et un refresh token');
      error.statusCode = 502;
      throw error;
    }
    const permissions = youtubeApi.normalizeScopes(tokens.scope || state.scopes);
    const inspected = await youtubeApi.inspectConnection({ accessToken: tokens.access_token, scopes: permissions });
    const now = new Date().toISOString();
    const row = await youtubeStore.saveConnection({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: tokenExpiryFromResponse(tokens),
      data: {
        connection_key: `youtube:${inspected.channel.id}`,
        provider: 'youtube',
        channel: inspected.channel,
        permissions,
        capabilities: inspected.capabilities,
        lastVerifiedAt: now,
        connectedAt: now,
      },
    });
    await memory.recordEvent('youtube.connection.created', {
      connectionId: row.id,
      channelId: inspected.channel.id,
      permissions,
      capabilities: inspected.capabilities,
    });
    return {
      statusCode: 302,
      headers: { Location: '/?youtube=connected', 'Cache-Control': 'no-store' },
      body: '',
    };
  } catch (err) {
    const message = safeErrorMessage(err);
    await memory.recordEvent('youtube.connection.failed', { raison: message }).catch(() => undefined);
    const error = new Error(message);
    error.statusCode = err.statusCode || 502;
    throw error;
  }
});
