#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const productionRoot = path.resolve(process.env.CONQUISTADOR_PREVIEW_ROOT || path.join(os.homedir(), 'work', 'conquistador-production'));
const manifestPath = path.join(projectRoot, 'assets', 'products', 'guide-8c-ad-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const audioRoot = path.join(productionRoot, 'audio-staging');
const outputRoot = path.join(productionRoot, 'output');
const dataRoot = path.join(productionRoot, 'data');
const cacheRoot = path.join(productionRoot, 'hf-cache');
const piperDataDir = path.resolve(process.env.PIPER_DATA_DIR || path.join(productionRoot, 'piper-voices'));
const piperPython = process.env.PIPER_PYTHON || path.join(os.homedir(), 'work', '.venv-piper', 'bin', 'python');
const piperVoice = process.env.PIPER_VOICE || 'fr_FR-siwis-medium';
for (const dir of [audioRoot, outputRoot, dataRoot, cacheRoot, piperDataDir]) fs.mkdirSync(dir, { recursive: true });
const piperModelPath = path.join(piperDataDir, `${piperVoice}.onnx`);
if (!fs.existsSync(piperPython) || !fs.existsSync(piperModelPath)) {
  throw new Error(`Voix Piper locale non prête (${piperVoice}); installe le modèle et le runtime dans ${piperDataDir}. Aucun service distant ni fallback de voix implicite ne sera utilisé.`);
}

process.env.CONQUISTADOR_DATA_DIR = dataRoot;
process.env.CONQUISTADOR_LOCAL_AUDIO_ROOT = audioRoot;
process.env.CONQUISTADOR_HF_CACHE_DIR = cacheRoot;
process.env.HF_HOME = process.env.HF_HOME || cacheRoot;
process.env.IMAGE_TEXT_TO_IMAGE_BACKEND = 'realistic_vision_lcm_cpu';
process.env.RV_LCM_PYTHON = process.env.RV_LCM_PYTHON || path.join(os.homedir(), 'work', '.venv-rv-lcm', 'bin', 'python');
process.env.VIDEO_FPS = process.env.VIDEO_FPS || '30';
process.env.VIDEO_VOICE_SAFETY_SECONDS = '0.25';

const voiceTracks = [];
for (const scene of manifest.scenes) {
  const audioPath = path.join(audioRoot, `${scene.id}.wav`);
  execFileSync(piperPython, [
    '-m', 'piper',
    '-m', piperVoice,
    '--data-dir', piperDataDir,
    '-f', audioPath,
    '--', scene.voix_off_scene,
  ], { stdio: 'inherit' });
  const stat = fs.statSync(audioPath);
  if (stat.size < 1024) throw new Error(`Piste vocale absente ou vide : ${scene.id}`);
  voiceTracks.push({
    scene_id: scene.id,
    text: scene.voix_off_scene,
    local_path: audioPath,
    provider: 'Piper TTS local (ONNX)',
    voice: `${piperVoice}; model card MIT, training dataset CC-BY 4.0 (attribution to add for commercial release)`,
  });
}

async function main() {
  const { createVideo } = require('../src/core/videoOrchestrator');
  const created = await createVideo({
    manifest,
    target_duration_seconds: manifest.target_duration_seconds,
    format: { ratio: '9:16', width: 720, height: 1280 },
    local_preview: true,
    local_voice_tracks: voiceTracks,
    idempotency_seed: `guide-8c-local-preview-${Date.now()}`,
  });
  const job = created.job;
  const sourcePath = job && job.render && job.render.outputPath;
  const report = {
    job_id: job && job.id,
    job_status: job && job.status,
    error_step: job && job.error_step,
    error: job && job.error,
    quality_check: job && job.quality_check,
    render: job && job.render,
    voice: job && job.voice && {
      provider: job.voice.provider,
      voice: job.voice.voice,
      total_duration_measured_seconds: job.voice.total_duration_measured_seconds,
      track_count: Array.isArray(job.voice.tracks) ? job.voice.tracks.length : 0,
    },
    manifest_path: manifestPath,
    paid_services_used: [],
    tts_runtime: 'Piper TTS local, ONNX CPU',
    tts_model: piperVoice,
    tts_model_card_license: 'MIT',
    tts_training_dataset_license: 'CC-BY 4.0; attribution required',
  };
  if (sourcePath && fs.existsSync(sourcePath)) {
    const outputPath = path.join(outputRoot, 'guide-8c-ad-local-preview.mp4');
    fs.copyFileSync(sourcePath, outputPath);
    report.output_path = outputPath;
    report.output_size_bytes = fs.statSync(outputPath).size;
  }
  const reportPath = path.join(outputRoot, 'guide-8c-ad-local-preview-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2));
  if (!report.output_path || !job.quality_check || job.quality_check.ok !== true) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error && error.stack || String(error));
  process.exitCode = 1;
});
