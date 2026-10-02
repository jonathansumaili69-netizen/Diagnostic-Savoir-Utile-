'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const graphicEngine = require('../src/core/graphicEngine');

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

test('graphicEngine: rend un titre en PNG reel (dimensions et signature correctes)', async () => {
  const result = await graphicEngine.render('title', { title: 'Un titre de test', subtitle: 'Sous-titre', mode: 'conquistador', width: 400, height: 600 });
  assert.equal(isPng(result.buffer), true);
  assert.equal(result.width, 400);
  assert.equal(result.height, 600);
});

test('graphicEngine: rend une carte statistique, citation et barres', async () => {
  const stat = await graphicEngine.render('stat', { value: '42%', label: 'Test', width: 300, height: 300 });
  assert.equal(isPng(stat.buffer), true);
  const quote = await graphicEngine.render('quote', { quote: 'Une citation de test suffisamment longue pour forcer un retour a la ligne', author: 'Auteur', width: 400, height: 400 });
  assert.equal(isPng(quote.buffer), true);
  const bars = await graphicEngine.render('bar_chart', { title: 'Progression', bars: [{ label: 'A', value: 1 }, { label: 'B', value: 5 }], width: 400, height: 400 });
  assert.equal(isPng(bars.buffer), true);
});

test('graphicEngine: type de template inconnu leve une erreur explicite', async () => {
  await assert.rejects(() => graphicEngine.render('inconnu', {}), /type de template inconnu/);
});

test('graphicEngine: refuse des dimensions excessives plutot que de produire un fichier demesure', async () => {
  await assert.rejects(() => graphicEngine.render('title', { title: 'x', width: 9000, height: 9000 }), /dimensions maximales/);
});

test('graphicEngine.wrapText: ne coupe jamais un mot et respecte la longueur maximale', () => {
  const lines = graphicEngine.wrapText('Ceci est un test de decoupage de texte assez long', 15);
  for (const line of lines) {
    assert.ok(line.length <= 15 || !line.includes(' '), `ligne trop longue et coupable : "${line}"`);
  }
  assert.equal(lines.join(' ').replace(/\s+/g, ' '), 'Ceci est un test de decoupage de texte assez long');
});

test('graphicEngine: la meme entree utilise une palette differente selon le mode', async () => {
  const silencio = await graphicEngine.render('title', { title: 'X', mode: 'silencio', width: 200, height: 200 });
  const conquistador = await graphicEngine.render('title', { title: 'X', mode: 'conquistador', width: 200, height: 200 });
  assert.notDeepEqual(silencio.buffer, conquistador.buffer, 'les deux modes doivent produire des visuels distincts');
});
