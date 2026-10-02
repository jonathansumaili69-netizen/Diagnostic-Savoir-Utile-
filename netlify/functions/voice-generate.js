'use strict';

const { wrapHandler, CORS_HEADERS, SECURITY_HEADERS } = require('../../src/utils/http');
const { parseJsonBody, requireString, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const voiceStudio = require('../../src/core/voiceStudio');

exports.handler = wrapHandler(async (event) => {
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, ...SECURITY_HEADERS, Allow: 'POST' },
      body: JSON.stringify({ erreur: 'Methode non autorisee, utiliser POST' }),
    };
  }
  const body = parseJsonBody(event.body);
  const text = requireString(body.text, 'text', { maxLength: 50000 });
  const audio = await voiceStudio.synthesize({ text, rate: body.rate, voiceId: body.voice_id });
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      'Content-Type': audio.contentType,
      'Content-Disposition': 'inline; filename="conquistador-remy-neural.mp3"',
    },
    body: audio.buffer.toString('base64'),
  };
});
