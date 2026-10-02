'use strict';

const memory = require('./memory');
const approval = require('./approval');
const killswitch = require('./killswitch');
const { logger } = require('./logger');
const agents = require('../agents');
const operationalState = require('./operationalState');

const VALID_PRIORITIES = ['basse', 'normale', 'haute', 'urgente'];
const VALID_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'done',
  'error',
  'rejected',
  'blocked',
];

/**
 * AUDIT (tache "done" != action reussie) : une tache dont l'agent n'a pas
 * leve d'exception passe en statut 'done' - mais pour les quatre actions
 * EXTERNES (systemActions), "done" signifie seulement "le connecteur a ete
 * appele sans crash", PAS "l'action a reellement ete confirmee". Sans
 * connecteur configure, publishPost/sendMessage/replyComment/updateData
 * renvoient honnetement NON_EXECUTE_* (ou publishPost peut renvoyer ECHEC /
 * EN_TRAITEMENT selon le fournisseur) - et l'ancien code journalisait quand
 * meme `resultat: 'succes'` sans jamais regarder ce statut de sortie reel.
 * Consequence concrete : le journal d'execution (EXECUTIONS), utilise pour
 * les statistiques ("contenus_publies") et certains calculs de quota,
 * pouvait compter des actions jamais executees comme des succes.
 *
 * Cette table associe, PAR TYPE D'ACTION EXTERNE, l'ensemble des valeurs de
 * `output.output.statut` qui constituent une reussite reelle. Toute action
 * absente de cette table (analyses, generation de contenu, preparations...)
 * n'a pas de notion de confirmation externe : `resultat: 'succes'` garde
 * son sens historique ("l'agent a repondu sans erreur").
 */
const EXTERNAL_ACTION_SUCCESS_STATUTS = {
  PUBLISH_POST: new Set(['PUBLIE', 'EN_TRAITEMENT']),
  SEND_MESSAGE: new Set(['ENVOYE']),
  REPLY_COMMENT: new Set(['ENVOYE']),
  UPDATE_DATA: new Set(['MIS_A_JOUR']),
};

function deriveExecutionResult(actionType, output) {
  const successStatuts = EXTERNAL_ACTION_SUCCESS_STATUTS[actionType];
  if (!successStatuts) return 'succes'; // action non externe : pas de notion de confirmation.
  const statut = output && output.output && output.output.statut ? String(output.output.statut) : null;
  return statut && successStatuts.has(statut) ? 'succes' : 'non_execute';
}

function pushHistory(task, entry) {
  const history = Array.isArray(task.history) ? task.history : [];
  history.push({ at: new Date().toISOString(), ...entry });
  return history;
}

const taskLocks = new Map();

/**
 * Section 10 - MOTEUR DE TACHES : creation d'une tache avec statut, priorite,
 * date, et historique. Ne l'execute pas automatiquement : voir runTask().
 */
async function createTask({ type, input = {}, priority = 'normale', declencheur = 'manuel' }) {
  if (!type || typeof type !== 'string') {
    throw new Error('taskEngine.createTask: "type" est requis (format "domaine.sous_type")');
  }
  // Valide que le type est reconnu avant meme de creer la tache.
  agents.resolve(type);
  const finalPriority = VALID_PRIORITIES.includes(priority) ? priority : 'normale';

  const record = await memory.insert(memory.COLLECTIONS.TASKS, {
    type,
    input,
    priority: finalPriority,
    status: 'pending',
    declencheur,
    result: null,
    error: null,
    history: [{ at: new Date().toISOString(), event: 'task.created', status: 'pending' }],
  });

  await memory.recordEvent('task.created', { taskId: record.id, type, priority: finalPriority });
  return record;
}

async function getTask(id) {
  return memory.get(memory.COLLECTIONS.TASKS, id);
}

async function listTasks(options = {}) {
  return memory.list(memory.COLLECTIONS.TASKS, options);
}

/**
 * Execute une tache en suivant le pipeline complet :
 * EVENEMENT -> OBSERVATION -> ANALYSE -> RAISONNEMENT -> DECISION -> ACTION
 * -> VERIFICATION -> JOURNALISATION -> APPRENTISSAGE
 *
 * Si l'action requise necessite une approbation humaine (section 13) et que
 * `skipApprovalCheck` n'est pas active, la tache s'arrete au stade DECISION et
 * attend une decision humaine via approval-decide avant de pouvoir continuer.
 */
async function runTaskUnlocked(id, { skipApprovalCheck = false } = {}) {
  const startedAt = Date.now();
  let task = await getTask(id);
  if (!task) {
    throw new Error(`taskEngine.runTask: aucune tache trouvee pour l'id "${id}"`);
  }
  if (task.data.status === 'done') {
    return task; // idempotent : une tache terminee n'est pas rejouee.
  }
  if (!skipApprovalCheck && (task.data.status === 'waiting_approval' || task.data.status === 'running')) {
    return task;
  }

  // OBSERVATION : le contexte est deja disponible dans task.data.input.
  const { domain, subtype, module, actionType } = agents.resolve(task.data.type);

  // DECISION : en mode Silencio, aucune action externe automatique ne part.
  // Les analyses et préparations peuvent rester consultables, mais publication,
  // message, réponse à un commentaire et mise à jour externe sont bloqués
  // avant approbation ou connecteur.
  //
  // AUDIT : REPLY_COMMENT était absente de cet ensemble alors que
  // inboundPipeline.js et systemActions.js la documentent explicitement comme
  // suivant exactement les mêmes règles Copilot/Conquistador/Silencio que
  // SEND_MESSAGE et PUBLISH_POST. Conséquence concrète du bug : une réponse à
  // un commentaire déclenchée par un webhook ne pouvait JAMAIS être
  // auto-approuvée en mode Conquistador (elle restait bloquée en
  // waiting_approval quel que soit le mode), et ne bénéficiait pas du
  // blocage explicite dès le mode Silencio. DELETE reste volontairement
  // exclu : une suppression n'est jamais auto-exécutée, même en Conquistador.
  const automaticExternalActions = new Set(['SEND_MESSAGE', 'REPLY_COMMENT', 'PUBLISH_POST', 'UPDATE_DATA']);
  if (task.data.declencheur !== 'manuel' && task.data.declencheur !== 'campaign' && automaticExternalActions.has(actionType)) {
    const settings = await operationalState.getSettings();
    if (settings.mode === 'silencio') {
      const reason = 'Mode Silencio actif : aucune action externe automatique n’est exécutée.';
      const finalHistory = pushHistory(task.data, { event: 'task.blocked_mode', status: 'blocked', raison: reason });
      task = await memory.update(memory.COLLECTIONS.TASKS, id, {
        status: 'blocked',
        error: reason,
        history: finalHistory,
      });
      await memory.recordExecution({
        workflow: task.data.type,
        declencheur: task.data.declencheur,
        agent: domain,
        action: actionType,
        resultat: 'bloque_mode',
        duree_ms: Date.now() - startedAt,
      });
      return task;
    }
  }

  // DECISION : une tâche issue d’une campagne automatique n’est exécutable
  // que si le mode Conquistador a été explicitement activé côté serveur. Les
  // tâches manuelles et les préparations restent compatibles avec l’historique.
  if (task.data.declencheur === 'campaign') {
    const settings = await operationalState.getSettings();
    const platform = task.data.input && task.data.input.plateforme ? String(task.data.input.plateforme).toLowerCase() : null;
    const allowedPlatforms = settings.campaign?.allowed_platforms || [];
    const recentExecutions = await memory.list(memory.COLLECTIONS.EXECUTIONS, { limit: 200 });
    const todayCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const campaignCount = recentExecutions.filter((row) => {
      const at = row.created_at ? new Date(row.created_at).getTime() : 0;
      return row.data?.declencheur === 'campaign'
        && row.data?.action === 'PUBLISH_POST'
        && row.data?.resultat === 'succes'
        && row.data?.statut_sortie === 'PUBLIE'
        && at >= todayCutoff;
    }).length;
    const invalidCampaign = settings.mode !== 'conquistador'
      || settings.campaign?.enabled !== true
      || (platform && allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform))
      || Number(settings.campaign?.max_publications_per_day || 0) <= 0
      || campaignCount >= Number(settings.campaign?.max_publications_per_day || 0);
    if (invalidCampaign) {
      const reason = settings.mode !== 'conquistador' || settings.campaign?.enabled !== true
        ? 'Les campagnes automatiques exigent le mode Conquistador explicitement activé.'
        : platform && allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform)
          ? `La plateforme "${platform}" n’est pas autorisée dans la campagne.`
          : campaignCount >= Number(settings.campaign?.max_publications_per_day || 0)
            ? 'La limite quotidienne de campagne est atteinte.'
            : 'La campagne doit définir au moins une publication autorisée par jour.';
      const finalHistory = pushHistory(task.data, {
        event: 'task.blocked_mode',
        status: 'blocked',
        raison: reason,
      });
      task = await memory.update(memory.COLLECTIONS.TASKS, id, {
        status: 'blocked',
        error: `Campagne automatique bloquée : ${reason}`,
        history: finalHistory,
      });
      await memory.recordExecution({
        workflow: task.data.type,
        declencheur: task.data.declencheur,
        agent: domain,
        action: actionType,
        resultat: 'bloque_mode',
        duree_ms: Date.now() - startedAt,
      });
      return task;
    }
  }

  // DECISION : le niveau d'approbation determine si on continue vers ACTION.
  //
  // AUTONOMIE DE CAMPAGNE (cahier des charges "mode Conquistador - autonomie
  // reelle") : une tache 'campaign' qui a deja franchi la porte de validite
  // ci-dessus (mode=conquistador, campagne activee, plateforme autorisee,
  // quota disponible) peut sauter l'approbation humaine SI ET SEULEMENT SI
  // l'utilisateur a explicitement configure campaign.requires_approval=false.
  // Par defaut, rien ne change : meme une campagne valide continue d'attendre
  // une approbation humaine tant que ce reglage n'a pas ete change
  // volontairement. L'auto-approbation est integralement journalisee
  // (collection APPROVALS) pour rester auditable, et le kill switch ainsi
  // que le controle qualite video / la validite du connecteur (voir
  // systemActions.publishPost) restent verifies APRES ce point, sans aucune
  // exception. Ce mecanisme est complementaire au planificateur autonome
  // (netlify/functions/scheduler-tick.js) qui, lui, appelle systemActions
  // directement sans passer par une tache : les deux chemins appliquent les
  // memes garde-fous (kill switch, quota, horaires, score qualite).
  const level = approval.levelFor(actionType);
  // AUTONOMIE CONQUISTADOR - EVENEMENTS ENTRANTS (webhooks DM/commentaire) :
  // en mode conquistador, une action externe declenchee par un evenement reel
  // entrant (declencheur='webhook') est auto-approvee et integralement
  // journalisee. Le kill switch, la qualite video et la validite du
  // connecteur restent verifies APRES ce point, sans aucune exception. En
  // mode silencio, le blocage plus haut s'applique deja ; en mode copilot,
  // l'approbation humaine standard ci-dessous reste exigee.
  let autonomousEvent = false;
  if (level === approval.APPROVAL_REQUIRED && task.data.declencheur === 'webhook' && automaticExternalActions.has(actionType)) {
    const eventSettings = await operationalState.getSettings();
    autonomousEvent = eventSettings.mode === 'conquistador';
    if (autonomousEvent) {
      const approvalRecord = await approval.recordEventAutoApproval({
        actionType,
        taskId: task.id,
        agent: domain,
        summary: `Tache ${task.data.type} auto-approuvee : evenement entrant traite en mode Conquistador (revision ${eventSettings.revision ?? 'n/a'})`,
        payload: task.data.input,
        reason: `Auto-approuvee car mode=conquistador pour un evenement entrant (revision ${eventSettings.revision ?? 'n/a'}). Le kill switch et la validite du connecteur restent verifies avant toute execution reelle.`,
      });
      task = await memory.update(memory.COLLECTIONS.TASKS, id, {
        history: pushHistory(task.data, {
          event: 'task.auto_approved_event',
          status: 'approved',
          approvalId: approvalRecord.id,
          raison: 'Mode Conquistador actif : evenement entrant traite sans approbation humaine.',
        }),
        approvalId: approvalRecord.id,
      });
    }
  }
  let autonomousCampaign = false;
  if (level === approval.APPROVAL_REQUIRED && task.data.declencheur === 'campaign') {
    const campaignSettings = await operationalState.getSettings();
    autonomousCampaign = campaignSettings.mode === 'conquistador'
      && campaignSettings.campaign?.enabled === true
      && campaignSettings.campaign?.requires_approval === false;
    if (autonomousCampaign) {
      const approvalRecord = await approval.recordCampaignAutoApproval({
        actionType,
        taskId: task.id,
        agent: domain,
        summary: `Tache ${task.data.type} auto-approuvee : campagne autonome active en mode Conquistador (revision ${campaignSettings.revision ?? 'n/a'})`,
        payload: task.data.input,
        reason: `Auto-approuvee automatiquement car mode=conquistador, campagne.enabled=true et campagne.requires_approval=false (revision ${campaignSettings.revision ?? 'n/a'}). Le kill switch, le controle qualite video et la validite du connecteur restent verifies avant toute execution reelle.`,
      });
      task = await memory.update(memory.COLLECTIONS.TASKS, id, {
        history: pushHistory(task.data, {
          event: 'task.auto_approved_campaign',
          status: 'approved',
          approvalId: approvalRecord.id,
          raison: 'Campagne autonome active (mode Conquistador, approbation humaine desactivee explicitement dans les parametres).',
        }),
        approvalId: approvalRecord.id,
      });
    }
  }
  if (level === approval.APPROVAL_REQUIRED && !skipApprovalCheck && !autonomousCampaign && !autonomousEvent) {
    const approvalRecord = await approval.requestApproval({
      actionType,
      taskId: task.id,
      agent: domain,
      summary: `Tache ${task.data.type} en attente d'approbation avant execution`,
      payload: task.data.input,
    });
    const history = pushHistory(task.data, {
      event: 'task.waiting_approval',
      status: 'waiting_approval',
      approvalId: approvalRecord.id,
    });
    task = await memory.update(memory.COLLECTIONS.TASKS, id, {
      status: 'waiting_approval',
      history,
      approvalId: approvalRecord.id,
    });
    await memory.recordExecution({
      workflow: task.data.type,
      declencheur: task.data.declencheur,
      agent: domain,
      action: actionType,
      resultat: 'en_attente_approbation',
      duree_ms: Date.now() - startedAt,
    });
    return task;
  }

  // KILL SWITCH (section 13, boost pass) : verifie APRES la validation
  // d'approbation mais AVANT l'execution reelle, meme pour une action deja
  // approuvee - le mode securise doit pouvoir bloquer une action externe a
  // tout moment. Les analyses/preparations (non listees comme actions
  // externes) ne sont jamais concernees.
  if (await killswitch.isBlocked(actionType)) {
    const status = await killswitch.getStatus();
    const finalHistory = pushHistory(task.data, {
      event: 'task.blocked_kill_switch',
      status: 'blocked',
      raison: status.raison,
    });
    task = await memory.update(memory.COLLECTIONS.TASKS, id, {
      status: 'blocked',
      error: `Action bloquee par le kill switch (mode securise actif) : ${status.raison || 'aucune raison fournie'}`,
      history: finalHistory,
    });
    await memory.recordExecution({
      workflow: task.data.type,
      declencheur: task.data.declencheur,
      agent: domain,
      action: actionType,
      resultat: 'bloque_kill_switch',
      duree_ms: Date.now() - startedAt,
    });
    return task;
  }

  // ACTION : execution reelle de l'agent specialise.
  task = await memory.update(memory.COLLECTIONS.TASKS, id, {
    status: 'running',
    history: pushHistory(task.data, { event: 'task.started', status: 'running' }),
  });

  try {
    const output = await module.handle({ subtype, input: task.data.input });

    // VERIFICATION : verification minimale et honnete du resultat obtenu.
    const verification = verifyOutput(output);

    const finalHistory = pushHistory(task.data, {
      event: 'task.completed',
      status: 'done',
      verification,
    });

    task = await memory.update(memory.COLLECTIONS.TASKS, id, {
      status: 'done',
      result: output,
      error: null,
      history: finalHistory,
    });

    if (task.data.type === 'pipeline.video' && output && output.output && output.output.revue_video) {
      const pipelineInput = task.data.input && typeof task.data.input === 'object' ? task.data.input : {};
      await operationalState.saveVideoReview(output.output.revue_video, {
        taskId: id,
        contentKey: pipelineInput.content_key || pipelineInput.content_id || id,
        contentTitle: pipelineInput.titre || pipelineInput.title || pipelineInput.sujet || null,
      }).catch((err) => {
        logger.warn('taskEngine: revue video non persistee', { taskId: id, error: err.message });
      });
    }

    // JOURNALISATION (le fournisseur IA reellement utilise, s'il y en a un,
    // est extrait directement du resultat de l'agent - jamais suppose).
    const statutSortie = output && output.output && output.output.statut ? output.output.statut : null;
    const resultatReel = deriveExecutionResult(actionType, output);
    await memory.recordExecution({
      workflow: task.data.type,
      declencheur: task.data.declencheur,
      agent: domain,
      fournisseur_ia: output && output.provider ? output.provider : null,
      action: actionType,
      statut_sortie: statutSortie,
      resultat: resultatReel,
      duree_ms: Date.now() - startedAt,
    });
    await memory.recordEvent('task.completed', { taskId: id, type: task.data.type });


    // APPRENTISSAGE : donnees reelles et verifiables, jamais inventees.
    // succes reflete la meme distinction que resultatReel ci-dessus : une
    // action externe jamais confirmee (NON_EXECUTE_*, ECHEC...) n'est pas
    // un succes d'apprentissage, meme si l'agent n'a pas leve d'exception.
    await memory.insert(memory.COLLECTIONS.LEARNINGS, {
      taskId: id,
      type: task.data.type,
      provider: output.provider || null,
      succes: resultatReel === 'succes',
      duree_ms: Date.now() - startedAt,
      at: new Date().toISOString(),
    });

    return task;
  } catch (err) {
    logger.error('taskEngine.runTask: echec de la tache', { taskId: id, error: err.message });

    const finalHistory = pushHistory(task.data, {
      event: 'task.failed',
      status: 'error',
      error: err.message,
    });

    task = await memory.update(memory.COLLECTIONS.TASKS, id, {
      status: 'error',
      error: err.message,
      history: finalHistory,
    });

    await memory.recordError({ taskId: id, type: task.data.type }, err);
    await memory.recordExecution({
      workflow: task.data.type,
      declencheur: task.data.declencheur,
      agent: domain,
      action: actionType,
      resultat: 'erreur',
      duree_ms: Date.now() - startedAt,
      erreur: err.message,
    });
    await memory.insert(memory.COLLECTIONS.LEARNINGS, {
      taskId: id,
      type: task.data.type,
      succes: false,
      erreur: err.message,
      duree_ms: Date.now() - startedAt,
      at: new Date().toISOString(),
    });

    return task;
  }
}

async function runTask(id, options = {}) {
  const previous = taskLocks.get(id) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  taskLocks.set(id, turn);
  await previous;
  try {
    return await runTaskUnlocked(id, options);
  } finally {
    release();
    if (taskLocks.get(id) === turn) taskLocks.delete(id);
  }
}

function verifyOutput(output) {
  if (!output || typeof output !== 'object') {
    return { ok: false, raison: "L'agent n'a renvoye aucun resultat exploitable." };
  }
  if (output.output && output.output.parsed === false) {
    return { ok: true, avertissement: "La reponse IA n'etait pas un JSON strict, texte brut conserve." };
  }
  if (output.parsed && output.parsed.ok === false) {
    return { ok: true, avertissement: "La reponse IA n'a pas pu etre structuree en JSON, texte brut conserve dans le resultat." };
  }
  return { ok: true };
}

/**
 * Appelee par l'endpoint d'approbation apres une decision humaine positive :
 * relance runTask en ignorant le controle d'approbation (deja effectue).
 */
async function resumeAfterApproval(taskId, approvalId) {
  const task = await getTask(taskId);
  if (!task) {
    const err = new Error(`taskEngine.resumeAfterApproval: aucune tache trouvee pour l'id "${taskId}"`);
    err.statusCode = 404;
    throw err;
  }
  const resolvedApprovalId = approvalId || task.data.approvalId;
  const record = resolvedApprovalId
    ? await memory.get(memory.COLLECTIONS.APPROVALS, resolvedApprovalId)
    : null;
  if (!record || record.data.taskId !== taskId || record.data.status !== 'approved') {
    const err = new Error('La tache ne peut etre reprise que par une approbation approuvee et associee');
    err.statusCode = 409;
    throw err;
  }
  return runTask(taskId, { skipApprovalCheck: true });
}

async function markRejected(taskId, note) {
  const task = await getTask(taskId);
  if (!task) return null;
  const history = pushHistory(task.data, { event: 'task.rejected', status: 'rejected', note });
  return memory.update(memory.COLLECTIONS.TASKS, taskId, { status: 'rejected', history });
}

module.exports = {
  createTask,
  getTask,
  listTasks,
  runTask,
  resumeAfterApproval,
  markRejected,
  VALID_PRIORITIES,
  VALID_STATUSES,
  deriveExecutionResult,
};
