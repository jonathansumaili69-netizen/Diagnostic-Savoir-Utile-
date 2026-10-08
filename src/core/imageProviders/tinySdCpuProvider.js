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
let generatorService = null;
let requestCounter = 0;
let requestQueue = Promise.resolve();

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

function fatalGeneratorError(message) {
  const error = new Error(message);
  error.code = 'TINY_SD_FATAL';
  return error;
}

function rejectPending(service, error) {
  for (const [id, pending] of service.pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
    service.pending.delete(id);
  }
}

function startGeneratorService() {
  if (generatorService && !generatorService.child.killed) return generatorService;
  const python = String(process.env.TINY_SD_PYTHON || 'python3');
  const childEnv = { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: '1' };
  // Public weights are downloaded anonymously; never pass account tokens or call inference APIs.
  delete childEnv.HF_TOKEN;
  delete childEnv.HUGGINGFACEHUB_API_TOKEN;
  delete childEnv.HF_API_TOKEN;
  const child = spawn(python, [GENERATOR_SCRIPT, '--serve'], {
    cwd: PROJECT_ROOT,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const service = { child, pending: new Map(), stdoutBuffer: '', stderr: '', python };
  generatorService = service;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    service.stdoutBuffer += chunk;
    let newline = service.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = service.stdoutBuffer.slice(0, newline).trim();
      service.stdoutBuffer = service.stdoutBuffer.slice(newline + 1);
      newline = service.stdoutBuffer.indexOf('\n');
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        rejectPending(service, fatalGeneratorError('Réponse JSON invalide du générateur Tiny-SD CPU.'));
        if (generatorService === service) generatorService = null;
        child.kill('SIGTERM');
        continue;
      }
      const id = String(message.id);
      const pending = service.pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      service.pending.delete(id);
      if (message.ok !== true) {
        const error = new Error(`Tiny-SD CPU a échoué : ${String(message.error || 'raison inconnue').slice(0, 500)}`);
        if (message.fatal === true) error.code = 'TINY_SD_FATAL';
        pending.reject(error);
      } else {
        pending.resolve(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    service.stderr = (service.stderr + chunk.toString()).slice(-8000);
  });
  child.on('error', (err) => {
    if (generatorService === service) generatorService = null;
    rejectPending(service, fatalGeneratorError(`Impossible de démarrer Tiny-SD CPU (${python}) : ${err.message}`));
  });
  child.on('close', (code, signal) => {
    const diagnostic = cleanDiagnostic(service.stderr);
    if (generatorService === service) generatorService = null;
    if (service.pending.size) {
      rejectPending(service, fatalGeneratorError(`Tiny-SD CPU s’est arrêté (code ${code}, signal ${signal || 'aucun'}). ${diagnostic}`.trim()));
    }
  });
  return service;
}

function requestGeneration({ prompt, width, height, steps, seed, outputPath, timeoutMs }) {
  const service = startGeneratorService();
  const id = String(++requestCounter);
  const request = { id, prompt, width, height, steps, seed, output: outputPath };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.pending.delete(id);
      if (generatorService === service) generatorService = null;
      service.child.kill('SIGTERM');
      setTimeout(() => service.child.kill('SIGKILL'), 5000).unref();
      reject(fatalGeneratorError(`Tiny-SD CPU a dépassé le délai de ${timeoutMs} ms.`));
    }, timeoutMs);
    service.pending.set(id, { resolve, reject, timer });
    service.child.stdin.write(`${JSON.stringify(request)}\n`, (err) => {
      if (!err) return;
      clearTimeout(timer);
      service.pending.delete(id);
      if (generatorService === service) generatorService = null;
      reject(fatalGeneratorError(`Échec d’envoi de la requête à Tiny-SD CPU : ${err.message}`));
    });
  });
}

function runGenerator(request) {
  const operation = requestQueue.then(() => requestGeneration(request));
  requestQueue = operation.catch(() => {});
  return operation;
}

async function shutdown() {
  await requestQueue.catch(() => {});
  const service = generatorService;
  if (!service) return;
  generatorService = null;
  if (service.pending.size) rejectPending(service, new Error('Service Tiny-SD CPU arrêté avant la fin de la génération.'));
  if (service.child.stdin && !service.child.stdin.destroyed) service.child.stdin.end();
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      clearTimeout(hardKill);
      resolve();
    };
    const forceKill = setTimeout(() => service.child.kill('SIGTERM'), 3000);
    const hardKill = setTimeout(() => service.child.kill('SIGKILL'), 5000);
    service.child.once('close', finish);
    if (service.child.exitCode !== null) finish();
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
  const outputPath = path.join(tempDir, 'generated.png');
  try {
    const result = await runGenerator({ prompt, width: nativeWidth, height: nativeHeight, steps, seed, outputPath, timeoutMs });
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
      generation_seconds: result.elapsed_seconds,
      model_load_seconds: result.model_load_seconds,
      pipeline_reused: result.pipeline_reused === true,
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
        generation_seconds: result.elapsed_seconds,
        model_load_seconds: result.model_load_seconds,
        pipeline_reused: result.pipeline_reused === true,
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
  shutdown,
  setGenerateForTest,
};
