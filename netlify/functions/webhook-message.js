'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, requireString, optionalString, assertApiKey, assertWebhookSignature, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const taskEngine = require('../../src/core/taskEngine');
const memory = require('../../src/core/memory');
const idempotency = require('../../src/core/idempotency');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  }
  assertApiKey(event.headers);
  assertWebhookSignature(event.headers, event.body);
  checkRateLimit(getRateLimitKey(event.headers));

  const body = parseJsonBody(event.body);
  const message = requireString(body.message, 'message', { maxLength: 4000 });
  const identifiant = requireString(body.identifiant, 'identifiant');
  const canal = optionalString(body.canal, 'canal') || 'whatsapp';
  const nom = optionalString(body.nom, 'nom');

  await memory.recordEvent('webhook.message_recu', { identifiant, canal });

  // Idempotence (section 5) : evite de repreparer/renvoyer une reponse si
  // le meme message webhook est livre plusieurs fois par la source.
  const idemKey =
    optionalString(body.idempotency_key, 'idempotency_key') ||
    idempotency.deriveKey({ identifiant, canal, message });
  const dedupCheck = await idempotency.checkAndMark('webhook.message', idemKey);
  if (dedupCheck.doublon) {
    return json(200, {
      deja_traite: true,
      premiere_fois: dedupCheck.premiere_fois,
      contact: null,
      intention: null,
      reponse_preparee: null,
      envoi: null,
    });
  }

  const contactTask = await taskEngine.createTask({
    type: 'client.upsert_contact',
    input: { identifiant, nom, canal, message },
    declencheur: 'webhook',
  });
  const contactResult = await taskEngine.runTask(contactTask.id);

  const intentTask = await taskEngine.createTask({
    type: 'commercial.analyze_intent',
    input: { message },
    declencheur: 'webhook',
  });
  const intentResult = await taskEngine.runTask(intentTask.id);

  const historique = contactResult.data.result?.output?.data?.historique || [];
  const responseTask = await taskEngine.createTask({
    type: 'commercial.prepare_response',
    input: { message, historique },
    declencheur: 'webhook',
  });
  const responseResult = await taskEngine.runTask(responseTask.id);

  const preparedMessage =
    responseResult.data.result?.output?.data?.reponse ||
    responseResult.data.result?.output?.raw ||
    null;

  let sendTask = null;
  if (preparedMessage) {
    sendTask = await taskEngine.createTask({
      type: 'system.send_message',
      input: { canal, destinataire: identifiant, message: preparedMessage },
      declencheur: 'webhook',
    });
    sendTask = await taskEngine.runTask(sendTask.id);
  }

  return json(200, {
    deja_traite: false,
    contact: contactResult,
    intention: intentResult,
    reponse_preparee: responseResult,
    envoi: sendTask,
  });
});
