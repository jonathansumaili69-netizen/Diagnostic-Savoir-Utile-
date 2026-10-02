'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { requireString, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const tiktokStore = require('../../src/core/tiktokStore');
const tiktokService = require('../../src/core/tiktokService');
const { safeErrorMessage } = require('../../src/core/tiktokSecurity');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'GET') return json(405, { erreur: 'Methode non autorisee, utiliser GET' });
  const params = event.queryStringParameters || {};
  const publishId = requireString(params.publication_id || params.publish_id, 'publication_id', { maxLength: 512 });
  const row = await tiktokStore.getPublication(publishId);
  if (!row) return json(404, { erreur: 'Publication TikTok inconnue dans la mémoire du projet' });
  try {
    const status = await tiktokService.safePublicationStatus(row);
    return json(200, {
      fournisseur: 'tiktok',
      succes: true,
      ...status,
      note: status.statut === 'PUBLIE'
        ? 'TikTok a retourné un état final positif. L’identifiant public n’est fourni que si TikTok l’a retourné.'
        : 'La soumission reste en traitement ou doit être corrigée. Aucun état positif n’est inventé.',
    });
  } catch (err) {
    return json(err.statusCode || 502, {
      fournisseur: 'tiktok',
      succes: false,
      statut: 'ERREUR_CONTROLE',
      raison: safeErrorMessage(err),
    });
  }
});
