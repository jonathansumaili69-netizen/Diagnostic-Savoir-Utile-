'use strict';

const crypto = require('crypto');
const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, checkRateLimit, getRateLimitKey, headerValue } = require('../../src/core/validation');
const { config } = require('../../src/core/config');
const memory = require('../../src/core/memory');
const idempotency = require('../../src/core/idempotency');
const inboundPipeline = require('../../src/core/inboundPipeline');
const { safeErrorMessage } = require('../../src/core/metaSecurity');

function rawBytes(body) {
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(String(body || ''), 'utf8');
}

function assertMetaSignature(headers, body) {
  if (!config.meta.appSecret) {
    const error = new Error('META_APP_SECRET doit etre configure pour verifier le webhook Meta');
    error.statusCode = 503;
    throw error;
  }
  const provided = headerValue(headers, ['x-hub-signature-256']).replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    const error = new Error('Signature Meta absente ou mal formee');
    error.statusCode = 401;
    throw error;
  }
  const expected = crypto.createHmac('sha256', config.meta.appSecret).update(rawBytes(body)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) {
    const error = new Error('Signature Meta invalide');
    error.statusCode = 401;
    throw error;
  }
}

function verifyRequest(event) {
  const query = event.queryStringParameters || {};
  if (!config.meta.webhookVerifyToken) {
    const error = new Error('META_WEBHOOK_VERIFY_TOKEN doit etre configure pour le challenge Meta');
    error.statusCode = 503;
    throw error;
  }
  if (event.httpMethod !== 'GET') return false;
  if (query['hub.mode'] !== 'subscribe' || query['hub.verify_token'] !== config.meta.webhookVerifyToken) {
    const error = new Error('Verification webhook Meta refusee');
    error.statusCode = 403;
    throw error;
  }
  return true;
}

function eventKey(body) {
  const parts = [];
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    parts.push(String(entry.id || ''));
    parts.push(String(entry.time || ''));
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      parts.push(String(change.field || ''));
      const value = change.value || {};
      parts.push(String(value.comment_id || value.id || value.message_id || ''));
      parts.push(String(value.media && value.media.id || ''));
    }
    for (const message of Array.isArray(entry.messaging) ? entry.messaging : []) {
      parts.push(String(message.sender && message.sender.id || ''));
      parts.push(String(message.timestamp || ''));
      parts.push(String(message.message && message.message.mid || ''));
    }
  }
  const raw = parts.filter(Boolean).join(':') || JSON.stringify(body);
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  if (verifyRequest(event)) return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    body: event.queryStringParameters['hub.challenge'],
  };
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser GET ou POST' });
  assertMetaSignature(event.headers, event.body);
  const body = parseJsonBody(event.body);
  const key = eventKey(body);
  // Idempotence de l'ENVELOPPE (cette livraison HTTP precise de Meta),
  // distincte de l'idempotence PAR EVENEMENT geree dans inboundPipeline
  // (scope meta.inbound - voir src/core/inboundPipeline.js). CLAIM avant
  // traitement, CONFIRM seulement apres un traitement complet sans
  // exception non geree, RELEASE si une erreur inattendue interrompt tout
  // avant la fin : un retry Meta de cette meme livraison doit pouvoir
  // reessayer plutot que de rester bloque par une marque definitive posee
  // avant meme d'avoir commence.
  const claimResult = await idempotency.claim('meta.webhook', key);
  if (claimResult.doublon) return json(200, { event_recu: true, deja_traite: true, statut_idempotence: claimResult.statut });
  await memory.recordEvent('meta.webhook.received', {
    object: body.object || null,
    entry_count: Array.isArray(body.entry) ? body.entry.length : 0,
    event_key: key,
    payload: body,
  });
  let processing;
  try {
    // BUG CORRIGE : le webhook ne s'arrete plus a l'enregistrement. L'evenement
    // est transmis au moteur operationnel (contact -> analyse commerciale ->
    // preparation -> proposition Copilot / action selon le mode). Les echecs
    // internes PAR EVENEMENT sont journalises et detailles dans la reponse,
    // jamais masques, et geres individuellement (voir inboundPipeline).
    processing = await inboundPipeline.processMetaWebhookEvent(body, key);
  } catch (err) {
    await idempotency.release('meta.webhook', key);
    throw err;
  }
  await idempotency.confirm('meta.webhook', key);
  return json(200, {
    event_recu: true,
    deja_traite: false,
    pipeline: {
      evenements: processing.total,
      traites: processing.results.filter((r) => r.traite).length,
      resultats: processing.results,
    },
  });
});

module.exports = { handler: exports.handler, assertMetaSignature, eventKey, verifyRequest };
