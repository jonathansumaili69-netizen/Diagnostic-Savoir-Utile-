'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const migrationSql = fs.readFileSync(path.join(__dirname, '../docs/migrations/20260823_add_tiktok_connections.sql'), 'utf8');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-tiktok-test-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
process.env.CONQUISTADOR_API_KEY = 'tiktok-test-api-key';
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

const { encryptSecret, decryptSecret, generateOAuthState, hashState } = require('../src/core/tiktokSecurity');
const tiktokApi = require('../src/core/tiktokApi');
const tiktokService = require('../src/core/tiktokService');
const tiktokStore = require('../src/core/tiktokStore');
const socialConnectors = require('../src/core/socialConnectors');
const tiktokStart = require('../netlify/functions/tiktok-oauth-start');
const tiktokStatus = require('../netlify/functions/tiktok-status');

function parseBody(response) {
  return JSON.parse(response.body);
}

const headers = { 'x-conquistador-key': 'tiktok-test-api-key' };

test('TikTok security: chiffre et dechiffre un token sans conserver le clair', () => {
  const secret = 'act.test-token-ne-doit-pas-apparaitre';
  const encrypted = encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptSecret(encrypted), secret);
});

test('TikTok security: state aleatoire et hash stable', () => {
  const state = generateOAuthState();
  assert.ok(state.length >= 40);
  assert.equal(hashState(state), hashState(state));
  assert.notEqual(hashState(state), hashState(generateOAuthState()));
});

test('TikTok OAuth: URL utilise client_key, redirect URI, scopes et state sans secret', () => {
  const url = new URL(tiktokApi.buildAuthorizeUrl('state-test'));
  assert.equal(url.hostname, 'www.tiktok.com');
  assert.equal(url.pathname, '/v2/auth/authorize/');
  assert.equal(url.searchParams.get('client_key'), 'tiktok-client-key-test');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/api/tiktok/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'user.info.basic,video.list,video.publish');
  assert.equal(url.searchParams.get('state'), 'state-test');
  assert.equal(url.searchParams.get('disable_auto_auth'), '1');
  assert.doesNotMatch(url.toString(), /tiktok-client-secret-test/);
});

test('TikTok capabilities: publication seulement avec video.publish', () => {
  assert.equal(tiktokApi.capabilityForScopes(['user.info.basic', 'video.list']).publication, false);
  assert.equal(tiktokApi.capabilityForScopes(['user.info.basic', 'video.list', 'video.publish']).publication, true);
  assert.equal(tiktokApi.capabilityForScopes(['user.info.basic']).lecture_chaine, true);
  assert.equal(tiktokApi.capabilityForScopes(['user.info.basic']).dm, false);
  assert.equal(tiktokApi.capabilityForScopes(['user.info.basic']).lecture_commentaires, false);
});

test('TikTok API: publication refuse une URL non HTTPS avant tout appel réseau', async () => {
  await assert.rejects(
    () => tiktokApi.initVideoPost({ accessToken: 'act.test', videoUrl: 'http://example.test/video.mp4' }),
    /URL vidéo HTTPS/,
  );
});

test('TikTok store: state OAuth consommé une seule fois', async () => {
  const state = generateOAuthState();
  await tiktokStore.saveOAuthState({ state, redirectUri: 'https://example.test/callback', scopes: ['user.info.basic'], expiresAt: new Date(Date.now() + 60000).toISOString() });
  const first = await tiktokStore.consumeOAuthState(state);
  const second = await tiktokStore.consumeOAuthState(state);
  assert.equal(first.redirect_uri, 'https://example.test/callback');
  assert.equal(second, null);
});

test('TikTok store: tokens chiffrés et absents de la projection publique', async () => {
  const row = await tiktokStore.saveConnection({
    tokenResponse: {
      access_token: 'act.private-token',
      refresh_token: 'rft.private-token',
      expires_in: 3600,
      refresh_expires_in: 86400,
    },
    user: { openId: 'open-1', username: 'savoirutile', displayName: 'Savoir Utile' },
    permissions: ['user.info.basic', 'video.list', 'video.publish'],
    capabilities: tiktokApi.capabilityForScopes(['user.info.basic', 'video.list', 'video.publish']),
  });
  assert.ok(row.data.accessTokenEncrypted);
  assert.ok(row.data.refreshTokenEncrypted);
  assert.doesNotMatch(JSON.stringify(tiktokStore.publicConnection(row)), /private-token/);
  const decrypted = await tiktokStore.getDecryptedConnection(row);
  assert.equal(decrypted.accessToken, 'act.private-token');
  assert.equal(decrypted.refreshToken, 'rft.private-token');
});

test('TikTok service: retourne le token rafraîchi pour les lectures suivantes', async () => {
  const originalUserInfo = tiktokApi.getUserInfo;
  const originalRefresh = tiktokApi.refreshAccessToken;
  const seenTokens = [];
  tiktokApi.getUserInfo = async ({ accessToken }) => {
    seenTokens.push(accessToken);
    if (seenTokens.length === 1) {
      const error = new Error('token TikTok expiré');
      error.statusCode = 401;
      throw error;
    }
    return { data: { user: { open_id: 'open-refresh', display_name: 'Refresh TikTok' } } };
  };
  tiktokApi.refreshAccessToken = async (refreshToken) => {
    assert.equal(refreshToken, 'rft.refresh-token');
    return { access_token: 'act.refresh-token', refresh_token: 'rft.refresh-token', expires_in: 3600, refresh_expires_in: 86400 };
  };
  const row = await tiktokStore.saveConnection({
    tokenResponse: { access_token: 'act.expired-token', refresh_token: 'rft.refresh-token', expires_in: 1, refresh_expires_in: 86400 },
    user: { openId: 'open-old', displayName: 'Ancien TikTok' },
    permissions: ['user.info.basic', 'video.list'],
    capabilities: tiktokApi.capabilityForScopes(['user.info.basic', 'video.list']),
  });
  try {
    const connection = await tiktokStore.getDecryptedConnection(row);
    const result = await tiktokService.inspectWithRefresh(connection);
    assert.equal(result.refreshed, true);
    assert.equal(result.accessToken, 'act.refresh-token');
    assert.deepEqual(seenTokens, ['act.expired-token', 'act.refresh-token']);
    const fresh = await tiktokStore.getDecryptedConnection(await tiktokStore.getActiveConnection());
    assert.equal(fresh.accessToken, 'act.refresh-token');
  } finally {
    tiktokApi.getUserInfo = originalUserInfo;
    tiktokApi.refreshAccessToken = originalRefresh;
    await tiktokStore.disconnect(row.id);
  }
});

test('TikTok connectors: aucune connexion déclarée sans stockage actif', async () => {
  const row = await tiktokStore.getActiveConnection();
  if (row) await tiktokStore.disconnect(row.id);
  const snapshot = await socialConnectors.getDynamicSnapshot();
  const tiktok = snapshot.find((entry) => entry.plateforme === 'tiktok');
  assert.equal(tiktok.connecte, false);
  assert.equal(tiktok.capacites.publication, false);
});

test('TikTok migration: reste additive et active RLS sans politique publique', () => {
  assert.match(migrationSql, /create table if not exists public\.tiktok_connections/i);
  assert.match(migrationSql, /create table if not exists public\.tiktok_oauth_states/i);
  assert.match(migrationSql, /alter table public\.tiktok_connections enable row level security/i);
  assert.match(migrationSql, /alter table public\.tiktok_oauth_states enable row level security/i);
  assert.doesNotMatch(migrationSql, /\b(drop|truncate)\b/i);
  assert.doesNotMatch(migrationSql, /create policy/i);
});

test('TikTok OAuth start: exige la clé et ne retourne aucun secret', async () => {
  const response = await tiktokStart.handler({ httpMethod: 'GET', headers, queryStringParameters: {} });
  assert.equal(response.statusCode, 200);
  const body = parseBody(response);
  assert.match(body.authorization_url, /tiktok\.com/);
  assert.doesNotMatch(response.body, /tiktok-client-secret-test/);
});

test('TikTok status: refuse sans clé et masque la configuration secrète', async () => {
  const refused = await tiktokStatus.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.equal(refused.statusCode, 401);
  const response = await tiktokStatus.handler({ httpMethod: 'GET', headers, queryStringParameters: {} });
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /tiktok-client-secret-test/);
  assert.equal(parseBody(response).statut, 'non_connecte');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
