'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const visualConsistency = require('./visualConsistency');

const ASSETS_ROOT = path.resolve(__dirname, '../../assets');
const DEFAULT_STYLE_EXAMPLE_ROOT = path.join(ASSETS_ROOT, 'style-reference');
const OFFICIAL_CHARACTERS_ROOT = path.join(ASSETS_ROOT, 'personnages');
const OFFICIAL_LOGO_ROOT = path.join(ASSETS_ROOT, 'logo');
const OFFICIAL_PRODUCTS_ROOT = path.join(ASSETS_ROOT, 'products');
const FINGERPRINT_MANIFEST = 'reference-index.json';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const EXAMPLE_DUPLICATE_HAMMING_MAX = 4;
const SCENE_DUPLICATE_HAMMING_MAX = 4;
const indexCache = new Map();

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isInside(candidate, root) {
  if (!candidate || !root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function classifyPath(sourcePath, roots = {}) {
  if (!sourcePath || /^https?:\/\//i.test(String(sourcePath))) return 'UNKNOWN_OR_REMOTE';
  const candidate = path.resolve(String(sourcePath));
  const styleRoot = path.resolve(roots.styleExampleRoot || DEFAULT_STYLE_EXAMPLE_ROOT);
  if (isInside(candidate, styleRoot)) return 'STYLE_EXAMPLE';
  if (isInside(candidate, roots.officialCharactersRoot || OFFICIAL_CHARACTERS_ROOT)) return 'OFFICIAL_CHARACTER_REFERENCE';
  if (isInside(candidate, roots.officialLogoRoot || OFFICIAL_LOGO_ROOT)) return 'OFFICIAL_LOGO';
  if (isInside(candidate, roots.officialProductsRoot || OFFICIAL_PRODUCTS_ROOT)) return 'OFFICIAL_PRODUCT_ASSET';
  return 'EXTERNAL_OR_GENERATED';
}

async function walkImages(root) {
  const files = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      files.push(...await walkImages(fullPath));
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

async function styleExampleIndex(root = DEFAULT_STYLE_EXAMPLE_ROOT) {
  const absoluteRoot = path.resolve(root);
  if (indexCache.has(absoluteRoot)) return indexCache.get(absoluteRoot);
  const pending = (async () => {
    const files = await walkImages(absoluteRoot);
    const items = [];
    for (const filePath of files) {
      let real;
      try { real = await fs.realpath(filePath); } catch { continue; }
      if (!isInside(real, absoluteRoot)) continue;
      // eslint-disable-next-line no-await-in-loop
      const buffer = await fs.readFile(real);
      let phash;
      try { phash = await visualConsistency.computePHash(buffer); } catch { continue; }
      items.push({
        id: path.relative(absoluteRoot, real).split(path.sep).join('/'),
        source_path: real,
        sha256: sha256(buffer),
        phash,
      });
    }
    const knownDigests = new Set(items.map((item) => item.sha256));
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(absoluteRoot, FINGERPRINT_MANIFEST), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Index de provenance illisible (${FINGERPRINT_MANIFEST}): ${error.message}`);
      manifest = null;
    }
    const fingerprints = Array.isArray(manifest && manifest.examples) ? manifest.examples : [];
    for (const entry of fingerprints) {
      const digest = String(entry && entry.sha256 || '').toLowerCase();
      const perceptualHash = String(entry && entry.phash || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{16}$/.test(perceptualHash) || knownDigests.has(digest)) continue;
      items.push({
        id: String(entry.id || digest.slice(0, 12)),
        source_path: null,
        source: String(entry.source || 'fingerprint_manifest'),
        sha256: digest,
        phash: perceptualHash,
      });
      knownDigests.add(digest);
    }
    return items;
  })();
  indexCache.set(absoluteRoot, pending);
  try { return await pending; } catch (error) { indexCache.delete(absoluteRoot); throw error; }
}

function typeCategory(asset = {}, sourceCategory = null) {
  if (sourceCategory && sourceCategory !== 'EXTERNAL_OR_GENERATED' && sourceCategory !== 'UNKNOWN_OR_REMOTE') return sourceCategory;
  if (asset.asset_type === 'OFFICIAL_PRODUCT_COVER') return 'OFFICIAL_PRODUCT_COVER';
  if (asset.asset_type === 'OFFICIAL_LOGO') return 'OFFICIAL_LOGO';
  if (asset.asset_type === 'AI_IMAGE_REFERENCED') return 'GENERATED_FROM_IDENTITY_REFERENCE';
  if (asset.asset_type === 'AI_IMAGE_GENERATED' || asset.asset_type === 'AI_IMAGE') return 'GENERATED_SCENE';
  if (asset.asset_type === 'GENERATED_GRAPHIC') return 'GENERATED_GRAPHIC';
  if (asset.asset_type === 'EXISTING_ASSET') return 'OFFICIAL_REFERENCE_ASSET';
  return 'UNCLASSIFIED_MEDIA';
}

async function bufferFor(asset = {}) {
  if (Buffer.isBuffer(asset.buffer)) return asset.buffer;
  const candidate = asset.source_path || asset.local_path;
  if (candidate && !/^https?:\/\//i.test(String(candidate))) return fs.readFile(candidate);
  return null;
}

async function inspectAsset({ asset = {}, scene = {}, exampleRoot = DEFAULT_STYLE_EXAMPLE_ROOT } = {}) {
  const sourcePath = asset.source_path || (asset.provenance && asset.provenance.source_path) || null;
  const sourceCategory = classifyPath(sourcePath, { styleExampleRoot: exampleRoot });
  const category = typeCategory(asset, sourceCategory);
  const allowOfficialFrame = scene.allow_official_reference_frame === true;
  const allowLogo = scene.logo_requis === true;
  const allowProduct = scene.official_asset_id === 'guide_8c_cover';
  const failures = [];

  if (sourceCategory === 'STYLE_EXAMPLE') failures.push('chemin source de la collection style-reference');
  if (sourceCategory === 'OFFICIAL_CHARACTER_REFERENCE' && !allowOfficialFrame) failures.push('référence d’identité officielle utilisée comme plan final sans autorisation explicite');
  if (sourceCategory === 'OFFICIAL_LOGO' && !allowLogo) failures.push('logo officiel utilisé sans scène de marque explicitement demandée');
  if (sourceCategory === 'OFFICIAL_PRODUCT_ASSET' && !allowProduct) failures.push('asset produit officiel utilisé hors de son identifiant déclaré');

  const buffer = await bufferFor(asset);
  let digest = asset.content_sha256 || null;
  let phash = null;
  if (buffer) {
    digest = sha256(buffer);
    try { phash = await visualConsistency.computePHash(buffer); }
    catch (error) { failures.push(`image illisible pour le calcul de provenance: ${error.message}`); }
  } else if (!digest) {
    failures.push('octets ou hash de contenu absents; provenance invérifiable');
  }

  const examples = await styleExampleIndex(exampleRoot);
  const matches = [];
  if (digest) {
    for (const example of examples) {
      if (digest === example.sha256) matches.push({ id: example.id, match: 'SHA256_EXACT', hamming_distance: 0 });
      else if (phash) {
        const distance = visualConsistency.hammingDistance(phash, example.phash);
        if (distance <= EXAMPLE_DUPLICATE_HAMMING_MAX) matches.push({ id: example.id, match: 'PERCEPTUAL_NEAR_DUPLICATE', hamming_distance: distance });
      }
    }
  }
  if (matches.length) failures.push(`correspond à un exemple fourni (${matches.map((m) => `${m.id}:${m.match}`).join(', ')})`);

  return {
    ok: failures.length === 0,
    category,
    source_category: sourceCategory,
    source_path: sourcePath,
    sha256: digest,
    phash,
    examples_available: examples.length,
    example_matches: matches,
    failures,
    identity_conditioning: asset.asset_type === 'AI_IMAGE_REFERENCED' ? 'official_reference_used_for_generation' : 'not_conditioned_on_identity_reference',
  };
}

async function assertAssetAllowed(params) {
  const report = await inspectAsset(params);
  if (!report.ok) {
    const error = new Error(`Asset refusé par mediaProvenance: ${report.failures.join('; ')}.`);
    error.code = 'MEDIA_PROVENANCE_REJECTED';
    error.provenance = report;
    throw error;
  }
  return report;
}

async function auditAssetCollection(assets = [], { exampleRoot = DEFAULT_STYLE_EXAMPLE_ROOT } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const checked = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    const report = await inspectAsset({
      asset: item,
      scene: item.scene || {
        allow_official_reference_frame: item.allow_official_reference_frame === true,
        logo_requis: item.logo_requis === true,
        official_asset_id: item.official_asset_id,
      },
      exampleRoot,
    });
    checked.push({ scene_id: item.scene_id || item.id || `scene_${i + 1}`, ...report });
  }
  const duplicates = [];
  for (let i = 0; i < checked.length; i += 1) {
    if (!checked[i].ok || !checked[i].phash) continue;
    for (let j = 0; j < i; j += 1) {
      if (!checked[j].ok || !checked[j].phash) continue;
      const distance = visualConsistency.hammingDistance(checked[i].phash, checked[j].phash);
      if (checked[i].sha256 === checked[j].sha256 || distance <= SCENE_DUPLICATE_HAMMING_MAX) {
        duplicates.push({ scene_id: checked[i].scene_id, duplicate_of: checked[j].scene_id,
          match: checked[i].sha256 === checked[j].sha256 ? 'SHA256_EXACT' : 'PERCEPTUAL_NEAR_DUPLICATE', hamming_distance: distance });
      }
    }
  }
  return {
    ok: checked.length > 0 && checked.every((item) => item.ok) && duplicates.length === 0,
    assets_checked: checked.length,
    examples_available: checked.length ? checked[0].examples_available : (await styleExampleIndex(exampleRoot)).length,
    rejected: checked.filter((item) => !item.ok),
    duplicates,
    scenes: checked,
  };
}

function extractFrame(videoPath, timeSeconds, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, Number(timeSeconds) || 0)), '-i', videoPath,
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    const chunks = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Délai ffmpeg dépassé pendant l’extraction des frames.')); }, timeoutMs);
    proc.stdout.on('data', (chunk) => { size += chunk.length; if (size > 32 * 1024 * 1024) { proc.kill('SIGKILL'); return; } chunks.push(chunk); });
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1500); });
    proc.on('error', (error) => { clearTimeout(timer); reject(new Error(`ffmpeg indisponible pour l’audit des frames: ${error.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (size > 32 * 1024 * 1024) return reject(new Error('Frame extraite trop volumineuse pour l’audit.'));
      if (code !== 0 || size === 0) return reject(new Error(`Extraction de frame impossible à ${timeSeconds}s: ${stderr.trim() || `ffmpeg code ${code}`}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

async function auditRenderedFrames(frames = [], { exampleRoot = DEFAULT_STYLE_EXAMPLE_ROOT } = {}) {
  const examples = await styleExampleIndex(exampleRoot);
  const list = Array.isArray(frames) ? frames : [];
  if (!examples.length) return { ok: false, status: 'blocked', reason: 'Aucun exemple de style indexé; l’exclusion n’est pas vérifiable.', examples_available: 0, frames: [] };
  if (!list.length) return { ok: false, status: 'blocked', reason: 'Aucune frame de scène n’a été extraite du MP4.', examples_available: examples.length, frames: [] };
  const results = [];
  for (const frame of list) {
    const buffer = Buffer.isBuffer(frame.buffer) ? frame.buffer : await extractFrame(frame.video_path, frame.time_seconds);
    const report = await inspectAsset({ asset: { buffer, asset_type: 'RENDERED_FRAME' }, scene: {}, exampleRoot });
    results.push({ scene_id: frame.scene_id || null, time_seconds: frame.time_seconds, ...report });
  }
  return {
    ok: results.every((frame) => frame.ok),
    status: results.every((frame) => frame.ok) ? 'pass' : 'fail',
    examples_available: examples.length,
    frames_checked: results.length,
    rejected: results.filter((frame) => !frame.ok),
    frames: results,
  };
}

async function auditRenderedVideo(videoPath, sceneFrames = [], { exampleRoot = DEFAULT_STYLE_EXAMPLE_ROOT } = {}) {
  const frames = Array.isArray(sceneFrames) ? sceneFrames.map((frame) => ({ ...frame, video_path: videoPath })) : [];
  try { return await auditRenderedFrames(frames, { exampleRoot }); }
  catch (error) { return { ok: false, status: 'blocked', reason: error.message, examples_available: (await styleExampleIndex(exampleRoot)).length, frames_checked: 0, frames: [] }; }
}

function clearIndexCache(root) {
  if (root) indexCache.delete(path.resolve(root));
  else indexCache.clear();
}

module.exports = {
  ASSETS_ROOT,
  DEFAULT_STYLE_EXAMPLE_ROOT,
  EXAMPLE_DUPLICATE_HAMMING_MAX,
  SCENE_DUPLICATE_HAMMING_MAX,
  sha256,
  isInside,
  classifyPath,
  styleExampleIndex,
  inspectAsset,
  assertAssetAllowed,
  auditAssetCollection,
  auditRenderedFrames,
  auditRenderedVideo,
  clearIndexCache,
};
