'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, optionalString, assertApiKey, assertWebhookSignature, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const memory = require('../../src/core/memory');
const taskEngine = require('../../src/core/taskEngine');
const idempotency = require('../../src/core/idempotency');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  }
  assertApiKey(event.headers);
  assertWebhookSignature(event.headers, event.body);
  checkRateLimit(getRateLimitKey(event.headers));

  const body = parseJsonBody(event.body);
  const montant = Number(body.montant) || 0;
  const identifiant = optionalString(body.identifiant, 'identifiant');
  const produit = optionalString(body.produit, 'produit') || 'La methode complete pour trouver un emploi';
  const source = optionalString(body.source, 'source') || 'inconnue';

  // Idempotence (section 5) : une meme vente ne doit jamais etre comptee
  // deux fois si la plateforme source renvoie le meme webhook plusieurs
  // fois (retry). Cle preferee : idempotency_key ou transaction_id fournis
  // explicitement par l'appelant ; a defaut, l'identifiant client (moins
  // fiable si un client peut acheter plusieurs fois - fournir
  // idempotency_key/transaction_id est fortement recommande, voir README).
  const idemKey =
    optionalString(body.idempotency_key, 'idempotency_key') ||
    optionalString(body.transaction_id, 'transaction_id') ||
    identifiant;
  if (idemKey) {
    const check = await idempotency.checkAndMark('webhook.sale', idemKey);
    if (check.doublon) {
      return json(200, {
        deja_traite: true,
        premiere_fois: check.premiere_fois,
        evenement: null,
        statistiques: null,
      });
    }
  }

  const saleEvent = await memory.recordEvent('vente.nouvelle', { montant, identifiant, produit, source });

  const statsTask = await taskEngine.createTask({
    type: 'stats.record',
    input: { ventes: 1, source },
    declencheur: 'webhook',
  });
  const statsResult = await taskEngine.runTask(statsTask.id);

  return json(200, { deja_traite: false, evenement: saleEvent, statistiques: statsResult });
});
