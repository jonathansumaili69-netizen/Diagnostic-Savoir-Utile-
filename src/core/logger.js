'use strict';

const SECRET_KEYS = [
  'apikey',
  'api_key',
  'groq_api_key',
  'gemini_api_key',
  'supabase_service_key',
  'password',
  'token',
  'secret',
  'authorization',
  'conquistador_api_key',
];

/**
 * Retire recursivement toute cle sensible d'un objet avant journalisation.
 * Ne mute jamais l'objet d'origine.
 */
function redact(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const clean = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEYS.includes(key.toLowerCase())) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = redact(val);
      }
    }
    return clean;
  }
  return value;
}

function line(level, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const serialized = JSON.stringify(entry);
  if (level === 'error') {
    console.error(serialized);
  } else if (level === 'warn') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
  return entry;
}

const logger = {
  info: (message, meta) => line('info', message, meta),
  warn: (message, meta) => line('warn', message, meta),
  error: (message, meta) => line('error', message, meta),
  debug: (message, meta) => line('debug', message, meta),
  redact,
};

module.exports = { logger, redact };
