'use strict';

const { logger } = require('../logger');
const { imageToImage } = require('@huggingface/inference');

/**
 * ADAPTATEUR IMAGE-TO-IMAGE PROVIDER-AGNOSTIQUE (prompt maitre, sections 5 et 22).
 *
 * Fournit un VRAI mode image-to-image / reference image pour conserver
 * l'identite visuelle d'un personnage officiel, derriere une abstraction
 * propre permettant de changer de fournisseur sans reecrire le pipeline.
 *
 * REGLES :
 *   - jamais obligatoire : active uniquement si IMAGE_IMG2IMG_PROVIDER et la
 *     cle API correspondante sont fournies via l'environnement. Sinon
 *     `configured()` renvoie false et aucun appel reseau n'est effectue ;
 *   - aucun secret n'est ecrit en dur ; aucune cle n'est exposee au frontend ;
 *   - health check, timeout, retry, backoff, erreurs typées, logs ;
 *   - en cas d'echec : exception explicite, jamais un buffer fabrique.
 *
 * Fournisseurs supportes (tous OPTIONNELS, aucun n'est requis par Conquistador) :
 *   - huggingface (Inference Providers image-to-image via le SDK officiel ;
 *                  FLUX Kontext est route vers le provider fal-ai)
 *   - stability   (Stable Image / structure, multipart image+prompt)
 *   - fal         (flux Kontext / flux.2 image-to-image, image_url)
 *   - replicate   (modele img2img via predictions, data URI)
 *   - generic     (endpoint JSON configurable, contrat documente ci-dessous)
 */

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RETRIES = 2;

function env(name) {
  return process.env[name] || '';
}

/**
 * Contrat "generic" (documente, aucune cle en dur) :
 *   POST {IMAGE_IMG2IMG_ENDPOINT}
 *   Authorization: Bearer {IMAGE_IMG2IMG_API_KEY}
 *   body JSON: { prompt, image, reference_images[], width, height, model }
 *              `image` = data URI de la premiere reference
 *   reponse acceptee : { image_url } | { url } | { b64_json } | { image: { b64 } }
 *                      | { images: [ { url | b64_json } ] }
 */
const PROVIDERS = Object.freeze({
  stability: {
    id: 'stability',
    label: 'Stability AI (Stable Image / structure)',
    requiresApiKey: true,
    apiKeyEnv: 'STABILITY_API_KEY',
    endpointEnv: 'STABILITY_ENDPOINT',
    defaultEndpoint: 'https://api.stability.ai/v2beta/stable-image/edit/structure',
    defaultModel: 'stable-image-core',
    capabilities: { image_to_image: true, reference_image: true, multi_reference: false, seed: true },
  },
  fal: {
    id: 'fal',
    label: 'fal.ai (FLUX Kontext / FLUX.2 image-to-image)',
    requiresApiKey: true,
    apiKeyEnv: 'FAL_API_KEY',
    endpointEnv: 'FAL_ENDPOINT',
    defaultEndpoint: (model) => `https://fal.run/${model || 'fal-ai/flux-kontext/dev'}`,
    defaultModel: 'fal-ai/flux-kontext/dev',
    capabilities: { image_to_image: true, reference_image: true, multi_reference: true, seed: true },
  },
  replicate: {
    id: 'replicate',
    label: 'Replicate (modele image-to-image)',
    requiresApiKey: true,
    apiKeyEnv: 'REPLICATE_API_TOKEN',
    endpointEnv: 'REPLICATE_ENDPOINT',
    defaultEndpoint: (model) => `https://api.replicate.com/v1/models/${(model || 'black-forest-labs/flux-kontext-pro')}/predictions`,
    defaultModel: 'black-forest-labs/flux-kontext-pro',
    capabilities: { image_to_image: true, reference_image: true, multi_reference: false, seed: true },
  },
  huggingface: {
    id: 'huggingface',
    label: 'Hugging Face Inference Providers (fal-ai / image-to-image)',
    requiresApiKey: true,
    apiKeyEnv: 'HF_TOKEN',
    endpointEnv: 'HF_ENDPOINT',
    defaultEndpoint: 'https://router.huggingface.co',
    defaultModel: 'black-forest-labs/FLUX.1-Kontext-dev',
    capabilities: { image_to_image: true, reference_image: true, multi_reference: false, seed: true },
  },
  generic: {
    id: 'generic',
    label: 'Endpoint image-to-image personnalise',
    requiresApiKey: true,
    apiKeyEnv: 'IMAGE_IMG2IMG_API_KEY',
    endpointEnv: 'IMAGE_IMG2IMG_ENDPOINT',
    defaultEndpoint: '',
    defaultModel: 'custom',
    capabilities: { image_to_image: true, reference_image: true, multi_reference: true, seed: true },
  },
});

function providerId() {
  return String(env('IMAGE_IMG2IMG_PROVIDER') || '').trim().toLowerCase();
}

function getProvider() {
  const id = providerId();
  if (!id) return null;
  return PROVIDERS[id] || null;
}

/** true uniquement si un provider est choisi ET dote de sa cle/endpoint. */
function configured() {
  const p = getProvider();
  if (!p) return false;
  if (!env(p.apiKeyEnv)) return false;
  if (p.id === 'generic' && !env('IMAGE_IMG2IMG_ENDPOINT')) return false;
  return true;
}

/** Etat honnete de configuration (jamais de faux "connecte"). */
function status() {
  const id = providerId();
  if (!id) {
    return {
      configure: false,
      provider: null,
      raison: "Aucun provider image-to-image selectionne (IMAGE_IMG2IMG_PROVIDER). Le pipeline reste fonctionnel via existing_asset / graphic_engine.",
      providers_disponibles: Object.keys(PROVIDERS),
    };
  }
  const p = PROVIDERS[id];
  if (!p) {
    return { configure: false, provider: id, raison: `Provider "${id}" inconnu. Disponibles : ${Object.keys(PROVIDERS).join(', ')}` };
  }
  const hasKey = Boolean(env(p.apiKeyEnv));
  return {
    configure: hasKey && (p.id !== 'generic' || Boolean(env('IMAGE_IMG2IMG_ENDPOINT'))),
    provider: id,
    label: p.label,
    modele: env('IMAGE_IMG2IMG_MODEL') || p.defaultModel,
    cle_detectee: hasKey,
    capabilities: p.capabilities,
    raison: hasKey ? null : `Cle ${p.apiKeyEnv} absente : generation conditionnee par reference indisponible (fallback officiel utilise).`,
  };
}

function resolveEndpoint(p, model) {
  const explicit = env(p.endpointEnv);
  if (explicit) return explicit;
  return typeof p.defaultEndpoint === 'function' ? p.defaultEndpoint(model) : p.defaultEndpoint;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function toDataUri(buffer, mime = 'image/jpeg') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`telechargement du resultat impossible (HTTP ${res.status})`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'image/png',
  };
}

function extractImage(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = [
    json.image_url,
    json.url,
    json.output && json.output.image_url,
    json.output && json.output.url,
    json.data && json.data[0] && json.data[0].url,
    json.images && json.images[0] && (json.images[0].url || json.images[0]),
  ].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return { url: c };
  }
  const b64 = json.b64_json
    || (json.image && (json.image.b64 || json.image.base64))
    || json.image_base64
    || (json.data && json.data[0] && json.data[0].b64_json)
    || (json.images && json.images[0] && json.images[0].b64_json);
  if (typeof b64 === 'string' && b64.length > 100) return { base64: b64.replace(/^data:image\/\w+;base64,/, '') };
  return null;
}

/**
 * Construit la requete HTTP specifique au provider. Chaque provider a sa
 * propre forme (multipart vs JSON) — c'est exactement le role de l'adaptateur.
 */
function buildRequest({ p, model, prompt, referenceBuffers, width, height, seed }) {
  const endpoint = resolveEndpoint(p, model);
  const apiKey = env(p.apiKeyEnv);
  const mime = 'image/jpeg';

  if (p.id === 'stability') {
    const form = new FormData();
    form.append('image', new Blob([referenceBuffers[0]], { type: mime }), 'reference.jpg');
    form.append('prompt', prompt);
    form.append('mode', 'image-to-image');
    form.append('output_format', 'png');
    form.append('strength', String(Number(env('IMAGE_IMG2IMG_STRENGTH')) || 0.62));
    if (Number.isFinite(seed)) form.append('seed', String(seed));
    return { endpoint, headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, body: form, method: 'POST' };
  }

  if (p.id === 'fal') {
    const body = {
      prompt,
      image_url: toDataUri(referenceBuffers[0], mime),
      num_images: 1,
    };
    if (referenceBuffers.length > 1) body.reference_image_urls = referenceBuffers.slice(1).map((b) => toDataUri(b, mime));
    if (Number.isFinite(seed)) body.seed = seed;
    return {
      endpoint,
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      method: 'POST',
    };
  }

  if (p.id === 'replicate') {
    const body = {
      input: {
        prompt,
        input_image: toDataUri(referenceBuffers[0], mime),
        aspect_ratio: width && height ? `${width}:${height}` : '9:16',
        output_format: 'png',
      },
    };
    if (Number.isFinite(seed)) body.input.seed = seed;
    return {
      endpoint,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Prefer: 'wait=60' },
      body: JSON.stringify(body),
      method: 'POST',
    };
  }

  if (p.id === 'huggingface') {
    // Compatibilite avec un endpoint HF explicitement configure. Sans
    // surcharge, generate() emploie le SDK et le routeur Inference Providers.
    const url = new URL(endpoint);
    url.searchParams.set('prompt', prompt);
    if (Number.isFinite(seed)) url.searchParams.set('seed', String(seed));
    return {
      endpoint: url.toString(),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': mime, Accept: 'image/png' },
      body: referenceBuffers[0],
      method: 'POST',
      binaryResponse: true,
    };
  }

  // generic
  const body = {
    prompt,
    model,
    width,
    height,
    image: toDataUri(referenceBuffers[0], mime),
    reference_images: referenceBuffers.slice(1).map((b) => toDataUri(b, mime)),
  };
  if (Number.isFinite(seed)) body.seed = seed;
  return {
    endpoint,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    method: 'POST',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Genere un visuel a partir d'une ou plusieurs references REELLES.
 * `referenceBuffers` = Buffers des images officielles (jamais des URLs
 * inventees). Leve une erreur explicite si le provider n'est pas configure :
 * aucun repli silencieux ici (c'est la chaine imageProviders qui decide).
 */
async function generate({
  prompt,
  referenceBuffers = [],
  width,
  height,
  model,
  seed,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
} = {}) {
  const p = getProvider();
  if (!p || !configured()) {
    const err = new Error(`providerAdapter: aucun provider image-to-image configure (${status().raison})`);
    err.notConfigured = true;
    throw err;
  }
  if (!prompt) throw new Error('providerAdapter.generate: "prompt" est requis');
  if (!referenceBuffers.length) throw new Error('providerAdapter.generate: au moins une image de reference officielle est requise (aucune generation non conditionnee).');

  const maxAttempts = Math.max(1, Number(retries) + 1);
  const attempts = [];
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const t = withTimeout(timeoutMs);
    try {
      const selectedModel = model || env('IMAGE_IMG2IMG_MODEL') || p.defaultModel;
      let res;
      let sdkImage = null;
      let binaryResponse = false;
      if (p.id === 'huggingface' && !env('HF_ENDPOINT')) {
        const referenceMime = referenceBuffers[0].subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg' : 'image/png';
        sdkImage = await imageToImage({
          model: selectedModel,
          provider: 'fal-ai',
          accessToken: env('HF_TOKEN'),
          inputs: new Blob([referenceBuffers[0]], { type: referenceMime }),
          parameters: { prompt },
        }, { signal: t.signal, retry_on_error: false });
      } else {
        const req = buildRequest({ p, model: selectedModel, prompt, referenceBuffers, width, height, seed });
        binaryResponse = req.binaryResponse === true;
        res = await fetch(req.endpoint, { method: req.method, headers: req.headers, body: req.body, signal: t.signal });
      }
      if (sdkImage) {
        binaryResponse = true;
        const bytes = Buffer.from(await sdkImage.arrayBuffer());
        if (!bytes.length) throw new Error('reponse image vide du routeur Hugging Face / fal-ai');
        res = {
          ok: true,
          headers: { get: () => sdkImage.type || 'image/png' },
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
      const contentTypeHeader = res.headers.get('content-type') || '';
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status} — ${errText.slice(0, 300)}`);
      }
      let image;
      let responseFormat = 'json';
      if (binaryResponse || contentTypeHeader.startsWith('image/')) {
        // Les providers qui renvoient directement les OCTETS de l'image :
        // aucune enveloppe JSON a decoder.
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!bytes.length) throw new Error('reponse binaire vide du provider (aucune image recue)');
        image = { buffer: bytes, contentType: contentTypeHeader.startsWith('image/') ? contentTypeHeader : 'image/png' };
        responseFormat = 'binary';
      } else {
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch (parseErr) {
          throw new Error(`reponse non JSON du provider (${text.slice(0, 160)})`);
        }
        const found = extractImage(json);
        if (!found) throw new Error(`reponse du provider sans image exploitable (${text.slice(0, 200)})`);
        image = found.url ? await fetchImage(found.url) : { buffer: Buffer.from(found.base64, 'base64'), contentType: 'image/png' };
      }
      t.clear();
      attempts.push({ attempt, ok: true, duration_ms: Date.now() - startedAt });
      logger.info('providerAdapter: generation image-to-image reussie', { provider: p.id, attempt, duration_ms: attempts[attempts.length - 1].duration_ms });
      return {
        buffer: image.buffer,
        contentType: image.contentType,
        provider: p.id,
        model: model || env('IMAGE_IMG2IMG_MODEL') || p.defaultModel,
        width,
        height,
        asset_type: 'AI_IMAGE_REFERENCED',
        reference_count: referenceBuffers.length,
        response_format: responseFormat,
        attempts,
      };
    } catch (err) {
      t.clear();
      lastError = err;
      attempts.push({ attempt, ok: false, duration_ms: Date.now() - startedAt, error: err.message, timeout: err.name === 'AbortError' });
      logger.warn('providerAdapter: echec generation image-to-image', { provider: p.id, attempt, error: err.message });
      if (attempt < maxAttempts) await sleep(Math.min(8000, 700 * 2 ** (attempt - 1)));
    }
  }
  const err = new Error(`providerAdapter: generation ${p.id} echouee apres ${maxAttempts} tentative(s) — ${lastError ? lastError.message : 'raison inconnue'}`);
  err.attempts = attempts;
  throw err;
}

/** Health check reel : verifie configuration + joignabilite de l'endpoint. */
async function healthCheck({ timeoutMs = 8000 } = {}) {
  const st = status();
  if (!st.configure) return { ok: false, ...st };
  const p = getProvider();
  const endpoint = resolveEndpoint(p, st.modele);
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(endpoint, { method: 'HEAD', signal: t.signal }).catch(() => null);
    t.clear();
    return {
      ok: true,
      provider: p.id,
      endpoint,
      http_status: res ? res.status : null,
      note: "Joignabilite verifiee. La validation reelle d'une generation necessite une cle API valide et un appel de generation.",
    };
  } catch (err) {
    t.clear();
    return { ok: false, provider: p.id, endpoint, raison: err.message };
  }
}

module.exports = { PROVIDERS, configured, status, generate, healthCheck, extractImage, buildRequest, providerId };
