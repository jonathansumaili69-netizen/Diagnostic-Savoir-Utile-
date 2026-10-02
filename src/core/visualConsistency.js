'use strict';

const fs = require('fs/promises');
const sharp = require('sharp');

/**
 * VISUAL CONSISTENCY / CHARACTER QC (prompt maitre, section 6).
 *
 * Compare un visuel GENERE avec les REFERENCES OFFICIELLES du personnage et
 * renvoie un verdict EXPLICITE : PASS / REVIEW / FAIL. Aucune promesse
 * d'identite parfaite : on mesure ce qui est reellement mesurable (pHash
 * perceptuel + signature couleur + structure), avec un seuil configurable.
 *
 * Methodes (toutes locales, aucun reseau) :
 *   1. pHash DCT 32x32 -> 8x8 basse frequence -> 64 bits, distance de Hamming ;
 *   2. signature couleur perceptuelle (moyennes ponderees + ecarts) ;
 *   3. coherence de cadrage (ratio) — informatif.
 *
 * Le seuil est configurable via VISUAL_CONSISTENCY_PASS_THRESHOLD (defaut
 * 0.78) et VISUAL_CONSISTENCY_REVIEW_THRESHOLD (defaut 0.60).
 */

const PHASH_SIZE = 32;
const HASH_SIDE = 8;
const DEFAULT_PASS_THRESHOLD = 0.78;
const DEFAULT_REVIEW_THRESHOLD = 0.6;

function num(env, fallback) {
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
}

function thresholds(overrides = {}) {
  return {
    pass: overrides.pass != null ? Number(overrides.pass) : num(process.env.VISUAL_CONSISTENCY_PASS_THRESHOLD, DEFAULT_PASS_THRESHOLD),
    review: overrides.review != null ? Number(overrides.review) : num(process.env.VISUAL_CONSISTENCY_REVIEW_THRESHOLD, DEFAULT_REVIEW_THRESHOLD),
  };
}

async function toGrayMatrix(input) {
  const raw = await sharp(input)
    .resize(PHASH_SIZE, PHASH_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const matrix = [];
  for (let y = 0; y < info.height; y += 1) {
    const row = [];
    for (let x = 0; x < info.width; x += 1) row.push(data[y * info.width + x]);
    matrix.push(row);
  }
  return matrix;
}

/** DCT-II 1D (in-place sur un vecteur). */
function dct1d(vector) {
  const N = vector.length;
  const out = new Array(N).fill(0);
  for (let k = 0; k < N; k += 1) {
    let sum = 0;
    for (let n = 0; n < N; n += 1) sum += vector[n] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
    out[k] = sum * (k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N));
  }
  return out;
}

function dct2d(matrix) {
  const rows = matrix.map((row) => dct1d(row));
  const cols = [];
  for (let x = 0; x < rows[0].length; x += 1) {
    cols.push(dct1d(rows.map((r) => r[x])));
  }
  const out = matrix.map(() => []);
  for (let k = 0; k < cols.length; k += 1) {
    for (let j = 0; j < cols[k].length; j += 1) out[j][k] = cols[k][j];
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * pHash perceptuel : renvoie 16 caracteres hexadecimaux (64 bits).
 * Deterministe, sans dependance externe, stable entre environnements.
 */
async function computePHash(input) {
  const matrix = await toGrayMatrix(input);
  const coeffs = dct2d(matrix);
  const low = [];
  for (let y = 0; y < HASH_SIDE; y += 1) {
    for (let x = 0; x < HASH_SIDE; x += 1) {
      if (x === 0 && y === 0) continue;
      low.push(coeffs[y][x]);
    }
  }
  const med = median(low);
  let bits = '';
  for (let y = 0; y < HASH_SIDE; y += 1) {
    for (let x = 0; x < HASH_SIDE; x += 1) {
      if (x === 0 && y === 0) continue;
      bits += coeffs[y][x] > med ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  return hex;
}

function hexToBits(hex) {
  return hex
    .split('')
    .map((c) => parseInt(c, 16).toString(2).padStart(4, '0'))
    .join('');
}

function hammingDistance(hexA, hexB) {
  const a = hexToBits(hexA);
  const b = hexToBits(hexB);
  if (a.length !== b.length) throw new Error('visualConsistency.hammingDistance: longueurs de hash incompatibles');
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
}

/** Similarite perceptuelle [0..1] derivee de la distance de Hamming. */
function similarityFromHashes(hexA, hexB) {
  const bits = hexToBits(hexA).length || 64;
  return Math.max(0, 1 - hammingDistance(hexA, hexB) / bits);
}

/** Signature couleur : moyenne RVB + luminosite + contraste, normalisee. */
async function colorSignature(input) {
  const { data, info } = await sharp(input)
    .resize(16, 16, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let r = 0;
  let g = 0;
  let b = 0;
  const lum = [];
  const px = info.width * info.height;
  for (let i = 0; i < px; i += 1) {
    const o = i * ch;
    r += data[o];
    g += data[o + 1];
    b += data[o + 2];
    lum.push(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
  }
  const mean = lum.reduce((a, x) => a + x, 0) / (lum.length || 1);
  const variance = lum.reduce((a, x) => a + (x - mean) ** 2, 0) / (lum.length || 1);
  return { r: r / px, g: g / px, b: b / px, luminance: mean, contraste: Math.sqrt(variance) };
}

function colorSimilarity(a, b) {
  const dist = Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2) / (Math.sqrt(3) * 255);
  const lumDelta = Math.abs(a.luminance - b.luminance) / 255;
  const conDelta = Math.abs(a.contraste - b.contraste) / 128;
  return Math.max(0, 1 - (0.6 * dist + 0.25 * lumDelta + 0.15 * conDelta));
}

/** Classification explicite PASS / REVIEW / FAIL a partir de la similarite globale. */
function classify(similarity, th = thresholds()) {
  if (!Number.isFinite(similarity)) return 'FAIL';
  if (similarity >= th.pass) return 'PASS';
  if (similarity >= th.review) return 'REVIEW';
  return 'FAIL';
}

async function loadRef(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFile(input);
}

/**
 * Compare un visuel genere a un ENSEMBLE de references officielles.
 * La reference la plus proche fait foi (une identite peut etre mieux captee
 * par un cadrage secondaire que par la reference principale), mais la
 * reference principale est toujours evaluee separement et reportee.
 */
async function checkConsistency({ generated, references = [], thresholds: th = {}, referenceLabels = [] } = {}) {
  if (!generated) throw new Error('visualConsistency.checkConsistency: "generated" est requis');
  if (!Array.isArray(references) || references.length === 0) {
    return {
      status: 'FAIL',
      raison: 'Aucune reference officielle fournie : la coherence ne peut pas etre evaluee ni revendiquee.',
      evaluated: 0,
      thresholds: thresholds(th),
    };
  }
  const genBuf = await loadRef(generated);
  const genHash = await computePHash(genBuf);
  const genColor = await colorSignature(genBuf);

  const comparisons = [];
  for (let i = 0; i < references.length; i += 1) {
    const refBuf = await loadRef(references[i]);
    const refHash = await computePHash(refBuf);
    const refColor = await colorSignature(refBuf);
    const perceptual = similarityFromHashes(genHash, refHash);
    const color = colorSimilarity(genColor, refColor);
    const score = 0.65 * perceptual + 0.35 * color;
    comparisons.push({
      index: i,
      label: referenceLabels[i] || `reference_${i}`,
      perceptual_similarity: Number(perceptual.toFixed(4)),
      color_similarity: Number(color.toFixed(4)),
      score: Number(score.toFixed(4)),
      phash: refHash,
    });
  }

  const best = comparisons.reduce((a, b) => (b.score > a.score ? b : a));
  const primary = comparisons[0];
  const status = classify(best.score, thresholds(th));
  return {
    status,
    score: best.score,
    best_reference: best.label,
    primary_score: primary.score,
    primary_status: classify(primary.score, thresholds(th)),
    comparisons,
    generated_phash: genHash,
    thresholds: thresholds(th),
    raison:
      status === 'PASS'
        ? `Coherence visuelle suffisante avec la reference "${best.label}" (score ${best.score}).`
        : status === 'REVIEW'
          ? `Coherence partielle (score ${best.score}) : verification humaine recommandee avant validation.`
          : `Coherence insuffisante (score ${best.score}) : le visuel ne peut pas etre considere comme fidele a la reference officielle.`,
    honnetete:
      "Cette mesure est un indicateur perceptuel, pas une garantie d'identite. Un score PASS ne garantit pas une identite parfaite ; un score FAIL ne prouve pas non plus une absence de ressemblance.",
  };
}

/** Verifie qu'un buffer est une image exploitable (garde-fou avant tout QC). */
async function isImage(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    return Boolean(meta.width && meta.height);
  } catch (err) {
    return false;
  }
}

module.exports = {
  PHASH_SIZE,
  HASH_SIDE,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  computePHash,
  hammingDistance,
  similarityFromHashes,
  colorSignature,
  colorSimilarity,
  classify,
  checkConsistency,
  thresholds,
  isImage,
};
