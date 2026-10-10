'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { test } = require('node:test');
const productEndCard = require('../src/core/productEndCard');

test('productEndCard.compose: garde la couverture officielle et la CTA dans une image verticale', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conquistador-end-card-'));
  const backgroundPath = path.join(dir, 'background.png');
  const outputPath = path.join(dir, 'end-card.png');
  try {
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#20334a' } }).png().toFile(backgroundPath);
    const result = await productEndCard.compose({
      backgroundPath, outputPath, width: 720, height: 1280,
      title: 'Décrocher un emploi', brand: 'Savoir Utile', cta: 'Découvre le guide',
    });
    const metadata = await sharp(outputPath).metadata();
    assert.equal(metadata.width, 720);
    assert.equal(metadata.height, 1280);
    assert.equal(result.productUrl, 'https://savoir-utile.mychariow.shop/prd_s33t0e');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
