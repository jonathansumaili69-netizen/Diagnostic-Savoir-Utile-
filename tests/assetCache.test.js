'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-assetcache-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const assetCache = require('../src/core/assetCache');

test('assetCache.computeKey: deterministe, insensible a l ordre des champs, sensible au contenu', () => {
  const a = assetCache.computeKey({ provider: 'p', model: 'm', prompt: 'chat', width: 100, height: 200, style: 's', reference: 'r' });
  const b = assetCache.computeKey({ reference: 'r', style: 's', height: 200, width: 100, prompt: 'chat', model: 'm', provider: 'p' });
  assert.equal(a, b);
  const c = assetCache.computeKey({ provider: 'p', model: 'm', prompt: 'chien', width: 100, height: 200, style: 's', reference: 'r' });
  assert.notEqual(a, c);
});

test('assetCache: miss puis hit apres set()', async () => {
  const params = { provider: 'graphic_engine', model: 'title', prompt: 'bonjour', width: 400, height: 400 };
  const miss = await assetCache.get(params);
  assert.equal(miss, null);
  await assetCache.set(params, { url: 'https://example.test/img.png', provider: 'graphic_engine', model: 'title' });
  const hit = await assetCache.get(params);
  assert.ok(hit);
  assert.equal(hit.url, 'https://example.test/img.png');
  assert.equal(hit.cache_hit, true);
});

test('assetCache: une entree plus vieille que le TTL est traitee comme un miss', async () => {
  const params = { provider: 'p', model: 'm', prompt: 'expire-moi', width: 10, height: 10 };
  await assetCache.set(params, { url: 'https://example.test/old.png' });
  const stillFresh = await assetCache.get(params, { ttlMs: 999999999 });
  assert.ok(stillFresh);
  const expired = await assetCache.get(params, { ttlMs: 0 });
  assert.equal(expired, null);
});

test('assetCache.getOrGenerate: n appelle generateFn qu au premier appel (cache hit ensuite)', async () => {
  const params = { provider: 'p', model: 'm', prompt: 'compte-moi', width: 50, height: 50 };
  let calls = 0;
  const generateFn = async () => { calls += 1; return { url: 'https://example.test/gen.png', provider: 'p', model: 'm' }; };
  const first = await assetCache.getOrGenerate(params, generateFn);
  const second = await assetCache.getOrGenerate(params, generateFn);
  assert.equal(calls, 1, 'generateFn ne doit etre appelee qu une seule fois');
  assert.equal(first.url, second.url);
  assert.equal(second.cache_hit, true);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
