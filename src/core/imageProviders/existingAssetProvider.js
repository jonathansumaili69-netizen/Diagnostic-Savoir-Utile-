'use strict';

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

/**
 * Provider "existing_asset" : reutilise les VRAIES images de reference deja
 * bundlees dans ce projet (assets/personnages/, assets/logo/) plutot que
 * d'en generer une nouvelle. Pour Samuel/Marc/le logo officiel, c'est le
 * choix le plus honnete disponible sans reseau : au lieu de tenter une
 * imitation par IA (jamais garantie identique), on sert directement le
 * fichier officiel, recadre/redimensionne pour le format cible.
 *
 * Coherent avec la politique de continuite visuelle existante
 * (src/core/visualContinuity.js, section 12-14 du prompt maitre) : Samuel,
 * Marc et le logo sont les seules references OFFICIELLES autorisees. Ce
 * provider ne genere jamais un personnage non officiel.
 */

const id = 'existing_asset';
const requiresNetwork = false;
const requiresApiKey = false;

const ASSETS_ROOT = path.join(__dirname, '..', '..', '..', 'assets');

const ASSET_MAP = Object.freeze({
  logo: path.join(ASSETS_ROOT, 'logo', 'logo-savoir-utile-officiel.jpeg'),
  samuel: path.join(ASSETS_ROOT, 'personnages', 'samuel', 'samuel-reference-principale.jpeg'),
  marc: path.join(ASSETS_ROOT, 'personnages', 'marc', 'marc-reference-principale.jpg'),
  samuel_et_marc: path.join(ASSETS_ROOT, 'personnages', 'samuel-et-marc-ensemble.jpg'),
  guide_8c_cover: path.join(ASSETS_ROOT, 'products', 'guide-methode-8c-officiel.png'),
});

/** Renvoie { key, path } si cette scene correspond a une reference officielle bundlee, sinon null (provider non applicable). */
function resolveAsset(scene = {}) {
  if (scene.official_asset_id === 'guide_8c_cover') return { key: 'guide_8c_cover', path: ASSET_MAP.guide_8c_cover };
  if (scene.logo_requis === true) return { key: 'logo', path: ASSET_MAP.logo };
  const personnage = String(scene.personnage || '').toLowerCase();
  const hasSamuel = personnage.includes('samuel');
  const hasMarc = personnage.includes('marc');
  if (hasSamuel && hasMarc) return { key: 'samuel_et_marc', path: ASSET_MAP.samuel_et_marc };
  if (hasSamuel) return { key: 'samuel', path: ASSET_MAP.samuel };
  if (hasMarc) return { key: 'marc', path: ASSET_MAP.marc };
  return null;
}

async function generate({ scene = {}, width, height } = {}) {
  const resolved = resolveAsset(scene);
  if (!resolved) {
    const err = new Error('existingAssetProvider: aucune reference officielle bundlee ne correspond a cette scene (personnage non reconnu, pas de logo requis) — non applicable.');
    err.notApplicable = true;
    throw err;
  }
  let sourceStat;
  try {
    sourceStat = await fs.stat(resolved.path);
  } catch (err) {
    throw new Error(`existingAssetProvider: fichier de reference introuvable sur disque (${resolved.path}) : ${err.message}`);
  }
  const targetWidth = Number(width) > 0 ? Math.round(Number(width)) : 1080;
  const targetHeight = Number(height) > 0 ? Math.round(Number(height)) : 1920;
  const isCover = resolved.key === 'guide_8c_cover';
  const buffer = await sharp(resolved.path)
    .resize(targetWidth, targetHeight, isCover
      ? { fit: 'contain', background: '#ffffff' }
      : { fit: 'cover', position: 'attention' })
    .png()
    .toBuffer();
  const assetType = isCover ? 'OFFICIAL_PRODUCT_COVER' : (resolved.key === 'logo' ? 'OFFICIAL_LOGO' : 'EXISTING_ASSET');
  return {
    buffer,
    contentType: 'image/png',
    width: targetWidth,
    height: targetHeight,
    provider: id,
    model: `existing_asset:${resolved.key}`,
    asset_type: assetType,
    source_path: resolved.path,
    source_size_bytes: sourceStat.size,
    provenance: {
      category: isCover ? 'OFFICIAL_PRODUCT_COVER' : (resolved.key === 'logo' ? 'OFFICIAL_LOGO' : 'OFFICIAL_CHARACTER_REFERENCE'),
      source_path: resolved.path,
      usage: isCover ? 'product_proof_explicit_scene' : (resolved.key === 'logo' ? 'brand_asset_explicit_scene' : 'identity_reference_only'),
    },
  };
}

module.exports = { id, requiresNetwork, requiresApiKey, resolveAsset, ASSET_MAP, generate };
