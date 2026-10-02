'use strict';

const { askAI } = require('./base');
const memory = require('../core/memory');

const SYSTEM = [
  'Tu es AGENT_AFFILIATION au sein de Conquistador OS.',
  'Tu suis les affilies de Savoir Utile, prepares des messages de relance',
  'motivants, et identifies les opportunites de partenariat.',
].join('\n');

async function registerAffiliate(input) {
  const identifiant = input.identifiant || input.email || input.nom;
  if (!identifiant) {
    throw new Error('AGENT_AFFILIATION.registerAffiliate: identifiant, email ou nom requis');
  }
  const saved = await memory.insert(memory.COLLECTIONS.CONTACTS, {
    identifiant,
    nom: input.nom || null,
    type: 'affilie',
    ventes_generees: input.ventes_generees || 0,
    derniere_activite: new Date().toISOString(),
  });
  return { type: 'affiliation.register', output: saved };
}

async function followup(input) {
  const prompt = [
    `Affilie concerne : ${input.nom || 'affilie'}`,
    `Performance connue : ${JSON.stringify(input.performance || {})}`,
    'Redige un message de relance motivant et personnalise pour cet affilie.',
    'Format JSON attendu : { "message": "...", "ton": "..." }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.7 });
  return { type: 'affiliation.followup', provider: result.provider, model: result.model, output: result.parsed };
}

async function report(input) {
  const affiliates = await memory.list(memory.COLLECTIONS.CONTACTS, {
    filter: (data) => data.type === 'affilie',
  });
  const totalVentes = affiliates.reduce((sum, a) => sum + (a.data.ventes_generees || 0), 0);
  return {
    type: 'affiliation.report',
    output: {
      nombre_affilies: affiliates.length,
      total_ventes_generees: totalVentes,
      top_affilies: affiliates
        .slice()
        .sort((a, b) => (b.data.ventes_generees || 0) - (a.data.ventes_generees || 0))
        .slice(0, 5)
        .map((a) => ({ nom: a.data.nom || a.data.identifiant, ventes_generees: a.data.ventes_generees || 0 })),
    },
  };
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'register':
      return registerAffiliate(input || {});
    case 'followup':
      return followup(input || {});
    case 'report':
      return report(input || {});
    default:
      throw new Error(`AGENT_AFFILIATION: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, registerAffiliate, followup, report };
