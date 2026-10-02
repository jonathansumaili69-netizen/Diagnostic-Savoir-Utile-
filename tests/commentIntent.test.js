'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-comment-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const commercial = require('../src/agents/commercial');
const agents = require('../src/agents');
const taskEngine = require('../src/core/taskEngine');

test('detectPurchaseIntent: detecte le mot-cle "guide" (insensible a la casse)', () => {
  assert.equal(commercial.detectPurchaseIntent('GUIDE stp').detecte, true);
  assert.equal(commercial.detectPurchaseIntent('je veux le Guide').detecte, true);
  assert.equal(commercial.detectPurchaseIntent('un guide pratique').detecte, true);
});

test('detectPurchaseIntent: ne detecte rien sur un commentaire neutre', () => {
  const result = commercial.detectPurchaseIntent('super video, merci !');
  assert.equal(result.detecte, false);
  assert.deepEqual(result.mots_cles_trouves, []);
});

test('detectPurchaseIntent: accepte une liste de mots-cles personnalisee', () => {
  const result = commercial.detectPurchaseIntent('je veux le pdf', ['pdf']);
  assert.equal(result.detecte, true);
  assert.deepEqual(result.mots_cles_trouves, ['pdf']);
});

test('detectCommentIntent: aucune intention -> statut AUCUNE_INTENTION_DETECTEE, aucune action', async () => {
  const result = await commercial.detectCommentIntent({ commentaire: 'belle video', plateforme: 'tiktok' });
  assert.equal(result.output.intention_achat_detectee, false);
  assert.equal(result.output.statut, 'AUCUNE_INTENTION_DETECTEE');
  assert.equal(result.output.action_recommandee, 'aucune_action');
});

test('detectCommentIntent: intention detectee SANS connecteur -> prepare une reponse PUBLIQUE, jamais un DM simule', async () => {
  const result = await commercial.detectCommentIntent({ commentaire: 'GUIDE merci', plateforme: 'tiktok' });
  assert.equal(result.output.intention_achat_detectee, true);
  assert.equal(result.output.dm_possible, false);
  assert.equal(result.output.statut, 'ACTION_PREPAREE_REPONSE_PUBLIQUE');
  assert.equal(result.output.action_recommandee, 'reponse_publique_prepare');
  assert.ok(result.output.reponse_publique_preparee.length > 0);
  // Ne doit jamais contenir de champ pretendant un envoi reel.
  assert.equal(result.output.message_prive_prepare, undefined);
});

test('detectCommentIntent: le modele de reponse publique par defaut demande explicitement d\'ecrire en prive', async () => {
  const result = await commercial.detectCommentIntent({ commentaire: 'guide', plateforme: 'instagram' });
  assert.match(result.output.reponse_publique_preparee, /message priv/i);
});

test('detectCommentIntent: raison_dm explique honnetement l\'absence de connecteur', async () => {
  const result = await commercial.detectCommentIntent({ commentaire: 'guide', plateforme: 'whatsapp' });
  assert.match(result.output.raison_dm, /[Aa]ucun connecteur/);
});

test('agents.resolve: commercial.detect_comment_intent est catalogue en ANALYZE (AUTO)', () => {
  const r = agents.resolve('commercial.detect_comment_intent');
  assert.equal(r.actionType, 'ANALYZE');
});

test('taskEngine: commercial.detect_comment_intent s\'execute automatiquement (AUTO, jamais bloque)', async () => {
  const task = await taskEngine.createTask({
    type: 'commercial.detect_comment_intent',
    input: { commentaire: 'GUIDE svp', plateforme: 'tiktok' },
  });
  const done = await taskEngine.runTask(task.id);
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.result.output.action_recommandee, 'reponse_publique_prepare');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
