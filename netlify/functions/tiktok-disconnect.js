'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const tiktokStore = require('../../src/core/tiktokStore');
const tiktokApi = require('../../src/core/tiktokApi');
const { safeErrorMessage } = require('../../src/core/tiktokSecurity');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  const row = await tiktokStore.getActiveConnection();
  if (!row) return json(200, { fournisseur: 'tiktok', deconnecte: true, statut: 'non_connecte' });
  try {
    const connection = await tiktokStore.getDecryptedConnection(row);
    // TikTok ne documente pas un endpoint de révocation universel dans le flux Login Kit.
    // La suppression locale des tokens chiffrés reste donc obligatoire et déterministe.
    const revokedAtProvider = false;
    await tiktokStore.disconnect(row.id);
    return json(200, {
      fournisseur: 'tiktok',
      deconnecte: true,
      token_revoque_chez_tiktok: revokedAtProvider,
      raison: connection ? 'Tokens locaux supprimés ; TikTok ne fournit pas de révocation universelle documentée dans ce flux.' : null,
    });
  } catch (err) {
    return json(err.statusCode || 500, { fournisseur: 'tiktok', deconnecte: false, raison: safeErrorMessage(err) });
  }
});
