'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const videoJobs = require('../../src/core/videoJobs');
const schedulerBridge = require('../../src/core/schedulerBridge');
const killswitch = require('../../src/core/killswitch');
const operationalState = require('../../src/core/operationalState');
const planner = require('../../src/core/planner');
const { logger } = require('../../src/core/logger');

/**
 * ENDPOINT VIDEO PUBLISH — jonction explicite entre un job video RENDU et la
 * diffusion (prompt maitre, sections 18-19).
 *
 * ACTIONS (POST, cle API requise — endpoint mutant) :
 *   { action: 'ready',    job_id }                                  -> promeut COMPLETED en READY
 *   { action: 'schedule', job_id, scheduled_for, platform }          -> READY -> SCHEDULED
 *   { action: 'publish',  job_id, platform }                         -> tente la diffusion MAINTENANT
 *   { action: 'process_due' }                                        -> traite tous les jobs dus
 *
 * GET -> diagnostic en lecture seule (aucune donnee sensible).
 *
 * SECURITE : assertApiKey sur toute mutation (identique aux autres endpoints
 * mutants) ; le kill switch, les regles de campagne, les quotas et
 * l'idempotence sont appliques par schedulerBridge — cet endpoint ne les
 * contourne jamais et n'ecrit PUBLISHED qu'apres confirmation reelle.
 */

const handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));

  if (event.httpMethod === 'GET') {
    const [diag, kill] = await Promise.all([schedulerBridge.diagnostics(), killswitch.getStatus()]);
    return json(200, {
      ok: true,
      kill_switch: { engage: kill.engage, raison: kill.raison || null },
      candidats: diag.jobs_dus,
      detail: diag.detail,
      note: "Une video generee n'est JAMAIS une video publiee : PUBLISHED exige un identifiant externe renvoye par le provider.",
    });
  }

  assertApiKey(event.headers);
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return json(400, { ok: false, error: 'Corps JSON invalide.' });
  }

  const action = String(body.action || '').trim().toLowerCase();

  if (action === 'ready') {
    if (!body.job_id) return json(400, { ok: false, error: '"job_id" est requis.' });
    const job = await videoJobs.markReady(body.job_id);
    return json(200, { ok: true, job });
  }

  if (action === 'schedule') {
    if (!body.job_id || !body.scheduled_for) return json(400, { ok: false, error: '"job_id" et "scheduled_for" (ISO) sont requis.' });
    const job = await videoJobs.schedulePublication(body.job_id, {
      scheduled_for: body.scheduled_for,
      platform: body.platform,
      timezone: body.timezone || null,
    });
    return json(200, { ok: true, job });
  }

  if (action === 'publish') {
    if (!body.job_id) return json(400, { ok: false, error: '"job_id" est requis.' });
    const job = await videoJobs.getJob(body.job_id);
    if (!job) return json(404, { ok: false, error: `Job "${body.job_id}" introuvable.` });
    // On force l'echeance a maintenant pour que le job soit traite comme dû.
    // (patchJob sans output_url : le garde-fou storage_ok ne s'applique pas.)
    if (body.platform || job.status === 'SCHEDULED') {
      await videoJobs.patchJob(body.job_id, {
        publication: {
          ...(job.publication || {}),
          platform: String(body.platform || (job.publication && job.publication.platform) || 'tiktok').toLowerCase(),
          scheduled_for: new Date().toISOString(),
        },
      }, { status: job.status === 'PUBLISHED' ? 'PUBLISHED' : 'SCHEDULED', allowedFrom: ['COMPLETED', 'READY', 'SCHEDULED'] }).catch(() => null);
    }
    const result = await schedulerBridge.processDueVideoJobs({ limit: 1, publishFn: null });
    const updated = await videoJobs.getJob(body.job_id);
    return json(200, { ok: true, result, job: updated });
  }

  if (action === 'process_due') {
    const settings = await operationalState.getSettings();
    if (settings.mode !== 'conquistador') {
      return json(200, {
        ok: true,
        skipped: `Mode "${settings.mode}" : la diffusion autonome de jobs video n'est executee qu'en mode conquistador.`,
      });
    }
    const result = await schedulerBridge.processDueVideoJobs({ limit: Number(body.limit) || 20 });
    await planner.logAction({ action: 'video_publish_batch', status: 'done', reason: `candidats=${result.candidats} publies=${result.publies.length} bloques=${result.bloques.length} echecs=${result.echecs.length}` });
    logger.info('video-publish: traitement des jobs video dus', { candidats: result.candidats, publies: result.publies.length });
    return json(200, { ok: true, result });
  }

  return json(400, {
    ok: false,
    error: `Action inconnue "${action}". Actions valides : ready, schedule, publish, process_due.`,
  });
});

exports.handler = handler;
module.exports = { handler };
