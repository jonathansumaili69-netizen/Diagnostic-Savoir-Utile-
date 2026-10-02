'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ISOLATION (voir tests/planner.test.js) : jamais le dossier data/ du depot.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-scheduler-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;

const { tick } = require('../netlify/functions/scheduler-tick');
const operationalState = require('../src/core/operationalState');
const killswitch = require('../src/core/killswitch');
const socialConnectors = require('../src/core/socialConnectors');
const planner = require('../src/core/planner');

async function activateCampaign(overrides = {}) {
  await operationalState.setSettings({
    mode: 'conquistador',
    campaign: {
      enabled: true,
      allowed_platforms: ['facebook'],
      allowed_hours: [],
      max_publications_per_day: 10,
      quality_min_score: 85,
      requires_approval: false,
      timezone: 'Africa/Bujumbura',
      ...overrides,
    },
  });
  await killswitch.setStatus({ engage: false, raison: 'reset test', confirmation: true }).catch(() => {});
}

let publishCalls = 0;
function mockPublishOnce() {
  publishCalls = 0;
  const previous = socialConnectors.activeClientFor;
  socialConnectors.activeClientFor = async () => ({
    publish: async () => {
      publishCalls += 1;
      return { id: `post-${publishCalls}` };
    },
  });
  return previous;
}

test('scheduler.tick : PUBLIE au premier cycle, ne republie JAMAIS le meme contenu au cycle suivant (bug de republication)', async () => {
  await activateCampaign();
  const previous = mockPublishOnce();
  try {
    await operationalState.saveVideoReview(
      {
        conforme: true,
        publication_autorisee: true,
        score_qualite: 95,
        contenu_prepare: 'Texte pret',
        video: { platform: 'facebook' },
      },
      { contentKey: 'contenu-idempotence-1' },
    );

    const firstTick = await tick();
    assert.equal(firstTick.publications.length, 1, 'le premier cycle doit publier');
    assert.equal(firstTick.publications[0].statut, 'PUBLIE');
    assert.equal(publishCalls, 1);

    const secondTick = await tick();
    assert.equal(secondTick.publications.length, 0, 'le deuxieme cycle ne doit RIEN republier');
    assert.equal(publishCalls, 1, 'le connecteur ne doit pas etre rappele pour le meme contenu');

    const thirdTick = await tick();
    assert.equal(thirdTick.publications.length, 0, 'un troisieme cycle confirme la non-republication');
    assert.equal(publishCalls, 1);
  } finally {
    socialConnectors.activeClientFor = previous;
  }
});

test('scheduler.tick : planner.getPublishedContentKeys() reconstruit l’historique meme sans le flag local review.publie', async () => {
  await activateCampaign();
  const previous = mockPublishOnce();
  try {
    await operationalState.saveVideoReview(
      {
        conforme: true,
        publication_autorisee: true,
        score_qualite: 95,
        contenu_prepare: 'Texte pret',
        video: { platform: 'facebook' },
      },
      { contentKey: 'contenu-idempotence-2' },
    );
    await tick();
    const keys = await planner.getPublishedContentKeys();
    assert.ok(keys.has('contenu-idempotence-2::facebook'), 'la cle composite content_key::plateforme doit etre journalisee');
  } finally {
    socialConnectors.activeClientFor = previous;
  }
});

test('planner.getPublishedContentKeys : le meme content_key publie sur deux plateformes distinctes donne deux entrees separees (pas un doublon)', async () => {
  await planner.logAction({ action: 'publish', content_key: 'x-multi-plateforme', plateforme: 'facebook', status: 'success' });
  await planner.logAction({ action: 'publish', content_key: 'x-multi-plateforme', plateforme: 'youtube', status: 'success' });
  const keys = await planner.getPublishedContentKeys();
  assert.ok(keys.has('x-multi-plateforme::facebook'), 'la publication Facebook doit etre journalisee sous sa propre cle');
  assert.ok(keys.has('x-multi-plateforme::youtube'), 'la publication YouTube (meme content_key) ne doit PAS etre confondue avec Facebook');
  // Les deux paires sont bien distinctes : le nombre total de cles pour ce
  // content_key doit etre 2, pas 1 (sinon la plateforme serait ignoree
  // dans la cle d'idempotence).
  const matching = [...keys].filter((k) => k.startsWith('x-multi-plateforme::'));
  assert.equal(matching.length, 2);
});

test('scheduler.tick : une publication echouee reste eligible a un nouvel essai (pas marquee comme publiee)', async () => {
  await activateCampaign();
  const previous = socialConnectors.activeClientFor;
  socialConnectors.activeClientFor = async () => ({
    publish: async () => {
      throw new Error('panne fournisseur simulee');
    },
  });
  try {
    await operationalState.saveVideoReview(
      {
        conforme: true,
        publication_autorisee: true,
        score_qualite: 95,
        contenu_prepare: 'Texte pret',
        video: { platform: 'facebook' },
      },
      { contentKey: 'contenu-echec-retry' },
    );
    const first = await tick();
    assert.equal(first.publications.length, 0, 'un echec ne doit pas apparaitre comme publication reussie');
    const keys = await planner.getPublishedContentKeys();
    assert.equal(keys.has('contenu-echec-retry::facebook'), false, 'un echec ne doit jamais etre marque comme publie');
  } finally {
    socialConnectors.activeClientFor = previous;
  }
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
