'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join('/tmp', `conquistador-commercial-followup-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.CONQUISTADOR_DATA_DIR = dataDir;
process.env.CONQUISTADOR_API_KEY = 'test-commercial-key';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

const commercial = require('../src/agents/commercial');
const operationalState = require('../src/core/operationalState');


test('commercial.prepareFollowup: prépare une relance bornée et sans envoi', async () => {
  const result = await commercial.prepareFollowup({
    contact_key: 'prospect-42',
    nom: 'Awa',
    sujet: 'le guide CV',
    plateforme: 'linkedin',
    delai_jours: 9,
  });
  assert.equal(result.output.statut, 'RELANCE_PREPAREE');
  assert.equal(result.output.delai_jours, 7);
  assert.equal(result.output.envoi_effectue, false);
  assert.equal(result.output.approbation_requise_pour_envoi, true);
  assert.match(result.output.message, /Bonjour Awa/);
  assert.equal(result.provider, null);
  assert.ok(result.output.persistence_id);
  assert.deepEqual(result.output.profil_commercial.axes_a_documenter, commercial.COMMERCIAL_PROFILE_FOCUS);
  assert.equal(JSON.stringify(result.output).includes('api_key'), false);
});

test('commercial.detectCommentIntent: expose les faits réels du guide sans promesse garantie', async () => {
  const result = await commercial.detectCommentIntent({ commentaire: 'Je veux le guide et le lien', plateforme: 'tiktok' });
  assert.equal(result.output.guide.pages, 187);
  assert.equal(result.output.guide.lien, commercial.PRODUCT_FACTS.product_url);
  assert.ok(result.output.guide.benefices_documentes.includes('structurer sa recherche d’emploi'));
  assert.doesNotMatch(JSON.stringify(result.output), /emploi garanti|salaire garanti|promesse garantie/i);
});

test('commercial.prepareFollowup: la relance est retrouvable dans la mémoire additive', async () => {
  const rows = await operationalState.listCommercialFollowups({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.kind, 'commercial_followup');
  assert.equal(rows[0].data.contact_key, 'prospect-42');
  assert.equal(rows[0].data.status, 'prepared');
});
