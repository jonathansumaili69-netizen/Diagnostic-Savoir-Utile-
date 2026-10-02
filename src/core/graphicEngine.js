'use strict';

const sharp = require('sharp');
const { config } = require('./config');

/**
 * GRAPHIC ENGINE — genere de vrais visuels (titres, statistiques, citations,
 * panneaux/backgrounds de marque) sans aucune dependance reseau ni IA :
 * composition SVG (typographie, formes, couleurs de la charte Conquistador
 * OS/Savoir Utile) rasterisee en PNG via sharp (deja present dans ce
 * projet). C'est le seul type d'asset du Visual Engine qui fonctionne a
 * 100% hors-ligne, sans cle API, sans quota, sans budget - donc le socle le
 * plus fiable du pipeline video (voir src/core/visualEngine.js).
 *
 * Registre de templates volontairement resserre sur les cas reellement
 * exploitables par une scene de video faceless (titre, statistique,
 * citation, panneau/fond de marque). Extensible : ajouter un nouveau type
 * = ajouter une fonction `buildXxxSvg(params)` + une entree dans TEMPLATES.
 * Chaque builder ne fait QUE renvoyer une chaine SVG valide ; render()
 * gere la rasterisation et la validation commune (dimensions, palette).
 */

const PALETTE = Object.freeze({
  ink: '#0b1220',
  ink2: '#101a2e',
  ink3: '#16233d',
  parchment: '#ece4d3',
  parchmentDim: '#b9b09c',
  brass: '#c99a3d',
  brassBright: '#e6b653',
  violet: '#7c6adf',
  violetBright: '#9c8cf0',
  signal: '#3fa796',
  alert: '#c1502e',
});

// Une palette legerement differenciee par mode, pour que les visuels generes
// portent eux aussi l'identite du mode actif (coherence avec le theme
// frontend, voir public/style.css). Mode absent/inconnu -> palette neutre.
const MODE_ACCENTS = Object.freeze({
  silencio: '#6b7bb8',
  copilot: '#6a8cdf',
  conquistador: '#9a5cf0',
});

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Decoupe un texte en lignes tenant approximativement dans `maxCharsPerLine`
 * caracteres, sans jamais couper un mot. Approximation deliberee (pas de
 * mesure reelle de glyphes) : suffisante pour des titres/citations courts,
 * documentee comme telle plutot que presentee comme un moteur de mise en
 * page typographique precis.
 */
function wrapText(text, maxCharsPerLine) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function accentFor(mode) {
  return MODE_ACCENTS[mode] || PALETTE.violet;
}

/**
 * Nombre de caracteres approximatif tenant sur une ligne pour une taille de
 * police donnee, a partir d'une largeur moyenne de glyphe (police serif
 * grasse a ~0.56x la taille de police - approximation, pas une mesure reelle
 * de glyphes, documentee comme telle dans wrapText ci-dessus). Calculee a
 * PARTIR de fontSize (au lieu d'une estimation independante liee seulement a
 * `width`) pour rester coherente quelle que soit la formule de taille de
 * police choisie par chaque builder.
 */
function charsPerLineForFontSize(width, fontSize, { marginFraction = 0.08, avgCharWidthFactor = 0.56 } = {}) {
  const availableWidth = width * (1 - marginFraction * 2);
  return Math.max(6, Math.floor(availableWidth / (fontSize * avgCharWidthFactor)));
}

function baseDefs(width, height, accent) {
  return `
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${PALETTE.ink}"/>
        <stop offset="100%" stop-color="${PALETTE.ink2}"/>
      </linearGradient>
      <radialGradient id="glow" cx="15%" cy="0%" r="75%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#glow)"/>`;
}

/** Panneau/fond de marque : utilisable seul (arriere-plan d'une scene) ou comme base pour composer d'autres elements par-dessus (voir videoRenderer.js). */
function buildBackgroundSvg({ width, height, mode, variant = 'panel' } = {}) {
  const accent = accentFor(mode);
  const corner = variant === 'diagonal'
    ? `<path d="M0 ${height} L${width * 0.35} ${height} L${width} ${height * 0.2} L${width} 0 Z" fill="${accent}" opacity="0.06"/>`
    : `<rect x="0" y="${height - Math.round(height * 0.02)}" width="${width}" height="${Math.round(height * 0.02)}" fill="${accent}" opacity="0.35"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${baseDefs(width, height, accent)}
    ${corner}
  </svg>`;
}

/** Titre plein ecran (ouverture/CTA/transition de section). */
function buildTitleSvg({ width, height, mode, title, subtitle, brandLabel } = {}) {
  const accent = accentFor(mode);
  let fontSize = Math.round(width / 15);
  let lines = wrapText(title, charsPerLineForFontSize(width, fontSize));
  // Ajuste la taille de police si le titre est long, pour eviter tout
  // debordement (jamais plus de 5 lignes, jamais un texte tronque en
  // silence) : on retrecit progressivement plutot que de couper le texte.
  for (let attempt = 0; attempt < 4 && lines.length > 5; attempt += 1) {
    fontSize = Math.round(fontSize * 0.82);
    lines = wrapText(title, charsPerLineForFontSize(width, fontSize));
  }
  const lineHeight = Math.round(fontSize * 1.22);
  const startY = Math.round(height / 2 - (lines.length - 1) * lineHeight / 2);
  const titleLines = lines.map((line, i) => `<tspan x="${Math.round(width * 0.08)}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${baseDefs(width, height, accent)}
    <rect x="${Math.round(width * 0.08)}" y="${startY - lineHeight - 6}" width="${Math.round(width * 0.14)}" height="4" fill="${accent}"/>
    <text font-family="Georgia, 'Fraunces', serif" font-size="${fontSize}" font-weight="700" fill="${PALETTE.parchment}">${titleLines}</text>
    ${subtitle ? `<text x="${Math.round(width * 0.08)}" y="${startY + lines.length * lineHeight + Math.round(fontSize * 0.5)}" font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="${Math.round(fontSize * 0.4)}" fill="${PALETTE.parchmentDim}">${escapeXml(subtitle)}</text>` : ''}
    ${brandLabel ? `<text x="${Math.round(width * 0.08)}" y="${height - Math.round(height * 0.05)}" font-family="'IBM Plex Mono', monospace" font-size="${Math.round(fontSize * 0.28)}" letter-spacing="2" fill="${accent}">${escapeXml(String(brandLabel).toUpperCase())}</text>` : ''}
  </svg>`;
}

/** Carte de statistique (chiffre mis en avant + libelle). */
function buildStatSvg({ width, height, mode, value, label, sublabel } = {}) {
  const accent = accentFor(mode);
  const valueFontSize = Math.round(width / 6);
  const labelFontSize = Math.round(width / 22);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${baseDefs(width, height, accent)}
    <text x="${Math.round(width / 2)}" y="${Math.round(height * 0.48)}" text-anchor="middle" font-family="Georgia, 'Fraunces', serif" font-size="${valueFontSize}" font-weight="800" fill="${accent}">${escapeXml(value)}</text>
    <text x="${Math.round(width / 2)}" y="${Math.round(height * 0.48 + labelFontSize * 1.6)}" text-anchor="middle" font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="${labelFontSize}" fill="${PALETTE.parchment}">${escapeXml(label)}</text>
    ${sublabel ? `<text x="${Math.round(width / 2)}" y="${Math.round(height * 0.48 + labelFontSize * 3)}" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="${Math.round(labelFontSize * 0.7)}" fill="${PALETTE.parchmentDim}">${escapeXml(sublabel)}</text>` : ''}
  </svg>`;
}

/** Carte citation (guillemet + texte + auteur optionnel). */
function buildQuoteSvg({ width, height, mode, quote, author } = {}) {
  const accent = accentFor(mode);
  const fontSize = Math.round(width / 19);
  const lines = wrapText(quote, charsPerLineForFontSize(width, fontSize, { marginFraction: 0.12 })).slice(0, 6);
  const lineHeight = Math.round(fontSize * 1.32);
  const startY = Math.round(height / 2 - (lines.length - 1) * lineHeight / 2);
  const quoteLines = lines.map((line, i) => `<tspan x="${Math.round(width * 0.12)}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${baseDefs(width, height, accent)}
    <text x="${Math.round(width * 0.08)}" y="${startY - lineHeight * 0.6}" font-family="Georgia, serif" font-size="${Math.round(fontSize * 2.4)}" fill="${accent}" opacity="0.6">&#8220;</text>
    <text font-family="Georgia, 'Fraunces', serif" font-style="italic" font-size="${fontSize}" fill="${PALETTE.parchment}">${quoteLines}</text>
    ${author ? `<text x="${Math.round(width * 0.12)}" y="${startY + lines.length * lineHeight + fontSize}" font-family="'IBM Plex Mono', monospace" font-size="${Math.round(fontSize * 0.55)}" fill="${accent}">— ${escapeXml(author)}</text>` : ''}
  </svg>`;
}

/** Barres simples (comparaison de quelques valeurs), axe non chiffre : usage narratif, pas un graphique analytique precis. */
function buildBarChartSvg({ width, height, mode, title, bars } = {}) {
  const accent = accentFor(mode);
  const list = Array.isArray(bars) ? bars.slice(0, 6) : [];
  const max = Math.max(1, ...list.map((b) => Number(b.value) || 0));
  const chartTop = Math.round(height * 0.28);
  const chartBottom = Math.round(height * 0.82);
  const chartHeight = chartBottom - chartTop;
  const chartLeft = Math.round(width * 0.1);
  const chartRight = Math.round(width * 0.9);
  const gap = Math.round((chartRight - chartLeft) * 0.06);
  const barWidth = list.length ? Math.round((chartRight - chartLeft - gap * (list.length - 1)) / list.length) : 0;
  const barsSvg = list.map((b, i) => {
    const value = Number(b.value) || 0;
    const barHeight = Math.round((value / max) * chartHeight);
    const x = chartLeft + i * (barWidth + gap);
    const y = chartBottom - barHeight;
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${i === list.length - 1 ? accent : PALETTE.violetBright}" opacity="${i === list.length - 1 ? 1 : 0.55}" rx="3"/>
      <text x="${x + barWidth / 2}" y="${chartBottom + Math.round(height * 0.045)}" text-anchor="middle" font-family="'IBM Plex Sans', system-ui, sans-serif" font-size="${Math.round(width / 34)}" fill="${PALETTE.parchmentDim}">${escapeXml(b.label || '')}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${baseDefs(width, height, accent)}
    ${title ? `<text x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.14)}" font-family="Georgia, 'Fraunces', serif" font-size="${Math.round(width / 20)}" fill="${PALETTE.parchment}">${escapeXml(title)}</text>` : ''}
    <line x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartBottom}" stroke="${PALETTE.parchmentDim}" stroke-width="1" opacity="0.4"/>
    ${barsSvg}
  </svg>`;
}

const TEMPLATES = Object.freeze({
  background: buildBackgroundSvg,
  title: buildTitleSvg,
  stat: buildStatSvg,
  quote: buildQuoteSvg,
  bar_chart: buildBarChartSvg,
});

function listTemplates() {
  return Object.keys(TEMPLATES);
}

/**
 * Rend un visuel du Graphic Engine en PNG. Renvoie toujours un Buffer reel
 * (jamais une promesse de succes non verifiee) : une erreur sharp/SVG remonte
 * telle quelle a l'appelant (Visual Engine), qui doit la traiter comme un
 * echec de generation, pas comme un asset partiel.
 */
async function render(type, params = {}) {
  const builder = TEMPLATES[type];
  if (!builder) {
    throw new Error(`graphicEngine.render: type de template inconnu "${type}" (disponibles : ${listTemplates().join(', ')})`);
  }
  const width = Number.isFinite(Number(params.width)) && Number(params.width) > 0 ? Math.round(Number(params.width)) : 1080;
  const height = Number.isFinite(Number(params.height)) && Number(params.height) > 0 ? Math.round(Number(params.height)) : 1920;
  if (width > 4000 || height > 4000) {
    throw new Error('graphicEngine.render: dimensions maximales depassees (4000px)');
  }
  const svg = builder({ ...params, width, height });
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, contentType: 'image/png', width, height, type, engine: 'graphic_engine' };
}

module.exports = {
  PALETTE,
  MODE_ACCENTS,
  listTemplates,
  render,
  wrapText,
  escapeXml,
  brandDefaultLabel: () => config.brand.name,
};
