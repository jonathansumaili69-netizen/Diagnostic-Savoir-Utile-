'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ISOLATION (voir tests/chariow.test.js pour l'explication complete) :
// jamais le dossier data/ du depot lui-meme.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-weeklyobj-endpoint-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

process.env.CONQUISTADOR_API_KEY = process.env.CONQUISTADOR_API_KEY || 'test-key-dashboard';

const weeklyObjectivesHandler = require('../netlify/functions/weekly-objectives').handler;
const dashboardHandler = require('../netlify/functions/dashboard-data').handler;

function makeEvent({ method = 'GET', body = null, headers = {} } = {}) {
  return { httpMethod: method, body: body ? JSON.stringify(body) : null, headers: { 'x-conquistador-key': process.env.CONQUISTADOR_API_KEY, ...headers } };
}

test('netlify/functions/weekly-objectives: GET renvoie objectifs + progres exploitables par le frontend', async () => {
  const res = await weeklyObjectivesHandler(makeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.objectifs && body.objectifs.objectifs);
  assert.ok(body.progres && body.progres.progres);
  assert.ok(Array.isArray(body.champs_disponibles));
  assert.ok(body.champs_disponibles.includes('contenus_publies'));
});

test('netlify/functions/weekly-objectives: POST enregistre réellement et GET reflète le changement (round-trip complet)', async () => {
  const postRes = await weeklyObjectivesHandler(makeEvent({ method: 'POST', body: { chiffre_affaires: 250, ventes: 8 } }));
  assert.equal(postRes.statusCode, 200);
  const postBody = JSON.parse(postRes.body);
  assert.equal(postBody.objectifs.objectifs.chiffre_affaires, 250);

  const getRes = await weeklyObjectivesHandler(makeEvent({ method: 'GET' }));
  const getBody = JSON.parse(getRes.body);
  assert.equal(getBody.objectifs.objectifs.chiffre_affaires, 250);
  assert.equal(getBody.progres.progres.chiffre_affaires.objectif, 250);
});

test('netlify/functions/dashboard-data: expose bien objectifs_hebdomadaires, progres_hebdomadaire, comparaison_semaine (consommés par app.js)', async () => {
  const res = await dashboardHandler(makeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.objectifs_hebdomadaires, 'objectifs_hebdomadaires manquant');
  assert.ok(body.progres_hebdomadaire && body.progres_hebdomadaire.progres, 'progres_hebdomadaire manquant');
  assert.ok(body.comparaison_semaine && body.comparaison_semaine.comparaison, 'comparaison_semaine manquant');
  assert.ok(body.fuseaux_horaires_disponibles && body.fuseaux_horaires_disponibles.length >= 5);
  // Regression Abidjan : ne doit plus apparaitre dans la liste exposee au dashboard.
  assert.ok(!body.fuseaux_horaires_disponibles.some((c) => c.ville === 'Abidjan'), 'Abidjan ne doit plus être proposée');
  assert.ok(body.fuseaux_horaires_disponibles.some((c) => c.ville === 'Goma'), 'Goma doit rester disponible');
});
