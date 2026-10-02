'use strict';

const { schedule } = require('@netlify/functions');
const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const memory = require('../../src/core/memory');
const planner = require('../../src/core/planner');
const operationalState = require('../../src/core/operationalState');
const systemActions = require('../../src/agents/systemActions');
const schedulerBridge = require('../../src/core/schedulerBridge');
const { logger } = require('../../src/core/logger');
const { resolveHour } = require('../../src/core/timezones');

/**
 * Planificateur autonome (cahier des charges section "planificateur
 * autonome"). Tourne toutes les 30 minutes (voir schedule() en bas), publie
 * automatiquement le contenu deja valide qualite-wise ET encore dans les
 * regles de campagne actives - jamais l'inverse.
 */
async function tick() {
  const settings = await operationalState.getSettings();
  const campaign = settings.campaign || {};
  const result = { mode: settings.mode, checked_at: new Date().toISOString(), publications: [], skipped: null };

  if (settings.mode !== 'conquistador' || campaign.enabled !== true) {
    result.skipped = 'Mode Conquistador inactif ou campagne non activée : aucune action autonome.';
    await planner.logAction({ action: 'scheduler_tick', status: 'skipped', reason: result.skipped });
    return result;
  }

  const hours = Array.isArray(campaign.allowed_hours) ? campaign.allowed_hours : [];
  const tz = String(campaign.timezone || 'Africa/Bujumbura');
  // BUG CORRIGE (audit V7) : voir timezones.js - l'ancien calcul
  // Number(Intl...format fr-FR) renvoyait toujours NaN, bloquant en
  // permanence toute fenetre horaire configuree.
  const hour = resolveHour(tz);
  if (hours.length && !hours.includes(hour)) {
    result.skipped = `Heure ${hour}h locale (${tz}) hors fenêtre autorisée.`;
    return result;
  }

  // Seuil de secours aligné sur le défaut de 85/100 (voir planner.js).
  const minQ = Number.isFinite(Number(campaign.quality_min_score)) ? Number(campaign.quality_min_score) : planner.QUALITY_FALLBACK;
  const reviews = await operationalState.listVideoReviews({ limit: 100 });
  const seen = new Set();
  const ready = [];
  for (const row of reviews) {
    const review = row.data && row.data.review ? row.data.review : {};
    const key = (row.data && row.data.content_key) || row.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (review.conforme !== true || review.publication_autorisee !== true) continue;
    const score = Number.isFinite(Number(review.score_qualite)) ? Number(review.score_qualite) : 0;
    if (score < minQ) continue;
    if (review.publie === true) continue;
    ready.push({ key, review, row });
  }

  const max = Number(campaign.max_publications_per_day || 0);
  const exec = await memory.list(memory.COLLECTIONS.EXECUTIONS, { limit: 500 });
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  const doneCount = exec.filter((r) => {
    const at = new Date(r.created_at || 0).getTime();
    const d = r.data || {};
    return at >= cutoff.getTime() && d.declencheur === 'campaign' && d.action === 'PUBLISH_POST' && d.resultat === 'succes';
  }).length;
  let remaining = Math.max(0, max - doneCount);

  // AUDIT (bug de republication) : reconstruit les publications deja
  // confirmees (journal persistant) pour ne JAMAIS republier le meme
  // contenu sur la meme plateforme, meme si `review.publie` (garde-fou
  // local, mis a jour ci-dessous) n'a pas ete positionne pour une raison
  // quelconque (ancienne entree, ecriture partielle, etc.).
  const publishedKeys = await planner.getPublishedContentKeys();

  for (const item of ready) {
    if (remaining <= 0) break;
    const video = item.review.video && typeof item.review.video === 'object' ? item.review.video : {};
    const platform = String(
      video.platform || video.plateforme || (Array.isArray(campaign.allowed_platforms) ? campaign.allowed_platforms[0] : null) || 'tiktok',
    ).toLowerCase();
    const publishedKey = `${item.key}::${platform}`;
    if (publishedKeys.has(publishedKey)) {
      await planner.logAction({
        action: 'publish',
        content_key: item.key,
        plateforme: platform,
        status: 'already_published',
        reason: 'Contenu deja publie avec succes sur cette plateforme (idempotence planificateur) : republication bloquee.',
      });
      continue;
    }
    const gate = await planner.checkAction({ actionType: 'PUBLISH_POST', platform, qualityScore: item.review.score_qualite });
    if (!gate.allowed) {
      await planner.logAction({ action: 'publish', content_key: item.key, plateforme: platform, status: 'blocked', reason: gate.reason });
      continue;
    }
    try {
      const out = await systemActions.publishPost({
        plateforme: platform,
        contenu: item.review.contenu_prepare || null,
        content_key: item.key,
        video,
        titre: (item.row && item.row.data && (item.row.data.content_title || item.row.data.title)) || null,
      });
      const statut = out && out.output ? out.output.statut : 'INCONNU';
      // PUBLIE et EN_TRAITEMENT comptent tous deux comme "deja soumis avec
      // succes" : dans les deux cas, une nouvelle soumission creerait un
      // doublon reel chez le fournisseur (ex: TikTok EN_TRAITEMENT = deja
      // accepte par l'API, en cours de traitement asynchrone).
      const success = ['PUBLIE', 'EN_TRAITEMENT'].includes(String(statut));
      await planner.logAction({ action: 'publish', content_key: item.key, plateforme: platform, status: success ? 'success' : 'not_executed', statut_sortie: statut });
      await memory.recordExecution({
        workflow: 'scheduler.publish',
        declencheur: 'campaign',
        agent: 'system',
        action: 'PUBLISH_POST',
        statut_sortie: statut,
        resultat: success ? 'succes' : 'non_execute',
        duree_ms: 0,
      });
      result.publications.push({ content_key: item.key, plateforme: platform, statut });
      if (success) {
        remaining -= 1;
        publishedKeys.add(publishedKey);
        // Garde-fou local supplementaire (chemin rapide lu directement
        // depuis les video_reviews au cycle suivant, sans nouvelle requete
        // sur le journal des decisions). Best-effort : le journal des
        // decisions ci-dessus reste la source de verite si cette mise a
        // jour echoue.
        if (item.row && item.row.id) {
          try {
            await memory.update(memory.COLLECTIONS.CONTENT, item.row.id, {
              review: { ...item.review, publie: true, publie_le: new Date().toISOString(), publie_plateforme: platform },
            });
          } catch (updateErr) {
            await memory.recordError({ taskId: null, type: 'scheduler.mark_published' }, updateErr);
          }
        }
      }
    } catch (err) {
      await planner.logAction({ action: 'publish', content_key: item.key, plateforme: platform, status: 'error', reason: err.message });
      await memory.recordError({ taskId: null, type: 'scheduler.publish' }, err);
    }
  }

  // JONCTION VIDEO (section 19) : le pipeline video ecrit dans `video_jobs`,
  // pas dans `video_reviews`. Sans cet appel, un job video rendu n'etait
  // JAMAIS pris en compte par le planificateur. Comportement historique
  // INCHANGE : ce bloc n'ajoute qu'un traitement supplementaire, dans le
  // meme mode Conquistador, avec les memes garde-fous (kill switch, regles
  // de campagne, quotas, idempotence) appliques par schedulerBridge.
  try {
    const videoResult = await schedulerBridge.processDueVideoJobs({ limit: 10 });
    result.video_jobs = videoResult;
  } catch (err) {
    result.video_jobs = { error: err.message };
    await memory.recordError({ taskId: null, type: 'scheduler.video_bridge' }, err).catch(() => {});
    logger.error('scheduler-tick: echec de la jonction video_jobs', { error: err.message });
  }

  if (!result.publications.length && !result.skipped) {
    result.skipped = 'Aucun contenu valide prêt à publier dans les règles actuelles.';
  }
  return result;
}

const manualHandler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  if (event.httpMethod === 'GET') return json(200, { log: await planner.getLog({ limit: 50 }) });
  assertApiKey(event.headers);
  return json(200, { result: await tick() });
});

/**
 * Distingue une invocation planifiee reelle par Netlify (cron) d'un appel
 * HTTP manuel (dashboard/API). Netlify envoie les invocations planifiees
 * sans methode HTTP exploitable de la meme maniere qu'un appel manuel, et
 * avec un corps JSON de la forme {"next_run": "..."} (voir la documentation
 * Netlify sur les Scheduled Functions). Absence totale d'evenement = invoque
 * en tant que fonction planifiee (comportement le plus sur par defaut).
 */
function isNetlifyScheduledEvent(event) {
  if (!event) return true;
  if (!event.httpMethod) return true;
  if (event.body) {
    try {
      const parsed = JSON.parse(event.body);
      if (parsed && typeof parsed === 'object' && 'next_run' in parsed) return true;
    } catch (err) {
      // corps non JSON : ce n'est pas une invocation planifiee, on continue.
    }
  }
  return false;
}

// CORRECTION BUILD NETLIFY : le helper `schedule()` importe de
// "@netlify/functions" doit obligatoirement envelopper directement
// `exports.handler` (Netlify detecte ce motif statiquement a la compilation
// - voir la doc officielle des Scheduled Functions). Le precedent
// `exports.scheduled = schedule(...)` distinct de `exports.handler` n'etait
// pas reconnu par cette analyse statique, d'ou l'echec de build. Le
// planificateur (`scheduledJob`) reproduit exactement le meme comportement
// qu'avant pour chacun des deux chemins :
//  - invocation planifiee (cron) : identique a l'ancien `job` (aucun
//    controle d'origine/cle/debit - Netlify ne peut pas en fournir pour un
//    declenchement planifie) ;
//  - appel manuel HTTP (dashboard/API) : identique a l'ancien handler
//    separe (origine verifiee, debit limite, GET=journal, POST=cle API
//    requise). Le calendrier ('*/30 * * * *') est strictement inchange.
const scheduledJob = async (event, context) => {
  if (isNetlifyScheduledEvent(event)) {
    try {
      const r = await tick();
      logger.info('scheduler-tick: cycle termine', { publications: r.publications.length, skipped: r.skipped || null });
    } catch (err) {
      logger.error('scheduler-tick: echec', { error: err.message });
    }
    return { statusCode: 200, body: 'ok' };
  }
  return manualHandler(event, context);
};

exports.handler = schedule('*/30 * * * *', scheduledJob);

module.exports.tick = tick;
