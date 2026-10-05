'use strict';

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const visualContinuity = require('./visualContinuity');
const characterRegistry = require('./characterRegistry');
const visualConsistency = require('./visualConsistency');
const imageProviders = require('./imageProviders');
const assetCache = require('./assetCache');
const mediaStorage = require('./mediaStorage');
const { logger } = require('./logger');

/**
 * VISUAL ENGINE — responsabilites (voir mission Video Engine) :
 *   1. recevoir une scene ;
 *   2. verifier sa continuite visuelle (reutilise visualContinuity.js) ;
 *   3. resoudre l'identite officielle du personnage cite (characterRegistry) ;
 *   4. choisir/generer le meilleur asset disponible (chaine de repli
 *      provider-agnostic, voir imageProviders/index.js) ;
 *   5. CONTROLER la coherence visuelle avec les references officielles
 *      (visualConsistency.js : PASS / REVIEW / FAIL) ;
 *   6. stocker l'asset de facon durable (mediaStorage.js) et le mettre en
 *      cache (assetCache.js) pour eviter de le regenerer ;
 *   7. ecrire une copie locale exploitable immediatement par le Video
 *      Renderer (ffmpeg a besoin de chemins de fichiers locaux, pas d'URL) ;
 *   8. retourner une reference complete et honnete (jamais un succes fictif
 *      si le stockage durable a echoue - voir `storage.raison`).
 *
 * AJOUTS NON REGRESSIFS (sections 3-6) : `character` + `consistency`. Pour un
 * asset OFFICIEL (existing_asset), la coherence est mesuree mais
 * INFORMATIVE (l'image EST la reference : son identite est exacte par
 * construction). Pour un asset GENERE par reference (AI_IMAGE_REFERENCED),
 * un verdict FAIL est BLOQUANT : la scene est marquee NEEDS_REVIEW et
 * l'orchestrateur ne peut pas la considerer comme conforme.
 */

function cacheParamsFor(scene, width, height) {
  const provider = imageProviders.referenceProviderStatus();
  return {
    prompt: scene.prompt_final || scene.description || scene.voix_off_scene || '',
    width,
    height,
    style: scene.style || '',
    reference: scene.personnage || (scene.logo_requis ? 'logo' : ''),
    provider: provider.provider || '',
    model: provider.modele || '',
  };
}

function sceneFileStem(scene, index) {
  const raw = String(scene.id || scene.numero || `scene_${index + 1}`);
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Tente de reutiliser une entree de cache existante en telechargeant ses
 * octets depuis l'URL de stockage durable (necessite un reseau sortant en
 * production ; voir docs/VIDEO_ENGINE.md pour la limite de ce sandbox de
 * developpement, ou aucun stockage durable n'est jamais configure et cette
 * branche n'est donc jamais exercee). Un echec de telechargement n'est
 * jamais fatal : retombe simplement sur une regeneration.
 */
async function tryHydrateFromCache(cacheParams) {
  const cached = await assetCache.get(cacheParams);
  if (!cached || !cached.url) return null;
  try {
    const response = await fetch(cached.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer,
      contentType: cached.content_type || 'image/png',
      provider: cached.provider,
      model: cached.model,
      asset_type: cached.asset_type,
      width: cached.width,
      height: cached.height,
      url: cached.url,
    };
  } catch (err) {
    logger.warn('visualEngine: entree de cache presente mais telechargement impossible, regeneration', { error: err.message });
    return null;
  }
}

/**
 * Controle de coherence d'une scene a personnage officiel.
 * Renvoie null si la scene ne cite aucun personnage officiel (rien a
 * comparer : on ne fabrique pas une reference pour "pouvoir comparer").
 */
async function evaluateCharacterConsistency({ scene, asset, characterId }) {
  if (!characterId) return null;
  const character = characterRegistry.getCharacter(characterId);
  if (!character || !character.references.length) {
    return {
      status: 'FAIL',
      raison: `Aucune reference officielle disponible pour "${characterId}" : la coherence ne peut pas etre evaluee ni revendiquee.`,
      evaluated: 0,
      character_id: characterId,
    };
  }
  const references = character.references.map((r) => r.abs_path);
  const referenceLabels = character.references.map((r) => `${r.role}:${r.filename}`);
  try {
    const result = await visualConsistency.checkConsistency({ generated: asset.buffer, references, referenceLabels });
    return { ...result, character_id: characterId, enforce: asset.asset_type === 'AI_IMAGE_REFERENCED' };
  } catch (err) {
    logger.warn('visualEngine: controle de coherence visuelle impossible', { scene_id: scene.id || null, error: err.message });
    return {
      status: 'REVIEW',
      character_id: characterId,
      raison: `Controle de coherence non realisable techniquement (${err.message}) : a verifier manuellement.`,
      evaluated: 0,
    };
  }
}

/**
 * Resout l'asset visuel d'une scene unique. `workDir`, si fourni, recoit une
 * copie locale du PNG/JPEG (necessaire au Video Renderer). `priorScenes`
 * sert uniquement a la verification de continuite de style (voir
 * visualContinuity.evaluateScene).
 */
async function resolveSceneAsset(scene = {}, { width, height, mode, priorScenes = [], workDir = null, useCache = true, index = 0, requireAiGeneration = false, seenHashes = null } = {}) {
  const continuite = visualContinuity.evaluateScene(scene, priorScenes);
  const characterId = characterRegistry.resolveCharacterId(scene.personnage || scene.character_id || '');
  const character = characterId ? characterRegistry.getCharacter(characterId) : null;
  const cacheParams = cacheParamsFor(scene, width, height);

  let asset = requireAiGeneration ? null : (useCache ? await tryHydrateFromCache(cacheParams) : null);
  const fromCache = Boolean(asset);
  let providerAttempts = [];
  if (!asset) {
    asset = await imageProviders.generateAsset({ scene, width, height, mode, requireAiGeneration });
    providerAttempts = asset.provider_attempts || [];
  }

  const contentSha256 = asset.content_sha256 || crypto.createHash('sha256').update(asset.buffer).digest('hex');
  if (requireAiGeneration && asset.asset_type !== 'AI_IMAGE_GENERATED') {
    throw new Error(`La scène ${scene.id || index + 1} n’a pas été produite par un générateur IA d’images (${asset.asset_type || 'type inconnu'}).`);
  }
  if (requireAiGeneration && seenHashes && seenHashes.has(contentSha256)) {
    throw new Error(`L’image de la scène ${scene.id || index + 1} est un doublon binaire d’une autre scène; le job strict est refusé.`);
  }
  if (requireAiGeneration && seenHashes) seenHashes.add(contentSha256);

  let localPath = null;
  if (workDir) {
    await fs.mkdir(workDir, { recursive: true });
    const ext = (asset.contentType || '').includes('jpeg') ? 'jpg' : 'png';
    localPath = path.join(workDir, `${sceneFileStem(scene, index)}.${ext}`);
    await fs.writeFile(localPath, asset.buffer);
  }

  let storage = { configured: mediaStorage.configured(), url: asset.url || null };
  if (!fromCache) {
    storage = await mediaStorage.upload({
      path: `video-assets/${sceneFileStem(scene, index)}-${Date.now()}.${(asset.contentType || '').includes('jpeg') ? 'jpg' : 'png'}`,
      buffer: asset.buffer,
      contentType: asset.contentType || 'image/png',
    });
    if (requireAiGeneration && !storage.url) {
      throw new Error(`La nouvelle image de la scène ${scene.id || index + 1} n’a pas été stockée dans Supabase Storage : ${storage.raison || 'URL durable absente'}.`);
    }
    if (useCache && storage.url) {
      await assetCache.set(cacheParams, {
        url: storage.url,
        provider: asset.provider,
        model: asset.model,
        asset_type: asset.asset_type,
        width: asset.width,
        height: asset.height,
        content_type: asset.contentType || 'image/png',
      });
    }
  }

  const consistency = await evaluateCharacterConsistency({ scene, asset, characterId });

  if (!requireAiGeneration) {
    if (fromCache || asset.asset_type === 'EXISTING_ASSET') {
      logger.info('EXISTING_ASSET', { scene_id: scene.id || scene.numero || null, asset_type: asset.asset_type || 'CACHE' });
    } else if (asset.asset_type === 'AI_IMAGE' || asset.asset_type === 'AI_IMAGE_REFERENCED' || asset.asset_type === 'AI_IMAGE_GENERATED') {
      logger.info('AI_IMAGE_GENERATED', { scene_id: scene.id || scene.numero || null, provider: asset.provider || null, model: asset.model || null, asset_type: asset.asset_type, sha256: contentSha256 });
    } else {
      logger.warn('FALLBACK', { scene_id: scene.id || scene.numero || null, provider: asset.provider || null, asset_type: asset.asset_type || null });
    }
  }

  return {
    scene_id: scene.id || scene.numero || null,
    asset_type: asset.asset_type || null,
    provider: asset.provider || null,
    model: asset.model || null,
    content_sha256: contentSha256,
    storage_url: storage.url || null,
    width: asset.width,
    height: asset.height,
    local_path: localPath,
    url: storage.url || null,
    storage,
    cache_hit: fromCache,
    continuite,
    provider_attempts: providerAttempts,
    character: character
      ? {
        character_id: character.character_id,
        nom: character.nom,
        statut_reference: character.statut_reference,
        references_total: character.references.length,
        reference_principale: character.reference_principale.rel_path,
        references_secondaires: character.references_secondaires.length,
        strategie: characterRegistry.referenceStrategyFor(characterId, {
          providerCapabilities: require('./imageProviders/characterReferenceProvider').CAPABILITIES,
        }).strategy,
      }
      : null,
    consistency,
    needs_review: Boolean(consistency && consistency.enforce && consistency.status !== 'PASS'),
  };
}

/**
 * Resout les assets pour un ensemble de scenes (une video complete), dans
 * l'ordre, en propageant la continuite de style. N'echoue jamais en bloc
 * pour une seule scene en erreur : chaque scene documente son propre
 * succes/echec (voir `ok`/`erreur`), et l'appelant (orchestrateur) decide
 * s'il s'agit d'un echec bloquant pour tout le job.
 */
async function resolveVideoAssets(scenes = [], options = {}) {
  const list = Array.isArray(scenes) ? scenes : [];
  const results = [];
  const seenHashes = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const scene = list[i] && typeof list[i] === 'object' ? list[i] : {};
    try {
      // eslint-disable-next-line no-await-in-loop
      const resolved = await resolveSceneAsset(scene, { ...options, seenHashes, priorScenes: list.slice(0, i), index: i });
      results.push({ ok: true, ...resolved });
    } catch (err) {
      logger.error('visualEngine: echec de resolution d asset pour une scene', { scene_id: scene.id || null, error: err.message });
      results.push({ ok: false, scene_id: scene.id || scene.numero || null, erreur: err.message });
    }
  }
  const withCharacter = results.filter((r) => r.ok && r.character);
  return {
    total: results.length,
    reussis: results.filter((r) => r.ok).length,
    echecs: results.filter((r) => !r.ok).length,
    continuite_garantie: results.every((r) => r.ok && r.continuite && r.continuite.continuite_garantie !== false),
    personnages_officiels: {
      scenes_concernees: withCharacter.length,
      coherence_pass: withCharacter.filter((r) => r.consistency && r.consistency.status === 'PASS').length,
      coherence_review: withCharacter.filter((r) => r.consistency && r.consistency.status === 'REVIEW').length,
      coherence_fail: withCharacter.filter((r) => r.consistency && r.consistency.status === 'FAIL').length,
      scenes_a_verifier: withCharacter.filter((r) => r.needs_review).map((r) => r.scene_id),
    },
    scenes: results,
  };
}

module.exports = { resolveSceneAsset, resolveVideoAssets, cacheParamsFor, evaluateCharacterConsistency };
