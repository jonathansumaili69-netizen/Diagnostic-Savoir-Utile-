'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/tiny_sd_cpu_generate.py');

async function createFakeRuntime() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-sd-fake-runtime-'));
  await fs.writeFile(path.join(dir, 'torch.py'), `
from contextlib import nullcontext
float32 = 'float32'
def set_num_threads(_): pass
def set_num_interop_threads(_): pass
def set_grad_enabled(_): pass
def inference_mode(): return nullcontext()
class Generator:
    def __init__(self, device=None): pass
    def manual_seed(self, _): return self
`);
  await fs.writeFile(path.join(dir, 'diffusers.py'), `
import os
from types import SimpleNamespace
class FakeTokenizer:
    model_max_length = 77
    def __call__(self, text, add_special_tokens=True): return {'input_ids': list(range(min(len(text.split()), 77)))}
    def num_special_tokens_to_add(self, pair=False): return 2
    def decode(self, ids, skip_special_tokens=True): return ' '.join('subject' for _ in ids)
class FakeImage:
    def __init__(self, width, height): self.width, self.height = width, height
    def save(self, path, format=None, **kwargs):
        with open(path, 'wb') as output: output.write(b'fake-png')
class FakePipeline:
    tokenizer = FakeTokenizer()
    scheduler = SimpleNamespace(config={})
    def to(self, device): return self
    def set_progress_bar_config(self, **kwargs): pass
    def __call__(self, **kwargs): return SimpleNamespace(images=[FakeImage(kwargs['width'], kwargs['height'])])
class DiffusionPipeline:
    @staticmethod
    def from_pretrained(*args, **kwargs):
        counter = os.environ['TINY_SD_FAKE_LOAD_COUNTER']
        with open(counter, 'a', encoding='utf-8') as output: output.write('loaded\\n')
        if os.environ.get('TINY_SD_FAKE_LOAD_FAIL') == '1': raise RuntimeError('mock model unavailable')
        return FakePipeline()
class DPMSolverMultistepScheduler:
    @staticmethod
    def from_config(config): return object()
`);
  return dir;
}

function runServer({ pythonPath, env, requests }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [SCRIPT, '--serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`mock Tiny-SD exited ${code}: ${stderr}`));
      try {
        resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
      } catch (error) {
        reject(new Error(`invalid server JSON: ${error.message}; stderr=${stderr}; stdout=${stdout}`));
      }
    });
    child.stdin.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
  });
}

async function withFakeServer(run) {
  const dir = await createFakeRuntime();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-sd-protocol-test-'));
  const counter = path.join(work, 'loads.txt');
  const env = {
    ...process.env,
    PYTHONPATH: [dir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    TINY_SD_FAKE_LOAD_COUNTER: counter,
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
  };
  try {
    await run({ env, counter, work });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
}

test('Tiny-SD JSONL server loads the diffusion pipeline once and reuses it for later scenes', async () => {
  await withFakeServer(async ({ env, counter, work }) => {
    const responses = await runServer({
      pythonPath: process.env.PYTHON || 'python3',
      env,
      requests: [
        { id: 'one', prompt: 'blue notebook', width: 64, height: 128, steps: 25, seed: 11, output: path.join(work, 'one.png') },
        { id: 'two', prompt: 'golden lamp', width: 64, height: 128, steps: 25, seed: 12, output: path.join(work, 'two.png') },
      ],
    });
    assert.equal(responses.length, 2);
    assert.deepEqual(responses.map((response) => response.id), ['one', 'two']);
    assert.ok(responses.every((response) => response.ok === true), JSON.stringify(responses));
    assert.ok(responses.every((response) => response.width === 64 && response.height === 128 && response.steps === 25));
    assert.equal(responses[0].pipeline_reused, false);
    assert.equal(responses[1].pipeline_reused, true);
    assert.equal(responses[1].model_load_seconds, 0);
    assert.equal((await fs.readFile(counter, 'utf8')).trim().split('\n').length, 1);
    assert.equal((await fs.readFile(path.join(work, 'one.png'))).toString(), 'fake-png');
    assert.equal((await fs.readFile(path.join(work, 'two.png'))).toString(), 'fake-png');
  });
});

test('Tiny-SD JSONL server reports model-load failure as fatal and never retries it per scene', async () => {
  await withFakeServer(async ({ env, counter, work }) => {
    env.TINY_SD_FAKE_LOAD_FAIL = '1';
    const responses = await runServer({
      pythonPath: process.env.PYTHON || 'python3',
      env,
      requests: [
        { id: 'one', prompt: 'blue notebook', width: 64, height: 128, steps: 25, seed: 11, output: path.join(work, 'one.png') },
        { id: 'two', prompt: 'golden lamp', width: 64, height: 128, steps: 25, seed: 12, output: path.join(work, 'two.png') },
      ],
    });
    assert.equal(responses.length, 2);
    assert.ok(responses.every((response) => response.ok === false && response.fatal === true));
    assert.match(responses[0].error, /mock model unavailable/);
    assert.equal((await fs.readFile(counter, 'utf8')).trim().split('\n').length, 1);
  });
});
