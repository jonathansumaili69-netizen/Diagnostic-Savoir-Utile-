'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const huggingFaceInference = require('@huggingface/inference');
const { logger } = require('../logger');
const characterRegistry = require('../characterRegistry');

const PROVIDER = 'fal-ai';
const DEFAULT_MODEL = 'Qwen/Qwen-Image';
let testTextToImage = null;

function setTextToImageForTest(fn) {
  const previous = testTextToImage;
  testTextToImage = typeof fn === 'function' ? fn : null;
  return () => { testTextToImage = previous; };
}

function modelId() {
  return String(process.env.HF_TEXT_TO_IMAGE_MODEL || DEFAULT_MODEL).trim();
}

function isConfigured() {
  return Boolean(String(process.env.HF_TOKEN || '').trim());
}

function status() {
  return {
    configured: isConfigured(),
    provider: PROVIDER,
    model: modelId(),
    reference_image_conditioning: false,
    reason: isConfigured() ? null : 'HF_TOKEN absent; aucun repli non-HF ne sera autorisé pour le profil strict.',
  };
}

function buildPrompt(scene = {}) {
  const scenePrompt = scene.prompt_final || scene.description || scene.voix_off_scene || '';
  const label = scene.personnage || scene.character_id || scene.personnage_id;
  const characterId = characterRegistry.resolveCharacterId(label);
  const character = characterId ? characterRegistry.getCharacter(characterId) : null;
  const parts = [
    String(scenePrompt).trim(),
    character ? `Personnage officiel ${character.nom}; identité visuelle à suivre uniquement par description textuelle : ${character.description_visuelle}; visage : ${character.caracteristiques_visage}; coiffure : ${character.coiffure}; tenue : ${character.vetements_style}; éléments distinctifs : ${character.elements_distinctifs}.` : '',
    scene.decor ? `Décor : ${scene.decor}.` : '',
    scene.cadrage ? `Cadrage : ${scene.cadrage}.` : '',
    scene.style ? `Style visuel : ${scene.style}.` : '',
    'Direction artistique constante pour toute la série : vidéo faceless semi-réaliste, illustration éditoriale, palette bleu nuit, ivoire et touches ocre, lumière naturelle douce, composition lisible sur mobile.',
    'Image originale pour une vidéo verticale 9:16, composition claire sur mobile, une seule scène cohérente, aucun texte lisible, aucun logo non fourni.',
  ].filter(Boolean);
  return parts.join('\n');
}

async function generate({ scene = {}, width = 720, height = 1280, timeoutMs = 120000 } = {}) {
  if (!isConfigured()) throw new Error('HF_TOKEN absent : génération d’image Hugging Face impossible.');
  const prompt = buildPrompt(scene);
  if (!prompt.trim()) throw new Error(`Prompt d’image absent pour la scène ${scene.id || 'inconnue'}.`);
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) throw new Error('Dimensions d’image invalides.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const seed = crypto.randomInt(1, 2147483647);
  let output;
  try {
    output = await (testTextToImage || huggingFaceInference.textToImage)({
      model: modelId(),
      provider: PROVIDER,
      accessToken: process.env.HF_TOKEN,
      inputs: prompt,
      parameters: {
        width: w,
        height: h,
        num_inference_steps: 30,
        guidance_scale: 2.5,
        negative_prompt: 'blurry, low detail, unreadable text, watermark, logo',
        seed,
      },
    }, { signal: controller.signal, retry_on_error: false });
  } catch (err) {
    const safeMessage = err && err.name === 'AbortError' ? 'délai Hugging Face dépassé' : (err && err.message) || 'erreur provider inconnue';
    throw new Error(`Hugging Face ${modelId()} via ${PROVIDER} a échoué : ${String(safeMessage).slice(0, 240)}`);
  } finally {
    clearTimeout(timer);
  }

  let raw;
  if (Buffer.isBuffer(output)) raw = output;
  else if (output instanceof Blob) raw = Buffer.from(await output.arrayBuffer());
  else if (output && typeof output.arrayBuffer === 'function') raw = Buffer.from(await output.arrayBuffer());
  else throw new Error('Le provider Hugging Face n’a pas renvoyé un binaire image.');
  if (!raw.length) throw new Error('Le provider Hugging Face a renvoyé une image vide.');

  const image = await sharp(raw, { failOn: 'error' })
    .rotate()
    .resize(w, h, { fit: 'cover', position: 'attention' })
    .png()
    .toBuffer();
  const metadata = await sharp(image).metadata();
  if (metadata.width !== w || metadata.height !== h) throw new Error('L’image générée n’a pas les dimensions verticales demandées.');
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');

  logger.info('AI_IMAGE_GENERATED', {
    scene_id: scene.id || scene.scene_id || null,
    provider: `huggingface/${PROVIDER}`,
    model: modelId(),
    width: w,
    height: h,
    sha256,
  });
  return {
    buffer: image,
    contentType: 'image/png',
    provider: `huggingface/${PROVIDER}`,
    model: modelId(),
    asset_type: 'AI_IMAGE_GENERATED',
    width: w,
    height: h,
    content_sha256: sha256,
    generation: { prompt, seed, reference_image_conditioning: false },
  };
}

module.exports = { PROVIDER, DEFAULT_MODEL, modelId, isConfigured, status, buildPrompt, generate, setTextToImageForTest };
