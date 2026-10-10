'use strict';

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// Couverture officielle téléchargée depuis la fiche Chariow de Savoir Utile.
const OFFICIAL_COVER_PATH = path.join(__dirname, '../../assets/products/savoir-utile-emploi-cover.png');
const PRODUCT_URL = 'https://savoir-utile.mychariow.shop/prd_s33t0e';

function xml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[ch]);
}

function buildOverlaySvg({ width, height, title, brand, cta, coverBase64 }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 720 1280" preserveAspectRatio="none">
    <rect x="30" y="52" width="660" height="958" rx="34" fill="#07172beF" stroke="#d6b25e" stroke-width="4"/>
    <text x="360" y="143" text-anchor="middle" fill="#f6f1e7" font-family="sans-serif" font-size="39" font-weight="800" letter-spacing="1">${xml(title).toLocaleUpperCase('fr-FR')}</text>
    <image x="90" y="180" width="540" height="496" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${coverBase64}" xlink:href="data:image/png;base64,${coverBase64}"/>
    <rect x="85" y="718" width="550" height="146" rx="22" fill="#d6b25e"/>
    <text x="360" y="780" text-anchor="middle" fill="#07172b" font-family="sans-serif" font-size="34" font-weight="900" letter-spacing="1">${xml(cta).toLocaleUpperCase('fr-FR')}</text>
    <text x="360" y="827" text-anchor="middle" fill="#07172b" font-family="sans-serif" font-size="24" font-weight="700">${xml(brand)} · GUIDE PRATIQUE</text>
    <text x="360" y="918" text-anchor="middle" fill="#f6f1e7" font-family="sans-serif" font-size="19" font-weight="600">${xml(PRODUCT_URL.replace(/^https:\/\//, ''))}</text>
  </svg>`;
}

/** Compose une vraie couverture et une CTA au-dessus de la dernière image IA du pipeline.
 * La zone inférieure reste libre pour les sous-titres brûlés ensuite par videoRenderer.
 */
async function compose({ backgroundPath, outputPath, width = 720, height = 1280, title = 'Décrocher un emploi', brand = 'Savoir Utile', cta = 'Découvre le guide' } = {}) {
  if (!backgroundPath || !outputPath) throw new Error('productEndCard.compose: backgroundPath et outputPath sont requis.');
  if (Number(width) / Number(height) !== 9 / 16) throw new Error('productEndCard.compose: la carte officielle est réservée au format vertical 9:16.');
  const cover = await fs.readFile(OFFICIAL_COVER_PATH);
  const svg = Buffer.from(buildOverlaySvg({
    width, height, title, brand, cta, coverBase64: cover.toString('base64'),
  }));
  await sharp(backgroundPath)
    .resize(width, height, { fit: 'cover' })
    .composite([{ input: svg, blend: 'over' }])
    .png()
    .toFile(outputPath);
  return { outputPath, width, height, coverPath: OFFICIAL_COVER_PATH, productUrl: PRODUCT_URL };
}

module.exports = { compose, OFFICIAL_COVER_PATH, PRODUCT_URL };
