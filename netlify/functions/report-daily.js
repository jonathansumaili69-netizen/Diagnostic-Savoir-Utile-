'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const memory = require('../../src/core/memory');
const statistiques = require('../../src/agents/statistiques');
const analyste = require('../../src/agents/analyste');
const directeur = require('../../src/agents/directeur');

function isToday(isoDate) {
  const today = new Date().toISOString().slice(0, 10);
  return String(isoDate || '').slice(0, 10) === today;
}

async function buildReport() {
  const today = new Date().toISOString().slice(0, 10);

  const [executions, errors, events, contacts, approvalsAll] = await Promise.all([
    memory.list(memory.COLLECTIONS.EXECUTIONS, { limit: 200 }),
    memory.list(memory.COLLECTIONS.ERRORS, { limit: 100 }),
    memory.list(memory.COLLECTIONS.EVENTS, { limit: 300 }),
    memory.list(memory.COLLECTIONS.CONTACTS, { limit: 200 }),
    memory.list(memory.COLLECTIONS.APPROVALS, { limit: 100 }),
  ]);

  const executionsToday = executions.filter((e) => isToday(e.data.date));
  const errorsToday = errors.filter((e) => isToday(e.data.at));
  const messagesToday = events.filter((e) => e.data.type === 'webhook.message_recu' && isToday(e.data.payload?.at || e.created_at));
  const ventesToday = events.filter((e) => e.data.type === 'vente.nouvelle' && isToday(e.created_at));
  const prospectsToday = contacts.filter((c) => isToday(c.created_at) && c.data.type !== 'affilie');
  const approvalsEnAttente = approvalsAll.filter((a) => a.data.status === 'pending');

  const stats = await statistiques.summary({});
  const performance = await analyste.performance({});
  const opportunity = await analyste.opportunity({});
  const priorities = await directeur.priorities();

  const rapport = {
    titre: 'RAPPORT QUOTIDIEN SAVOIR UTILE',
    date: today,
    statistiques: stats.output,
    messages: {
      total_aujourdhui: messagesToday.length,
      details: messagesToday.slice(0, 20).map((e) => e.data.payload),
    },
    prospects: {
      total_aujourdhui: prospectsToday.length,
      details: prospectsToday.slice(0, 20).map((c) => ({ identifiant: c.data.identifiant, nom: c.data.nom, canal: c.data.canal })),
    },
    ventes: {
      total_aujourdhui: ventesToday.length,
      details: ventesToday.slice(0, 20).map((e) => e.data.payload),
    },
    actions_effectuees: {
      total_aujourdhui: executionsToday.length,
      details: executionsToday.slice(0, 30).map((e) => ({
        workflow: e.data.workflow,
        action: e.data.action,
        resultat: e.data.resultat,
        heure: e.data.heure,
      })),
    },
    erreurs: {
      total_aujourdhui: errorsToday.length,
      details: errorsToday.slice(0, 20).map((e) => ({ context: e.data.context, message: e.data.message })),
    },
    approbations_en_attente: approvalsEnAttente.length,
    opportunites: opportunity.output,
    analyse: performance.output,
    top_priorites_demain: priorities.output,
    genere_le: new Date().toISOString(),
  };

  await memory.insert(memory.COLLECTIONS.CONTENT, { kind: 'rapport_quotidien', rapport });
  await memory.recordEvent('rapport.genere', { date: today });

  return rapport;
}

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  const rapport = await buildReport();
  return json(200, { rapport });
});

module.exports.buildReport = buildReport;
