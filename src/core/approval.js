'use strict';

const { config, int } = require('./config');
const memory = require('./memory');
const { logger } = require('./logger');

/**
 * Politique d'approbation humaine (section 13 du prompt maitre).
 * Niveau choisi par l'utilisateur pour la V1 : EQUILIBRE.
 *   - analyses / idees / rapports        -> AUTO
 *   - preparation de reponse client/post -> AUTO (uniquement la preparation)
 *   - envoi d'une reponse / publication  -> APPROVAL_REQUIRED
 *   - suppression                        -> APPROVAL_REQUIRED
 *   - action commerciale sensible        -> APPROVAL_REQUIRED
 */

const AUTO = 'AUTO';
const APPROVAL_REQUIRED = 'APPROVAL_REQUIRED';

// Section 15 (boost pass) : une approbation en attente trop longtemps ne
// doit plus pouvoir etre validee sans re-verification (le contexte a pu
// changer). Configurable, 72h par defaut. Utilise le helper int() partage
// (config.js) plutot que "parseInt(...) || 72" pour ne pas ignorer
// silencieusement une valeur explicite de 0.
const EXPIRY_HOURS = int(process.env.APPROVAL_EXPIRY_HOURS, 72);

const DEFAULT_POLICY = {
  ANALYZE: AUTO,
  GENERATE: AUTO,
  GENERATE_IDEA: AUTO,
  GENERATE_REPORT: AUTO,
  UPDATE_MEMORY: AUTO,
  PREPARE_RESPONSE: AUTO,
  PREPARE_POST: AUTO,
  NOTIFY: AUTO,
  SEND_MESSAGE: APPROVAL_REQUIRED,
  REPLY_COMMENT: APPROVAL_REQUIRED,
  PUBLISH_POST: APPROVAL_REQUIRED,
  UPDATE_DATA: APPROVAL_REQUIRED,
  DELETE: APPROVAL_REQUIRED,
  COMMERCIAL_SENSITIVE: APPROVAL_REQUIRED,
};

function levelFor(actionType) {
  const override = config.approval.override || {};
  if (override[actionType]) return override[actionType];
  if (DEFAULT_POLICY[actionType]) return DEFAULT_POLICY[actionType];
  // Par prudence, toute action inconnue non explicitement classee AUTO est
  // soumise a approbation (section 13 : ne jamais pretendre qu'une action a
  // ete effectuee sans verification humaine quand le doute existe).
  logger.warn('approval: type d\'action non catalogue, approbation requise par defaut', {
    actionType,
  });
  return APPROVAL_REQUIRED;
}

/**
 * Enregistre une demande d'approbation en attente et renvoie son statut.
 * Si le niveau est AUTO, l'action est marquee "approuvee automatiquement"
 * et peut etre executee immediatement par l'appelant.
 */
async function requestApproval({ actionType, taskId, agent, summary, payload }) {
  const level = levelFor(actionType);
  const now = new Date();
  const expiresAt = level === APPROVAL_REQUIRED ? new Date(now.getTime() + EXPIRY_HOURS * 3600 * 1000).toISOString() : null;
  const record = await memory.insert(memory.COLLECTIONS.APPROVALS, {
    actionType,
    taskId: taskId || null,
    agent: agent || null,
    summary: summary || '',
    payload: payload || {},
    level,
    status: level === AUTO ? 'auto_approved' : 'pending',
    decidedBy: level === AUTO ? 'system' : null,
    decidedAt: level === AUTO ? now.toISOString() : null,
    expiresAt,
  });
  return record;
}

/**
 * Auto-approbation d'une action de campagne autonome (mode Conquistador,
 * campagne activee, approbation humaine explicitement desactivee par
 * l'utilisateur dans les parametres - voir operationalState.js et
 * taskEngine.js). Contrairement a requestApproval() en niveau AUTO, le
 * niveau reel de l'action reste APPROVAL_REQUIRED : c'est la politique de
 * campagne, et non la nature de l'action, qui justifie l'execution
 * immediate. Cette distinction reste visible dans le journal d'approbations
 * pour l'auditabilite (cahier des charges section "journal de toutes les
 * actions").
 */
async function recordCampaignAutoApproval({ actionType, taskId, agent, summary, payload, reason }) {
  const now = new Date();
  return memory.insert(memory.COLLECTIONS.APPROVALS, {
    actionType,
    taskId: taskId || null,
    agent: agent || null,
    summary: summary || '',
    payload: payload || {},
    level: APPROVAL_REQUIRED,
    status: 'approved',
    decidedBy: 'campagne_autonome',
    decidedAt: now.toISOString(),
    note: reason || 'Auto-approuvee par la politique de campagne autonome (mode Conquistador).',
    expiresAt: null,
  });
}

/**
 * Auto-approbation d'une action declenchee par un evenement entrant reel
 * (webhook DM/commentaire) lorsque le mode Conquistador est actif. Comme
 * recordCampaignAutoApproval, le niveau reel de l'action reste
 * APPROVAL_REQUIRED : c'est le mode operationnel, pas la nature de l'action,
 * qui justifie l'execution immediate. Journalise pour l'auditabilite.
 */
async function recordEventAutoApproval({ actionType, taskId, agent, summary, payload, reason }) {
  const now = new Date();
  return memory.insert(memory.COLLECTIONS.APPROVALS, {
    actionType,
    taskId: taskId || null,
    agent: agent || null,
    summary: summary || '',
    payload: payload || {},
    level: APPROVAL_REQUIRED,
    status: 'approved',
    decidedBy: 'mode_conquistador',
    decidedAt: now.toISOString(),
    note: reason || 'Auto-approuvee car le mode Conquistador est actif pour un evenement entrant.',
    expiresAt: null,
  });
}

function isExpired(record) {
  return Boolean(record.data.expiresAt) && record.data.status === 'pending' && new Date(record.data.expiresAt) < new Date();
}

async function decide(id, { approve, decidedBy, note }) {
  const existing = await memory.get(memory.COLLECTIONS.APPROVALS, id);
  if (!existing) return null;
  if (existing.data.status !== 'pending') return existing;

  if (isExpired(existing)) {
    logger.warn('approval: tentative de decision sur une approbation expiree, refusee', { id, expiresAt: existing.data.expiresAt });
    return memory.updateIf(memory.COLLECTIONS.APPROVALS, id, { status: 'pending' }, {
      status: 'expired',
      note: 'Approbation expiree avant toute decision : re-creer la tache pour une nouvelle demande.',
    });
  }

  return memory.updateIf(memory.COLLECTIONS.APPROVALS, id, { status: 'pending' }, {
    status: approve ? 'approved' : 'rejected',
    decidedBy: decidedBy || 'utilisateur',
    decidedAt: new Date().toISOString(),
    note: note || null,
  });
}

/**
 * Renvoie les approbations en attente. Fait expirer paresseusement (lazy)
 * toute approbation pending dont le delai est depasse, sans necessiter de
 * tache planifiee dediee - coherent avec l'architecture serverless.
 */
async function pending() {
  const rows = await memory.list(memory.COLLECTIONS.APPROVALS, {
    filter: (data) => data.status === 'pending',
  });
  const stillPending = [];
  for (const row of rows) {
    if (isExpired(row)) {
      await memory.update(memory.COLLECTIONS.APPROVALS, row.id, {
        status: 'expired',
        note: 'Expiree automatiquement (delai depasse sans decision).',
      });
    } else {
      stillPending.push(row);
    }
  }
  return stillPending;
}

module.exports = {
  AUTO,
  APPROVAL_REQUIRED,
  levelFor,
  requestApproval,
  recordCampaignAutoApproval,
  recordEventAutoApproval,
  decide,
  pending,
  isExpired,
  EXPIRY_HOURS,
};
