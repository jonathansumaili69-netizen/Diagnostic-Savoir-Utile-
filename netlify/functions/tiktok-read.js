'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const tiktokStore = require('../../src/core/tiktokStore');
const tiktokService = require('../../src/core/tiktokService');
const tiktokApi = require('../../src/core/tiktokApi');
const { safeErrorMessage } = require('../../src/core/tiktokSecurity');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const row = await tiktokStore.getActiveConnection();
  if (!row) return json(200, {
    fournisseur: 'tiktok',
    statut: 'non_connecte',
    donnees: null,
    raison: 'Aucune connexion TikTok active.',
  });
  try {
    const connection = await tiktokStore.getDecryptedConnection(row);
    const verified = await tiktokService.inspectWithRefresh(connection);
    const query = event.queryStringParameters || {};
    const videos = await tiktokApi.listVideos({
      accessToken: verified.accessToken,
      cursor: query.cursor || undefined,
      maxCount: query.max_count || 20,
    });
    return json(200, {
      fournisseur: 'tiktok',
      statut: 'connecte',
      compte: {
        nom: verified.inspected.user.displayName || null,
        nom_utilisateur: verified.inspected.user.username || null,
      },
      videos: Array.isArray(videos.data && videos.data.videos) ? videos.data.videos : [],
      pagination: {
        cursor: videos.data && videos.data.cursor ? videos.data.cursor : null,
        has_more: Boolean(videos.data && videos.data.has_more),
      },
    });
  } catch (err) {
    return json(err.statusCode || 502, {
      fournisseur: 'tiktok',
      statut: 'echec',
      raison: safeErrorMessage(err),
    });
  }
});
