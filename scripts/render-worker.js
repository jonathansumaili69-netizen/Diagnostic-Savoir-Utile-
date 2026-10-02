#!/usr/bin/env node
'use strict';

/**
 * WORKER DE RENDU EXTERNE — realise concretement la separation
 * ORCHESTRATOR / RENDER WORKER demandee pour le Video Engine (voir
 * src/core/videoRenderer.js et docs/VIDEO_ENGINE.md).
 *
 * POURQUOI CE SCRIPT EXISTE : les fonctions Netlify standard ont un delai
 * d'execution limite (voir netlify.toml, section [functions] et la
 * documentation Netlify) - un rendu FFmpeg reel (plusieurs scenes, voix,
 * sous-titres) peut legitimement depasser cette limite. Ce script permet de
 * faire tourner exactement le meme code (src/core/videoOrchestrator.js)
 * mais dans un processus qui n'a PAS cette contrainte de duree : un poste
 * personnel, une petite VM toujours allumee, un conteneur planifie, ou une
 * tache GitHub Actions declenchee periodiquement. Aucune reecriture de
 * Conquistador OS n'est necessaire pour l'utiliser.
 *
 * PREREQUIS reels pour que ce worker produise effectivement des MP4 :
 *   - ffmpeg installe sur la machine qui l'execute (deteste automatiquement,
 *     voir videoRenderer.isAvailable()) ;
 *   - un acces reseau sortant pour les providers d'image/voix reseau
 *     (sinon, repli automatique sur le Graphic Engine/les references
 *     bundlees — voir src/core/imageProviders/index.js) ;
 *   - les memes variables d'environnement que le reste de Conquistador OS
 *     (SUPABASE_URL/SUPABASE_SERVICE_KEY pour un stockage durable reel,
 *     sinon le rendu reussit mais ne peut pas etre marque COMPLETED — voir
 *     videoOrchestrator.stepFinalize).
 *
 * USAGE :
 *   node scripts/render-worker.js                 # tourne en continu (poll toutes les 15s)
 *   node scripts/render-worker.js --once           # traite les jobs en attente puis quitte (ideal pour un cron externe)
 *   node scripts/render-worker.js --interval=30000 # change l'intervalle de sondage (ms)
 *   node scripts/render-worker.js --job=<id>       # traite un seul job precis jusqu'a completion, puis quitte
 */

const videoJobs = require('../src/core/videoJobs');
const videoOrchestrator = require('../src/core/videoOrchestrator');
const videoRenderer = require('../src/core/videoRenderer');
const { logger } = require('../src/core/logger');

function parseArgs(argv) {
  const args = { once: false, interval: 15000, job: null };
  for (const arg of argv) {
    if (arg === '--once') args.once = true;
    else if (arg.startsWith('--interval=')) args.interval = Math.max(2000, parseInt(arg.split('=')[1], 10) || 15000);
    else if (arg.startsWith('--job=')) args.job = arg.split('=')[1];
  }
  return args;
}

const NON_TERMINAL_STATUSES = videoJobs.STATUSES.filter((s) => !videoJobs.TERMINAL_STATUSES.has(s));

async function findWork() {
  const jobs = [];
  for (const status of NON_TERMINAL_STATUSES) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await videoJobs.listJobs({ status, limit: 20 });
    jobs.push(...batch);
  }
  // Les plus anciens d'abord (FIFO) : un job cree il y a longtemps ne doit
  // pas rester bloque derriere des arrivees plus recentes.
  return jobs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

async function processOnce() {
  const available = await videoRenderer.isAvailable();
  if (!available) {
    logger.error('render-worker: ffmpeg indisponible sur cette machine — aucun rendu ne peut aboutir ici. Voir docs/VIDEO_ENGINE.md.');
  }
  const jobs = await findWork();
  if (jobs.length === 0) {
    logger.info('render-worker: aucun job en attente.');
    return 0;
  }
  logger.info(`render-worker: ${jobs.length} job(s) a faire avancer.`);
  let advanced = 0;
  for (const job of jobs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const updated = await videoOrchestrator.processJob(job.id);
      logger.info('render-worker: job avance', { job_id: job.id, statut: updated.status, progress: updated.progress });
      advanced += 1;
    } catch (err) {
      logger.error('render-worker: echec en traitant un job', { job_id: job.id, error: err.message });
    }
  }
  return advanced;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.job) {
    logger.info(`render-worker: traitement du job unique ${args.job} jusqu'a completion.`);
    const result = await videoOrchestrator.runToCompletion(args.job);
    logger.info('render-worker: job termine', { job_id: args.job, statut: result ? result.status : 'introuvable' });
    process.exit(result && result.status === 'COMPLETED' ? 0 : 1);
    return;
  }

  if (args.once) {
    await processOnce();
    process.exit(0);
    return;
  }

  logger.info(`render-worker: demarrage en continu (sondage toutes les ${args.interval}ms). Ctrl+C pour arreter.`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    await processOnce();
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, args.interval));
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('render-worker: erreur fatale', { error: err.message });
    process.exit(1);
  });
}

module.exports = { findWork, processOnce, parseArgs };
