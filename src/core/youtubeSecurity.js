'use strict';

const crypto = require('crypto');
const { config } = require('./config');

function decodeKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch (err) {
    // La validation explicite ci-dessous renvoie l’erreur sûre.
  }
  return null;
}

function encryptionKey() {
  const key = decodeKey(config.youtube.tokenEncryptionKey);
  if (!key) {
    const error = new Error('YOUTUBE_TOKEN_ENCRYPTION_KEY doit etre une cle hexadecimale de 64 caracteres ou Base64 de 32 octets');
    error.statusCode = 503;
    throw error;
  }
  return key;
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function fromB64(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function encryptSecret(secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('Secret YouTube vide ou invalide');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${b64(iv)}.${b64(tag)}.${b64(ciphertext)}`;
}

function decryptSecret(payload) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Secret YouTube chiffre mal forme');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), fromB64(parts[1]));
  decipher.setAuthTag(fromB64(parts[2]));
  return Buffer.concat([decipher.update(fromB64(parts[3])), decipher.final()]).toString('utf8');
}

function generateOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashState(state) {
  return crypto.createHash('sha256').update(String(state || ''), 'utf8').digest('hex');
}

function safeErrorMessage(error) {
  const message = error && error.message ? String(error.message) : String(error || 'Erreur YouTube');
  return message
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .replace(/refresh_token=[^&\s]+/gi, 'refresh_token=[redacted]')
    .replace(/client_secret=[^&\s]+/gi, 'client_secret=[redacted]')
    .replace(/Authorization:\s*Bearer\s+[^\s]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[redacted-token]');
}

module.exports = {
  decodeKey,
  encryptionKey,
  encryptSecret,
  decryptSecret,
  generateOAuthState,
  hashState,
  safeErrorMessage,
};
