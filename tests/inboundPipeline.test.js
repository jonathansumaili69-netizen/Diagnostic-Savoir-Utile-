'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-inbound-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
process.env.CONQUISTADOR_API_KEY = 'inbound-test-key';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.CONTEXT;

const memory = require('../src/core/memory');
const operationalState = require('../src/core/operationalState');
const approval = require('../src/core/approval');
const taskEngine = require('../src/core/taskEngine');
const inbound = require('../src/core/inboundPipeline');
const idempotency = require('../src/core/idempotency');

function dmEvent(senderId, mid, text) {
  return {
    object: 'instagram',
    entry: [{
      id: 'ig-business-1',
      time: 1000,
      messaging: [{
        sender: { id: senderId },
        recipient: { id: 'ig-business-1' },
        timestamp: 1001,
        message: { mid, text },
      }],
    }],
  };
}

test('inbound DM: contact cree, analyse faite, reponse preparee, action bloquee en Silencio', async () => {
  const res = await inbound.processMetaWebhookEvent(
    dmEvent('user-silencio', 'mid-sil-1', 'Bonjour, je veux des infos sur le guide'),
    'evt-dm-silencio',
  );
  assert.equal(res.total, 1);
  assert.equal(res.results[0].traite, true);
  assert.equal(res.results[0].plateforme, 'instagram');

  const contacts = await memory.list(memory.COLLECTIONS.CONTACTS, {
    filter: (d) => d.identifiant === 'instagram:user-silencio',
  });
  assert.equal(contacts.length, 1, 'un seul contact cree pour cet utilisateur');

  const send = res.results[0].send_task_id ? await taskEngine.getTask(res.results[0].send_task_id) : null;
  assert.ok(send, 'une tache system.send_message doit etre creee (proposition Copilot)');
  assert.equal(send.data.status, 'blocked', 'en mode Silencio aucune action externe ne part');
});

test('inbound DM: idempotence stricte, un doublon ne cree rien de nouveau', async () => {
  const evt = dmEvent('user-silencio', 'mid-sil-1', 'Bonjour, je veux des infos sur le guide');
  const again = await inbound.processMetaWebhookEvent(evt, 'evt-dm-silencio-bis');
  assert.equal(again.results[0].traite, false);
  assert.equal(again.results[0].raison, 'doublon');
  const contacts = await memory.list(memory.COLLECTIONS.CONTACTS, {
    filter: (d) => d.identifiant === 'instagram:user-silencio',
  });
  assert.equal(contacts.length, 1, 'aucun doublon de contact');
});

test('inbound DM: mode Copilot produit une proposition en attente d approbation', async () => {
  await operationalState.setSettings({ mode: 'copilot' }, { actor: 'test' });
  const res = await inbound.processMetaWebhookEvent(
    dmEvent('user-copilot', 'mid-cop-1', 'Quel est le prix du guide ?'),
    'evt-dm-copilot',
  );
  const send = await taskEngine.getTask(res.results[0].send_task_id);
  assert.equal(send.data.status, 'waiting_approval');
  const pending = await approval.pending();
  const mine = pending.find((row) => row.data.taskId === send.id);
  assert.ok(mine, 'une approbation Copilot visible doit exister pour la tache');

  // Approbation -> reprise reelle -> sans connecteur, NON_EXECUTE honnete.
  await approval.decide(mine.id, { approve: true, decidedBy: 'test' });
  const resumed = await taskEngine.resumeAfterApproval(send.id, mine.id);
  assert.equal(resumed.data.status, 'done');
  assert.equal(resumed.data.result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION',
    'approved ne signifie pas envoye : sans connecteur reel, pas de faux succes');
});

test('inbound DM: mode Conquistador execute sans approbation, mais jamais de faux succes', async () => {
  await operationalState.setSettings({ mode: 'conquistador' }, { actor: 'test' });
  const res = await inbound.processMetaWebhookEvent(
    dmEvent('user-conq', 'mid-conq-1', 'Je suis interesse par le guide'),
    'evt-dm-conq',
  );
  const send = await taskEngine.getTask(res.results[0].send_task_id);
  assert.equal(send.data.status, 'done', 'mode Conquistador : pas d attente d approbation');
  assert.equal(send.data.result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION',
    'sans connecteur Instagram actif, le systeme ne pretend pas avoir envoye');
  await operationalState.setSettings({ mode: 'silencio' }, { actor: 'test' });
});

test('inbound commentaire: intention detectee -> reponse au commentaire (pas une publication)', async () => {
  const evt = {
    object: 'instagram',
    entry: [{
      id: 'ig-business-1',
      time: 2000,
      changes: [{
        field: 'comments',
        value: {
          id: 'comment-1',
          text: 'je veux le guide, combien ca coute ?',
          from: { id: 'commenter-9', username: 'fatou' },
          media: { id: 'media-1' },
        },
      }],
    }],
  };
  const res = await inbound.processMetaWebhookEvent(evt, 'evt-comment-1');
  assert.equal(res.results[0].traite, true);
  assert.equal(res.results[0].intention_achat_detectee, true);
  assert.equal(res.results[0].action_type, 'system.reply_comment',
    'sans connecteur DM, la reponse publique doit utiliser le vrai mecanisme de reponse aux commentaires');
  const action = await taskEngine.getTask(res.results[0].action_task_id);
  assert.equal(action.data.input.comment_id, 'comment-1');
});

test('inbound: les echos (messages du compte pro) sont ignores', async () => {
  const echo = {
    object: 'instagram',
    entry: [{
      id: 'ig-business-1',
      time: 3000,
      messaging: [{
        sender: { id: 'ig-business-1' },
        recipient: { id: 'user-x' },
        timestamp: 3001,
        message: { mid: 'mid-echo', text: 'reponse du compte pro', is_echo: true },
      }],
    }],
  };
  const res = await inbound.processMetaWebhookEvent(echo, 'evt-echo-1');
  assert.equal(res.total, 0);
});

test('inbound: commentaire sans intention d achat ne cree aucune action', async () => {
  const evt = {
    object: 'instagram',
    entry: [{
      id: 'ig-business-1',
      time: 4000,
      changes: [{
        field: 'comments',
        value: { id: 'comment-2', text: 'super video, bravo !', from: { id: 'fan-1', username: 'fan' } },
      }],
    }],
  };
  const res = await inbound.processMetaWebhookEvent(evt, 'evt-comment-2');
  assert.equal(res.results[0].traite, true);
  assert.equal(res.results[0].intention_achat_detectee, false);
  assert.equal(res.results[0].action_task_id, null);
});

test('inbound: A reussit / B echoue dans le meme lot -> retry retraite B mais jamais A a nouveau (bug idempotence corrige)', async () => {
  const evtA = dmEvent('user-ab-a', 'mid-ab-a', 'Bonjour, evenement A');
  const evtB = dmEvent('user-ab-b', 'mid-ab-b', 'Bonjour, evenement B');

  const resA = await inbound.processMetaWebhookEvent(evtA, 'evt-ab-a-1');
  assert.equal(resA.results[0].traite, true, 'A doit reussir normalement');

  // Panne simulee uniquement pour l'agent commercial.analyze_intent (celui
  // declenche par l'evenement B), sans toucher aux autres taches.
  const originalRunTask = taskEngine.runTask;
  taskEngine.runTask = async (id, opts) => {
    const task = await taskEngine.getTask(id);
    if (task && task.data.input && task.data.input.message === 'Bonjour, evenement B' && task.data.type === 'commercial.analyze_intent') {
      throw new Error('panne simulee pour B');
    }
    return originalRunTask(id, opts);
  };
  let resB1;
  try {
    resB1 = await inbound.processMetaWebhookEvent(evtB, 'evt-ab-b-1');
  } finally {
    taskEngine.runTask = originalRunTask;
  }
  assert.equal(resB1.results[0].traite, false, 'B doit echouer au premier essai');
  assert.notEqual(resB1.results[0].raison, 'doublon', 'B echoue reellement, ce n est pas un doublon');

  // Retry Meta du meme evenement B (meme eventKey applicatif) : doit etre
  // retraite, jamais bloque comme "deja traite" par l'echec precedent.
  const resB2 = await inbound.processMetaWebhookEvent(evtB, 'evt-ab-b-2');
  assert.equal(resB2.results[0].traite, true, 'B recuperable doit etre retraite au retry (c\'est exactement le bug corrige)');

  // A, deja reussi au premier essai, reste ignore comme doublon au "retry".
  const resA2 = await inbound.processMetaWebhookEvent(evtA, 'evt-ab-a-2');
  assert.equal(resA2.results[0].traite, false);
  assert.equal(resA2.results[0].raison, 'doublon', 'A deja termine ne doit jamais etre retraite deux fois');
});
