'use strict';

const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, { concurrency: false }, fn);
test.after = nodeTest.after.bind(nodeTest);
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-hardening-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
process.env.CONQUISTADOR_API_KEY = 'test-key-hardening';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.KILL_SWITCH_DEFAULT;

const idempotency = require('../src/core/idempotency');
const killswitch = require('../src/core/killswitch');
const diagnostics = require('../src/core/diagnostics');
const socialConnectors = require('../src/core/socialConnectors');
const aiProviders = require('../src/core/aiProviders');
const aiProvider = require('../src/core/aiProvider');
const taskEngine = require('../src/core/taskEngine');

/* --- Idempotence (section 5) ----------------------------------------------*/

test('idempotency.checkAndMark: premiere occurrence n\'est jamais un doublon', async () => {
  const r = await idempotency.checkAndMark('test.scope1', 'cle-unique-1');
  assert.equal(r.doublon, false);
});

test('idempotency.checkAndMark: la meme cle+scope est detectee comme doublon', async () => {
  await idempotency.checkAndMark('test.scope2', 'cle-repetee');
  const r = await idempotency.checkAndMark('test.scope2', 'cle-repetee');
  assert.equal(r.doublon, true);
  assert.ok(r.premiere_fois);
});

test('idempotency.checkAndMark: meme cle mais scope different n\'est pas un doublon', async () => {
  await idempotency.checkAndMark('test.scopeA', 'cle-partagee');
  const r = await idempotency.checkAndMark('test.scopeB', 'cle-partagee');
  assert.equal(r.doublon, false);
});

test('idempotency.deriveKey: deterministe (memes donnees -> meme cle)', () => {
  const k1 = idempotency.deriveKey({ a: 1, b: 'x' });
  const k2 = idempotency.deriveKey({ a: 1, b: 'x' });
  const k3 = idempotency.deriveKey({ a: 2, b: 'x' });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

/* --- Kill switch (section 13) ----------------------------------------------*/

test('killswitch: etat par defaut est desengage', async () => {
  const s = await killswitch.getStatus();
  assert.equal(s.engage, false);
});

test('killswitch: engager bloque SEND_MESSAGE/PUBLISH_POST mais jamais ANALYZE/GENERATE', async () => {
  await killswitch.setStatus({ engage: true, raison: 'test' });
  assert.equal(await killswitch.isBlocked('SEND_MESSAGE'), true);
  assert.equal(await killswitch.isBlocked('PUBLISH_POST'), true);
  assert.equal(await killswitch.isBlocked('ANALYZE'), false);
  assert.equal(await killswitch.isBlocked('GENERATE_IDEA'), false);
  assert.equal(await killswitch.isBlocked('PREPARE_RESPONSE'), false);
  await killswitch.setStatus({ engage: false, confirmation: true });
});

test('killswitch: desengager sans confirmation echoue explicitement', async () => {
  await killswitch.setStatus({ engage: true, raison: 'test2' });
  await assert.rejects(() => killswitch.setStatus({ engage: false }), /confirmation/);
  await killswitch.setStatus({ engage: false, confirmation: true });
});

test('taskEngine: une tache EXECUTE deja approuvee est BLOQUEE si le kill switch est actif', async () => {
  await killswitch.setStatus({ engage: true, raison: 'test taskEngine' });
  const task = await taskEngine.createTask({
    type: 'system.send_message',
    input: { canal: 'x', message: 'y' },
  });
  const result = await taskEngine.runTask(task.id, { skipApprovalCheck: true });
  assert.equal(result.data.status, 'blocked');
  assert.match(result.data.error, /kill switch/);
  await killswitch.setStatus({ engage: false, confirmation: true });
});

test('taskEngine: une tache AUTO (quality.review) continue de fonctionner meme kill switch actif', async () => {
  await killswitch.setStatus({ engage: true, raison: 'test AUTO' });
  const task = await taskEngine.createTask({ type: 'quality.review', input: { content: {} } });
  const result = await taskEngine.runTask(task.id);
  assert.equal(result.data.status, 'done');
  await killswitch.setStatus({ engage: false, confirmation: true });
});

/* --- Connecteurs sociaux (section 9) ---------------------------------------*/

test('socialConnectors.capabilities: plateforme non enregistree est honnetement "non_connecte"', () => {
  const c = socialConnectors.capabilities('tiktok');
  assert.equal(c.connecte, false);
  assert.equal(c.capacites.dm, false);
  assert.equal(c.capacites.publication, false);
  assert.ok(c.raison);
});

test('socialConnectors.testConnection: echoue honnetement sans connecteur reel', async () => {
  const r = await socialConnectors.testConnection('instagram');
  assert.equal(r.succes, false);
});

test('socialConnectors.getRegistrySnapshot: renvoie un tableau non vide de plateformes connues', () => {
  const snap = socialConnectors.getRegistrySnapshot();
  assert.ok(Array.isArray(snap) && snap.length > 0);
  assert.ok(snap.every((c) => typeof c.plateforme === 'string'));
});

/* --- Diagnostics (section 18) ----------------------------------------------*/

test('diagnostics.runDiagnostics: renvoie un statut_global et 7 verifications', async () => {
  const result = await diagnostics.runDiagnostics();
  assert.ok(['ok', 'a_configurer', 'erreur'].includes(result.statut_global));
  assert.equal(result.verifications.length, 7);
  assert.ok(result.verifications.every((v) => ['ok', 'a_configurer', 'erreur'].includes(v.statut)));
});

test('diagnostics.checkEnvVars: erreur si CONQUISTADOR_API_KEY absente', () => {
  const saved = process.env.CONQUISTADOR_API_KEY;
  delete process.env.CONQUISTADOR_API_KEY;
  const r = diagnostics.checkEnvVars();
  assert.equal(r.statut, 'erreur');
  process.env.CONQUISTADOR_API_KEY = saved;
});

test('diagnostics.checkAssets: a_configurer quand aucune reference visuelle n\'est definie', () => {
  const r = diagnostics.checkAssets();
  assert.equal(r.statut, 'a_configurer');
});

test('diagnostics.checkAssets: erreur si un chemin est configure mais le fichier n\'existe pas', () => {
  process.env.CHARACTER_REF_SAMUEL = 'assets/personnages/samuel/fichier-inexistant.jpeg';
  process.env.CHARACTER_REF_MARC = 'assets/personnages/marc/marc-reference-principale.jpg';
  process.env.LOGO_ASSET_ID = 'assets/logo/logo-savoir-utile-officiel.jpeg';
  delete require.cache[require.resolve('../src/core/config')];
  delete require.cache[require.resolve('../src/core/diagnostics')];
  const freshDiagnostics = require('../src/core/diagnostics');
  const r = freshDiagnostics.checkAssets();
  assert.equal(r.statut, 'erreur');
  delete process.env.CHARACTER_REF_SAMUEL;
  delete process.env.CHARACTER_REF_MARC;
  delete process.env.LOGO_ASSET_ID;
});

/* --- Robustesse fournisseur IA (section 6) ---------------------------------*/

test('aiProviders circuit breaker: 3 echecs consecutifs ouvrent le circuit', () => {
  aiProviders.recordAttempt('groq', { success: false, error: 'e1' });
  aiProviders.recordAttempt('groq', { success: false, error: 'e2' });
  aiProviders.recordAttempt('groq', { success: false, error: 'e3' });
  assert.equal(aiProviders.isTemporarilyUnavailable('groq'), true);
  // reinitialise pour ne pas polluer les tests suivants
  aiProviders.recordAttempt('groq', { success: true });
});

test('aiProviders circuit breaker: un succes reinitialise le compteur d\'echecs consecutifs', () => {
  aiProviders.recordAttempt('openrouter', { success: false, error: 'e1' });
  aiProviders.recordAttempt('openrouter', { success: false, error: 'e2' });
  aiProviders.recordAttempt('openrouter', { success: true });
  assert.equal(aiProviders.isTemporarilyUnavailable('openrouter'), false);
});

test('aiProviders: mock ne peut jamais etre desactive manuellement', () => {
  assert.throws(() => aiProviders.setManuallyDisabled('mock', true), /Mock ne peut jamais/);
});

test('aiProviders: mock n\'est jamais indisponible meme apres des echecs simules', () => {
  for (let i = 0; i < 5; i += 1) aiProviders.recordAttempt('mock', { success: false, error: 'x' });
  assert.equal(aiProviders.isTemporarilyUnavailable('mock'), false);
});

test('aiProviders.setManuallyDisabled: desactive puis reactive correctement', () => {
  aiProviders.setManuallyDisabled('gemini', true, 'maintenance test');
  assert.equal(aiProviders.isTemporarilyUnavailable('gemini'), true);
  aiProviders.setManuallyDisabled('gemini', false);
  assert.equal(aiProviders.isTemporarilyUnavailable('gemini'), false);
});

test('aiProvider.classifyError: distingue quota, timeout, reseau, config', () => {
  assert.equal(aiProvider.classifyError(new Error('HTTP 429: too many requests')), 'quota_depasse');
  assert.equal(aiProvider.classifyError(new Error('The operation was aborted')), 'timeout');
  assert.equal(aiProvider.classifyError(new Error('fetch failed ECONNREFUSED')), 'erreur_reseau');
  assert.equal(aiProvider.classifyError(new Error('GROQ_API_KEY non configuree')), 'non_configure');
});

test('aiProvider.isRetryable: uniquement timeout et erreur reseau sont retryable', () => {
  assert.equal(aiProvider.isRetryable('timeout'), true);
  assert.equal(aiProvider.isRetryable('erreur_reseau'), true);
  assert.equal(aiProvider.isRetryable('quota_depasse'), false);
  assert.equal(aiProvider.isRetryable('non_configure'), false);
});

test('aiProvider.generate: un fournisseur au circuit ouvert est saute sans etre reellement appele', async () => {
  aiProviders.recordAttempt('groq', { success: false, error: 'e1' });
  aiProviders.recordAttempt('groq', { success: false, error: 'e2' });
  aiProviders.recordAttempt('groq', { success: false, error: 'e3' });
  const result = await aiProvider.generate({ prompt: 'test circuit ouvert dans generate' });
  const groqAttempt = result.attempts.find((a) => a.provider === 'groq');
  assert.equal(groqAttempt.errorType, 'indisponible_temporairement');
  assert.equal(result.provider, 'mock');
  aiProviders.recordAttempt('groq', { success: true });
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
