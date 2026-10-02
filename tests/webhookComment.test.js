'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-webhookcomment-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
process.env.CONQUISTADOR_API_KEY = 'webhook-comment-test-key';
delete process.env.CONQUISTADOR_WEBHOOK_SECRET;
delete process.env.REQUIRE_WEBHOOK_SIGNATURE;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const webhookComment = require('../netlify/functions/webhook-comment');
const memory = require('../src/core/memory');

function event(body) {
  return {
    httpMethod: 'POST',
    headers: { 'x-conquistador-key': 'webhook-comment-test-key' },
    body: JSON.stringify(body),
  };
}

function parsed(response) {
  return JSON.parse(response.body || '{}');
}

/*
 * AUDIT (mission section 4) : ce webhook generique (source tierce relayant
 * des commentaires TikTok/Instagram/YouTube/etc.) creait auparavant une
 * tache PUBLISH_POST pour une reponse publique a un commentaire, sans meme
 * collecter de comment_id : une "reponse au commentaire" publiait donc en
 * realite un post independant, sans aucun lien avec le commentaire
 * d'origine. Corrige : reponse publique = REPLY_COMMENT avec comment_id
 * obligatoire ; sans comment_id, l'action est refusee explicitement.
 */

test('webhook-comment: intention detectee + comment_id fourni -> cree une tache REPLY_COMMENT (jamais PUBLISH_POST)', async () => {
  const response = await webhookComment.handler(event({
    commentaire: 'GUIDE merci',
    plateforme: 'tiktok',
    identifiant_auteur: 'user-1',
    comment_id: 'comment-abc-123',
  }));
  assert.equal(response.statusCode, 200);
  const data = parsed(response);
  assert.equal(data.deja_traite, false);
  assert.ok(data.action, 'une tache action aurait du etre creee');
  assert.equal(data.action.data.type, 'system.reply_comment');
  assert.notEqual(data.action.data.type, 'system.publish_post');
  assert.equal(data.action.data.input.comment_id, 'comment-abc-123');
  assert.equal(data.action.data.input.plateforme, 'tiktok');
});

test('webhook-comment: intention detectee SANS comment_id -> refuse explicitement, ne cree AUCUNE tache de publication de repli', async () => {
  const response = await webhookComment.handler(event({
    commentaire: 'GUIDE merci',
    plateforme: 'tiktok',
    identifiant_auteur: 'user-2',
  }));
  assert.equal(response.statusCode, 200);
  const data = parsed(response);
  assert.equal(data.action, null);
  assert.match(data.erreur, /comment_id manquant/i);
});

test('webhook-comment: aucune intention detectee -> aucune tache creee', async () => {
  const response = await webhookComment.handler(event({
    commentaire: 'belle video, merci !',
    plateforme: 'instagram',
    identifiant_auteur: 'user-3',
    comment_id: 'comment-xyz',
  }));
  assert.equal(response.statusCode, 200);
  const data = parsed(response);
  assert.equal(data.action, null);
});

test('webhook-comment: idempotence - le meme commentaire renvoye deux fois n est traite qu une seule fois', async () => {
  const payload = {
    commentaire: 'GUIDE svp',
    plateforme: 'tiktok',
    identifiant_auteur: 'user-4',
    comment_id: 'comment-dup-1',
    idempotency_key: 'dup-key-1',
  };
  const first = await webhookComment.handler(event(payload));
  assert.equal(parsed(first).deja_traite, false);

  const second = await webhookComment.handler(event(payload));
  const secondData = parsed(second);
  assert.equal(secondData.deja_traite, true);
  assert.equal(secondData.action, null);
});

test('webhook-comment: refuse sans cle API', async () => {
  const response = await webhookComment.handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ commentaire: 'GUIDE', plateforme: 'tiktok', comment_id: 'x' }),
  });
  assert.equal(response.statusCode, 401);
});
