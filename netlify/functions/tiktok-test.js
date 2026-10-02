'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const tiktokStore = require('../../src/core/tiktokStore');
const tiktokService = require('../../src/core/tiktokService');
const { safeErrorMessage } = require('../../src/core/tiktokSecurity');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  const row = await tiktokStore.getActiveConnection();
  if (!row) return json(200, {
    fournisseur: 'tiktok',
    succes: false,
    statut: 'non_connecte',
    raison: 'Aucune connexion TikTok active à tester.',
  });
  try {
    const inspected = await tiktokService.safeVerify(row);
    return json(200, {
      fournisseur: 'tiktok',
      succes: true,
      statut: 'connecte',
      compte: {
        nom: inspected.user.displayName || null,
        nom_utilisateur: inspected.user.username || null,
      },
      permissions: inspected.permissions,
      capacites: inspected.capabilities,
    });
  } catch (err) {
    return json(err.statusCode || 502, {
      fournisseur: 'tiktok',
      succes: false,
      statut: 'echec',
      raison: safeErrorMessage(err),
    });
  }
});
