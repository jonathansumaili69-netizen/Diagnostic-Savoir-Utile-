'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const metaStore = require('../../src/core/metaStore');
const metaGraph = require('../../src/core/metaGraph');
const { safeErrorMessage } = require('../../src/core/metaSecurity');
const memory = require('../../src/core/memory');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const query = event.queryStringParameters || {};
  if (query.error) return json(400, { erreur: 'Autorisation Meta refusee', detail: query.error_description || query.error });
  if (!query.code || !query.state) return json(400, { erreur: 'Le callback Meta exige code et state' });

  const state = await metaStore.consumeOAuthState(query.state);
  if (!state) return json(400, { erreur: 'State OAuth invalide, expire ou deja utilise' });

  try {
    const shortToken = await metaGraph.exchangeCode(query.code);
    if (!shortToken.access_token) throw new Error('Meta n’a pas renvoye de token court');
    const longToken = await metaGraph.exchangeLongLivedToken(shortToken.access_token);
    if (!longToken.access_token) throw new Error('Meta n’a pas renvoye de token long-lived');
    const inspected = await metaGraph.inspectConnection({ userAccessToken: longToken.access_token });
    const selectedPage = inspected.pages.find((page) => page.instagramId) || inspected.pages[0] || null;
    const row = await metaStore.saveConnection({
      userAccessToken: longToken.access_token,
      pageAccessToken: selectedPage && selectedPage.accessToken,
      data: {
        connection_key: `meta:${inspected.user.id}`,
        provider: 'meta',
        facebook: inspected.user,
        pages: inspected.pages,
        instagram: inspected.instagram,
        permissions: inspected.permissions,
        capabilities: inspected.capabilities,
        userTokenExpiresAt: inspected.userTokenExpiresAt,
        lastVerifiedAt: new Date().toISOString(),
        connectedAt: new Date().toISOString(),
      },
    });
    await memory.recordEvent('meta.connection.created', {
      connectionId: row.id,
      facebookUserId: inspected.user.id,
      pageIds: inspected.pages.map((page) => page.id),
      instagramId: inspected.instagram ? inspected.instagram.id : null,
      permissions: inspected.permissions,
    });
    return {
      statusCode: 302,
      headers: { Location: '/?meta=connected', 'Cache-Control': 'no-store' },
      body: '',
    };
  } catch (err) {
    await memory.recordEvent('meta.connection.failed', { raison: safeErrorMessage(err) }).catch(() => undefined);
    const error = new Error(safeErrorMessage(err));
    error.statusCode = err.statusCode || 502;
    throw error;
  }
});
