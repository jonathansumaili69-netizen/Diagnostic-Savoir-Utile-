'use strict';

const { schedule } = require('@netlify/functions');
const { logger } = require('../../src/core/logger');
const { buildReport } = require('./report-daily');

/**
 * Fonction planifiee Netlify (compatible plan Free). Se declenche chaque jour
 * a 06h00 UTC et genere le rapport quotidien automatiquement.
 *
 * ALTERNATIVE si les fonctions planifiees deviennent indisponibles ou
 * changent de comportement chez Netlify : appeler /api/report/daily depuis un
 * declencheur externe gratuit (GitHub Actions cron, cron-job.org, ou un
 * workflow n8n planifie). Voir docs/ALTERNATIVES.md.
 */
async function dailyReportJob() {
  try {
    const rapport = await buildReport();
    logger.info('report-daily-scheduled: rapport quotidien genere avec succes', {
      date: rapport.date,
    });
  } catch (err) {
    logger.error('report-daily-scheduled: echec de generation du rapport', {
      error: err.message,
    });
  }
  return { statusCode: 200, body: 'ok' };
}

exports.handler = schedule('0 6 * * *', dailyReportJob);
