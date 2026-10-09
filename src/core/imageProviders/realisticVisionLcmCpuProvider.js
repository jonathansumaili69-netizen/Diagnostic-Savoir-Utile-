'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const sharp = require('sharp');
const { logger } = require('../logger');

const PROVIDER = 'realistic-vision-lcm-cpu';
const MODEL_ORDER = Object.freeze([
  { id: 'rv4-lcm8', repo: 'SG161222/Realistic_Vision_V4.0_noVAE', revision: '1685907c0283c7278ba26c5fe561506f564b48d3', steps: 8 },
  { id: 'rv4-lcm6', repo: 'SG161222/Realistic_Vision_V4.0_noVAE', revision: '1685907c0283c7278ba26c5fe561506f564b48d3', steps: 6 },
  { id: 'rv51-lcm4', repo: 'SG161222/Realistic_Vision_V5.1_noVAE', revision: '1e9f017a7b1eaefb63a1900ea6c5953d2739fd21', steps: 4 },
]);
const LORA = { repo: 'latent-consistency/lcm-lora-sdv1-5', revision: 'cf2fced511dbe7e26c8d1d397e728fbab875db4b' };
const SCRIPT = path.resolve(__dirname, '../../../scripts/realistic_vision_lcm_generate.py');
const DEFAULT_TIMEOUT_MS = 900000;
const MODEL_WIDTH = 504;
const MODEL_HEIGHT = 896;
let testGenerate = null;
function setGenerateForTest(fn) {
  const previous = testGenerate;
  testGenerate = typeof fn === 'function' ? fn : null;
  return () => { testGenerate = previous; };
}
function status() {
  return { configured: true, provider: PROVIDER, device: 'CPU', inference_endpoint: false,
    reference_image_conditioning: false, order: MODEL_ORDER.map((m) => ({ ...m })), lora: { ...LORA },
    scheduler: 'LCMScheduler', guidance_scale: 1.5, native_resolution: [504, 896] };
}
function buildPrompt(scene = {}) {
  return String(scene.prompt_final || scene.description || scene.voix_off_scene || '').trim();
}
async function runOrderedVariants(attemptVariant, variants = MODEL_ORDER) {
  const attempts = [];
  for (const variant of variants) {
    const started = Date.now();
    try {
      // Sequential by design: never compete for CPU/RAM on a CPU-only runner.
      // eslint-disable-next-line no-await-in-loop
      const result = await attemptVariant(variant);
      attempts.push({ provider: variant.id, ok: true, duration_ms: Date.now() - started });
      return { variant, result, attempts };
    } catch (error) {
      attempts.push({ provider: variant.id, ok: false, duration_ms: Date.now() - started,
        error: String(error.message || error).slice(0, 1200), timeout: /délai|timeout/i.test(String(error.message || error)),
        oom: /out of memory|cannot allocate memory|oom/i.test(String(error.message || error)) });
    }
  }
  const error = new Error(`Les trois variantes Realistic Vision LCM ont échoué techniquement : ${attempts.map((a) => `${a.provider}: ${a.error}`).join(' | ')}`);
  error.attempts = attempts;
  throw error;
}
function runGenerator({ inputPath, outputPath, timeoutMs, variant }) {
  return new Promise((resolve, reject) => {
    const python = String(process.env.RV_LCM_PYTHON || 'python3');
    const env = { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4' };
    delete env.HF_TOKEN;
    delete env.HUGGINGFACEHUB_API_TOKEN;
    delete env.HF_API_TOKEN;
    const child = spawn(python, [SCRIPT, inputPath, outputPath, `--variant=${variant}`], { cwd: path.resolve(__dirname, '../../../..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    child.stdout.on('data', (b) => { stdout = (stdout + b.toString()).slice(-12000); });
    child.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-12000); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`Impossible de démarrer le runtime Realistic Vision CPU (${python}): ${err.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Realistic Vision LCM CPU a dépassé le délai de ${timeoutMs} ms; variantes non terminées interrompues.`));
      if (code !== 0) {
        const diagnostic = (stderr || stdout).replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-1600);
        const error = new Error(`Realistic Vision LCM CPU a échoué (code ${code}, signal ${signal || 'aucun'}): ${diagnostic}`);
        error.stderr = diagnostic;
        return reject(error);
      }
      try {
        const result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
        resolve(result);
      } catch (err) { reject(new Error(`Résultat du générateur Realistic Vision invalide: ${err.message}`)); }
    });
  });
}
async function generate({ scene = {}, width = 504, height = 896, seed, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (testGenerate) return testGenerate({ scene, width, height, seed, timeoutMs });
  const prompt = buildPrompt(scene);
  if (!prompt) throw new Error(`Prompt d’image absent pour la scène ${scene.id || 'inconnue'}.`);
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  const actualSeed = Number.isInteger(Number(seed)) ? Number(seed) : crypto.randomInt(1, 2147483647);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64 || w % 8 || h % 8 || Math.abs(w / h - 9 / 16) > 0.005) {
    throw new Error('Realistic Vision LCM CPU exige des dimensions >=64, multiples de 8 et au format vertical 9:16.');
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conquistador-rv-lcm-'));
  const inputPath = path.join(tempDir, 'request.json');
  const outputPath = path.join(tempDir, 'generated.png');
  try {
    await fs.writeFile(inputPath, JSON.stringify({ prompt, width: MODEL_WIDTH, height: MODEL_HEIGHT, seed: actualSeed }), 'utf8');
    const started = Date.now();
    const outcome = await runOrderedVariants(async (variant) => {
      try {
        const item = await runGenerator({ inputPath, outputPath, timeoutMs, variant: variant.id });
        if (item.variant !== variant.id || item.base_revision !== variant.revision || item.steps !== variant.steps) throw new Error(`Métadonnées de sortie inattendues pour ${variant.id}.`);
        const buffer = await fs.readFile(outputPath);
        const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
        if (metadata.format !== 'png' || metadata.width !== MODEL_WIDTH || metadata.height !== MODEL_HEIGHT) throw new Error(`Fichier généré invalide: ${metadata.format || 'format inconnu'} ${metadata.width}x${metadata.height}, attendu PNG ${MODEL_WIDTH}x${MODEL_HEIGHT}.`);
        const resized = await sharp(buffer, { failOn: 'error' }).resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer();
        const outputMetadata = await sharp(resized).metadata();
        if (outputMetadata.width !== w || outputMetadata.height !== h) throw new Error('Redimensionnement de sortie non conforme aux dimensions de rendu.');
        return { result: item, raw: resized };
      } catch (error) {
        await fs.rm(outputPath, { force: true }).catch(() => {});
        throw error;
      }
    });
    const { variant: used, result: { result, raw }, attempts } = outcome;
    for (const failed of attempts.filter((a) => !a.ok)) logger.warn('realisticVisionLcmCpuProvider: variante technique échouée, passage séquentiel à la suivante', { model: failed.provider, error: failed.error });
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    logger.info('AI_IMAGE_GENERATED', { scene_id: scene.id || null, provider: PROVIDER, model: used.id, width: w, height: h, steps: used.steps, sha256: digest, technical_fallbacks: attempts.length - 1 });
    return { buffer: raw, contentType: 'image/png', provider: PROVIDER, model: used.id, asset_type: 'AI_IMAGE_GENERATED', width: w, height: h,
      content_sha256: digest, provider_attempts: attempts,
      generation: { prompt, seed: actualSeed, model: used.id, model_repo: used.repo, model_revision: used.revision,
        lora_repo: LORA.repo, lora_revision: LORA.revision, scheduler: 'LCMScheduler', guidance_scale: 1.5, steps: used.steps,
        device: 'CPU', width: w, height: h, native_width: MODEL_WIDTH, native_height: MODEL_HEIGHT,
        elapsed_ms: Date.now() - started, reference_image_conditioning: false,
        quality_assessment: 'not_performed; technical success is not visual quality approval' } };
  } finally { await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {}); }
}
module.exports = { PROVIDER, MODEL_ORDER, LORA, status, buildPrompt, generate, runOrderedVariants, setGenerateForTest };
