'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const visualEngine = require('../src/core/visualEngine');

test('hydratePersistedVideoAssets: réhydrate les PNG existants, vérifie SHA/dimensions et ne génère ni ne réuploade', async () => {
  const originalFetch = global.fetch;
  const png = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#345678' } }).png().toBuffer();
  const digest = crypto.createHash('sha256').update(png).digest('hex');
  let fetchedUrl = null;
  global.fetch = async (url) => {
    fetchedUrl = url;
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conquistador-resume-assets-'));
  try {
    const report = await visualEngine.hydratePersistedVideoAssets(
      [{ id: 'resume-scene-1' }],
      { scenes: [{
        ok: true,
        scene_id: 'resume-scene-1',
        asset_type: 'AI_IMAGE_GENERATED',
        provider: 'tiny-sd-cpu',
        model: 'segmind/tiny-sd',
        storage_url: 'https://project.supabase.co/storage/v1/object/public/conquistador-media/video-assets/scene.png',
        content_sha256: digest,
        width: 720,
        height: 1280,
        local_path: '/stale/runner/path.png',
      }] },
      { width: 720, height: 1280, workDir },
    );
    assert.equal(fetchedUrl, 'https://project.supabase.co/storage/v1/object/public/conquistador-media/video-assets/scene.png');
    assert.equal(report.rehydrated_existing_assets, true);
    assert.equal(report.reussis, 1);
    assert.equal(report.scenes[0].provider, 'tiny-sd-cpu');
    assert.equal(await fs.readFile(report.scenes[0].local_path, 'base64'), png.toString('base64'));
  } finally {
    global.fetch = originalFetch;
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test('hydratePersistedVideoAssets: échoue fermé sur hash invalide sans régénérer', async () => {
  const originalFetch = global.fetch;
  const png = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#123456' } }).png().toBuffer();
  global.fetch = async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  try {
    await assert.rejects(
      () => visualEngine.hydratePersistedVideoAssets([{ id: 'scene-x' }], { scenes: [{
        ok: true,
        scene_id: 'scene-x',
        asset_type: 'AI_IMAGE_GENERATED',
        storage_url: 'https://project.supabase.co/storage/v1/object/public/conquistador-media/x.png',
        content_sha256: 'a'.repeat(64),
        width: 720,
        height: 1280,
      }] }, { width: 720, height: 1280 }),
      /Hash de l’asset persisté scene-x invalide; aucune régénération/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('hydratePersistedVideoAssets: ne génère pas d’images si l’ensemble déjà persisté est incomplet', async () => {
  await assert.rejects(
    () => visualEngine.hydratePersistedVideoAssets([{ id: 'scene-1' }, { id: 'scene-2' }], {
      scenes: [{ ok: true, scene_id: 'scene-1' }],
    }, { width: 720, height: 1280 }),
    /incomplet; reprise arrêtée sans régénérer les images/,
  );
});
