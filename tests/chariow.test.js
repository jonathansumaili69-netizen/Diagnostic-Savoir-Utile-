'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ISOLATION (correction audit externe - probleme 2, hygiene des donnees) :
// sans ceci, le fallback JSON ecrivait directement dans <projet>/data/,
// laissant des residus de test ("vente_test_001", etc.) dans le dossier
// livre avec le projet. Chaque fichier de test doit utiliser un dossier
// temporaire isole, jamais le dossier data/ du depot lui-meme.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-chariow-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

const memory = require('../src/core/memory');

test('chariow.status: honnête quand CHARIOW_API_KEY n’est pas configurée', async () => {
  delete process.env.CHARIOW_API_KEY;
  delete require.cache[require.resolve('../src/core/config')];
  delete require.cache[require.resolve('../src/core/chariow')];
  const { config } = require('../src/core/config');
  const chariow = require('../src/core/chariow');
  assert.equal(config.chariow.apiKey, '');
  const st = chariow.status();
  assert.equal(st.configure, false);
  assert.equal(st.statut, 'cle_api_manquante');
  const synced = await chariow.syncSales();
  assert.equal(synced.configured, false);
  assert.equal(synced.imported, 0);
});

test('chariow: CHARIOW_API_KEY est bien lue depuis config.js (régression du bug "config.chariow" manquant)', () => {
  process.env.CHARIOW_API_KEY = 'test-cle-chariow';
  process.env.CHARIOW_STORE_ID = 'boutique-test';
  delete require.cache[require.resolve('../src/core/config')];
  delete require.cache[require.resolve('../src/core/chariow')];
  const { config } = require('../src/core/config');
  const chariow = require('../src/core/chariow');
  // AUDIT V7 : avant la correction de config.js, config.chariow était
  // "undefined" et cette assertion aurait échoué même avec la variable
  // d'environnement correctement définie.
  assert.equal(config.chariow.apiKey, 'test-cle-chariow');
  const st = chariow.status();
  assert.equal(st.configure, true);
  assert.equal(st.boutique, 'boutique-test');
  delete process.env.CHARIOW_API_KEY;
  delete process.env.CHARIOW_STORE_ID;
  delete require.cache[require.resolve('../src/core/config')];
  delete require.cache[require.resolve('../src/core/chariow')];
});

test('chariow.syncSales: synchronise réellement les ventes reçues et reste idempotent', async () => {
  process.env.CHARIOW_API_KEY = 'test-cle-chariow-2';
  delete require.cache[require.resolve('../src/core/config')];
  delete require.cache[require.resolve('../src/core/chariow')];
  const chariow = require('../src/core/chariow');

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      data: [
        { id: 'vente_test_001', amount: 15, currency: 'USD', status: 'successful', created_at: new Date().toISOString() },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const first = await chariow.syncSales();
    assert.equal(first.configured, true);
    assert.equal(first.imported, 1);

    const rows = await memory.list(memory.COLLECTIONS.CONTENT, { limit: 300 });
    const saved = rows.find((r) => r.data.kind === 'chariow_sale' && r.data.sale_id === 'vente_test_001');
    assert.ok(saved, 'la vente doit être persistée');
    assert.equal(saved.data.amount, 15);
    assert.equal(saved.data.currency, 'USD');

    // Deuxième synchronisation avec la même vente : ne doit pas dupliquer.
    const second = await chariow.syncSales();
    assert.equal(second.imported, 0);
    const rowsAfter = await memory.list(memory.COLLECTIONS.CONTENT, { limit: 300 });
    const count = rowsAfter.filter((r) => r.data.kind === 'chariow_sale' && r.data.sale_id === 'vente_test_001').length;
    assert.equal(count, 1, 'aucune duplication attendue au second sync');
    assert.ok(calls >= 2);
  } finally {
    global.fetch = originalFetch;
    delete process.env.CHARIOW_API_KEY;
    delete require.cache[require.resolve('../src/core/config')];
    delete require.cache[require.resolve('../src/core/chariow')];
  }
});

test('chariowStats.summarize: signale honnêtement quand le champ montant n’est pas détecté', () => {
  const chariowStats = require('../src/core/chariowStats');
  const resume = chariowStats.summarize([{ id: 'x', unknown_field: 42 }]);
  assert.equal(resume.mapping_confidence, 'aucun_champ_montant_detecte');
  assert.match(resume.avertissement, /non calculable/);
});

test('chariowStats.summarize: agrège correctement quand les champs sont présents', () => {
  const chariowStats = require('../src/core/chariowStats');
  const resume = chariowStats.summarize([
    { id: 'a', amount: 10, currency: 'USD', status: 'successful' },
    { id: 'b', amount: 5, currency: 'USD', status: 'successful' },
    { id: 'c', amount: 999, currency: 'USD', status: 'failed' },
  ]);
  assert.equal(resume.chiffre_affaires_par_devise.USD, 15);
  assert.equal(resume.nombre_ventes_considerees_reussies, 2);
});
