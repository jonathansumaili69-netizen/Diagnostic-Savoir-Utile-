'use strict';

const { logger } = require('../logger');
const graphicProvider = require('./graphicProvider');
const existingAssetProvider = require('./existingAssetProvider');
const pollinationsProvider = require('./pollinationsProvider');
const characterReferenceProvider = require('./characterReferenceProvider');
const huggingFaceTextToImageProvider = require('./huggingFaceTextToImageProvider');
const tinySdCpuProvider = require('./tinySdCpuProvider');
const realisticVisionLcmCpuProvider = require('./realisticVisionLcmCpuProvider');

/**
 * REGISTRE DES PROVIDERS D'IMAGE (architecture provider-agnostic demandee) :
 * changer/ajouter un fournisseur = ajouter un fichier respectant le contrat
 * { id, requiresNetwork, requiresApiKey, generate(params) -> asset } et
 * l'inserer dans PROVIDERS + buildProviderOrder ci-dessous. Rien d'autre
 * dans le Visual Engine n'a besoin de changer (voir src/core/visualEngine.js
 * qui n'appelle que generateAsset()).
 *
 * NOTE DE PERIMETRE : ce module ne fait QUE choisir/generer un asset (buffer
 * en memoire). Le cache (assetCache.js) et le stockage durable
 * (mediaStorage.js) sont orchestres par visualEngine.js, pas ici — un asset
 * binaire ne doit jamais transiter par le cache JSON (voir la note dans
 * assetCache.js).
 *
 * AJOUT (sections 3-6 du prompt maitre) : `character_reference` est un
 * provider OPTIONNEL de generation conditionnee par les references officielles
 * du personnage. Il n'est JAMAIS requis : s'il n'est pas configure
 * (IMAGE_IMG2IMG_PROVIDER absent), l'ordre de repli reste STRICTEMENT celui
 * d'avant (existing_asset -> graphic_engine), ce qui garantit zero regression
 * pour les scenes Samuel / Marc / logo.
 */
const PROVIDERS = Object.freeze({
  character_reference: characterReferenceProvider,
  huggingface_text_to_image: huggingFaceTextToImageProvider,
  tiny_sd_cpu: tinySdCpuProvider,
  realistic_vision_lcm_cpu: realisticVisionLcmCpuProvider,
  graphic_engine: graphicProvider,
  existing_asset: existingAssetProvider,
  pollinations: pollinationsProvider,
});

/**
 * Ordre de repli reel utilise : privilegie TOUJOURS la reference officielle
 * bundlee (existing_asset) pour Samuel/Marc/logo — la continuite visuelle
 * (voir visualContinuity.js) est jugee plus importante que la nouveaute,
 * puisqu'une generation IA texte->image sans conditionnement par image de
 * reference ne peut pas garantir qu'un personnage "ressemble" a la scene
 * precedente. Pour tout le reste, tente d'abord une image IA specifique au
 * prompt (pollinations), et retombe toujours, en dernier recours, sur le
 * Graphic Engine (aucune dependance externe, ne peut pas echouer pour des
 * raisons reseau/quota).
 *
 * EXTENSION (non regressive) : pour une scene a personnage officiel, si un
 * provider image-to-image est REELLEMENT configure (cle API presente), la
 * generation conditionnee par reference officielle est tentee EN PREMIER ;
 * `existing_asset` reste le repli immediat (identite exacte, mise en scene
 * figee) — jamais un personnage generique.
 */
function buildProviderOrder(scene = {}) {
  const needsOfficialReference = scene.logo_requis === true
    || /samuel|marc/i.test(String(scene.personnage || ''));
  if (needsOfficialReference) {
    if (scene.logo_requis !== true && characterReferenceProvider.isEnabled()) {
      return ['character_reference', 'existing_asset', 'graphic_engine'];
    }
    return ['existing_asset', 'graphic_engine'];
  }
  return ['pollinations', 'graphic_engine'];
}

/**
 * Tente chaque provider de la chaine dans l'ordre, s'arrete au premier
 * succes. Chaque echec (timeout, quota, erreur reseau, non applicable) est
 * consigne dans `attempts` — jamais avale silencieusement. Si TOUS les
 * providers de la chaine echouent (ce qui ne devrait arriver que si meme
 * graphic_engine echoue, ex: SVG invalide), l'erreur agregee est levee :
 * l'appelant ne recoit jamais un succes fictif.
 */
async function runChain(order, params) {
  const attempts = [];
  for (const providerId of order) {
    const provider = PROVIDERS[providerId];
    if (!provider) continue;
    const startedAt = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const asset = await provider.generate(params);
      attempts.push({ provider: providerId, ok: true, duration_ms: Date.now() - startedAt });
      if (providerId === 'existing_asset') {
        logger.info('EXISTING_ASSET', { asset_type: asset.asset_type || 'EXISTING_ASSET' });
      } else if (attempts.some((attempt) => attempt.ok === false)) {
        logger.warn('FALLBACK', { provider: providerId, asset_type: asset.asset_type || null });
      } else if (asset.asset_type === 'AI_IMAGE' || asset.asset_type === 'AI_IMAGE_REFERENCED') {
        logger.info('AI_IMAGE_GENERATED', { provider: providerId, model: asset.model || null, asset_type: asset.asset_type });
      }
      return { asset, attempts };
    } catch (err) {
      attempts.push({
        provider: providerId,
        ok: false,
        duration_ms: Date.now() - startedAt,
        not_applicable: err.notApplicable === true,
        error: err.message,
      });
      logger.warn('imageProviders: echec provider dans la chaine de repli', { provider: providerId, error: err.message });
    }
  }
  const summary = attempts.map((a) => `${a.provider}: ${a.not_applicable ? 'non applicable' : a.error}`).join(' | ');
  const aggregate = new Error(`imageProviders: tous les providers de la chaine ont echoue (${summary})`);
  aggregate.attempts = attempts;
  throw aggregate;
}

/**
 * Genere un asset frais (buffer en memoire) en essayant la chaine de repli
 * adaptee a la scene. Ne met rien en cache et ne stocke rien : voir
 * visualEngine.js pour l'orchestration complete (cache + stockage durable).
 */
async function generateAsset({ scene = {}, width, height, mode, seed, requireAiGeneration = false } = {}) {
  if (requireAiGeneration) {
    const backendId = String(process.env.IMAGE_TEXT_TO_IMAGE_BACKEND || 'realistic_vision_lcm_cpu').trim().toLowerCase();
    const strictProviders = {
      realistic_vision_lcm_cpu: realisticVisionLcmCpuProvider,
    };
    const provider = strictProviders[backendId];
    if (!provider) throw new Error(`Backend strict d’image non autorisé : "${backendId}". Seul "realistic_vision_lcm_cpu" est autorisé; aucun provider de repli ne sera appelé.`);
    const asset = await provider.generate({ scene, width, height, seed });
    return { ...asset, provider_attempts: asset.provider_attempts || [{ provider: backendId, ok: true, model: asset.model }] };
  }
  const order = buildProviderOrder(scene);
  const { asset, attempts } = await runChain(order, { scene, width, height, mode, seed });
  return { ...asset, provider_attempts: attempts };
}

/** Etat honnete du provider optionnel de generation conditionnee (diagnostics). */
function referenceProviderStatus() {
  return characterReferenceProvider.isEnabled() ? require('./providerAdapter').status() : {
    configure: false,
    provider: null,
    raison: "Aucun provider image-to-image configure : les scenes a personnage officiel utilisent l'asset officiel tel quel.",
  };
}

module.exports = { PROVIDERS, buildProviderOrder, runChain, generateAsset, referenceProviderStatus };
