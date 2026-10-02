'use strict';

const { int } = require('../config');
const { logger } = require('../logger');

/**
 * Provider "pollinations" : generation d'image IA reelle via
 * image.pollinations.ai — service tiers dont l'endpoint image accepte des
 * requetes anonymes (aucune cle API a fournir), verifie a la redaction de ce
 * module. IMPORTANT (contrainte budget 0$, voir CONQUISTADOR_PROGRESS.md) :
 * ce provider n'est PAS presente comme "gratuit illimite" — il est
 * documente avec ses limites reelles connues :
 *   - debit anonyme limite (de l'ordre d'une requete toutes les ~15s selon
 *     la documentation communautaire du service) ;
 *   - aucun SLA formel, service pense pour le prototypage/usage
 *     communautaire, pas pour une charge de production garantie ;
 *   - conditions/disponibilite susceptibles de changer sans préavis côté
 *     fournisseur, hors du controle de Conquistador OS.
 * Voir docs/VIDEO_ENGINE.md pour la source et la date de verification.
 *
 * Ce module effectue un VRAI appel HTTP (fetch natif Node). Dans un
 * environnement sans acces reseau sortant (ex: bac a sable de
 * developpement/CI ferme), l'appel echoue avec une erreur reseau explicite
 * — c'est un comportement attendu et gere par la chaine de fallback (voir
 * index.js), jamais une simulation de succes.
 */

const id = 'pollinations';
const requiresNetwork = true;
const requiresApiKey = false;
const BASE_URL = 'https://image.pollinations.ai/prompt';
const TIMEOUT_MS = int(process.env.IMAGE_PROVIDER_TIMEOUT_MS, 20000);
const DEFAULT_MODEL = process.env.POLLINATIONS_MODEL || 'flux';

function buildPromptText(scene = {}) {
  // prompt_final = prompt d'image deja redige par l'agent createur de
  // contenu pour cette scene precise (voir src/agents/contenu.js) ; c'est
  // la source prioritaire, la description sert de repli honnete si absente.
  return String(scene.prompt_final || scene.description || '').trim();
}

async function generate({ scene = {}, width, height, seed } = {}) {
  const prompt = buildPromptText(scene);
  if (!prompt) {
    const err = new Error('pollinationsProvider: aucun prompt exploitable pour cette scene (prompt_final/description absents).');
    err.notApplicable = true;
    throw err;
  }
  const targetWidth = Number(width) > 0 ? Math.round(Number(width)) : 1080;
  const targetHeight = Number(height) > 0 ? Math.round(Number(height)) : 1920;
  const params = new URLSearchParams({
    width: String(targetWidth),
    height: String(targetHeight),
    model: DEFAULT_MODEL,
    nologo: 'true',
  });
  if (Number.isFinite(Number(seed))) params.set('seed', String(Math.round(Number(seed))));
  const url = `${BASE_URL}/${encodeURIComponent(prompt)}?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`pollinationsProvider: HTTP ${response.status} (quota/rate-limit ou service indisponible)`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw new Error('pollinationsProvider: reponse vide (aucune image renvoyee)');
    return {
      buffer,
      contentType: response.headers.get('content-type') || 'image/jpeg',
      width: targetWidth,
      height: targetHeight,
      provider: id,
      model: DEFAULT_MODEL,
      asset_type: 'AI_IMAGE',
      prompt,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`pollinationsProvider: delai depasse (${TIMEOUT_MS}ms) — service externe lent ou inaccessible`);
    }
    logger.warn('pollinationsProvider: echec de generation', { error: err.message });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { id, requiresNetwork, requiresApiKey, generate, buildPromptText, BASE_URL };
