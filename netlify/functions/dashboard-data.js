'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const memory = require('../../src/core/memory');
const approval = require('../../src/core/approval');
const statistiques = require('../../src/agents/statistiques');
const operationalState = require('../../src/core/operationalState');
const tiktokStore = require('../../src/core/tiktokStore');
const chariow = require('../../src/core/chariow');
const timezones = require('../../src/core/timezones');

exports.handler = wrapHandler(async (event) => {
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));

  const [
    tasks, executions, errors, contacts, contentRows, approvalsPending, stats, settings, knowledge,
    videoReviews, commercialFollowups, tiktokPublications, objectifsHebdo, progresHebdo,
    comparaisonSemaine, resumeCommercial, classementContenus, chariowConnexion,
  ] = await Promise.all([
    memory.list(memory.COLLECTIONS.TASKS, { limit: 30 }),
    memory.list(memory.COLLECTIONS.EXECUTIONS, { limit: 30 }),
    memory.list(memory.COLLECTIONS.ERRORS, { limit: 20 }),
    memory.list(memory.COLLECTIONS.CONTACTS, { limit: 30 }),
    memory.list(memory.COLLECTIONS.CONTENT, { limit: 10 }),
    approval.pending(),
    statistiques.summary({}),
    operationalState.getSettings(),
    operationalState.listKnowledge({ limit: 20 }),
    operationalState.listVideoReviews({ limit: 20 }),
    operationalState.listCommercialFollowups({ limit: 20 }),
    tiktokStore.listPublications({ limit: 20 }),
    operationalState.getWeeklyObjectives(),
    statistiques.weeklyProgress({}),
    statistiques.periodComparison({ granularite: 'semaine' }),
    statistiques.commercialSummary(),
    statistiques.ranking({ top: 5 }),
    chariow.status().configure ? chariow.listSales({ perPage: 1 }).then(() => ({ configure: true, connecte: true })).catch((err) => ({ configure: true, connecte: false, raison: err.message })) : Promise.resolve({ configure: false, connecte: false }),
  ]);

  const derniersRapports = contentRows.filter((c) => c.data.kind === 'rapport_quotidien').slice(0, 5);
  const etatsContenu = operationalState.summarizeContentStates({ tasks, videoReviews });

  return json(200, {
    taches: tasks,
    executions,
    erreurs: errors,
    prospects: contacts.filter((c) => c.data.type !== 'affilie'),
    affilies: contacts.filter((c) => c.data.type === 'affilie'),
    approbations_en_attente: approvalsPending,
    statistiques: stats.output,
    rapports_recents: derniersRapports,
    backend_memoire: memory.currentBackend(),
    modes: settings,
    base_connaissances: knowledge,
    revues_video: videoReviews,
    relances_commerciales: commercialFollowups,
    tiktok_publications: tiktokPublications,
    etats_contenu: etatsContenu,
    objectifs_hebdomadaires: objectifsHebdo,
    progres_hebdomadaire: progresHebdo.output,
    comparaison_semaine: comparaisonSemaine.output,
    resume_commercial: resumeCommercial.output,
    classement_contenus: classementContenus.output,
    chariow: chariowConnexion,
    fuseaux_horaires_disponibles: timezones.list(),
  });
});
