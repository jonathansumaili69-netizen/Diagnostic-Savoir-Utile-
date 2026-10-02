'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-meta-test-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
process.env.CONQUISTADOR_API_KEY = 'meta-test-api-key';
process.env.META_APP_ID = '123456789';
process.env.META_APP_SECRET = 'meta-app-secret-test';
process.env.META_CONFIGURATION_ID = '987654321';
process.env.META_OAUTH_REDIRECT_URI = 'https://example.test/api/meta/oauth/callback';
process.env.META_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.META_WEBHOOK_VERIFY_TOKEN = 'meta-verify-test';
process.env.META_GRAPH_API_VERSION = 'v26.0';
process.env.ALLOWED_ORIGIN = '';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.CONTEXT;

const { encryptSecret, decryptSecret, generateOAuthState, hashState } = require('../src/core/metaSecurity');
const metaStore = require('../src/core/metaStore');
const metaGraph = require('../src/core/metaGraph');
const socialConnectors = require('../src/core/socialConnectors');
const { assertMetaSignature, eventKey } = require('../netlify/functions/meta-webhook');
const oauthStart = require('../netlify/functions/meta-oauth-start');
const metaWebhook = require('../netlify/functions/meta-webhook');
const systemActions = require('../src/agents/systemActions');

function parseBody(response) {
  return JSON.parse(response.body);
}

test('Meta security: chiffre et dechiffre un token sans conserver le clair', () => {
  const secret = 'EAATEST-token-ne-doit-pas-apparaitre';
  const encrypted = encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptSecret(encrypted), secret);
});

test('Meta security: state aleatoire et hash stable', () => {
  const state = generateOAuthState();
  assert.ok(state.length >= 40);
  assert.equal(hashState(state), hashState(state));
  assert.notEqual(hashState(state), hashState(generateOAuthState()));
});

test('Meta Graph: URL OAuth code utilise state, redirect URI et scopes serveur', () => {
  const url = new URL(metaGraph.buildAuthorizeUrl('state-test'));
  assert.equal(url.hostname, 'www.facebook.com');
  assert.equal(url.searchParams.get('client_id'), '123456789');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/api/meta/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('config_id'), '987654321');
  assert.equal(url.searchParams.get('state'), 'state-test');
  assert.match(url.searchParams.get('scope'), /pages_show_list/);
  assert.doesNotMatch(url.toString(), /meta-app-secret-test/);
});

test('Meta capabilities: seules les permissions et tâches accordées activent les capacités', () => {
  const result = metaGraph.calculateCapabilities({
    permissions: ['pages_read_engagement', 'pages_manage_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_manage_comments'],
    page: { tasks: ['MODERATE', 'CREATE_CONTENT'] },
  });
  assert.equal(result.facebook.lecture_commentaires, true);
  assert.equal(result.facebook.reponse_commentaires, true);
  assert.equal(result.facebook.publication, true);
  assert.equal(result.facebook.dm, false);
  assert.equal(result.instagram.lecture_commentaires, true);
  assert.equal(result.instagram.publication, false);
});

test('Meta webhook: accepte la signature App Secret et refuse une signature falsifiée', () => {
  const raw = JSON.stringify({ object: 'instagram', entry: [{ id: 'ig1', time: 1 }] });
  const digest = crypto.createHmac('sha256', 'meta-app-secret-test').update(Buffer.from(raw)).digest('hex');
  assert.doesNotThrow(() => assertMetaSignature({ 'x-hub-signature-256': `sha256=${digest}` }, raw));
  assert.throws(() => assertMetaSignature({ 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, raw), /Signature Meta invalide/);
});

test('Meta webhook: clé d’événement est déterministe et change si le message change', () => {
  const first = { object: 'page', entry: [{ id: 'p1', time: 10, messaging: [{ sender: { id: 'u1' }, timestamp: 12, message: { mid: 'm1' } }] }] };
  const second = { object: 'page', entry: [{ id: 'p1', time: 10, messaging: [{ sender: { id: 'u1' }, timestamp: 12, message: { mid: 'm2' } }] }] };
  assert.equal(eventKey(first), eventKey(first));
  assert.notEqual(eventKey(first), eventKey(second));
});

test('Meta store: état OAuth consommé une seule fois', async () => {
  const state = generateOAuthState();
  await metaStore.saveOAuthState({ state, redirectUri: 'https://example.test/callback', expiresAt: new Date(Date.now() + 60000).toISOString() });
  const first = await metaStore.consumeOAuthState(state);
  const second = await metaStore.consumeOAuthState(state);
  assert.equal(first.redirect_uri, 'https://example.test/callback');
  assert.equal(second, null);
});

test('Meta store: tokens chiffrés et jamais renvoyés dans la connexion publique', async () => {
  const row = await metaStore.saveConnection({
    userAccessToken: 'USER-TOKEN-SECRET',
    pageAccessToken: 'PAGE-TOKEN-SECRET',
    data: {
      connection_key: 'meta:test-user',
      facebook: { id: 'fb1', name: 'Page test' },
      pages: [{ id: 'page1', name: 'Page test', tasks: ['MODERATE'], accessToken: 'PAGE-TOKEN-SECRET' }],
      instagram: { id: 'ig1', username: 'test' },
      permissions: ['pages_show_list'],
      capabilities: { facebook: {}, instagram: {} },
    },
  });
  assert.ok(row.data.userAccessTokenEncrypted);
  assert.ok(row.data.pageAccessTokenEncrypted);
  assert.doesNotMatch(JSON.stringify(metaStore.publicConnection(row)), /TOKEN-SECRET/);
  const decrypted = await metaStore.getDecryptedConnection(row);
  assert.equal(decrypted.userAccessToken, 'USER-TOKEN-SECRET');
  assert.equal(decrypted.data.pages[0].accessToken, 'PAGE-TOKEN-SECRET');
});

test('Meta connectors: aucun compte n’est déclaré connecté sans stockage actif', async () => {
  await metaStore.disconnect((await metaStore.getActiveConnection()).id);
  const snapshot = await socialConnectors.getDynamicSnapshot();
  const facebook = snapshot.find((row) => row.plateforme === 'facebook');
  const instagram = snapshot.find((row) => row.plateforme === 'instagram');
  assert.equal(facebook.connecte, false);
  assert.equal(instagram.connecte, false);
});

test('Meta webhook: repond au challenge officiel uniquement avec le verify token exact', async () => {
  const accepted = await metaWebhook.handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'meta-verify-test', 'hub.challenge': 'challenge-123' },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body, 'challenge-123');
  const refused = await metaWebhook.handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'challenge-123' },
  });
  assert.equal(refused.statusCode, 403);
});

test('Meta action: une connexion sans capacite dm reste NON_EXECUTE', async () => {
  await metaStore.saveConnection({
    userAccessToken: 'USER-TOKEN-2',
    pageAccessToken: 'PAGE-TOKEN-2',
    data: {
      connection_key: 'meta:capability-test',
      facebook: { id: 'fb2', name: 'Page capability' },
      pages: [{ id: 'page2', name: 'Page capability', tasks: [] }],
      instagram: { id: 'ig2', username: 'capability' },
      permissions: [],
      capabilities: { facebook: { dm: false }, instagram: { dm: false } },
    },
  });
  const result = await systemActions.sendMessage({ canal: 'facebook', destinataire: 'user', message: 'test' });
  assert.equal(result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION');
});

test('Meta OAuth start: exige la clé Conquistador et ne retourne aucun secret Meta', async () => {
  const response = await oauthStart.handler({
    httpMethod: 'GET',
    headers: { 'x-conquistador-key': 'meta-test-api-key' },
    body: '',
    queryStringParameters: {},
  });
  assert.equal(response.statusCode, 200);
  const body = parseBody(response);
  assert.match(body.authorization_url, /facebook\.com/);
  assert.doesNotMatch(response.body, /meta-app-secret-test/);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('socialConnectors: remonte l\'avatar réel de Facebook/Instagram quand l\'API Meta le fournit, jamais inventé', async () => {
  const socialConnectors = require('../src/core/socialConnectors');
  await metaStore.saveConnection({
    userAccessToken: 'USER-TOKEN-AVATAR-TEST',
    pageAccessToken: 'PAGE-TOKEN-AVATAR-TEST',
    data: {
      connection_key: 'meta:avatar-test-user',
      facebook: { id: 'fb-avatar-1', name: 'Savoir Utile', avatar: 'https://graph.facebook.com/fb-avatar-1/picture' },
      pages: [{ id: 'page1', name: 'Savoir Utile', tasks: ['MODERATE', 'MANAGE'], accessToken: 'PAGE-TOKEN-AVATAR-TEST', instagramId: 'ig-avatar-1' }],
      instagram: { id: 'ig-avatar-1', username: 'savoirutile', name: 'Savoir Utile', avatar: 'https://scontent.cdninstagram.com/avatar-ig-1.jpg' },
      permissions: ['pages_show_list'],
      capabilities: { facebook: {}, instagram: {} },
      lastVerifiedAt: new Date().toISOString(),
    },
  });
  const snapshot = await socialConnectors.getDynamicSnapshot();
  const facebook = snapshot.find((c) => c.plateforme === 'facebook');
  const instagram = snapshot.find((c) => c.plateforme === 'instagram');
  assert.equal(facebook.compte, 'Savoir Utile');
  assert.equal(facebook.avatar, 'https://graph.facebook.com/fb-avatar-1/picture');
  assert.equal(instagram.compte, 'Savoir Utile');
  assert.equal(instagram.avatar, 'https://scontent.cdninstagram.com/avatar-ig-1.jpg');
});

test('socialConnectors: avatar reste null (jamais inventé) quand l\'API ne l\'a pas fourni', async () => {
  const socialConnectors = require('../src/core/socialConnectors');
  const snapshot = await socialConnectors.getDynamicSnapshot();
  const tiktok = snapshot.find((c) => c.plateforme === 'tiktok');
  // Aucune connexion TikTok enregistree dans ce fichier de test -> doit
  // rester honnetement non connecte, avatar strictement null.
  assert.equal(tiktok.connecte, false);
  assert.equal(tiktok.avatar, null);
});
