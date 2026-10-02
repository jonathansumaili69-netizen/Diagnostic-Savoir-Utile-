'use strict';

const path = require('path');
const fs = require('fs');

/**
 * BRANDING CENTRALISE SAVOIR UTILE (prompt maitre, section 12).
 *
 * Source de verite UNIQUE pour l'identite visuelle : logo officiel, cover du
 * guide, fonts, couleurs, style, CTA, watermark, style de sous-titres, safe
 * zones, ratios. Aucun autre module ne doit redefinir ces valeurs.
 *
 * Le logo et la cover du guide pointent vers les ASSETS OFFICIELS reellement
 * bundles : le moteur ne genere jamais une imitation d'un asset officiel
 * disponible (interdiction explicite, section 11).
 *
 * HONNETETE : si un asset officiel (ex. la cover du guide) n'est pas present
 * dans le depot, la valeur reste null et `verifyAssets()` le signale comme
 * asset NON FOURNI. Aucune imitation n'est fabriquee en remplacement.
 */

const ASSETS = path.join(__dirname, '..', '..', 'assets');

/** Premier fichier existant parmi une liste de candidats (tolerant aux versions successives). */
function firstExisting(candidates) {
  return candidates.find((rel) => {
    try {
      return fs.statSync(path.join(ASSETS, rel)).isFile();
    } catch (err) {
      return false;
    }
  }) || null;
}

/** Chemin declare par l'environnement s'il pointe vers un fichier reel. */
function fromEnv(varName, fallbackCandidates) {
  const declared = process.env[varName];
  if (declared) {
    const abs = path.isAbsolute(declared) ? declared : path.join(ASSETS, declared);
    try {
      if (fs.statSync(abs).isFile()) return path.isAbsolute(declared) ? declared : declared;
    } catch (err) {
      // valeur declaree mais absente : on retombe honnetement sur la detection locale
    }
  }
  return firstExisting(fallbackCandidates);
}

const LOGO_OFFICIEL = fromEnv('BRAND_LOGO_ASSET', [
  'logo/logo-savoir-utile-officiel.jpeg',
  'logo/logo-savoir-utile-officiel.jpg',
  'logo/logo-savoir-utile-officiel.png',
]);

/** Variante officielle v2 fournie par Savoir Utile : AJOUTEE, jamais substituee a la v1. */
const LOGO_V2 = fromEnv('BRAND_LOGO_ASSET_V2', [
  'logo/logo-savoir-utile-officiel-v2-20260920.jpg',
]);

const GUIDE_COVER = fromEnv('BRAND_GUIDE_COVER_ASSET', [
  'guide/couverture-guide-savoir-utile.jpg',
  'guide/guide-savoir-utile-couverture.jpg',
]);

const BIBLE_V1 = fromEnv('BRAND_BIBLE_ASSET_V1', ['personnages/bible-personnages-samuel-marc.jpg']);

const BIBLE_V2 = fromEnv('BRAND_BIBLE_ASSET_V2', ['personnages/bible/bible-personnages-samuel-marc-v2-20260920.jpg']);

const BRANDING = Object.freeze({
  version: '2.0',
  marque: process.env.BRAND_NAME || 'Savoir Utile',
  produit: process.env.PRODUCT_NAME || "La méthode complète pour trouver un emploi en Afrique francophone",
  langue: 'fr',
  slogan: 'Des conseils utiles, vérifiés, applicables.',
  couleurs: Object.freeze({
    primaire: '#1B3A5C',
    secondaire: '#8FC1E3',
    accent: '#F2B441',
    texte: '#ECE4D3',
    fond: '#101A2E',
    alerte: '#D9534F',
    succes: '#4CAF7D',
  }),
  fonts: Object.freeze({
    principale: process.env.BRAND_FONT || 'IBM Plex Sans',
    fallback: 'DejaVu Sans',
  }),
  assets_officiels: Object.freeze({
    logo: LOGO_OFFICIEL,
    logo_v2: LOGO_V2,
    guide_cover: GUIDE_COVER,
    bible_personnages_v1: BIBLE_V1,
    bible_personnages_v2: BIBLE_V2,
  }),
  cta: Object.freeze({
    principal: process.env.BRAND_CTA || 'Découvre la méthode complète en description',
    url: process.env.PRODUCT_URL || 'https://savoir-utile.mychariow.shop/prd_s33t0e',
    duree_recommandee_secondes: 4,
  }),
  watermark: Object.freeze({
    actif: true,
    position: 'top-right',
    opacite: 0.72,
    marge_px: 48,
    asset: LOGO_OFFICIEL,
  }),
  sous_titres: Object.freeze({
    font_name: process.env.BRAND_FONT || 'IBM Plex Sans',
    taille_ratio_largeur: 1 / 72,
    marge_bas_ratio_hauteur: 1 / 32,
    couleur_principale: '&H00ece4d3',
    couleur_contour: '&H00101a2e',
    contour: 2,
    max_caracteres_par_segment: 42,
  }),
  safe_zones: Object.freeze({
    '9:16': Object.freeze({ top: 0.12, bottom: 0.2, left: 0.06, right: 0.06 }),
    '16:9': Object.freeze({ top: 0.08, bottom: 0.12, left: 0.05, right: 0.05 }),
    '1:1': Object.freeze({ top: 0.1, bottom: 0.14, left: 0.06, right: 0.06 }),
  }),
  ratios: Object.freeze({
    defaut: '9:16',
    supportes: Object.freeze({
      '9:16': Object.freeze({ width: 1080, height: 1920, usage: 'TikTok / Reels / Shorts (PRIORITAIRE)' }),
      '16:9': Object.freeze({ width: 1920, height: 1080, usage: 'YouTube paysage' }),
      '1:1': Object.freeze({ width: 1080, height: 1080, usage: 'Feed Instagram / Facebook' }),
    }),
  }),
  regles: Object.freeze([
    "Le logo officiel n'est JAMAIS regenere par IA : l'asset officiel est reutilise tel quel.",
    'La bible des personnages fournie est la reference immuable des identites Samuel / Marc.',
    'Aucun personnage non officiel ne peut etre genere ni substitue a un personnage officiel.',
    "Les valeurs de branding ne sont definies qu'ici (aucune duplication dans les autres modules).",
    "Un asset officiel absent du depot reste declare comme NON FOURNI : aucune imitation n'est produite.",
  ]),
});

/** Ratio cible pour une plateforme donnee (jamais de ratio invente). */
function ratioForPlatform(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'youtube') return '16:9';
  if (['facebook', 'instagram', 'tiktok', 'youtube_shorts', 'reels', 'shorts'].includes(p)) return '9:16';
  return BRANDING.ratios.defaut;
}

/** Dimensions exactes pour un ratio supporte. */
function dimensionsFor(ratio) {
  const entry = BRANDING.ratios.supportes[ratio];
  if (!entry) return null;
  return { ratio, width: entry.width, height: entry.height, usage: entry.usage };
}

/** Verifie que les assets de branding declares existent reellement sur disque. */
function verifyAssets() {
  const problems = [];
  const ok = [];
  for (const [key, rel] of Object.entries(BRANDING.assets_officiels)) {
    if (!rel) {
      problems.push({ asset: key, type: 'NON_FOURNI', detail: 'aucun asset officiel correspondant dans le depot (aucune imitation ne sera produite)' });
      continue;
    }
    const abs = path.isAbsolute(rel) ? rel : path.join(ASSETS, rel);
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size === 0) problems.push({ asset: key, type: 'INVALIDE', detail: rel });
      else ok.push({ asset: key, rel_path: rel, size_bytes: stat.size });
    } catch (err) {
      problems.push({ asset: key, type: 'INTROUVABLE', detail: rel });
    }
  }
  return {
    ok: problems.every((p) => p.type === 'NON_FOURNI'),
    assets_presents: ok,
    problems,
  };
}

module.exports = { BRANDING, ASSETS, ratioForPlatform, dimensionsFor, verifyAssets };
