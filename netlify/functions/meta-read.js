'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey, requireString } = require('../../src/core/validation');
const metaStore = require('../../src/core/metaStore');
const metaGraph = require('../../src/core/metaGraph');
const { safeErrorMessage } = require('../../src/core/metaSecurity');
const memory = require('../../src/core/memory');

const REQUIRED_CAPABILITY = {
  facebook_pages: null,
  facebook_posts: 'lecture_commentaires',
  facebook_comments: 'lecture_commentaires',
  facebook_conversations: 'dm',
  instagram_profile: null,
  instagram_media: null,
  instagram_comments: 'lecture_commentaires',
  instagram_conversations: 'dm',
};

function checkCapability(connection, operation) {
  const platform = operation.startsWith('facebook_') ? 'facebook' : 'instagram';
  const required = REQUIRED_CAPABILITY[operation];
  if (!required) return;
  const granted = connection.data.capabilities && connection.data.capabilities[platform];
  if (!granted || !granted[required]) {
    const error = new Error(`La capacite ${required} n’est pas accordee par Meta pour ${platform}`);
    error.statusCode = 403;
    throw error;
  }
}

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  if (event.httpMethod !== 'POST') return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  const body = parseJsonBody(event.body);
  const operation = requireString(body.operation, 'operation', { maxLength: 80 });
  const row = await metaStore.getActiveConnection();
  if (!row) return json(404, { succes: false, raison: 'Aucune connexion Meta active' });
  const connection = await metaStore.getDecryptedConnection(row);
  checkCapability(connection, operation);
  try {
    const result = await metaGraph.readData(connection, body);
    await memory.recordEvent('meta.read', { connectionId: row.id, operation, pageId: body.page_id || null, mediaId: body.media_id || null });
    return json(200, { succes: true, ...result });
  } catch (err) {
    const message = safeErrorMessage(err);
    await memory.recordEvent('meta.read.failed', { connectionId: row.id, operation, raison: message }).catch(() => undefined);
    const error = new Error(message);
    error.statusCode = err.statusCode || 502;
    throw error;
  }
});
