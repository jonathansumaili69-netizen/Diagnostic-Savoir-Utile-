'use strict';

const { askAI } = require('./base');
const memory = require('../core/memory');
const approval = require('../core/approval');

const SYSTEM = [
  'Tu es AGENT_DIRECTEUR au sein de Conquistador OS.',
  'Tu orchestres les autres agents (CONTENU, COMMERCIAL, CLIENTS, ANALYSTE,',
  'STATISTIQUES, AFFILIATION, RECHERCHE, QUALITE) et definis les priorites du',
  "lendemain a partir de l'activite reelle du systeme, jamais de suppositions.",
].join('\n');

/**
 * Determine les priorites du lendemain a partir de donnees reelles :
 * approbations en attente, erreurs recentes, taches en echec.
 */
async function priorities() {
  const [pendingApprovals, recentErrors, recentTasks] = await Promise.all([
    approval.pending(),
    memory.list(memory.COLLECTIONS.ERRORS, { limit: 10 }),
    memory.list(memory.COLLECTIONS.TASKS, { limit: 20 }),
  ]);
  const failedTasks = recentTasks.filter((t) => t.data.status === 'error');

  const prompt = [
    `Approbations en attente : ${pendingApprovals.length}`,
    `Erreurs recentes : ${recentErrors.length}`,
    `Taches recemment en echec : ${failedTasks.length}`,
    'A partir de ces chiffres reels uniquement (ne rien inventer au-dela), liste',
    '3 a 5 priorites concretes pour demain, classees par importance.',
    'Format JSON attendu : { "priorites": [ { "titre": "...", "raison": "...", "urgence": "haute|moyenne|basse" } ] }',
  ].join('\n');

  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.5 });
  return {
    type: 'directeur.priorities',
    provider: result.provider,
    model: result.model,
    output: {
      ...result.parsed,
      donnees_source: {
        approbations_en_attente: pendingApprovals.length,
        erreurs_recentes: recentErrors.length,
        taches_en_echec: failedTasks.length,
      },
    },
  };
}

async function handle(task) {
  const { subtype } = task;
  switch (subtype) {
    case 'priorities':
      return priorities();
    default:
      throw new Error(`AGENT_DIRECTEUR: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, priorities };
