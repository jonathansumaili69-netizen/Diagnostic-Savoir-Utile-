'use strict';

const { askAI } = require('./base');

const SYSTEM = [
  'Tu es AGENT_RECHERCHE au sein de Conquistador OS.',
  "IMPORTANT : tu n'as PAS acces a une recherche web en temps reel dans cette",
  "version. Tu raisonnes uniquement a partir de tes connaissances generales.",
  "Si une information recente ou verifiable est demandee, precise clairement",
  "que tu ne peux pas la garantir a jour et recommande une verification humaine.",
].join('\n');

async function topic(input) {
  const prompt = [
    `Sujet de recherche : ${input.sujet || ''}`,
    "Rassemble les angles, questions frequentes et pistes de contenu pertinentes",
    "pour ce sujet, dans le contexte de l'emploi en Afrique francophone.",
    'Format JSON attendu : { "angles": [...], "questions_frequentes": [...], "pistes_de_contenu": [...], "verification_recommandee": true|false }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.6 });
  return { type: 'research.topic', provider: result.provider, model: result.model, output: result.parsed };
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'topic':
      return topic(input || {});
    default:
      throw new Error(`AGENT_RECHERCHE: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, topic };
