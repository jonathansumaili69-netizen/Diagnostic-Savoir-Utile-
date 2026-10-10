'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const provenance = require('../src/core/mediaProvenance');

const tempRoot = path.join(os.tmpdir(), `conquistador-example-exclusion-${process.pid}`);
const exampleRoot = path.join(tempRoot, 'style-reference');
let exampleA;
let exampleB;

function makeSvg({ background, foreground, label }) {
  return Buffer.from(`<svg width="192" height="320" viewBox="0 0 192 320" xmlns="http://www.w3.org/2000/svg">
    <rect width="192" height="320" fill="${background}"/>
    <rect x="18" y="24" width="156" height="164" rx="14" fill="${foreground}"/>
    <circle cx="96" cy="242" r="32" fill="${foreground}"/>
    <text x="96" y="300" text-anchor="middle" font-size="13" fill="#ffffff">${label}</text>
  </svg>`);
}

test.before(async () => {
  await fs.mkdir(exampleRoot, { recursive: true });
  exampleA = await sharp(makeSvg({ background: '#1c2b45', foreground: '#e7b552', label: 'EXEMPLE A' })).png().toBuffer();
  exampleB = await sharp(makeSvg({ background: '#f0e6d7', foreground: '#31506a', label: 'EXEMPLE B' })).png().toBuffer();
  await fs.writeFile(path.join(exampleRoot, 'exemple-a.png'), exampleA);
  await fs.writeFile(path.join(exampleRoot, 'exemple-b.png'), exampleB);
  provenance.clearIndexCache(exampleRoot);
});

test('deux images d’exemple accessibles sont indexées séparément', async () => {
  const index = await provenance.styleExampleIndex(exampleRoot);
  assert.equal(index.length, 2);
  assert.deepEqual(index.map((item) => item.id), ['exemple-a.png', 'exemple-b.png']);
});

test('deux exemples ne peuvent pas être sélectionnés comme scènes de production', async () => {
  const audit = await provenance.auditAssetCollection([
    { scene_id: 'scene-a', asset_type: 'AI_IMAGE_GENERATED', buffer: exampleA },
    { scene_id: 'scene-b', asset_type: 'AI_IMAGE_GENERATED', buffer: exampleB },
  ], { exampleRoot });

  assert.equal(audit.ok, false);
  assert.equal(audit.assets_checked, 2);
  assert.equal(audit.rejected.length, 2);
  assert.ok(audit.rejected.every((item) => item.example_matches.length === 1));
  assert.deepEqual(audit.rejected.map((item) => item.example_matches[0].match), ['SHA256_EXACT', 'SHA256_EXACT']);
});

test('l’audit des frames bloque les deux exemples s’ils apparaissent dans le MP4', async () => {
  const audit = await provenance.auditRenderedFrames([
    { scene_id: 'rendered-a', time_seconds: 1, buffer: exampleA },
    { scene_id: 'rendered-b', time_seconds: 2, buffer: exampleB },
  ], { exampleRoot });

  assert.equal(audit.ok, false);
  assert.equal(audit.frames_checked, 2);
  assert.deepEqual(audit.rejected.map((frame) => frame.example_matches[0].match), ['SHA256_EXACT', 'SHA256_EXACT']);
});

test('une scène originale passe tandis que le SHA de l’image café de l’ancien job est bloqué', async () => {
  const original = await sharp(makeSvg({ background: '#184f3a', foreground: '#e8f0e5', label: 'ORIGINAL' })).png().toBuffer();
  const originalAudit = await provenance.auditAssetCollection([
    { scene_id: 'scene-originale', asset_type: 'AI_IMAGE_GENERATED', buffer: original },
  ]);
  assert.equal(originalAudit.ok, true);
  assert.equal(originalAudit.examples_available, 9, 'l’index de production inclut le style fourni et les huit images de l’ancien job');

  const index = await provenance.styleExampleIndex();
  const coffee = index.find((item) => item.id === 'stale-job-56059bc2/s08-suivi-1791204725152');
  assert.ok(coffee, 'l’image à la tasse doit rester enregistrée comme exemple interdit');
  const coffeeAudit = await provenance.inspectAsset({ asset: {
    asset_type: 'AI_IMAGE_GENERATED',
    content_sha256: coffee.sha256,
  } });
  assert.equal(coffeeAudit.ok, false);
  assert.equal(coffeeAudit.example_matches[0].match, 'SHA256_EXACT');
});

test('le fichier source corrompu dans style-reference reste bloqué par son chemin et son SHA', async () => {
  const source = path.join(provenance.DEFAULT_STYLE_EXAMPLE_ROOT, 'exemple-01-chambre-inquiet.png');
  const audit = await provenance.inspectAsset({
    asset: { asset_type: 'AI_IMAGE_GENERATED', source_path: source },
  });
  assert.equal(audit.ok, false);
  assert.equal(audit.source_category, 'STYLE_EXAMPLE');
  assert.ok(audit.failures.some((failure) => /style-reference/.test(failure)));
  assert.ok(audit.example_matches.some((match) => match.match === 'SHA256_EXACT'));
});

test.after(async () => {
  provenance.clearIndexCache(exampleRoot);
  await fs.rm(tempRoot, { recursive: true, force: true });
});
