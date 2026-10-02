'use strict';

const { askAI } = require('./base');
const memory = require('../core/memory');
const statistiques = require('./statistiques');

const SYSTEM = [
  'Tu es AGENT_ANALYSTE au sein de Conquistador OS.',
  "Tu analyses les statistiques, les evenements et les erreurs reellement",
  "enregistres pour en tirer des constats fiables, sans inventer de chiffres",
  "qui ne t'ont pas ete fournis.",
].join('\n');

async function performance(input) {
  const stats = await statistiques.summary(input || {});
  const recentErrors = await memory.list(memory.COLLECTIONS.ERRORS, { limit: 10 });
  const prompt = [
    `Statistiques agregees reelles (ne pas en inventer d'autres) : ${JSON.stringify(stats.output)}`,
    `Nombre d'erreurs recentes enregistrees : ${recentErrors.length}`,
    "Analyse ces donnees et produit une synthese de performance honnete (si les donnees",
    "sont insuffisantes, dis-le explicitement plutot que d'inventer des tendances).",
    'Format JSON attendu : { "synthese": "...", "points_positifs": [...], "points_attention": [...], "donnees_insuffisantes": true|false }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.4 });
  return {
    type: 'analysis.performance',
    provider: result.provider,
    model: result.model,
    output: { ...result.parsed, statistiques_source: stats.output },
  };
}

async function opportunity(input) {
  const contacts = await memory.list(memory.COLLECTIONS.CONTACTS, { limit: 30 });
  const prompt = [
    `Nombre de contacts enregistres : ${contacts.length}`,
    `Contexte additionnel fourni par l'utilisateur : ${input.contexte || 'aucun'}`,
    "Identifie 3 a 5 opportunites concretes et actionnables pour Savoir Utile,",
    'fondees sur ce contexte reel plutot que sur des suppositions generiques.',
    'Format JSON attendu : { "opportunites": [ { "titre": "...", "description": "...", "action_recommandee": "..." } ] }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.6 });
  return { type: 'analysis.opportunity', provider: result.provider, model: result.model, output: result.parsed };
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'performance':
      return performance(input || {});
    case 'opportunity':
      return opportunity(input || {});
    default:
      throw new Error(`AGENT_ANALYSTE: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, performance, opportunity };
