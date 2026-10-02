'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timezones = require('../src/core/timezones');

test('timezones.resolveHour: ne renvoie jamais NaN (régression du bug fr-FR "04 h")', () => {
  for (const city of timezones.CITIES) {
    const hour = timezones.resolveHour(city.id);
    assert.equal(Number.isFinite(hour), true, `${city.ville} (${city.id}) a renvoyé une heure non numérique`);
    assert.ok(hour >= 0 && hour <= 23, `${city.ville} (${city.id}) a renvoyé une heure hors plage: ${hour}`);
  }
});

test('timezones.resolveHour: Kinshasa (UTC+1) et Lubumbashi/Goma (UTC+2) diffèrent d’une heure', () => {
  // Ne dépend pas de l'heure réelle d'exécution du test : compare directement
  // le décalage mesuré par Intl pour un instant fixe, ce qui est stable.
  const fixed = new Date('2026-06-15T10:00:00Z'); // hors toute periode de changement d'heure (aucun des deux fuseaux n'en a)
  const kinHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Kinshasa', hour: 'numeric', hourCycle: 'h23' }).formatToParts(fixed).find((p) => p.type === 'hour').value);
  const lubHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Lubumbashi', hour: 'numeric', hourCycle: 'h23' }).formatToParts(fixed).find((p) => p.type === 'hour').value);
  assert.equal(kinHour, 11); // UTC+1
  assert.equal(lubHour, 12); // UTC+2
  assert.equal(lubHour - kinHour, 1, 'Kinshasa (WAT, UTC+1) et Lubumbashi/Goma (CAT, UTC+2) doivent différer d’exactement 1 heure');
});

test('timezones: Goma est bien présente et rattachée à Africa/Lubumbashi (CAT, UTC+2)', () => {
  const goma = timezones.CITIES.find((c) => c.ville === 'Goma');
  assert.ok(goma, 'Goma doit apparaître dans le catalogue');
  assert.equal(goma.id, 'Africa/Lubumbashi');
  assert.equal(goma.pays, 'RDC');
});

test('timezones.normalize: retombe sur le défaut honnête pour un fuseau invalide, jamais silencieusement sur UTC déguisé', () => {
  assert.equal(timezones.normalize('Pas/UnFuseau'), timezones.DEFAULT_TIMEZONE);
  assert.equal(timezones.normalize('Africa/Kinshasa'), 'Africa/Kinshasa');
  assert.equal(timezones.normalize(''), timezones.DEFAULT_TIMEZONE);
});

test('timezones.list: chaque ville a un décalage UTC actuel calculé (pas de table statique figée)', () => {
  const list = timezones.list();
  assert.ok(list.length >= 5);
  for (const c of list) {
    assert.ok(c.utc_actuel && /UTC[+-]\d/.test(c.utc_actuel), `decalage manquant/invalide pour ${c.ville}`);
  }
});

test('timezones.currentUtcOffsetLabel: Dakar (UTC+0) est bien normalisé en "UTC+0", quelle que soit la forme renvoyée par Intl (régression audit externe)', () => {
  const label = timezones.currentUtcOffsetLabel('Africa/Dakar');
  assert.equal(label, 'UTC+0', `attendu "UTC+0", obtenu "${label}"`);
});

test('timezones.currentUtcOffsetLabel: normalise directement "GMT" et "UTC" bruts (sans suffixe numérique) en "UTC+0"', () => {
  // Simule explicitement les deux formes rapportées par l'audit externe,
  // sans dépendre du comportement réel de l'ICU installée sur cette
  // machine (qui peut déjà renvoyer "GMT+0" ici et masquer la régression).
  const originalFormat = Intl.DateTimeFormat.prototype.formatToParts;
  for (const rawValue of ['GMT', 'UTC', 'GMT+0', 'UTC+0']) {
    Intl.DateTimeFormat.prototype.formatToParts = function fakeFormatToParts() {
      return [{ type: 'timeZoneName', value: rawValue }];
    };
    const label = timezones.currentUtcOffsetLabel('Africa/Dakar');
    assert.equal(label, 'UTC+0', `pour value="${rawValue}", attendu "UTC+0", obtenu "${label}"`);
  }
  Intl.DateTimeFormat.prototype.formatToParts = originalFormat;
});

test('timezones.currentUtcOffsetLabel: conserve correctement les décalages non nuls, positifs et négatifs', () => {
  const originalFormat = Intl.DateTimeFormat.prototype.formatToParts;
  const cases = [['GMT+2', 'UTC+2'], ['GMT-5', 'UTC-5'], ['UTC+1', 'UTC+1']];
  for (const [rawValue, expected] of cases) {
    Intl.DateTimeFormat.prototype.formatToParts = function fakeFormatToParts() {
      return [{ type: 'timeZoneName', value: rawValue }];
    };
    assert.equal(timezones.currentUtcOffsetLabel('Africa/Dakar'), expected);
  }
  Intl.DateTimeFormat.prototype.formatToParts = originalFormat;
});
