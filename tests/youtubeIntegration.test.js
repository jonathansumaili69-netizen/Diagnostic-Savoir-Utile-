'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-youtube-test-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
process.env.CONQUISTADOR_API_KEY = 'youtube-test-api-key';
process.env.YOUTUBE_CLIENT_ID = 'youtube-client-id-test';
process.env.YOUTUBE_CLIENT_SECRET = 'youtube-client-secret-test';
process.env.YOUTUBE_OAUTH_REDIRECT_URI = 'https://example.test/api/youtube/oauth/callback';
process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.YOUTUBE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
process.env.ALLOWED_ORIGIN = '';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.CONTEXT;

const youtubeSecurity = require('../src/core/youtubeSecurity');
const youtubeApi = require('../src/core/youtubeApi');
const youtubeService = require('../src/core/youtubeService');
const youtubeStore = require('../src/core/youtubeStore');
const socialConnectors = require('../src/core/socialConnectors');
const youtubeStart = require('../netlify/functions/youtube-oauth-start');
const youtubeStatus = require('../netlify/functions/youtube-status');
const youtubeCallback = require('../netlify/functions/youtube-oauth-callback');

function parseBody(response) {
  return JSON.parse(response.body);
}

const baseEvent = {
  headers: { 'x-conquistador-key': 'youtube-test-api-key' },
  queryStringParameters: {},
};

test('YouTube security: chiffre et dechiffre un token sans conserver le clair', () => {
  const secret = 'YOUTUBE-refresh-token-ne-doit-pas-apparaitre';
  const encrypted = youtubeSecurity.encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.doesNotMatch(encrypted, /YOUTUBE-refresh-token/);
  assert.equal(youtubeSecurity.decryptSecret(encrypted), secret);
});

test('YouTube OAuth: URL Google utilise state, redirect URI, offline et scopes sans secret', () => {
  const url = new URL(youtubeApi.buildAuthorizeUrl('state-test-youtube'));
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'youtube-client-id-test');
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/api/youtube/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-test-youtube');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.match(url.searchParams.get('scope'), /youtube\.readonly/);
  assert.doesNotMatch(url.toString(), /youtube-client-secret-test/);
});

test('YouTube capabilities: lecture seule et publication restent distinctes', () => {
  const readOnly = youtubeApi.capabilityForScopes(['https://www.googleapis.com/auth/youtube.readonly']);
  assert.equal(readOnly.lecture_chaine, true);
  assert.equal(readOnly.publication, false);
  const upload = youtubeApi.capabilityForScopes(['https://www.googleapis.com/auth/youtube.upload']);
  assert.equal(upload.lecture_chaine, true);
  assert.equal(upload.publication, true);
});

test('YouTube upload: refuse une URL non HTTPS sans appel réseau', async () => {
  await assert.rejects(
    () => youtubeApi.uploadVideoFromUrl({ accessToken: 'ACCESS', videoUrl: 'http://example.test/video.mp4' }),
    (error) => error && error.statusCode === 400 && /HTTPS/.test(error.message),
  );
});

test('YouTube upload: initialise puis termine un téléversement résumable simulé', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return new Response(Buffer.from('fake-video-bytes'), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '15' },
      });
    }
    if (calls.length === 2) {
      return new Response('', {
        status: 200,
        headers: { location: 'https://upload.youtube.test/session/abc' },
      });
    }
    return new Response(JSON.stringify({ id: 'video-uploaded-test', status: { privacyStatus: 'private' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await youtubeApi.uploadVideoFromUrl({
      accessToken: 'ACCESS-TOKEN-TEST',
      videoUrl: 'https://cdn.example.test/video.mp4',
      title: 'Vidéo test',
      privacyStatus: 'private',
    });
    assert.equal(result.id, 'video-uploaded-test');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.method, 'POST');
    assert.match(calls[1].options.body, /Vidéo test/);
    assert.equal(calls[2].options.method, 'PUT');
    assert.equal(calls[2].options.headers.Authorization, 'Bearer ACCESS-TOKEN-TEST');
  } finally {
    global.fetch = originalFetch;
  }
});

test('YouTube service: rafraîchit le token avant de retenter une publication', async () => {
  const originalUpload = youtubeApi.uploadVideoFromUrl;
  const originalRefresh = youtubeApi.refreshAccessToken;
  const calls = [];
  youtubeApi.uploadVideoFromUrl = async ({ accessToken }) => {
    calls.push(accessToken);
    if (calls.length === 1) {
      const error = new Error('token expiré');
      error.statusCode = 401;
      throw error;
    }
    return { id: 'video-after-refresh' };
  };
  youtubeApi.refreshAccessToken = async (refreshToken) => {
    assert.equal(refreshToken, 'REFRESH-TOKEN-ROTATION');
    return { access_token: 'ACCESS-TOKEN-REFRESHED', expires_in: 3600 };
  };
  const row = await youtubeStore.saveConnection({
    accessToken: 'ACCESS-TOKEN-EXPIRED',
    refreshToken: 'REFRESH-TOKEN-ROTATION',
    tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    data: {
      connection_key: 'youtube:refresh-publish',
      provider: 'youtube',
      channel: { id: 'refresh-channel', title: 'Refresh test' },
      permissions: ['https://www.googleapis.com/auth/youtube.upload'],
      capabilities: youtubeApi.capabilityForScopes(['https://www.googleapis.com/auth/youtube.upload']),
    },
  });
  try {
    const connection = await youtubeStore.getDecryptedConnection(row);
    const result = await youtubeService.publishVideo(connection, { video_url: 'https://cdn.example.test/video.mp4' });
    assert.equal(result.id, 'video-after-refresh');
    assert.deepEqual(calls, ['ACCESS-TOKEN-EXPIRED', 'ACCESS-TOKEN-REFRESHED']);
    const freshRow = await youtubeStore.getActiveConnection();
    const stored = await youtubeStore.getDecryptedConnection(freshRow);
    assert.equal(stored.accessToken, 'ACCESS-TOKEN-REFRESHED');
  } finally {
    youtubeApi.uploadVideoFromUrl = originalUpload;
    youtubeApi.refreshAccessToken = originalRefresh;
    await youtubeStore.disconnect(row.id);
  }
});

test('YouTube connector: expose publish seulement avec le scope upload', async () => {
  const row = await youtubeStore.saveConnection({
    accessToken: 'ACCESS-TOKEN-PUBLISH',
    refreshToken: 'REFRESH-TOKEN-PUBLISH',
    tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    data: {
      connection_key: 'youtube:publish',
      provider: 'youtube',
      channel: { id: 'publish-channel', title: 'Publication test' },
      permissions: ['https://www.googleapis.com/auth/youtube.upload'],
      capabilities: youtubeApi.capabilityForScopes(['https://www.googleapis.com/auth/youtube.upload']),
      lastVerifiedAt: new Date().toISOString(),
    },
  });
  const client = await socialConnectors.activeClientFor('youtube', 'publication');
  assert.equal(typeof client.publish, 'function');
  await youtubeStore.disconnect(row.id);
});

test('YouTube store: state OAuth consommé une seule fois', async () => {
  const state = youtubeSecurity.generateOAuthState();
  await youtubeStore.saveOAuthState({
    state,
    redirectUri: 'https://example.test/api/youtube/oauth/callback',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const first = await youtubeStore.consumeOAuthState(state);
  const second = await youtubeStore.consumeOAuthState(state);
  assert.equal(first.redirect_uri, 'https://example.test/api/youtube/oauth/callback');
  assert.deepEqual(first.scopes, ['https://www.googleapis.com/auth/youtube.readonly']);
  assert.equal(second, null);
});

test('YouTube store: projection publique sans access token ni refresh token', async () => {
  const row = await youtubeStore.saveConnection({
    accessToken: 'ACCESS-TOKEN-SECRET',
    refreshToken: 'REFRESH-TOKEN-SECRET',
    tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    data: {
      connection_key: 'youtube:channel-test',
      provider: 'youtube',
      channel: { id: 'channel-test', title: 'Chaîne test' },
      permissions: ['https://www.googleapis.com/auth/youtube.readonly'],
      capabilities: youtubeApi.capabilityForScopes(['https://www.googleapis.com/auth/youtube.readonly']),
      lastVerifiedAt: new Date().toISOString(),
      connectedAt: new Date().toISOString(),
    },
  });
  const publicJson = JSON.stringify(youtubeStore.publicConnection(row));
  assert.doesNotMatch(publicJson, /ACCESS-TOKEN-SECRET|REFRESH-TOKEN-SECRET/);
  assert.equal(youtubeStore.publicConnection(row).chaine.titre, 'Chaîne test');
  const decrypted = await youtubeStore.getDecryptedConnection(row);
  assert.equal(decrypted.accessToken, 'ACCESS-TOKEN-SECRET');
  assert.equal(decrypted.refreshToken, 'REFRESH-TOKEN-SECRET');
  await youtubeStore.disconnect(row.id);
});

test('YouTube status: renvoie uniquement des booléens de configuration sans token', async () => {
  const response = await youtubeStatus.handler({ ...baseEvent, httpMethod: 'GET' });
  assert.equal(response.statusCode, 200);
  const body = parseBody(response);
  assert.equal(body.configuration_serveur.client_id, true);
  assert.equal(body.configuration_serveur.client_secret, true);
  assert.equal(body.configuration_serveur.token_encryption_key, true);
  assert.doesNotMatch(response.body, /youtube-client-secret-test|ACCESS-TOKEN-SECRET|REFRESH-TOKEN-SECRET/);
});

test('YouTube connectors: la connexion active apparaît seulement après stockage réel', async () => {
  const row = await youtubeStore.saveConnection({
    accessToken: 'ACCESS-TOKEN-SNAPSHOT',
    refreshToken: 'REFRESH-TOKEN-SNAPSHOT',
    data: {
      connection_key: 'youtube:snapshot',
      provider: 'youtube',
      channel: { id: 'snapshot', title: 'Snapshot' },
      permissions: ['https://www.googleapis.com/auth/youtube.readonly'],
      capabilities: youtubeApi.capabilityForScopes(['https://www.googleapis.com/auth/youtube.readonly']),
      lastVerifiedAt: new Date().toISOString(),
    },
  });
  const snapshot = await socialConnectors.getDynamicSnapshot();
  const youtube = snapshot.find((entry) => entry.plateforme === 'youtube');
  assert.equal(youtube.connecte, true);
  assert.equal(youtube.compte, 'Snapshot');
  assert.equal(youtube.capacites.publication, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /ACCESS-TOKEN-SNAPSHOT|REFRESH-TOKEN-SNAPSHOT/);
  await youtubeStore.disconnect(row.id);
});

test('YouTube OAuth handlers: exigent la clé et refusent un callback incomplet', async () => {
  const unauthorized = await youtubeStart.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.equal(unauthorized.statusCode, 401);
  const missing = await youtubeCallback.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.equal(missing.statusCode, 400);
  assert.doesNotMatch(missing.body, /youtube-client-secret-test/);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
