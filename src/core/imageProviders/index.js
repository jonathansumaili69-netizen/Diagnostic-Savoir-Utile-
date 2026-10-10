'use strict';

const { logger } = require('../logger');
const graphicProvider = require('./graphicProvider');
const existingAssetProvider = require('./existingAssetProvider');
const pollinationsProvider = require('./pollinationsProvider');
const characterReferenceProvider = require('./characterReferenceProvider');
const huggingFaceTextToImageProvider = require('./huggingFaceTextToImageProvider');
const tinySdCpuProvider = require('./tinySdCpuProvider');
const realisticVisionLcmCpuProvider = require('./realisticVisionLcmCpuProvider');
const mediaProvenance = require('../mediaProvenance');

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
 * Les portraits officiels sont des references d'identite, jamais des plans de
 * production par defaut. Sans img2img conditionne, Samuel/Marc passent a une
 * image neuve (ou Graphic Engine si le provider echoue) et leur identite est
 * marquee a verifier; un portrait final n'est permis que par opt-in explicite.
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
 * Un logo ou un asset produit n'est servi que si la scene le demande
 * explicitement. Un portrait officiel ne se substitue jamais en silence a une
 * scene. Sans image-to-image, le moteur cree un visuel neuf, puis expose
 * honnetement que la ressemblance de Samuel/Marc doit etre verifiee.
 */
function buildProviderOrder(scene = {}) {
  if (scene.logo_requis === true || scene.official_asset_id) return ['existing_asset'];
  const hasOfficialCharacter = /samuel|marc/i.test(String(scene.personnage || scene.character_id || ''));
  if (hasOfficialCharacter && scene.allow_official_reference_frame === true) return ['existing_asset'];
  if (hasOfficialCharacter && characterReferenceProvider.isEnabled()) {
    return ['character_reference', 'pollinations', 'graphic_engine'];
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
      // Refuse chaque resultat avant qu'il puisse entrer dans le cache ou le rendu.
      // Le chemin de repli continue alors vers un provider autorise.
      // eslint-disable-next-line no-await-in-loop
      const provenance = await mediaProvenance.inspectAsset({ asset, scene: params.scene });
      if (!provenance.ok) {
        const error = new Error(`Asset ${providerId} rejete par le controle de provenance: ${provenance.failures.join('; ')}`);
        error.code = 'MEDIA_PROVENANCE_REJECTED';
        throw error;
      }
      attempts.push({ provider: providerId, ok: true, duration_ms: Date.now() - startedAt });
      if (providerId === 'existing_asset') {
        logger.info('EXISTING_ASSET', { asset_type: asset.asset_type || 'EXISTING_ASSET' });
      } else if (attempts.some((attempt) => attempt.ok === false)) {
        logger.warn('FALLBACK', { provider: providerId, asset_type: asset.asset_type || null });
      } else if (['AI_IMAGE', 'AI_IMAGE_REFERENCED', 'AI_IMAGE_GENERATED'].includes(asset.asset_type)) {
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
  if ((scene.logo_requis === true || scene.official_asset_id || scene.allow_official_reference_frame === true) && requireAiGeneration) {
    throw new Error('Le profil strict refuse les assets officiels comme plans; seuls des visuels de scène générés sont autorisés.');
  }
  if (requireAiGeneration) {
    const backendId = String(process.env.IMAGE_TEXT_TO_IMAGE_BACKEND || 'realistic_vision_lcm_cpu').trim().toLowerCase();
    const strictProviders = {
      realistic_vision_lcm_cpu: realisticVisionLcmCpuProvider,
    };
    const provider = strictProviders[backendId];
    if (!provider) throw new Error(`Backend strict d’image non autorisé : "${backendId}". Seul "realistic_vision_lcm_cpu" est autorisé; aucun provider de repli ne sera appelé.`);
    const asset = await provider.generate({ scene, width, height, seed });
    const provenance = await mediaProvenance.inspectAsset({ asset, scene });
    if (!provenance.ok) throw new Error(`Asset du backend strict refuse par mediaProvenance: ${provenance.failures.join('; ')}`);
    return { ...asset, provider_attempts: asset.provider_attempts || [{ provider: backendId, ok: true, model: asset.model }] };
  }
  const selectedBackend = String(process.env.IMAGE_TEXT_TO_IMAGE_BACKEND || '').trim().toLowerCase();
  if (selectedBackend === 'realistic_vision_lcm_cpu' && !scene.logo_requis && !scene.official_asset_id && !scene.allow_official_reference_frame) {
    const asset = await realisticVisionLcmCpuProvider.generate({ scene, width, height, seed });
    const provenance = await mediaProvenance.inspectAsset({ asset, scene });
    if (!provenance.ok) throw new Error(`Asset CPU refuse par mediaProvenance: ${provenance.failures.join('; ')}`);
    return { ...asset, provider_attempts: asset.provider_attempts || [{ provider: selectedBackend, ok: true, model: asset.model }] };
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
    raison: "Aucun provider image-to-image configure : un visuel neuf est produit; la ressemblance de Samuel/Marc n'est pas garantie et doit etre revue.",
  };
}

module.exports = { PROVIDERS, buildProviderOrder, runChain, generateAsset, referenceProviderStatus };
