'use strict';

/**
 * Tests du provider Hugging Face Inference Providers (routeur Fal-ai) ajoute a
 * l'architecture EXISTANTE, sans remplacer stability / fal / replicate /
 * generic. Ces tests prouvent que :
 *   - le provider HF est DECLARE et reste additif (aucun provider supprime) ;
 *   - il est SELECTIONNE lorsqu'il est configure (HF_TOKEN present) ;
 *   - il est IGNORE proprement lorsqu'il ne l'est pas (aucun appel reseau) ;
 *   - la requete reelle porte HF_TOKEN cote serveur (Authorization: Bearer) ;
 *   - le corps de la requete est bien l'image OFFICIELLE de reference ;
 *   - la reponse binaire est transformee en asset reel tracable ;
 *   - en cas d'echec, la chaine de repli retombe sur existing_asset ;
 *   - le token n'apparait JAMAIS dans un etat expose ni dans le frontend.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const sharp = require('sharp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-hf-test-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;

const ENV_KEYS = ['IMAGE_IMG2IMG_PROVIDER', 'HF_TOKEN', 'HF_ENDPOINT', 'IMAGE_IMG2IMG_MODEL',
  'STABILITY_API_KEY', 'FAL_API_KEY', 'REPLICATE_API_TOKEN', 'IMAGE_IMG2IMG_API_KEY', 'IMAGE_IMG2IMG_ENDPOINT'];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
clearEnv();

const providerAdapter = require('../src/core/imageProviders/providerAdapter');
const characterReferenceProvider = require('../src/core/imageProviders/characterReferenceProvider');
const imageProviders = require('../src/core/imageProviders');

const FRONTEND_DIR = path.join(__dirname, '..', 'public');
const TOKEN = 'hf_secret_token_de_test_0123456789';

async function makePng() {
  return sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 150, g: 185, b: 220 } } }).png().toBuffer();
}

function fakeResponse({ ok = true, status = 200, contentType = 'image/png', body = Buffer.alloc(0), text = '' }) {
  const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  return {
    ok,
    status,
    headers: new Map([['content-type', contentType]]),
    arrayBuffer: async () => ab,
    text: async () => text,
  };
}

const realFetch = global.fetch;

test.after(() => {
  global.fetch = realFetch;
  clearEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('providerAdapter: Hugging Face est declare sans remplacer stability/fal/replicate/generic', () => {
  assert.ok(providerAdapter.PROVIDERS.huggingface, 'le provider huggingface doit exister');
  assert.equal(providerAdapter.PROVIDERS.huggingface.apiKeyEnv, 'HF_TOKEN');
  assert.equal(providerAdapter.PROVIDERS.huggingface.defaultModel, 'Qwen/Qwen-Image-Edit-2511');
  assert.equal(providerAdapter.PROVIDERS.huggingface.capabilities.image_to_image, true);
  assert.equal(providerAdapter.PROVIDERS.huggingface.capabilities.reference_image, true);
  for (const kept of ['stability', 'fal', 'replicate', 'generic']) {
    assert.ok(providerAdapter.PROVIDERS[kept], `le provider existant ${kept} doit rester present`);
  }
});

test('providerAdapter: Hugging Face est IGNORE proprement si HF_TOKEN est absent (aucun faux etat connecte)', () => {
  clearEnv();
  assert.equal(providerAdapter.configured(), false);
  const st = providerAdapter.status();
  assert.equal(st.configure, false);
  assert.equal(st.provider, null);
  assert.ok(st.providers_disponibles.includes('huggingface'));
});

test('providerAdapter: Hugging Face est SELECTIONNE quand HF_TOKEN est present, sans jamais exposer le token', () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'huggingface';
  process.env.HF_TOKEN = TOKEN;
  try {
    assert.equal(providerAdapter.configured(), true);
    assert.equal(providerAdapter.providerId(), 'huggingface');
    const st = providerAdapter.status();
    assert.equal(st.configure, true);
    assert.equal(st.provider, 'huggingface');
    assert.equal(st.cle_detectee, true);
    assert.equal(JSON.stringify(st).includes(TOKEN), false, 'le token ne doit jamais apparaitre dans un etat expose');
  } finally {
    clearEnv();
  }
});

test('imageProviders: avec Hugging Face configure, la référence passe d’abord et le portrait ne sert jamais de fallback de scène', () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'huggingface';
  process.env.HF_TOKEN = TOKEN;
  try {
    assert.equal(characterReferenceProvider.isEnabled(), true);
    assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Samuel' }), ['character_reference', 'pollinations', 'graphic_engine']);
    assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Marc' }), ['character_reference', 'pollinations', 'graphic_engine']);
    // Le logo officiel n'est JAMAIS regenere par IA, meme provider configure.
    assert.deepEqual(imageProviders.buildProviderOrder({ logo_requis: true }), ['existing_asset']);
    const st = imageProviders.referenceProviderStatus();
    assert.equal(st.configure, true);
    assert.equal(st.provider, 'huggingface');
  } finally {
    clearEnv();
  }
});

test('imageProviders: sans Hugging Face configure, un portrait officiel n’est jamais un plan final par défaut', () => {
  clearEnv();
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Samuel' }), ['pollinations', 'graphic_engine']);
  assert.deepEqual(imageProviders.buildProviderOrder({ personnage: 'Marc' }), ['pollinations', 'graphic_engine']);
});

test('providerAdapter.generate: route le modele via Hugging Face vers fal-ai avec reference et recupere l image', async () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'huggingface';
  process.env.HF_TOKEN = TOKEN;
  const png = await makePng();
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, opts });
    if (parsed.hostname === 'huggingface.co' && parsed.pathname.includes('/api/models/')) {
      return new Response(JSON.stringify({ inferenceProviderMapping: {
        'fal-ai': { providerId: 'fal-ai/qwen-image-edit-plus', status: 'live', task: 'image-to-image' },
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (parsed.hostname === 'router.huggingface.co' && opts.method === 'POST') {
      return new Response(JSON.stringify({
        request_id: 'hf-test-request',
        status: 'COMPLETED',
        response_url: 'https://queue.fal.run/qwen-image-edit-plus/requests/hf-test-request',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (parsed.hostname === 'router.huggingface.co' && parsed.pathname.endsWith('/requests/hf-test-request')) {
      return new Response(JSON.stringify({ images: [{ url: 'https://generated.example.test/result.png' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (parsed.hostname === 'generated.example.test') {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('Unexpected mocked URL', { status: 500 });
  };
  try {
    const refBuf = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const out = await providerAdapter.generate({ prompt: 'PERSONNAGE OFFICIEL Samuel', referenceBuffers: [refBuf], width: 720, height: 1280, retries: 0 });
    const providerCall = calls.find((call) => call.url.hostname === 'router.huggingface.co' && call.opts.method === 'POST');
    assert.ok(providerCall, 'le SDK doit appeler le routeur officiel Hugging Face');
    assert.match(providerCall.url.pathname, /\/fal-ai\/qwen-image-edit-plus$/);
    assert.equal(providerCall.url.searchParams.get('_subdomain'), 'queue');
    assert.equal(providerCall.opts.headers.Authorization, `Bearer ${TOKEN}`);
    const payload = JSON.parse(providerCall.opts.body);
    assert.equal(payload.prompt, 'PERSONNAGE OFFICIEL Samuel');
    assert.equal(payload.image_size, 'portrait_16_9');
    assert.match(payload.image_url, /^data:image\/jpeg;base64,/);
    assert.match(String(calls.find((call) => call.url.hostname === 'huggingface.co').url), /api\/models\/Qwen\/Qwen-Image-Edit-2511/);
    assert.equal(out.provider, 'huggingface');
    assert.equal(out.asset_type, 'AI_IMAGE_REFERENCED');
    assert.equal(out.response_format, 'binary');
    assert.equal(out.reference_count, 1);
    assert.ok(Buffer.isBuffer(out.buffer) && out.buffer.length > 0);
    assert.notDeepEqual(out.buffer, refBuf, 'la réponse générée est un nouveau binaire, pas l’image de référence');
  } finally {
    global.fetch = realFetch;
    clearEnv();
  }
});

test('imageProviders.generateAsset: Hugging Face tente une génération référencée puis fallback sans réutiliser le portrait', async () => {
  process.env.IMAGE_IMG2IMG_PROVIDER = 'huggingface';
  process.env.HF_TOKEN = TOKEN;
  process.env.CHARACTER_REFERENCE_MAX_ATTEMPTS = '1';
  let hfCalls = 0;
  global.fetch = async (url, opts = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'router.huggingface.co' && opts.method === 'POST') {
      hfCalls += 1;
      return new Response(JSON.stringify({ error: 'Provider temporarily unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Unexpected mocked URL', { status: 500 });
  };
  try {
    const asset = await imageProviders.generateAsset({ scene: { personnage: 'Samuel' }, width: 120, height: 200 });
    assert.equal(asset.asset_type, 'GENERATED_GRAPHIC', 'le portrait officiel ne doit pas remplacer la scène en fallback');
    const first = asset.provider_attempts[0];
    assert.equal(first.provider, 'character_reference', 'character_reference (Hugging Face) doit avoir ete tente en premier');
    assert.equal(first.ok, false);
    assert.equal(asset.provider_attempts.at(-1).provider, 'graphic_engine');
    assert.equal(asset.provider_attempts.at(-1).ok, true);
    assert.ok(hfCalls >= 1, 'le provider Hugging Face doit avoir ete REELLEMENT appele');
  } finally {
    global.fetch = realFetch;
    delete process.env.CHARACTER_REFERENCE_MAX_ATTEMPTS;
    clearEnv();
  }
});

test('securite: HF_TOKEN n apparait dans AUCUN fichier du frontend', () => {
  if (!fs.existsSync(FRONTEND_DIR)) return;
  const stack = [FRONTEND_DIR];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else {
        const content = fs.readFileSync(p, 'latin1');
        assert.equal(content.includes(TOKEN), false, `le token ne doit jamais apparaitre dans le frontend : ${p}`);
      }
    }
  }
});
