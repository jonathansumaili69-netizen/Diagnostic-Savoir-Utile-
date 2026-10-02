'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-taskengine-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.APPROVAL_POLICY_OVERRIDE;

const taskEngine = require('../src/core/taskEngine');
const approval = require('../src/core/approval');
const memory = require('../src/core/memory');
const operationalState = require('../src/core/operationalState');
const killswitch = require('../src/core/killswitch');

test('createTask valide le type et initialise le statut a pending', async () => {
  const task = await taskEngine.createTask({ type: 'quality.review', input: { content: {} } });
  assert.equal(task.data.status, 'pending');
  assert.equal(task.data.type, 'quality.review');
  assert.equal(task.data.priority, 'normale');
  assert.ok(Array.isArray(task.data.history) && task.data.history.length === 1);
});

test('createTask rejette un type de tache inconnu', async () => {
  await assert.rejects(() => taskEngine.createTask({ type: 'domaine_inexistant.action' }));
});

test('createTask retombe sur la priorite "normale" si la valeur est invalide', async () => {
  const task = await taskEngine.createTask({ type: 'quality.review', input: {}, priority: 'ultra-mega' });
  assert.equal(task.data.priority, 'normale');
});

test('runTask: une action AUTO (quality.review) s\'execute jusqu\'au bout', async () => {
  const task = await taskEngine.createTask({
    type: 'quality.review',
    input: { content: { script: 'texte', cta: 'lien' } },
  });
  const done = await taskEngine.runTask(task.id);
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.error, null);
  assert.ok(done.data.result);
  assert.equal(done.data.result.type, 'quality.review');
});

test('runTask: le mode Silencio bloque une action externe automatique', async () => {
  const task = await taskEngine.createTask({
    type: 'system.publish_post',
    input: { plateforme: 'tiktok', contenu: 'publication automatique de test' },
    declencheur: 'scheduled',
  });
  const blocked = await taskEngine.runTask(task.id);
  assert.equal(blocked.data.status, 'blocked');
  assert.match(blocked.data.error, /Mode Silencio actif/);
});

test('runTask: le mode Silencio bloque aussi une reponse a un commentaire (REPLY_COMMENT) declenchee par un webhook', async () => {
  // AUDIT : REPLY_COMMENT manquait de l'ensemble automaticExternalActions
  // dans taskEngine.js, donc une reponse de commentaire issue d'un webhook
  // n'etait jamais bloquee explicitement en mode Silencio (elle finissait
  // en waiting_approval au lieu de blocked). Corrige : meme comportement que
  // SEND_MESSAGE / PUBLISH_POST.
  const task = await taskEngine.createTask({
    type: 'system.reply_comment',
    input: { plateforme: 'instagram', comment_id: 'c123', message: 'reponse de test' },
    declencheur: 'webhook',
  });
  const blocked = await taskEngine.runTask(task.id);
  assert.equal(blocked.data.status, 'blocked');
  assert.match(blocked.data.error, /Mode Silencio actif/);
});

test('runTask: le mode Conquistador auto-approuve une reponse a un commentaire declenchee par un evenement entrant reel', async () => {
  await operationalState.setSettings({ mode: 'conquistador' });
  const task = await taskEngine.createTask({
    type: 'system.reply_comment',
    input: { plateforme: 'instagram', comment_id: 'c456', message: 'reponse autonome de test' },
    declencheur: 'webhook',
  });
  const done = await taskEngine.runTask(task.id);
  // Sans connecteur reel configure dans les tests, l'action est honnetement
  // NON_EXECUTE_AUCUNE_CONNEXION, mais elle ne doit JAMAIS rester bloquee en
  // attente d'approbation humaine puisque le mode Conquistador l'auto-approuve.
  assert.equal(done.data.status, 'done');
  assert.ok(done.data.approvalId);
  const approvalRecord = await memory.get(memory.COLLECTIONS.APPROVALS, done.data.approvalId);
  assert.equal(approvalRecord.data.status, 'approved');
  assert.equal(approvalRecord.data.decidedBy, 'mode_conquistador');
  assert.equal(done.data.result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION');
  await operationalState.setSettings({ mode: 'silencio' });
});

test('runTask: le kill switch bloque une reponse a un commentaire (REPLY_COMMENT) meme en mode Conquistador (audit priorite kill switch)', async () => {
  // Regression : REPLY_COMMENT manquait de killswitch.EXTERNAL_ACTION_TYPES,
  // donc meme kill switch engage, ce chemin (webhook -> mode Conquistador ->
  // auto-approbation) allait jusqu'a l'execution reelle sans jamais etre
  // intercepte par le kill switch. Voir src/core/killswitch.js.
  await operationalState.setSettings({ mode: 'conquistador' });
  await killswitch.setStatus({ engage: true, raison: 'test priorite kill switch sur REPLY_COMMENT' });

  const task = await taskEngine.createTask({
    type: 'system.reply_comment',
    input: { plateforme: 'instagram', comment_id: 'c789', message: 'reponse qui doit etre bloquee' },
    declencheur: 'webhook',
  });
  const blocked = await taskEngine.runTask(task.id);
  assert.equal(blocked.data.status, 'blocked');
  assert.match(blocked.data.error, /kill switch/i);

  await killswitch.setStatus({ engage: false, raison: 'fin du test', confirmation: true });
  await operationalState.setSettings({ mode: 'silencio' });
});

test('runTask: une campagne est bloquee sans mode Conquistador explicitement active', async () => {
  const task = await taskEngine.createTask({
    type: 'system.publish_post',
    input: { plateforme: 'tiktok', contenu: 'campagne de test' },
    declencheur: 'campaign',
  });
  const blocked = await taskEngine.runTask(task.id);
  assert.equal(blocked.data.status, 'blocked');
  assert.match(blocked.data.error, /Campagne automatique bloquée/);
});

test('runTask: campagne Conquistador valide mais approbation humaine toujours obligatoire', async () => {
  await operationalState.setSettings({
    mode: 'conquistador',
    campaign: { enabled: true, max_publications_per_day: 1, allowed_platforms: ['tiktok'] },
  });
  const task = await taskEngine.createTask({
    type: 'system.publish_post',
    input: { plateforme: 'tiktok', contenu: 'campagne valide de test' },
    declencheur: 'campaign',
  });
  const waiting = await taskEngine.runTask(task.id);
  assert.equal(waiting.data.status, 'waiting_approval');
  assert.ok(waiting.data.approvalId);
  const request = await memory.get(memory.COLLECTIONS.APPROVALS, waiting.data.approvalId);
  assert.equal(request.data.status, 'pending');
  assert.equal(request.data.actionType, 'PUBLISH_POST');
});

test('runTask: campagne Conquistador avec requires_approval=false s\'execute sans attendre une approbation humaine', async () => {
  const settings = await operationalState.setSettings({
    mode: 'conquistador',
    campaign: { enabled: true, requires_approval: false, max_publications_per_day: 5, allowed_platforms: ['tiktok'], quality_min_score: 85 },
  });
  assert.equal(settings.campaign.requires_approval, false);
  assert.equal(settings.autonomy_active, true);

  const task = await taskEngine.createTask({
    type: 'system.publish_post',
    input: { plateforme: 'tiktok', contenu: 'campagne autonome de test' },
    declencheur: 'campaign',
  });
  const done = await taskEngine.runTask(task.id);
  // Aucune connexion reelle n'est configuree en test : l'action va bien
  // jusqu'au bout du moteur (pas de blocage sur l'approbation) mais
  // systemActions.publishPost refuse honnetement de publier sans connecteur.
  assert.equal(done.data.status, 'done');
  assert.notEqual(done.data.status, 'waiting_approval');
  assert.equal(done.data.result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION');

  const approvalRecord = await memory.get(memory.COLLECTIONS.APPROVALS, done.data.approvalId);
  assert.equal(approvalRecord.data.status, 'approved');
  assert.equal(approvalRecord.data.decidedBy, 'campagne_autonome');
  assert.equal(approvalRecord.data.actionType, 'PUBLISH_POST');

  await operationalState.setSettings({ mode: 'silencio', campaign: { enabled: false } });
});

test('runTask: le kill switch bloque une campagne autonome meme approbation desactivee', async () => {
  await operationalState.setSettings({
    mode: 'conquistador',
    campaign: { enabled: true, requires_approval: false, max_publications_per_day: 5, allowed_platforms: ['tiktok'] },
  });
  await killswitch.setStatus({ engage: true, raison: 'test securite' });

  const task = await taskEngine.createTask({
    type: 'system.publish_post',
    input: { plateforme: 'tiktok', contenu: 'campagne autonome bloquee par kill switch' },
    declencheur: 'campaign',
  });
  const blocked = await taskEngine.runTask(task.id);
  assert.equal(blocked.data.status, 'blocked');
  assert.match(blocked.data.error, /kill switch/i);

  await killswitch.setStatus({ engage: false, raison: 'fin du test', confirmation: true });
  await operationalState.setSettings({ mode: 'silencio', campaign: { enabled: false } });
});

test('taskEngine.deriveExecutionResult : distingue le statut de sortie reel par type d’action externe', () => {
  // AUDIT Phase 2 : "tache done" != "action reussie". Ce test verifie
  // directement la table de correspondance sans passer par un connecteur.
  assert.equal(taskEngine.deriveExecutionResult('PUBLISH_POST', { output: { statut: 'PUBLIE' } }), 'succes');
  assert.equal(taskEngine.deriveExecutionResult('PUBLISH_POST', { output: { statut: 'EN_TRAITEMENT' } }), 'succes');
  assert.equal(taskEngine.deriveExecutionResult('PUBLISH_POST', { output: { statut: 'ECHEC' } }), 'non_execute');
  assert.equal(taskEngine.deriveExecutionResult('PUBLISH_POST', { output: { statut: 'NON_EXECUTE_AUCUNE_CONNEXION' } }), 'non_execute');
  assert.equal(taskEngine.deriveExecutionResult('SEND_MESSAGE', { output: { statut: 'ENVOYE' } }), 'succes');
  assert.equal(taskEngine.deriveExecutionResult('SEND_MESSAGE', { output: { statut: 'NON_EXECUTE_AUCUNE_CONNEXION' } }), 'non_execute');
  assert.equal(taskEngine.deriveExecutionResult('REPLY_COMMENT', { output: { statut: 'ENVOYE' } }), 'succes');
  assert.equal(taskEngine.deriveExecutionResult('UPDATE_DATA', { output: { statut: 'MIS_A_JOUR' } }), 'succes');
  assert.equal(taskEngine.deriveExecutionResult('UPDATE_DATA', { output: { statut: 'NON_EXECUTE_AUCUNE_CONNEXION' } }), 'non_execute');
  // Action non externe (pas de notion de confirmation) : succes tant que
  // l'agent n'a pas leve d'exception, quel que soit le statut de sortie.
  assert.equal(taskEngine.deriveExecutionResult('ANALYZE', { output: { statut: 'AUTRE_CHOSE' } }), 'succes');
  assert.equal(taskEngine.deriveExecutionResult('ANALYZE', {}), 'succes');
});

test('runTask: une tache "done" sans connecteur reste honnetement resultat=non_execute dans le journal (tache terminee != action reussie)', async () => {
  // Regression du bug de fond : avant le correctif, memory.recordExecution
  // perdait statut_sortie a l'ecriture ET taskEngine.js journalisait
  // toujours resultat:'succes' pour toute tache 'done', meme quand l'action
  // externe reelle etait NON_EXECUTE_AUCUNE_CONNEXION.
  await operationalState.setSettings({
    mode: 'conquistador',
    campaign: { enabled: true, requires_approval: false, max_publications_per_day: 5, allowed_platforms: ['tiktok'] },
  });
  const task = await taskEngine.createTask({
    type: 'system.publish_post',
    input: { plateforme: 'tiktok', contenu: 'verification resultat honnete' },
    declencheur: 'campaign',
  });
  const done = await taskEngine.runTask(task.id);
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION');

  const executions = await memory.list(memory.COLLECTIONS.EXECUTIONS, { limit: 20 });
  const own = executions.find((row) => row.data.workflow === 'system.publish_post' && row.data.statut_sortie === 'NON_EXECUTE_AUCUNE_CONNEXION');
  assert.ok(own, 'une execution avec ce statut_sortie doit exister dans le journal');
  assert.equal(own.data.resultat, 'non_execute', 'une tache "done" sans confirmation reelle ne doit jamais journaliser resultat=succes');

  await operationalState.setSettings({ mode: 'silencio', campaign: { enabled: false } });
});

test('runTask: mode Copilot + REPLY_COMMENT declenchee par webhook -> attente d’approbation (ni bloque, ni auto-approuve)', async () => {
  // Complete la couverture Phase 3 (modes) : Silencio-bloque et
  // Conquistador-auto-approuve etaient deja testes pour REPLY_COMMENT
  // (voir plus haut) ; il manquait le cas Copilot, qui ne doit ni bloquer
  // ni auto-approuver - juste attendre une decision humaine, comme
  // n'importe quelle autre action APPROVAL_REQUIRED.
  await operationalState.setSettings({ mode: 'copilot' });
  const task = await taskEngine.createTask({
    type: 'system.reply_comment',
    input: { plateforme: 'instagram', comment_id: 'c-copilot-1', message: 'reponse en attente copilot' },
    declencheur: 'webhook',
  });
  const waiting = await taskEngine.runTask(task.id);
  assert.equal(waiting.data.status, 'waiting_approval');
  assert.ok(waiting.data.approvalId);
  const approvalRecord = await memory.get(memory.COLLECTIONS.APPROVALS, waiting.data.approvalId);
  assert.equal(approvalRecord.data.status, 'pending');
  assert.equal(approvalRecord.data.actionType, 'REPLY_COMMENT');
  assert.notEqual(approvalRecord.data.decidedBy, 'mode_conquistador');

  await operationalState.setSettings({ mode: 'silencio' });
});

test('runTask: une action APPROVAL_REQUIRED (system.send_message) s\'arrete en attente', async () => {
  const task = await taskEngine.createTask({
    type: 'system.send_message',
    input: { canal: 'whatsapp', destinataire: 'x', message: 'salut' },
  });
  const waiting = await taskEngine.runTask(task.id);
  assert.equal(waiting.data.status, 'waiting_approval');
  assert.ok(waiting.data.approvalId);

  const approvalRecord = await memory.get(memory.COLLECTIONS.APPROVALS, waiting.data.approvalId);
  assert.equal(approvalRecord.data.status, 'pending');
  assert.equal(approvalRecord.data.actionType, 'SEND_MESSAGE');
});

test('resumeAfterApproval: execute reellement la tache apres approbation humaine', async () => {
  const task = await taskEngine.createTask({
    type: 'system.publish_post',
    input: { plateforme: 'tiktok', contenu: 'post de test' },
  });
  const waiting = await taskEngine.runTask(task.id);
  assert.equal(waiting.data.status, 'waiting_approval');

  await approval.decide(waiting.data.approvalId, { approve: true, decidedBy: 'test' });
  const resumed = await taskEngine.resumeAfterApproval(task.id);

  assert.equal(resumed.data.status, 'done');
  assert.equal(resumed.data.result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION');
});

test('markRejected: place la tache en statut rejected', async () => {
  const task = await taskEngine.createTask({
    type: 'system.send_message',
    input: { canal: 'whatsapp', destinataire: 'x', message: 'salut' },
  });
  await taskEngine.runTask(task.id);
  const rejected = await taskEngine.markRejected(task.id, 'non pertinent');
  assert.equal(rejected.data.status, 'rejected');
});

test('runTask: une erreur reelle dans l\'agent est capturee proprement (jamais de crash silencieux)', async () => {
  const task = await taskEngine.createTask({
    type: 'client.upsert_contact',
    input: {}, // sans identifiant -> l'agent doit lever une erreur
  });
  const failed = await taskEngine.runTask(task.id);
  assert.equal(failed.data.status, 'error');
  assert.ok(failed.data.error && failed.data.error.includes('identifiant'));

  const errors = await memory.list(memory.COLLECTIONS.ERRORS);
  assert.ok(errors.some((e) => e.data.context && e.data.context.taskId === task.id));
});

test('runTask: est idempotent sur une tache deja terminee', async () => {
  const task = await taskEngine.createTask({ type: 'quality.review', input: { content: {} } });
  const first = await taskEngine.runTask(task.id);
  const second = await taskEngine.runTask(task.id);
  assert.equal(first.data.result === undefined, false);
  assert.deepEqual(first.data.result, second.data.result);
});

test('listTasks et getTask retrouvent bien les taches creees', async () => {
  const task = await taskEngine.createTask({ type: 'quality.review', input: {} });
  const fetched = await taskEngine.getTask(task.id);
  assert.equal(fetched.id, task.id);
  const list = await taskEngine.listTasks({ limit: 5 });
  assert.ok(list.length > 0);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
