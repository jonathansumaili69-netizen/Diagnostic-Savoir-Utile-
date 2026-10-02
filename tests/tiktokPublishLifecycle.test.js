'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-tiktok-publish-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
process.env.TIKTOK_CLIENT_KEY = 'tiktok-client-key-test';
process.env.TIKTOK_CLIENT_SECRET = 'tiktok-client-secret-test';
process.env.TIKTOK_OAUTH_REDIRECT_URI = 'https://example.test/api/tiktok/oauth/callback';
process.env.TIKTOK_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.TIKTOK_OAUTH_SCOPE = 'user.info.basic,video.list,video.publish';
process.env.ALLOWED_ORIGIN = '';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.CONTEXT;

const tiktokApi = require('../src/core/tiktokApi');
const tiktokStore = require('../src/core/tiktokStore');
const tiktokService = require('../src/core/tiktokService');

function connectionCapabilities() {
  return tiktokApi.capabilityForScopes(['user.info.basic', 'video.list', 'video.publish']);
}

async function createConnection() {
  return tiktokStore.saveConnection({
    tokenResponse: { access_token: 'act.publish-test', refresh_token: 'rft.publish-test', expires_in: 3600, refresh_expires_in: 86400 },
    user: { openId: 'open-publish', username: 'savoirutile', displayName: 'Savoir Utile' },
    permissions: ['user.info.basic', 'video.list', 'video.publish'],
    capabilities: connectionCapabilities(),
  });
}

test('TikTok lifecycle: une soumission conserve le publish_id et reste en traitement', async () => {
  const originalInit = tiktokApi.initVideoPost;
  tiktokApi.initVideoPost = async (input) => {
    assert.equal(input.videoUrl, 'https://cdn.example.test/video.mp4');
    assert.equal(input.title, 'Conseil CV');
    return { data: { publish_id: 'publish-123' } };
  };
  let row;
  try {
    row = await createConnection();
    const connection = await tiktokStore.getDecryptedConnection(row);
    const result = await tiktokService.publishVideo(connection, {
      content_key: 'content-123',
      title: 'Conseil CV',
      video_url: 'https://cdn.example.test/video.mp4',
      privacy_level: 'SELF_ONLY',
    });
    assert.equal(result.publication_id, 'publish-123');
    assert.equal(result.statut, 'EN_TRAITEMENT');
    assert.match(result.suivi, /publish-status/);
    const stored = await tiktokStore.getPublication('publish-123');
    assert.equal(stored.data.content_key, 'content-123');
    assert.equal(tiktokStore.publicPublication(stored).statut, 'EN_TRAITEMENT');
    assert.doesNotMatch(JSON.stringify(stored), /act\.publish-test|rft\.publish-test/);
  } finally {
    tiktokApi.initVideoPost = originalInit;
    if (row) await tiktokStore.disconnect(row.id);
  }
});

test('TikTok lifecycle: le statut final est relu et persisté sans prétendre avant confirmation', async () => {
  const originalFetch = tiktokApi.fetchPublishStatus;
  let row;
  tiktokApi.fetchPublishStatus = async ({ accessToken, publishId }) => {
    assert.equal(accessToken, 'act.publish-test');
    assert.equal(publishId, 'publish-final');
    return { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: 'post-public-1', uploaded_bytes: 12345 } };
  };
  try {
    row = await createConnection();
    await tiktokStore.savePublication({ publishId: 'publish-final', contentKey: 'content-final', title: 'Final', videoUrl: 'https://cdn.example.test/final.mp4', privacyLevel: 'SELF_ONLY' });
    const result = await tiktokService.safePublicationStatus(await tiktokStore.getPublication('publish-final'));
    assert.equal(result.statut, 'PUBLIE');
    assert.equal(result.provider_status, 'PUBLISH_COMPLETE');
    assert.equal(result.public_post_id, 'post-public-1');
    const stored = await tiktokStore.getPublication('publish-final');
    assert.equal(stored.data.statut, 'PUBLIE');
    assert.equal(stored.data.public_post_id, 'post-public-1');
    assert.equal(stored.data.uploaded_bytes, 12345);
  } finally {
    tiktokApi.fetchPublishStatus = originalFetch;
    if (row) await tiktokStore.disconnect(row.id);
  }
});

test('TikTok lifecycle: les états inconnus restent en traitement et les échecs deviennent ECHEC', () => {
  assert.equal(tiktokService.normalizePublishStatus({ data: { status: 'PROCESSING' } }).statut, 'EN_TRAITEMENT');
  assert.equal(tiktokService.normalizePublishStatus({ data: { status: 'FAILED', fail_reason: 'format invalide' } }).statut, 'ECHEC');
});

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
