'use strict';

const { askAI } = require('./base');
const memory = require('../core/memory');

const SYSTEM = [
  'Tu es AGENT_CLIENTS au sein de Conquistador OS.',
  "Tu geres les nouveaux prospects, leurs questions, et le suivi de la relation.",
  'Tes reponses restent humaines, chaleureuses et utiles.',
].join('\n');

const STADES_PROSPECT = Object.freeze(['nouveau', 'chaud', 'en_attente', 'client', 'perdu']);

async function upsertContact(input) {
  const identifiant = input.identifiant || input.telephone || input.email;
  if (!identifiant) {
    throw new Error('AGENT_CLIENTS.upsertContact: un identifiant (telephone, email ou identifiant) est requis');
  }
  const existingList = await memory.list(memory.COLLECTIONS.CONTACTS, {
    filter: (data) => data.identifiant === identifiant,
  });
  const existing = existingList[0];
  const historiqueEntry = {
    at: new Date().toISOString(),
    canal: input.canal || 'inconnu',
    message: input.message || null,
  };
  // stade et demande_guide sont optionnels et additifs (cahier des charges
  // "statistiques prospects") : un appelant qui ne les fournit pas conserve
  // exactement le comportement d'avant (stade par defaut 'nouveau' a la
  // creation, jamais modifie ensuite si non fourni explicitement).
  const stade = STADES_PROSPECT.includes(input.stade) ? input.stade : null;
  const demandeGuide = input.demande_guide === true ? true : (input.demande_guide === false ? false : null);
  if (existing) {
    const historique = [...(existing.data.historique || []), historiqueEntry];
    const updated = await memory.update(memory.COLLECTIONS.CONTACTS, existing.id, {
      historique,
      derniere_activite: historiqueEntry.at,
      nom: input.nom || existing.data.nom,
      stade: stade || existing.data.stade || 'nouveau',
      demande_guide: demandeGuide !== null ? demandeGuide : (existing.data.demande_guide || false),
    });
    return { type: 'client.upsert_contact', output: updated, isNew: false };
  }
  const created = await memory.insert(memory.COLLECTIONS.CONTACTS, {
    identifiant,
    nom: input.nom || null,
    canal: input.canal || 'inconnu',
    historique: [historiqueEntry],
    derniere_activite: historiqueEntry.at,
    stade: stade || 'nouveau',
    demande_guide: demandeGuide === true,
  });
  return { type: 'client.upsert_contact', output: created, isNew: true };
}

async function answerQuestion(input) {
  const prompt = [
    `Question du client/prospect : "${input.question || input.message || ''}"`,
    `Historique connu : ${input.historique ? JSON.stringify(input.historique) : 'aucun'}`,
    'Prepare une reponse personnalisee, claire et utile a cette question.',
    'Format JSON attendu : { "reponse": "...", "necessite_suivi_humain": true|false, "raison_suivi": "..." }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.6 });
  return { type: 'client.answer_question', provider: result.provider, model: result.model, output: result.parsed };
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'upsert_contact':
      return upsertContact(input || {});
    case 'answer_question':
      return answerQuestion(input || {});
    default:
      throw new Error(`AGENT_CLIENTS: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, upsertContact, answerQuestion, STADES_PROSPECT };
