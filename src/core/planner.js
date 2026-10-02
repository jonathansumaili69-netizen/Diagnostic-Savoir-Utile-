'use strict';

const memory = require('./memory');
const killswitch = require('./killswitch');
const operationalState = require('./operationalState');
const { logger } = require('./logger');
const { resolveHour } = require('./timezones');

// Seuil de secours si campaign.quality_min_score est absent/invalide.
// AUDIT V7 -> V8 : ce fallback valait 70 alors que le cahier des charges
// exige un seuil PAR DEFAUT de 85/100 (operationalState.normalizeCampaign
// applique deja 85 par defaut - ce fallback local doit rester cohérent avec
// ce défaut plutôt que d'introduire une valeur différente en silence).
const QUALITY_FALLBACK = 85;

async function countToday(collection, fn) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await memory.list(collection, { limit: 500 });
  return rows.filter((r) => {
    const at = new Date(r.created_at || r.updated_at || 0).getTime();
    return at >= start.getTime() && fn(r.data || {});
  }).length;
}

/**
 * Porte de decision centrale pour toute action autonome de campagne.
 * Verifie, dans cet ordre : kill switch > mode Conquistador actif > campagne
 * activee > plateforme autorisee > fenetre horaire (vrai fuseau IANA, voir
 * timezones.js) > quota quotidien > score de qualite configurable.
 * Ne renvoie jamais allowed:true sans avoir verifie CHAQUE condition.
 */
async function checkAction({ actionType, platform, qualityScore } = {}) {
  const settings = await operationalState.getSettings();
  const ks = await killswitch.getStatus();
  if (ks.engage === true) {
    return { allowed: false, reason: `Kill switch engagé : ${ks.raison || 'mode sécurisé actif'}` };
  }
  if (settings.mode !== 'conquistador') {
    return { allowed: false, reason: 'Le mode Conquistador n’est pas actif.' };
  }
  const c = settings.campaign || {};
  if (c.enabled !== true) {
    return { allowed: false, reason: 'La campagne autonome n’est pas activée.' };
  }
  const plat = String(platform || '').toLowerCase();
  if (actionType === 'PUBLISH_POST') {
    if (plat && Array.isArray(c.allowed_platforms) && c.allowed_platforms.length && !c.allowed_platforms.includes(plat)) {
      return { allowed: false, reason: `La plateforme "${plat}" n’est pas autorisée.` };
    }
    const hours = Array.isArray(c.allowed_hours) ? c.allowed_hours : [];
    const tz = String(c.timezone || 'Africa/Bujumbura');
    const localHour = resolveHour(tz);
    if (hours.length && !hours.includes(localHour)) {
      return { allowed: false, reason: `Hors fenêtre horaire autorisée (${localHour}h locale, ${tz}).` };
    }
    const max = Number(c.max_publications_per_day || 0);
    if (max <= 0) {
      return { allowed: false, reason: 'Quota quotidien fixé à zéro.' };
    }
    const done = await countToday(
      memory.COLLECTIONS.EXECUTIONS,
      (d) => d.declencheur === 'campaign' && d.action === 'PUBLISH_POST' && d.resultat === 'succes',
    );
    if (done >= max) {
      return { allowed: false, reason: `Quota quotidien atteint (${done}/${max}).` };
    }
    const minQ = Number.isFinite(Number(c.quality_min_score)) ? Number(c.quality_min_score) : QUALITY_FALLBACK;
    if (qualityScore != null && Number(qualityScore) < minQ) {
      return { allowed: false, reason: `Score qualité ${qualityScore} < seuil ${minQ}.` };
    }
  }
  return { allowed: true, reason: null, settings };
}

async function logAction(entry = {}) {
  const row = await memory.insert(memory.COLLECTIONS.DECISIONS, {
    kind: 'planner_action',
    at: new Date().toISOString(),
    ...entry,
  });
  logger.info('planner: action journalisee', { action: entry.action, status: entry.status });
  return row;
}

async function getLog({ limit = 50 } = {}) {
  const rows = await memory.list(memory.COLLECTIONS.DECISIONS, { limit: 300 });
  return rows.filter((r) => r && r.data && r.data.kind === 'planner_action').slice(0, limit);
}

/**
 * AUDIT (bug de republication) : le planificateur (scheduler-tick.js) ne
 * marquait JAMAIS un contenu comme publie apres succes - le seul garde-fou
 * existant (`review.publie === true`) verifiait un champ qui n'etait jamais
 * ecrit nulle part. Consequence : le meme contenu pouvait etre republie a
 * chaque cycle (toutes les 30 minutes).
 *
 * Cette fonction reconstruit l'ensemble des publications REELLEMENT
 * confirmees a partir du journal des decisions planificateur (DECISIONS,
 * kind 'planner_action', action 'publish', status 'success' - ecrit par
 * logAction() a chaque publication reussie). Ce journal est persistant
 * (Supabase, ou stockage JSON local en dev) et survit donc a un
 * redemarrage du processus, contrairement a un simple Set en memoire.
 *
 * Cle composite `${content_key}::${plateforme}` : un meme contenu publie
 * sur DEUX plateformes differentes n'est pas un doublon - chaque paire
 * (contenu, plateforme) a sa propre entree d'idempotence. Republier le
 * meme contenu sur la MEME plateforme est en revanche toujours bloque.
 */
async function getPublishedContentKeys({ limit = 1000 } = {}) {
  const requested = Math.max(1, Math.min(2000, Number(limit) || 1000));
  const rows = await memory.list(memory.COLLECTIONS.DECISIONS, { limit: requested });
  const keys = new Set();
  for (const row of rows) {
    const d = row && row.data ? row.data : {};
    if (d.kind !== 'planner_action' || d.action !== 'publish' || d.status !== 'success') continue;
    if (!d.content_key) continue;
    keys.add(`${d.content_key}::${String(d.plateforme || '').toLowerCase()}`);
  }
  return keys;
}

module.exports = { checkAction, logAction, getLog, getPublishedContentKeys, QUALITY_FALLBACK };
