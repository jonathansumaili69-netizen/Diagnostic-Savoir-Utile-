'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('bouton Connecter: affiche uniquement si non connecte ET flux OAuth existant', () => {
  assert.match(appJs, /!c\.connecte && CONNECTOR_OAUTH_FLOWS\[c\.plateforme\]/,
    'le bouton ne doit apparaitre que pour une plateforme non connectee avec flux existant');
  assert.match(appJs, /data-connect-platform/);
  assert.match(appJs, /Connecter<\/button>/);
});

test('bouton Connecter: reutilise les flux OAuth existants, aucun nouveau flux', () => {
  assert.match(appJs, /facebook:\s*\{\s*start:\s*\(\)\s*=>\s*startMetaOAuth\(\)/);
  assert.match(appJs, /instagram:\s*\{\s*start:\s*\(\)\s*=>\s*startMetaOAuth\(\)/);
  assert.match(appJs, /youtube:\s*\{\s*start:\s*\(\)\s*=>\s*startYoutubeOAuth\(\)/);
  assert.match(appJs, /tiktok:\s*\{\s*start:\s*\(\)\s*=>\s*startTiktokOAuth\(\)/);
  // Les fonctions existantes appellent bien les endpoints OAuth existants.
  assert.match(appJs, /api\('\/meta\/oauth\/start'\)/);
  assert.match(appJs, /api\('\/youtube\/oauth\/start'\)/);
  assert.match(appJs, /api\('\/tiktok\/oauth\/start'\)/);
});

test('bouton Connecter: etat de chargement puis retour a l etat normal', () => {
  assert.match(appJs, /Connexion\\u2026|Connexion…/, 'etat de chargement pendant le demarrage OAuth');
  assert.match(appJs, /button\.disabled = true/);
  assert.match(appJs, /button\.disabled = false/);
});

test('bouton Connecter: gestion d erreur sans casser l interface', () => {
  assert.match(appJs, /async function startConnectorOAuth/);
  assert.match(appJs, /catch \(err\)/);
  assert.match(appJs, /el\.querySelectorAll\('\.connect-connector-btn'\)/);
});

test('bouton Connecter: style coherent avec le design existant', () => {
  assert.match(styleCss, /\.entry-actions button\.connect-connector-btn/);
});

test('non-regression: les controles existants restent presents', () => {
  for (const marker of [
    'metaConnectBtn', 'metaDisconnectBtn', 'youtubeConnectBtn', 'youtubeDisconnectBtn',
    'tiktokConnectBtn', 'tiktokDisconnectBtn', 'test-connector-btn', 'refreshConnectors',
  ]) {
    assert.ok(appJs.includes(marker) || indexHtml.includes(marker), `controle existant conserve: ${marker}`);
  }
  // Aucun secret ni token dans le code frontend (les NOMS de variables dans
  // les textes d'aide de index.html sont de la documentation, pas des secrets).
  for (const forbidden of ['META_APP_SECRET', 'YOUTUBE_CLIENT_SECRET', 'SUPABASE_SERVICE_KEY', 'TOKEN_ENCRYPTION_KEY']) {
    assert.ok(!appJs.includes(forbidden), `secret interdit dans app.js: ${forbidden}`);
  }
  assert.ok(!indexHtml.includes('Bearer '), 'aucun token Bearer en dur dans index.html');
  // Le routeur de vues existant n'est pas remplace.
  assert.match(appJs, /function setActiveView\(/);
  assert.match(appJs, /function initViewRouter\(/);
});
