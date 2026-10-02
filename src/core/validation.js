'use strict';

const crypto = require('crypto');
const { config } = require('./config');

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.statusCode = 400;
  }
}

function requireString(value, field, { maxLength = 5000, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new ValidationError(`Le champ "${field}" doit etre une chaine de caracteres`, field);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new ValidationError(`Le champ "${field}" ne peut pas etre vide`, field);
  }
  if (value.length > maxLength) {
    throw new ValidationError(
      `Le champ "${field}" depasse la longueur maximale de ${maxLength} caracteres`,
      field
    );
  }
  return value.trim();
}

function optionalString(value, field, opts) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, { ...opts, allowEmpty: true });
}

function requireOneOf(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new ValidationError(
      `Le champ "${field}" doit etre l'une des valeurs suivantes : ${allowed.join(', ')}`,
      field
    );
  }
  return value;
}

function bodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody === undefined || rawBody === null) return Buffer.alloc(0);
  return Buffer.from(String(rawBody), 'utf8');
}

function parseJsonBody(rawBody, { maxBytes = config.http.maxBodyBytes } = {}) {
  const bytes = bodyBuffer(rawBody);
  if (bytes.length === 0) return {};
  if (bytes.length > maxBytes) {
    const err = new ValidationError(`Le corps de la requete depasse la taille maximale de ${maxBytes} octets`);
    err.statusCode = 413;
    throw err;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new ValidationError('Le corps de la requete doit etre un JSON valide');
  }
}

function headerValue(headers, names) {
  const source = headers || {};
  for (const name of names) {
    const value = source[name] || source[name.toLowerCase()] || source[name.toUpperCase()];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Retourne une identité réseau fournie par la plateforme avant les en-têtes
 * proxy génériques. Cette clé limite les abus entre clients sans prétendre
 * fournir un rate limiting distribué entre toutes les instances serverless.
 */
function getRateLimitKey(headers) {
  const value = headerValue(headers, [
    'x-nf-client-connection-ip',
    'x-real-ip',
    'client-ip',
    'x-forwarded-for',
  ]);
  if (!value) return 'anonymous';
  const first = value.split(',')[0].trim();
  return first.length > 200 ? 'anonymous' : first;
}

/**
 * Vérifie la clé API sur les endpoints sensibles. En production, une clé
 * absente est une erreur de configuration et l’endpoint refuse la requête.
 */
function assertApiKey(headers) {
  if (!config.apiKey) {
    if (config.isProduction) {
      const err = new Error('CONQUISTADOR_API_KEY doit etre configuree en production');
      err.statusCode = 503;
      throw err;
    }
    return { ok: true, warning: 'CONQUISTADOR_API_KEY non configuree en environnement local' };
  }
  const provided = headerValue(headers, ['x-conquistador-key']);
  if (!provided || provided.length !== config.apiKey.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(config.apiKey))) {
    const err = new Error('Cle API invalide ou manquante (header x-conquistador-key)');
    err.statusCode = 401;
    throw err;
  }
  return { ok: true };
}

/**
 * Vérifie une signature HMAC-SHA256 sur le corps brut d’un webhook.
 * Le format accepté est soit l’hexadécimal brut, soit `sha256=<hex>`.
 */
function assertWebhookSignature(headers, rawBody) {
  const secret = config.webhook.secret;
  if (!secret) {
    if (config.webhook.required) {
      const err = new Error('CONQUISTADOR_WEBHOOK_SECRET doit etre configure en production');
      err.statusCode = 503;
      throw err;
    }
    return { ok: true, skipped: true, warning: 'Signature webhook non configuree en environnement local' };
  }

  const provided = headerValue(headers, [
    'x-conquistador-signature',
    'x-hub-signature-256',
    'x-webhook-signature',
  ]).replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    const err = new Error('Signature webhook absente ou mal formee');
    err.statusCode = 401;
    throw err;
  }

  const expected = crypto.createHmac('sha256', secret).update(bodyBuffer(rawBody)).digest('hex');
  const valid = crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  if (!valid) {
    const err = new Error('Signature webhook invalide');
    err.statusCode = 401;
    throw err;
  }
  return { ok: true };
}

/**
 * Limitation simple des requêtes en mémoire (par instance de fonction).
 * Elle dissuade les abus basiques ; une protection distribuée doit être
 * ajoutée avec un service partagé si le trafic l’exige.
 */
const rateBuckets = new Map();

function checkRateLimit(identifier) {
  const now = Date.now();
  const windowMs = 60000;
  const key = typeof identifier === 'string' && identifier.length <= 200 ? identifier : 'anonymous';
  const bucket = rateBuckets.get(key) || [];
  const recent = bucket.filter((ts) => now - ts < windowMs);
  recent.push(now);
  rateBuckets.set(key, recent);
  if (rateBuckets.size > 10000) {
    for (const [bucketKey, timestamps] of rateBuckets) {
      if (!timestamps.some((ts) => now - ts < windowMs)) rateBuckets.delete(bucketKey);
    }
  }
  if (recent.length > config.rateLimitPerMinute) {
    const err = new Error('Trop de requetes, veuillez reessayer dans une minute');
    err.statusCode = 429;
    throw err;
  }
  return true;
}

module.exports = {
  ValidationError,
  requireString,
  optionalString,
  requireOneOf,
  parseJsonBody,
  assertApiKey,
  assertWebhookSignature,
  getRateLimitKey,
  checkRateLimit,
  headerValue,
};
