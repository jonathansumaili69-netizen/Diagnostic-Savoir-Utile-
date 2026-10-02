'use strict';

const memory = require('./memory');
const { logger } = require('./logger');

/**
 * KILL SWITCH (section 13 du prompt maitre V1.1 - boost pass) : mecanisme
 * de securite global. Lorsqu'il est active ("MODE SECURISE"), aucune
 * action EXTERNE irreversible (envoi de message, publication, mise a jour
 * de donnees externes, suppression) ne peut s'executer, meme si elle a ete
 * approuvee - seules les analyses et preparations continuent normalement.
 *
 * Persiste dans la collection DECISIONS existante (aucune nouvelle table
 * Supabase requise) : le dernier enregistrement de type "kill_switch" fait
 * foi. Une valeur par defaut peut aussi etre fixee via la variable
 * d'environnement KILL_SWITCH_DEFAULT (utile pour demarrer en mode
 * securise sur un nouvel environnement tant que la configuration n'est pas
 * finalisee).
 */

// AUDIT (bug critique - priorite du kill switch) : REPLY_COMMENT etait
// absent de cet ensemble alors que taskEngine.js (voir le commentaire a
// l'endroit ou automaticExternalActions est defini) traite explicitement
// REPLY_COMMENT comme une action externe automatique au meme titre que
// SEND_MESSAGE/PUBLISH_POST/UPDATE_DATA. Consequence concrete du bug :
// meme kill switch engage (mode securise), une reponse a un commentaire
// declenchee par un webhook n'etait JAMAIS bloquee - le kill switch
// n'avait donc PAS la priorite absolue qu'il doit toujours avoir.
const EXTERNAL_ACTION_TYPES = new Set(['SEND_MESSAGE', 'REPLY_COMMENT', 'PUBLISH_POST', 'UPDATE_DATA', 'DELETE', 'COMMERCIAL_SENSITIVE']);

function defaultFromEnv() {
  const raw = (process.env.KILL_SWITCH_DEFAULT || '').toLowerCase();
  return raw === 'true' || raw === '1';
}

/** Renvoie l'etat actuel (engage ou non) avec la raison et la date du dernier changement. */
async function latestSwitchRow() {
  const rows = await memory.list(memory.COLLECTIONS.DECISIONS, {
    filter: (data) => data.type === 'kill_switch',
    limit: 100,
  });
  return rows.sort((a, b) => {
    const ar = Number(a.data && a.data.revision);
    const br = Number(b.data && b.data.revision);
    const ah = Number.isFinite(ar);
    const bh = Number.isFinite(br);
    if (ah && bh && ar !== br) return br - ar;
    if (ah !== bh) return ah ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  })[0] || null;
}

async function getStatus() {
  const row = await latestSwitchRow();
  if (!row) {
    const engaged = defaultFromEnv();
    return {
      engage: engaged,
      raison: engaged ? 'Valeur par defaut (KILL_SWITCH_DEFAULT=true)' : null,
      changePar: engaged ? 'configuration' : null,
      changeLe: null,
      source: 'defaut',
    };
  }
  const data = row.data;
  return {
    engage: data.engage,
    raison: data.raison || null,
    changePar: data.changePar || null,
    changeLe: row.created_at,
    revision: Number.isFinite(Number(data.revision)) ? Number(data.revision) : null,
    source: 'memoire',
  };
}

/** Active ou desactive le kill switch. Une confirmation explicite est exigee pour la reactivation (desengagement). */
async function setStatus({ engage, raison, changePar, confirmation }) {
  if (engage === false && confirmation !== true) {
    const err = new Error(
      'Desengager le kill switch (reactiver les actions externes) exige une confirmation explicite (confirmation: true).'
    );
    err.statusCode = 400;
    throw err;
  }
  const current = await getStatus();
  const previousRevision = Number(current.revision);
  const revision = Number.isFinite(previousRevision) ? previousRevision + 1 : Date.now();
  const record = await memory.insert(memory.COLLECTIONS.DECISIONS, {
    type: 'kill_switch',
    revision,
    engage: Boolean(engage),
    raison: raison || (engage ? 'Active manuellement' : 'Desactive manuellement'),
    changePar: changePar || 'utilisateur',
    at: new Date().toISOString(),
  });
  logger.warn(`killswitch: ${engage ? 'ACTIVE (mode securise)' : 'desactive (actions externes reautorisees)'}`, {
    raison: record.data.raison,
    changePar: record.data.changePar,
  });
  return getStatus();
}

/**
 * Verifie si un type d'action donne doit etre bloque par le kill switch.
 * Les analyses/preparations (non listees dans EXTERNAL_ACTION_TYPES) ne
 * sont jamais bloquees, meme kill switch actif.
 */
async function isBlocked(actionType) {
  if (!EXTERNAL_ACTION_TYPES.has(actionType)) return false;
  const status = await getStatus();
  return status.engage === true;
}

module.exports = { getStatus, setStatus, isBlocked, EXTERNAL_ACTION_TYPES };
