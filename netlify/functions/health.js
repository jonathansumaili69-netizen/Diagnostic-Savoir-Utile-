'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const memory = require('../../src/core/memory');
const { config } = require('../../src/core/config');

exports.handler = wrapHandler(async () => {
  return json(200, {
    statut: 'operationnel',
    heure: new Date().toISOString(),
    memoire_backend: memory.currentBackend(),
    fournisseurs_ia: {
      ordre: ['gemini', 'groq', 'openrouter', 'mock'],
      gemini: Boolean(config.ai.geminiApiKey),
      groq: Boolean(config.ai.groqApiKey),
      openrouter: Boolean(config.ai.openrouterApiKey),
      mock: true,
      mock_disponible: true,
    },
    api_key_configuree: Boolean(config.apiKey),
  });
});
