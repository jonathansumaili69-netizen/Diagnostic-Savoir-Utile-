'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ISOLATION (voir tests/chariow.test.js pour l'explication complete) :
// jamais le dossier data/ du depot lui-meme.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-planner-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;

const planner = require('../src/core/planner');
const operationalState = require('../src/core/operationalState');
const killswitch = require('../src/core/killswitch');

async function resetSettings() {
  // Reinitialisation complete et explicite : normalizeSettings fusionne
  // toujours avec les reglages precedents (design voulu pour des mises a
  // jour partielles depuis le dashboard), donc un helper de test doit
  // remettre EXPLICITEMENT chaque champ a son etat neutre plutot que de
  // compter sur un simple {enabled:false} qui laisserait fuiter
  // allowed_hours/allowed_platforms/quality_min_score d'un test au suivant.
  await operationalState.setSettings({
    mode: 'silencio',
    campaign: { enabled: false, allowed_platforms: [], allowed_hours: [], max_publications_per_day: 0, quality_min_score: 85, requires_approval: true },
  });
  await killswitch.setStatus({ engage: false, raison: 'reset test', confirmation: true }).catch(() => {});
}

test('planner.QUALITY_FALLBACK vaut bien 85 (audit V7 : était 70 par erreur)', () => {
  assert.equal(planner.QUALITY_FALLBACK, 85);
});

test('planner.checkAction: refuse si le kill switch est engagé, priorité absolue', async () => {
  await resetSettings();
  await operationalState.setSettings({ mode: 'conquistador', campaign: { enabled: true, allowed_platforms: ['tiktok'], max_publications_per_day: 5, quality_min_score: 50 } });
  await killswitch.setStatus({ engage: true, raison: 'test priorite' });
  const gate = await planner.checkAction({ actionType: 'PUBLISH_POST', platform: 'tiktok', qualityScore: 99 });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /Kill switch/);
  await resetSettings();
});

test('planner.checkAction: refuse hors mode Conquistador même si tout le reste est correct', async () => {
  await resetSettings();
  await operationalState.setSettings({ mode: 'copilot', campaign: { enabled: true, allowed_platforms: ['tiktok'], max_publications_per_day: 5 } });
  const gate = await planner.checkAction({ actionType: 'PUBLISH_POST', platform: 'tiktok', qualityScore: 99 });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /Conquistador/);
  await resetSettings();
});

test('planner.checkAction: refuse une plateforme non autorisée', async () => {
  await resetSettings();
  await operationalState.setSettings({ mode: 'conquistador', campaign: { enabled: true, allowed_platforms: ['tiktok'], max_publications_per_day: 5, quality_min_score: 50 } });
  const gate = await planner.checkAction({ actionType: 'PUBLISH_POST', platform: 'facebook', qualityScore: 99 });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /plateforme/);
  await resetSettings();
});

test('operationalState.normalizeCampaign: le seuil qualité par défaut (aucune valeur fournie) est bien 85/100', () => {
  const normalized = operationalState.normalizeCampaign({});
  assert.equal(normalized.quality_min_score, 85);
});

test('planner.checkAction: refuse un score de qualité sous le seuil configuré (85 par défaut)', async () => {
  await resetSettings();
  // Seuil fixe explicite (85, le defaut du cahier des charges) plutot que de
  // compter sur l'absence du champ : normalizeSettings fusionne avec les
  // reglages precedents, donc un test isole doit fixer explicitement la
  // valeur qu'il verifie plutot que de dependre d'un "defaut implicite" qui
  // pourrait avoir ete modifie par un test precedent dans le meme fichier.
  await operationalState.setSettings({ mode: 'conquistador', campaign: { enabled: true, allowed_platforms: ['tiktok'], max_publications_per_day: 5, quality_min_score: 85 } });
  const gate = await planner.checkAction({ actionType: 'PUBLISH_POST', platform: 'tiktok', qualityScore: 84 });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /qualit/i);
  await resetSettings();
});

test('planner.checkAction: autorise quand toutes les conditions réelles sont réunies', async () => {
  await resetSettings();
  await operationalState.setSettings({
    mode: 'conquistador',
    campaign: { enabled: true, allowed_platforms: ['tiktok'], max_publications_per_day: 5, quality_min_score: 85, allowed_hours: [] },
  });
  const gate = await planner.checkAction({ actionType: 'PUBLISH_POST', platform: 'tiktok', qualityScore: 90 });
  assert.equal(gate.allowed, true);
  await resetSettings();
});

test('planner.checkAction: respecte une fenêtre horaire qui exclut l’heure actuelle', async () => {
  await resetSettings();
  const { resolveHour } = require('../src/core/timezones');
  const tz = 'Africa/Bujumbura';
  const currentHour = resolveHour(tz);
  const excludedHour = (currentHour + 12) % 24; // heure garantie différente de l'heure actuelle
  await operationalState.setSettings({
    mode: 'conquistador',
    campaign: { enabled: true, allowed_platforms: ['tiktok'], max_publications_per_day: 5, quality_min_score: 50, allowed_hours: [excludedHour], timezone: tz },
  });
  const gate = await planner.checkAction({ actionType: 'PUBLISH_POST', platform: 'tiktok', qualityScore: 90 });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /fenêtre horaire/);
  await resetSettings();
});

test('planner.logAction et getLog: journalisation réelle et consultable', async () => {
  await planner.logAction({ action: 'test_journal', status: 'success', reason: 'verification' });
  const log = await planner.getLog({ limit: 10 });
  assert.ok(log.length >= 1);
  assert.equal(log[0].data.kind, 'planner_action');
});
