'use strict';

const crypto = require('crypto');
const memory = require('./memory');
const { logger } = require('./logger');

/**
 * Deux modes d'idempotence, tous deux bases sur memory.claimIdempotencyEvent
 * (EN_COURS/TERMINE) - voir src/core/memory.js pour le detail du mecanisme.
 * Aucune architecture parallele : meme primitive, deux usages.
 *
 * 1) checkAndMark(scope, key) - idempotence "un coup" : claim puis
 *    confirmation immediate. Pour les appelants qui n'ont pas de succes/
 *    echec distinct a proteger apres coup (webhook.sale, webhook.comment,
 *    webhook.message, enveloppe payload meta.webhook) : une fois enregistre,
 *    l'evenement reste TERMINE pour toujours - comportement historique
 *    inchange.
 *
 * 2) claim/confirm/release(scope, key) - idempotence en deux temps, pour un
 *    traitement qui peut echouer partiellement (ex: evenements Meta entrants
 *    dans un meme payload). L'appelant doit explicitement confirm() apres
 *    succes reel, ou release() apres echec pour permettre un nouvel essai
 *    immediat. Une erreur qui n'appelle ni l'un ni l'autre reste recuperable
 *    via l'expiration EN_COURS (voir config.memory.idempotencyTtlMs).
 */

function deriveKey(payload) {
  const json = JSON.stringify(payload || {});
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 32);
}

async function checkAndMark(scope, key) {
  if (!scope) throw new Error('idempotency.checkAndMark: "scope" est requis');
  const finalKey = key || deriveKey({ scope, at: 'no-key-provided' });
  const result = await memory.claimIdempotencyEvent(scope, finalKey);
  if (result.doublon) {
    logger.info('idempotency: doublon detecte, traitement ignore', { scope, key: finalKey, statut: result.statut });
    return { ...result, cle: finalKey };
  }
  // Claim reussi et pas de suivi succes/echec distinct ici -> confirmation
  // immediate (comportement identique a l'ancienne version one-shot).
  await memory.confirmIdempotencyEvent(scope, finalKey);
  return { ...result, statut: 'TERMINE', cle: finalKey };
}

async function claim(scope, key, options) {
  if (!scope) throw new Error('idempotency.claim: "scope" est requis');
  const finalKey = key || deriveKey({ scope, at: 'no-key-provided' });
  const result = await memory.claimIdempotencyEvent(scope, finalKey, options);
  if (result.doublon) {
    logger.info('idempotency: doublon detecte, traitement ignore', { scope, key: finalKey, statut: result.statut });
  }
  return { ...result, cle: finalKey };
}

async function confirm(scope, key) {
  if (!scope || !key) throw new Error('idempotency.confirm: "scope" et "key" sont requis');
  return memory.confirmIdempotencyEvent(scope, key);
}

async function release(scope, key) {
  if (!scope || !key) throw new Error('idempotency.release: "scope" et "key" sont requis');
  return memory.releaseIdempotencyEvent(scope, key);
}

module.exports = { checkAndMark, claim, confirm, release, deriveKey };
