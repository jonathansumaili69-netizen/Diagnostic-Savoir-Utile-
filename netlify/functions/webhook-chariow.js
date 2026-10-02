'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const memory = require('../../src/core/memory');
const idempotency = require('../../src/core/idempotency');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'POST uniquement' });

  const body = parseJsonBody(event.body);
  const id = String(body.id || body.event_id || body.pulse_id || '').trim();
  const type = String(body.type || body.trigger || body.event || 'unknown').trim();

  // AUDIT (bug critique) : ce handler importait `claimIdempotencyEvent`
  // depuis src/core/idempotency, module qui n'exporte que `checkAndMark` et
  // `deriveKey` (claimIdempotencyEvent vit dans src/core/memory.js, jamais
  // appele directement par les handlers webhook). Consequence reelle : tout
  // appel avec un `id` present levait `TypeError: claimIdempotencyEvent is
  // not a function` - le webhook Chariow etait casse des qu'un identifiant
  // etait fourni. Meme corrige, l'appel original passait une seule chaine
  // combinant scope+cle et traitait le resultat (un objet `{ doublon, ... }`)
  // comme un booleen, ce qui aurait desactive silencieusement la
  // deduplication (un objet est toujours "truthy"). Corrige avec le meme
  // motif que les autres webhooks fonctionnels (voir webhook-sale.js,
  // webhook-comment.js, webhook-message.js) : idempotency.checkAndMark(
  // scope, cle) puis verification explicite de `.doublon`.
  if (id) {
    const check = await idempotency.checkAndMark('webhook.chariow', id);
    if (check.doublon) {
      return json(200, { statut: 'DOUBLON_IGNORE', event_id: id });
    }
  }

  await memory.insert(memory.COLLECTIONS.CONTENT, {
    kind: 'chariow_pulse',
    event_id: id || null,
    pulse_type: type,
    payload: body,
    at: new Date().toISOString(),
  });

  if (type === 'successful_sale') {
    await memory.recordEvent('chariow.sale', {
      event_id: id,
      amount: body.amount != null ? body.amount : (body.total != null ? body.total : null),
      source: 'chariow_pulse',
    });
  }

  return json(200, { statut: 'RECU', pulse_type: type });
});
