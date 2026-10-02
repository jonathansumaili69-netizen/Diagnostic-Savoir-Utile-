'use strict';

const killswitch = require('./killswitch');
const idempotency = require('./idempotency');
const videoJobs = require('./videoJobs');
const planner = require('./planner');
const systemActions = require('../agents/systemActions');
const { logger } = require('./logger');

/**
 * SCHEDULER BRIDGE — la JONCTION manquante entre `video_jobs` et le
 * planificateur/publication (prompt maitre, section 19).
 *
 * Constat corrige : le Video Engine produisait des jobs RENDUS
 * (COMPLETED + output_url) alors que le planificateur ne lisait QUE la
 * collection `video_reviews` du pipeline editorial historique. Consequence
 * reelle : un job video rendu n'etait JAMAIS pris en compte par le
 * planificateur — le renderer fonctionnait, la diffusion ignorait ses sorties.
 *
 * Ce module comble la jonction SANS toucher au chemin historique :
 *   1. selectionne les jobs candidats (READY / SCHEDULED du / COMPLETED promu) ;
 *   2. respecte le kill switch (action externe PUBLISH_POST) ;
 *   3. respecte les regles de campagne via planner.checkAction ;
 *   4. exige une idempotence persistante (scope "video.publish") ;
 *   5. n'ecrit PUBLISHED qu'apres confirmation REELLE du provider
 *      (external_post_id / statut explicite) ;
 *   6. journalise chaque tentative (planner.logAction + memory.recordExecution).
 *
 * Aucun faux succes : un echec laisse le job reessayable (READY) jusqu'au
 * nombre maximal de tentatives, puis FAILED avec la raison.
 */

const PUBLISH_SUCCESS_STATUTS = ['PUBLIE', 'EN_TRAITEMENT'];

function maxPublishAttempts() {
  const n = parseInt(process.env.VIDEO_PUBLISH_MAX_ATTEMPTS, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 3;
}

/** Liste les jobs video dont la diffusion est due, avec leur echeance. */
async function listDueVideoJobs({ now = new Date(), limit = 20 } = {}) {
  const candidates = await videoJobs.listPublicationCandidates({ now, limit });
  return candidates.map((job) => ({
    job_id: job.id,
    status: job.status,
    platform: (job.publication && job.publication.platform) || 'tiktok',
    scheduled_for: (job.publication && job.publication.scheduled_for) || null,
    output_url: job.output_url || null,
    attempts: (job.publication && job.publication.attempts) || 0,
    due: job.status !== 'SCHEDULED'
      || !job.publication
      || !job.publication.scheduled_for
      || new Date(job.publication.scheduled_for).getTime() <= new Date(now).getTime(),
  })).filter((j) => j.due);
}

/**
 * Traite les jobs video dus. `publishFn` est injectable (tests / provider
 * alternatif) et vaut par defaut systemActions.publishPost — c'est-a-dire le
 * MEME chemin que le planificateur editorial, donc les MEMES connecteurs.
 */
async function processDueVideoJobs({ now = new Date(), publishFn = null, limit = 20, qualityScore = null } = {}) {
  const publish = publishFn || ((params) => systemActions.publishPost(params));
  const result = {
    checked_at: new Date().toISOString(),
    candidats: 0,
    publies: [],
    bloques: [],
    echecs: [],
    doublons: [],
  };

  const killStatus = await killswitch.getStatus();
  const due = await listDueVideoJobs({ now, limit });
  result.candidats = due.length;
  if (!due.length) return result;

  for (const item of due) {
    const { job_id: jobId, platform } = item;

    // 1) KILL SWITCH — priorite absolue, jamais contourne.
    if (killStatus.engage === true) {
      result.bloques.push({ job_id: jobId, plateforme: platform, raison: `Kill switch engage (${killStatus.raison || 'mode securise'}) : aucune action externe.` });
      await planner.logAction({ action: 'video_publish', content_key: jobId, plateforme: platform, status: 'blocked', reason: 'kill_switch' });
      continue;
    }

    // 2) Regles de campagne (mode, fenetre horaire, quotas, qualite).
    // eslint-disable-next-line no-await-in-loop
    const gate = await planner.checkAction({
      actionType: 'PUBLISH_POST',
      platform,
      qualityScore: qualityScore != null ? qualityScore : 100,
    });
    if (!gate.allowed) {
      result.bloques.push({ job_id: jobId, plateforme: platform, raison: gate.reason });
      // eslint-disable-next-line no-await-in-loop
      await planner.logAction({ action: 'video_publish', content_key: jobId, plateforme: platform, status: 'blocked', reason: gate.reason });
      continue;
    }

    // 3) IDEMPOTENCE PERSISTANTE — cle stable par job + plateforme.
    const idemKey = `${jobId}:${platform}`;
    // eslint-disable-next-line no-await-in-loop
    const claim = await idempotency.claim('video.publish', idemKey);
    if (claim.doublon) {
      result.doublons.push({ job_id: jobId, plateforme: platform, statut: claim.statut });
      continue;
    }

    // 4) Soumission reelle.
    try {
      const job = await videoJobs.getJob(jobId);
      // eslint-disable-next-line no-await-in-loop
      await videoJobs.markPublishing(jobId, { platform, attempt: item.attempts + 1 });
      // eslint-disable-next-line no-await-in-loop
      const out = await publish({
        plateforme: platform,
        contenu: (job.manifest && job.manifest.description) || null,
        content_key: jobId,
        video: { url: job.output_url, job_id: jobId, platform },
        titre: (job.manifest && (job.manifest.titre || job.manifest.idee)) || null,
      });
      const statut = out && out.output ? out.output.statut : null;
      const externalId = (out && out.output && (out.output.external_post_id || out.output.post_id || out.output.id)) || null;
      const success = PUBLISH_SUCCESS_STATUTS.includes(String(statut)) && Boolean(externalId);

      if (success) {
        // eslint-disable-next-line no-await-in-loop
        await videoJobs.markPublished(jobId, {
          external_post_id: externalId,
          platform,
          statut_provider: statut,
          response: (out && out.output && out.output.response) || null,
        });
        // eslint-disable-next-line no-await-in-loop
        await idempotency.confirm('video.publish', idemKey);
        // eslint-disable-next-line no-await-in-loop
        await planner.logAction({ action: 'video_publish', content_key: jobId, plateforme: platform, status: 'success', statut_sortie: statut });
        // eslint-disable-next-line no-await-in-loop
        await require('./memory').recordExecution({
          workflow: 'scheduler.video_publish',
          declencheur: 'campaign',
          agent: 'system',
          action: 'PUBLISH_POST',
          statut_sortie: statut,
          resultat: 'succes',
          duree_ms: 0,
        });
        result.publies.push({ job_id: jobId, plateforme: platform, external_post_id: externalId, statut });
      } else {
        // Confirmation absente/insuffisante : on ne declare JAMAIS publie.
        // eslint-disable-next-line no-await-in-loop
        await videoJobs.markPublicationFailed(jobId, {
          platform,
          error: new Error(`Confirmation provider insuffisante (statut="${statut || 'absent'}", external_post_id="${externalId || 'absent'}") : publication non confirmee.`),
          maxAttempts: maxPublishAttempts(),
        });
        // eslint-disable-next-line no-await-in-loop
        await idempotency.release('video.publish', idemKey);
        // eslint-disable-next-line no-await-in-loop
        await planner.logAction({ action: 'video_publish', content_key: jobId, plateforme: platform, status: 'not_confirmed', statut_sortie: statut || null });
        result.echecs.push({ job_id: jobId, plateforme: platform, raison: 'confirmation_provider_absente' });
      }
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await idempotency.release('video.publish', idemKey).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await videoJobs.markPublicationFailed(jobId, { platform, error: err, maxAttempts: maxPublishAttempts() }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await planner.logAction({ action: 'video_publish', content_key: jobId, plateforme: platform, status: 'error', reason: err.message });
      logger.error('schedulerBridge: echec de diffusion d un job video', { job_id: jobId, plateforme: platform, error: err.message });
      result.echecs.push({ job_id: jobId, plateforme: platform, raison: err.message });
    }
  }

  return result;
}

/** Resume de diagnostic (aucune donnee sensible). */
async function diagnostics({ now = new Date() } = {}) {
  const due = await listDueVideoJobs({ now, limit: 100 });
  const killStatus = await killswitch.getStatus();
  return {
    kill_switch: { engage: killStatus.engage, raison: killStatus.raison || null },
    max_tentatives: maxPublishAttempts(),
    jobs_dus: due.length,
    detail: due,
  };
}

module.exports = {
  PUBLISH_SUCCESS_STATUTS,
  maxPublishAttempts,
  listDueVideoJobs,
  processDueVideoJobs,
  diagnostics,
};
