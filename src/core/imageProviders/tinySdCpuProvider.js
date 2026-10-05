'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const sharp = require('sharp');
const { logger } = require('../logger');

const PROVIDER = 'tiny-sd-cpu';
const DEFAULT_MODEL = 'segmind/tiny-sd';
const DEFAULT_NATIVE_WIDTH = 504;
const DEFAULT_NATIVE_HEIGHT = 896;
const DEFAULT_STEPS = 25;
const DEFAULT_TIMEOUT_MS = 900000;
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const GENERATOR_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tiny_sd_cpu_generate.py');
let testGenerate = null;

function setGenerateForTest(fn) {
  const previous = testGenerate;
  testGenerate = typeof fn === 'function' ? fn : null;
  return () => { testGenerate = previous; };
}

function status() {
  return {
    configured: true,
    provider: PROVIDER,
    model: DEFAULT_MODEL,
    license: 'creativeml-openrail-m',
    requires_api_key: false,
    device: 'CPU',
    inference_endpoint: false,
    reference_image_conditioning: false,
  };
}

function buildPrompt(scene = {}) {
  return String(scene.prompt_final || scene.description || scene.voix_off_scene || '').trim();
}

function cleanDiagnostic(stderr = '') {
  return String(stderr)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' ')
    .slice(0, 500);
}

function runGenerator({ inputPath, outputPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const python = String(process.env.TINY_SD_PYTHON || 'python3');
    const childEnv = { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: '1' };
    // The public weights are downloaded anonymously. Never pass account tokens
    // to this process, and never call Hugging Face Inference Providers here.
    delete childEnv.HF_TOKEN;
    delete childEnv.HUGGINGFACEHUB_API_TOKEN;
    delete childEnv.HF_API_TOKEN;

    const child = spawn(python, [GENERATOR_SCRIPT, '--input', inputPath, '--output', outputPath], {
      cwd: PROJECT_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Impossible de démarrer Tiny-SD CPU (${python}) : ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Tiny-SD CPU a dépassé le délai de ${timeoutMs} ms.`));
      } else if (code !== 0) {
        const diagnostic = cleanDiagnostic(stderr);
        reject(new Error(`Tiny-SD CPU a échoué (code ${code}, signal ${signal || 'aucun'}). ${diagnostic}`.trim()));
      } else {
        resolve();
      }
    });
  });
}

async function generate({ scene = {}, width = 720, height = 1280, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (testGenerate) return testGenerate({ scene, width, height, timeoutMs });

  const prompt = buildPrompt(scene);
  if (!prompt) throw new Error(`Prompt d’image absent pour la scène ${scene.id || 'inconnue'}.`);
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    throw new Error('Dimensions d’image invalides.');
  }
  if (Math.abs((w / h) - (9 / 16)) > 0.005) {
    throw new Error('Tiny-SD CPU strict attend une composition verticale 9:16.');
  }

  const nativeWidth = Number(process.env.TINY_SD_CPU_WIDTH) || DEFAULT_NATIVE_WIDTH;
  const nativeHeight = Number(process.env.TINY_SD_CPU_HEIGHT) || DEFAULT_NATIVE_HEIGHT;
  const steps = Number(process.env.TINY_SD_CPU_STEPS) || DEFAULT_STEPS;
  if (!Number.isInteger(nativeWidth) || !Number.isInteger(nativeHeight)
      || nativeWidth % 8 !== 0 || nativeHeight % 8 !== 0) {
    throw new Error('Les dimensions natives Tiny-SD doivent être des multiples de 8.');
  }
  if (!Number.isInteger(steps) || steps < 1 || steps > 50) {
    throw new Error('TINY_SD_CPU_STEPS doit être un entier de 1 à 50.');
  }

  const seed = crypto.randomInt(1, 2147483647);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conquistador-tiny-sd-'));
  const inputPath = path.join(tempDir, 'request.json');
  const outputPath = path.join(tempDir, 'generated.png');
  try {
    await fs.writeFile(inputPath, JSON.stringify({ prompt, width: nativeWidth, height: nativeHeight, steps, seed }), 'utf8');
    await runGenerator({ inputPath, outputPath, timeoutMs });
    const raw = await fs.readFile(outputPath);
    if (!raw.length) throw new Error('Tiny-SD CPU a renvoyé une image vide.');

    const image = await sharp(raw, { failOn: 'error' })
      .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();
    const metadata = await sharp(image).metadata();
    if (metadata.width !== w || metadata.height !== h) {
      throw new Error('L’image Tiny-SD agrandie ne correspond pas aux dimensions demandées.');
    }
    const sha256 = crypto.createHash('sha256').update(image).digest('hex');
    logger.info('AI_IMAGE_GENERATED', {
      scene_id: scene.id || scene.scene_id || null,
      provider: PROVIDER,
      model: DEFAULT_MODEL,
      device: 'CPU',
      width: w,
      height: h,
      native_width: nativeWidth,
      native_height: nativeHeight,
      steps,
      sha256,
    });
    return {
      buffer: image,
      contentType: 'image/png',
      provider: PROVIDER,
      model: DEFAULT_MODEL,
      asset_type: 'AI_IMAGE_GENERATED',
      width: w,
      height: h,
      content_sha256: sha256,
      generation: {
        prompt,
        seed,
        steps,
        device: 'CPU',
        native_width: nativeWidth,
        native_height: nativeHeight,
        license: 'creativeml-openrail-m',
        reference_image_conditioning: false,
      },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_NATIVE_WIDTH,
  DEFAULT_NATIVE_HEIGHT,
  DEFAULT_STEPS,
  status,
  buildPrompt,
  generate,
  setGenerateForTest,
};
