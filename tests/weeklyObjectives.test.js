'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ISOLATION (voir tests/chariow.test.js pour l'explication complete) :
// jamais le dossier data/ du depot lui-meme.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-weeklyobj-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

const operationalState = require('../src/core/operationalState');
const statistiques = require('../src/agents/statistiques');
const memory = require('../src/core/memory');

test('operationalState.getWeeklyObjectives: par défaut tous les champs valent 0 (aucun objectif = pas un objectif atteint)', async () => {
  const state = await operationalState.getWeeklyObjectives();
  for (const field of operationalState.OBJECTIVE_FIELDS) {
    assert.equal(state.objectifs[field], 0);
  }
});

test('operationalState.setWeeklyObjectives: enregistre réellement et incrémente la révision', async () => {
  const first = await operationalState.setWeeklyObjectives({ chiffre_affaires: 100, ventes: 5, vues: 20000 });
  assert.equal(first.objectifs.chiffre_affaires, 100);
  assert.equal(first.objectifs.ventes, 5);
  const second = await operationalState.setWeeklyObjectives({ chiffre_affaires: 150 });
  assert.equal(second.objectifs.chiffre_affaires, 150);
  // Les champs non fournis dans le second appel doivent être conservés (mise à jour partielle).
  assert.equal(second.objectifs.ventes, 5);
  assert.ok(second.revision > first.revision);
});

test('statistiques.weeklyProgress: calcule un vrai pourcentage quand un objectif est défini, jamais quand il vaut 0', async () => {
  await operationalState.setWeeklyObjectives({ chiffre_affaires: 100, ventes: 0 });
  await memory.insert(memory.COLLECTIONS.METRICS, {
    source: 'test', date: new Date().toISOString().slice(0, 10), at: new Date().toISOString(), chiffre_affaires: 40,
  });
  const progres = await statistiques.weeklyProgress({});
  assert.equal(progres.output.progres.chiffre_affaires.objectif, 100);
  assert.ok(progres.output.progres.chiffre_affaires.actuel >= 40);
  assert.equal(progres.output.progres.chiffre_affaires.pourcentage, Math.round((progres.output.progres.chiffre_affaires.actuel / 100) * 1000) / 10);
  // ventes : objectif à 0 -> pas de faux pourcentage (null, jamais 0% ni Infinity).
  assert.equal(progres.output.progres.ventes.objectif, 0);
  assert.equal(progres.output.progres.ventes.pourcentage, null);
  assert.equal(progres.output.progres.ventes.reste, null);
});

test('statistiques.periodComparison: compare bien deux fenêtres temporelles distinctes sans écraser les anciennes données', async () => {
  // AUDIT (test flaky selon le jour de la semaine) : l'ancien test utilisait
  // un décalage fixe de 10 jours pour placer une métrique "dans la semaine
  // précédente". Comme periodComparison() utilise des semaines ISO
  // (lundi-dimanche), un décalage fixe ne tombe dans la fenêtre "semaine
  // précédente" que certains jours de la semaine en cours - il échoue par
  // exemple chaque lundi/mardi/mercredi (10 jours en arrière tombe alors
  // dans l'AVANT-dernière semaine, pas la précédente). Corrigé : on calcule
  // explicitement le début de la semaine ISO en cours (même définition que
  // statistiques.js : lundi 00:00 UTC) puis on se place 3 jours avant ce
  // lundi - un point toujours au milieu de la semaine précédente, quel que
  // soit le jour d'exécution du test.
  function startOfIsoWeekUTC(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    d.setUTCDate(d.getUTCDate() + diff);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const now = new Date();
  const currentIsoWeekStart = startOfIsoWeekUTC(now);
  const lastWeek = new Date(currentIsoWeekStart.getTime() - 3 * 24 * 3600 * 1000); // milieu de la semaine précédente
  await memory.insert(memory.COLLECTIONS.METRICS, {
    source: 'test_semaine_precedente', date: lastWeek.toISOString().slice(0, 10), at: lastWeek.toISOString(), vues: 500,
  });
  await memory.insert(memory.COLLECTIONS.METRICS, {
    source: 'test_semaine_actuelle', date: now.toISOString().slice(0, 10), at: now.toISOString(), vues: 800,
  });
  const comparaison = await statistiques.periodComparison({ granularite: 'semaine' });
  assert.ok(comparaison.output.comparaison.vues.periode_actuelle >= 800);
  assert.ok(comparaison.output.comparaison.vues.periode_precedente >= 500);
  // La donnée de la semaine précédente doit toujours être là, pas remplacée.
  assert.notEqual(comparaison.output.comparaison.vues.periode_precedente, 0);
});

test('statistiques.periodComparison: variation_pourcentage est null si la période précédente est à zéro (pas de fausse variation)', async () => {
  const comparaison = await statistiques.periodComparison({ granularite: 'mois' });
  for (const field of statistiques.NUMERIC_FIELDS) {
    const c = comparaison.output.comparaison[field];
    if (c.periode_precedente === 0) {
      assert.equal(c.variation_pourcentage, null, `${field}: variation_pourcentage devrait être null quand periode_precedente=0`);
    }
  }
});

test('statistiques.weeklyProgress: contenus_publies compte uniquement les PUBLISH_POST réellement confirmés PUBLIE (pas EN_TRAITEMENT, pas resultat=succes seul)', async () => {
  // AUDIT Phase 2 : memory.recordExecution() perdait silencieusement le
  // champ statut_sortie (absent de son whitelist d'insertion) - ce test
  // reposait donc sur `resultat === 'succes'` seul, qui compte a tort
  // NON_EXECUTE_*/EN_TRAITEMENT comme "publie". Corrige : statut_sortie
  // est desormais persiste, et contenus_publies exige explicitement
  // statut_sortie === 'PUBLIE' (une vraie confirmation), jamais un simple
  // resultat='succes' (qui couvre aussi EN_TRAITEMENT, cf. taskEngine.js).
  await operationalState.setWeeklyObjectives({ contenus_publies: 3 });
  await memory.recordExecution({ workflow: 'test', declencheur: 'campaign', agent: 'system', action: 'PUBLISH_POST', resultat: 'succes', statut_sortie: 'PUBLIE', duree_ms: 10 });
  await memory.recordExecution({ workflow: 'test', declencheur: 'campaign', agent: 'system', action: 'PUBLISH_POST', resultat: 'succes', statut_sortie: 'EN_TRAITEMENT', duree_ms: 10 });
  await memory.recordExecution({ workflow: 'test', declencheur: 'campaign', agent: 'system', action: 'PUBLISH_POST', resultat: 'echec', statut_sortie: 'ECHEC', duree_ms: 10 });
  await memory.recordExecution({ workflow: 'test', declencheur: 'campaign', agent: 'system', action: 'SEND_MESSAGE', resultat: 'succes', statut_sortie: 'ENVOYE', duree_ms: 10 });
  const progres = await statistiques.weeklyProgress({});
  assert.equal(progres.output.progres.contenus_publies.actuel, 1);
  assert.equal(progres.output.progres.contenus_publies.objectif, 3);
  assert.equal(progres.output.progres.contenus_publies.pourcentage, Math.round((1 / 3) * 1000) / 10);
});

test('statistiques.weeklyProgress: pourcentage supérieur à 100% quand l’objectif est dépassé, jamais plafonné', async () => {
  const now = new Date();
  await memory.insert(memory.COLLECTIONS.METRICS, { source: 'test_depassement', date: now.toISOString().slice(0, 10), at: now.toISOString(), ventes: 50 });
  await operationalState.setWeeklyObjectives({ ventes: 10 });
  const progres = await statistiques.weeklyProgress({});
  assert.ok(progres.output.progres.ventes.pourcentage > 100, `attendu >100%, obtenu ${progres.output.progres.ventes.pourcentage}`);
});

test('statistiques.periodComparison: offset permet de naviguer dans les semaines précédentes sans écraser les données', async () => {
  const current = await statistiques.periodComparison({ granularite: 'semaine', offset: 0 });
  const previous = await statistiques.periodComparison({ granularite: 'semaine', offset: 1 });
  assert.equal(current.output.offset, 0);
  assert.equal(previous.output.offset, 1);
  assert.equal(current.output.periode_precedente.debut, previous.output.periode_actuelle.debut);
  assert.equal(current.output.periode_precedente.fin, previous.output.periode_actuelle.fin);
});

test('statistiques.periodComparison: comparaison_possible est false et variation_pourcentage null quand la période précédente est vide', async () => {
  const lointain = await statistiques.periodComparison({ granularite: 'semaine', offset: 500 });
  for (const field of statistiques.NUMERIC_FIELDS) {
    const c = lointain.output.comparaison[field];
    if (c.periode_precedente === 0) {
      assert.equal(c.comparaison_possible, false);
      assert.equal(c.variation_pourcentage, null);
    }
  }
});
