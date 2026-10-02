'use strict';

const { config, int } = require('./config');
const { logger } = require('./logger');
const aiProviders = require('./aiProviders');

/**
 * Couche d'abstraction du fournisseur IA (section 15 du prompt maitre V1, et
 * sections 3-7 du prompt maitre V1.1 - fournisseurs multiples + routage).
 * Ordre de bascule par defaut : GEMINI -> GROQ -> OPENROUTER -> MOCK, avec
 * routage specialise possible par profil de tache (voir aiProviders.js et
 * docs/AI_PROVIDERS.md pour la justification complete du classement).
 * Chaque fournisseur est isole dans sa propre fonction pour pouvoir en
 * ajouter ou en retirer un facilement (AI_PROVIDERS + abstraction).
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Timeout par fournisseur (section 6, boost pass), configurable pour
// s'adapter aux limites de la plateforme d'hebergement (ex: fonctions
// Netlify Free limitees a 10s d'execution totale - un timeout de 25s par
// defaut reste pertinent en local/dev ou sur un plan permettant des
// fonctions plus longues, mais peut etre reduit via env si necessaire).
const PROVIDER_TIMEOUT_MS = int(process.env.AI_PROVIDER_TIMEOUT_MS, 25000);
// Nombre de tentatives supplementaires (retry controle) avant de passer au
// fournisseur suivant - seulement pour les erreurs reseau/temporaires,
// jamais pour une cle manquante ou un quota explicitement depasse (inutile
// de reessayer immediatement la meme requete dans ce cas).
const PROVIDER_MAX_RETRIES = int(process.env.AI_PROVIDER_MAX_RETRIES, 1);

class AIProviderError extends Error {
  constructor(provider, message, cause) {
    super(`[${provider}] ${message}`);
    this.provider = provider;
    this.cause = cause;
  }
}

/**
 * Classifie une erreur pour l'observabilite (section 6 et 14) : quota
 * depasse, erreur reseau/timeout, ou autre. N'affecte pas le comportement
 * de bascule (qui reste : tout echec passe au fournisseur suivant), mais
 * permet de journaliser une raison precise plutot qu'un message brut.
 */
function classifyError(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit') || msg.includes('rate_limit')) {
    return 'quota_depasse';
  }
  if (msg.includes('abort') || msg.includes('timeout') || msg.includes('etimedout')) {
    return 'timeout';
  }
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network') || msg.includes('fetch failed')) {
    return 'erreur_reseau';
  }
  if (msg.includes('non configuree')) {
    return 'non_configure';
  }
  return 'autre';
}

/** Une erreur "temporaire" merite un retry controle ; une erreur de config/quota non. */
function isRetryable(errorType) {
  return errorType === 'timeout' || errorType === 'erreur_reseau';
}

async function callGroq({ system, prompt, temperature, maxTokens }) {
  if (!config.ai.groqApiKey) {
    throw new AIProviderError('groq', 'GROQ_API_KEY non configuree');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.groqApiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.groqModel,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens ?? 1024,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AIProviderError('groq', `HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new AIProviderError('groq', 'Reponse vide');
    return { text, provider: 'groq', model: config.ai.groqModel, raw: json };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini({ system, prompt, temperature, maxTokens }) {
  if (!config.ai.geminiApiKey) {
    throw new AIProviderError('gemini', 'GEMINI_API_KEY non configuree');
  }
  const url = `${GEMINI_URL_BASE}/${config.ai.geminiModel}:generateContent?key=${config.ai.geminiApiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(system
          ? { systemInstruction: { parts: [{ text: system }] } }
          : {}),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: temperature ?? 0.7,
          maxOutputTokens: maxTokens ?? 1024,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AIProviderError('gemini', `HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
    if (!text) throw new AIProviderError('gemini', 'Reponse vide');
    return { text, provider: 'gemini', model: config.ai.geminiModel, raw: json };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * OpenRouter : troisieme fournisseur gratuit (voir docs/AI_PROVIDERS.md pour
 * la justification de son inclusion et de sa priorite la plus basse parmi
 * les fournisseurs reels). API compatible OpenAI, modele ":free" configurable
 * car le roster gratuit tourne dans le temps.
 */
async function callOpenRouter({ system, prompt, temperature, maxTokens }) {
  if (!config.ai.openrouterApiKey) {
    throw new AIProviderError('openrouter', 'OPENROUTER_API_KEY non configuree');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.openrouterApiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.openrouterModel,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens ?? 1024,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AIProviderError('openrouter', `HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new AIProviderError('openrouter', 'Reponse vide');
    return { text, provider: 'openrouter', model: config.ai.openrouterModel, raw: json };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fournisseur MOCK : ne pretend jamais etre une vraie IA generative. Il produit
 * un resultat structure deterministe a partir du prompt, pour que le systeme
 * reste utilisable (developpement, demo, panne de tous les quotas gratuits) sans
 * jamais afficher un resultat en prétendant qu'il vient d'un modele externe.
 */
async function callMock({ prompt, system }) {
  const summary = prompt.length > 220 ? `${prompt.slice(0, 220)}...` : prompt;
  const text = [
    '[MODE MOCK - aucun fournisseur IA externe configure ou disponible]',
    system ? `Contexte systeme recu : ${system.slice(0, 160)}` : null,
    `Demande recue : ${summary}`,
    'Ceci est un resultat de reserve structure, genere localement sans appel',
    "reseau, afin que le workflow puisse continuer a s'executer de bout en bout.",
    'Configurez GEMINI_API_KEY, GROQ_API_KEY ou OPENROUTER_API_KEY pour obtenir une vraie generation IA.',
  ]
    .filter(Boolean)
    .join('\n');
  return { text, provider: 'mock', model: 'mock-v1', raw: null };
}

const PROVIDER_FUNCTIONS = {
  gemini: callGemini,
  groq: callGroq,
  openrouter: callOpenRouter,
  mock: callMock,
};

/**
 * Appelle un fournisseur avec un retry controle (section 6) : seules les
 * erreurs classees "retryable" (timeout, erreur reseau) declenchent une
 * nouvelle tentative sur le MEME fournisseur, jusqu'a PROVIDER_MAX_RETRIES
 * fois. Une erreur de configuration (cle absente) ou de quota explicite
 * n'est jamais retentee (inutile : le resultat serait identique). Ne
 * produit qu'UNE seule entree dans le tableau "attempts" de l'appelant,
 * quel que soit le nombre de tentatives internes.
 */
async function callWithRetry(fn, args, providerName) {
  let lastErr;
  let retriesUsed = 0;
  for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt += 1) {
    try {
      return await fn(args);
    } catch (err) {
      lastErr = err;
      const errorType = classifyError(err);
      if (attempt < PROVIDER_MAX_RETRIES && isRetryable(errorType)) {
        retriesUsed += 1;
        logger.warn(`aiProvider: ${providerName} erreur temporaire (${errorType}), nouvelle tentative`, {
          tentative: attempt + 1,
          error: err.message,
        });
        continue;
      }
      lastErr.retriesUsed = retriesUsed;
      lastErr.errorType = errorType;
      throw lastErr;
    }
  }
  throw lastErr;
}

/**
 * Point d'entree unique utilise par les agents. Parcourt la chaine de
 * fournisseurs determinee par le profil de tache (voir aiProviders.js),
 * Mock etant toujours le dernier recours absolu. Chaque tentative (succes ou
 * echec) est enregistree dans le registre AI_PROVIDERS pour observabilite
 * (section 6 et 22-23 du prompt maitre V1.1). Aucun echec de fournisseur ne
 * doit interrompre le workflow. Un fournisseur temporairement indisponible
 * (desactive manuellement ou circuit ouvert apres des echecs consecutifs,
 * voir aiProviders.js) est saute sans etre reellement appele - protection
 * contre les boucles de fallback inutiles.
 *
 * @param {string} [profile] - 'reasoning' | 'fast' | 'long_context' | 'simple' | undefined (defaut)
 */
async function generate({ system, prompt, temperature, maxTokens, profile } = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('aiProvider.generate: "prompt" est requis (chaine de caracteres)');
  }
  const attempts = [];
  const chainOrder = aiProviders.chainForProfile(profile);
  for (const name of chainOrder) {
    const fn = PROVIDER_FUNCTIONS[name];
    if (!fn) continue;

    if (aiProviders.isTemporarilyUnavailable(name)) {
      attempts.push({ provider: name, error: 'Fournisseur temporairement indisponible (desactive ou circuit ouvert)', errorType: 'indisponible_temporairement' });
      logger.warn(`aiProvider: ${name} temporairement indisponible, saute sans appel reseau`, {});
      continue;
    }

    try {
      const result = await callWithRetry(fn, { system, prompt, temperature, maxTokens }, name);
      aiProviders.recordAttempt(name, { success: true });
      return { ...result, attempts, profile: profile || 'default' };
    } catch (err) {
      const errorType = err.errorType || classifyError(err);
      attempts.push({ provider: name, error: err.message, errorType, retriesUsed: err.retriesUsed || 0 });
      aiProviders.recordAttempt(name, { success: false, error: err.message });
      logger.warn(`aiProvider: ${name} indisponible, bascule vers le suivant`, {
        error: err.message,
        errorType,
      });
    }
  }
  // Ne devrait jamais arriver : "mock" reussit toujours et cloture chaque chaine.
  throw new Error('aiProvider: tous les fournisseurs ont echoue, y compris le mock');
}

module.exports = {
  generate,
  AIProviderError,
  callGroq,
  callGemini,
  callOpenRouter,
  callMock,
  classifyError,
  isRetryable,
  PROVIDER_TIMEOUT_MS,
  PROVIDER_MAX_RETRIES,
};
