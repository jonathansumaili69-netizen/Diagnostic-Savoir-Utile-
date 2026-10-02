'use strict';

const crypto = require('crypto');
const memory = require('./memory');
const { logger } = require('./logger');

/**
 * ASSET CACHE — evite de regenerer/re-telecharger un asset visuel identique
 * (meme provider, meme prompt, memes dimensions, meme style, meme
 * reference). Persiste dans la collection CONTENT existante (kind:
 * "visual_asset_cache"), comme le fait deja webhook-chariow.js pour ses
 * propres entrees taguees - aucune nouvelle table Supabase requise.
 *
 * Cle deterministe = hash SHA-256 des champs qui definissent reellement
 * l'asset. Deux appels avec les memes parametres produisent TOUJOURS la
 * meme cle, quel que soit l'ordre des champs fournis.
 */

const KIND = 'visual_asset_cache';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours : un asset genere reste pertinent longtemps (pas de contenu temps-reel)

function computeKey({ provider, model, prompt, width, height, style, reference } = {}) {
  const normalized = {
    provider: String(provider || '').trim().toLowerCase(),
    model: String(model || '').trim().toLowerCase(),
    prompt: String(prompt || '').trim(),
    width: Number(width) || 0,
    height: Number(height) || 0,
    style: String(style || '').trim().toLowerCase(),
    reference: String(reference || '').trim().toLowerCase(),
  };
  const json = JSON.stringify(normalized, Object.keys(normalized).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Renvoie l'entree en cache si elle existe et n'est pas expiree (cache hit),
 * sinon null (cache miss - couvre aussi le cas d'une entree presente mais
 * expiree, traitee comme un miss plutot que de servir un asset perime).
 */
async function get(keyParams, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const key = typeof keyParams === 'string' ? keyParams : computeKey(keyParams);
  const rows = await memory.list(memory.COLLECTIONS.CONTENT, {
    filter: (data) => data.kind === KIND && data.cache_key === key,
    limit: 1,
  });
  if (!rows.length) {
    logger.info('assetCache: miss (aucune entree)', { key: key.slice(0, 12) });
    return null;
  }
  const entry = rows[0].data;
  const ageMs = Date.now() - new Date(entry.cached_at || rows[0].created_at).getTime();
  // ttlMs <= 0 = expiration immediate (meme si l'entree vient juste d'etre
  // ecrite dans la meme milliseconde, ageMs === 0) ; sinon comparaison stricte.
  if (Number.isFinite(ttlMs) && (ttlMs <= 0 || ageMs > ttlMs)) {
    logger.info('assetCache: miss (entree expiree)', { key: key.slice(0, 12), ageMs });
    return null;
  }
  logger.info('assetCache: hit', { key: key.slice(0, 12) });
  return { ...entry.asset, cache_key: key, cached_at: entry.cached_at, cache_hit: true };
}

/**
 * Enregistre un asset genere dans le cache. `asset` doit contenir au moins
 * une reference exploitable (url ou description du contenu) - jamais le
 * buffer binaire brut (la collection CONTENT n'est pas prevue pour du
 * binaire volumineux ; voir mediaStorage.js pour le stockage des fichiers
 * eux-memes). L'appelant est responsable d'avoir deja stocke le binaire et
 * de ne passer ici que la reference (url, provider, dimensions, etc.).
 */
async function set(keyParams, asset) {
  if (!asset || typeof asset !== 'object') {
    throw new Error('assetCache.set: "asset" (objet) est requis');
  }
  const key = typeof keyParams === 'string' ? keyParams : computeKey(keyParams);
  const record = await memory.insert(memory.COLLECTIONS.CONTENT, {
    kind: KIND,
    cache_key: key,
    cached_at: new Date().toISOString(),
    asset,
  });
  return { cache_key: key, id: record.id };
}

/**
 * get-or-generate : verifie le cache, et n'appelle `generateFn` (couteux -
 * appel provider reseau, ou rendu Graphic Engine) qu'en cas de miss. Stocke
 * automatiquement le resultat pour les appels suivants identiques.
 */
async function getOrGenerate(keyParams, generateFn, options = {}) {
  const key = computeKey(keyParams);
  const cached = await get(key, options);
  if (cached) return cached;
  const generated = await generateFn();
  if (generated && generated.cache === false) {
    // L'appelant peut explicitement demander de ne pas mettre en cache
    // (ex : asset EXISTING_ASSET deja stable par nature, ou echec partiel).
    return { ...generated, cache_key: key, cache_hit: false };
  }
  await set(key, generated);
  return { ...generated, cache_key: key, cache_hit: false };
}

module.exports = { KIND, DEFAULT_TTL_MS, computeKey, get, set, getOrGenerate };
