'use strict';

const { logger } = require('../core/logger');
const { config } = require('../core/config');

const SAME_ORIGIN_MODE = '__SAME_ORIGIN__';

function corsHeaders() {
  return {
    ...(config.http.allowedOrigin && config.http.allowedOrigin !== SAME_ORIGIN_MODE
      ? { 'Access-Control-Allow-Origin': config.http.allowedOrigin }
      : {}),
    'Access-Control-Allow-Headers': 'Content-Type, x-conquistador-key, x-conquistador-signature, x-hub-signature-256, x-webhook-signature',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    Vary: 'Origin',
  };
}

const CORS_HEADERS = corsHeaders();

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

if (config.isProduction) {
  SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
}

function headerValue(headers = {}, name) {
  return headers[name] || headers[name.toLowerCase()] || '';
}

function originAllowed(event = {}) {
  const configured = config.http.allowedOrigin;
  const origin = headerValue(event.headers, 'Origin');
  if (!origin) return true;
  if (!configured) return false;
  if (configured === SAME_ORIGIN_MODE) {
    const host = headerValue(event.headers, 'Host');
    const forwardedProto = headerValue(event.headers, 'x-forwarded-proto');
    const protocol = forwardedProto || (config.isProduction ? 'https' : 'http');
    if (!host) return false;
    try {
      const requested = new URL(origin);
      const expected = new URL(`${protocol}://${host}`);
      return requested.protocol === expected.protocol && requested.host === expected.host;
    } catch (err) {
      return false;
    }
  }
  return origin === configured;
}

function assertAllowedOrigin(event = {}) {
  if (!originAllowed(event)) {
    const error = new Error('Origine non autorisee');
    error.statusCode = 403;
    throw error;
  }
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Enveloppe une fonction Netlify pour gérer OPTIONS (CORS preflight),
 * capturer toute erreur et journaliser sans exposer de secrets.
 */
function wrapHandler(fn) {
  return async function handler(event, context) {
    try {
      assertAllowedOrigin(event);
      if (event.httpMethod === 'OPTIONS') {
        return json(204, {});
      }
      return await fn(event, context);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        logger.error('Erreur non geree dans une fonction Netlify', {
          error: err.message,
          path: event.path,
        });
      }
      return json(statusCode, {
        erreur: err.message || 'Erreur interne',
        champ: err.field || undefined,
      });
    }
  };
}

module.exports = { json, wrapHandler, CORS_HEADERS, SECURITY_HEADERS, SAME_ORIGIN_MODE, originAllowed, assertAllowedOrigin, corsHeaders };
