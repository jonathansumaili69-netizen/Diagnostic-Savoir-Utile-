'use strict';

const { config, int } = require('./config');
const { logger } = require('./logger');

/**
 * AI_PROVIDERS — registre des fournisseurs IA disponibles pour Conquistador OS.
 *
 * Chaque score ci-dessous n'est PAS invente : il est derive de faits verifies
 * par recherche web (octobre 2026, sources officielles et independantes
 * convergentes) et documente en detail dans docs/AI_PROVIDERS.md. Echelle
 * qualitative 1 (faible) a 5 (eleve) — volontairement qualitative plutot que
 * de fausses precisions numeriques (ex: "87.3/100") qui n'auraient aucune
 * base reelle.
 *
 * Fournisseurs ecartes apres evaluation (voir docs/AI_PROVIDERS.md pour le
 * detail) :
 *   - Cerebras : sources officielles contradictoires en aout 2026 sur la
 *     necessite d'une carte bancaire (une source officielle indique que le
 *     "free trial" necessite une carte enregistree et expire). Ecarte par
 *     prudence tant que ce point n'est pas confirme sans ambiguite.
 *   - Mistral (La Plateforme, palier "Experiment") : gratuit et sans carte,
 *     mais Mistral documente lui-meme ce palier comme reserve a
 *     l'evaluation/prototypage, sans limites de requetes publiees
 *     precisement ("verifier dans Admin Console"). Trop imprevisible pour
 *     un moteur de production, meme gratuit.
 */
const PROVIDER_DEFINITIONS = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    model: () => config.ai.geminiModel,
    gratuit: true,
    quota: 'Palier Free à limites variables par modèle, compte et région; vérifier la page officielle de tarification',
    capacite: 'Contexte tres large (jusqu\'a ~1M tokens selon le modele), multimodal',
    scores: {
      raisonnement: 4,
      vitesse: 3,
      fiabilite: 4,
      contexte: 5,
      quota_gratuit: 3,
      disponibilite: 4,
    },
    justification:
      "Meilleur equilibre global : contexte le plus large du groupe, bonne qualite de raisonnement pour un modele 'flash', infrastructure Google stable. Le quota/minute reste modeste, ce qui limite sa vitesse effective en usage intensif.",
    requiresKey: 'GEMINI_API_KEY',
  },
  {
    id: 'groq',
    name: 'Groq',
    model: () => config.ai.groqModel,
    gratuit: false,
    quota: 'Modèle GPT-OSS 120B facturé au token; appels désactivés par défaut, opt-in GROQ_ALLOW_PAID=true',
    capacite: 'Débit LPU élevé; modèle actif openai/gpt-oss-120b (tarification à vérifier avant opt-in)',
    scores: {
      raisonnement: 3,
      vitesse: 5,
      fiabilite: 4,
      contexte: 3,
      quota_gratuit: 1,
      disponibilite: 4,
    },
    justification:
      "Route d'inférence rapide, mais son modèle de remplacement actif est facturé au token. Une clé présente ne déclenche pas d'appel sans opt-in GROQ_ALLOW_PAID=true.",
    requiresKey: 'GROQ_API_KEY',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (modeles :free)',
    model: () => config.ai.openrouterModel,
    gratuit: true,
    quota: 'Modèles :free à quotas d’usage variables; vérifier le catalogue et les limites du compte',
    capacite: 'Variable : agregateur de modeles gratuits dont la liste tourne dans le temps (roster non garanti stable)',
    scores: {
      raisonnement: 3,
      vitesse: 3,
      fiabilite: 2,
      contexte: 3,
      quota_gratuit: 2,
      disponibilite: 3,
    },
    justification:
      "Utile comme troisieme filet de securite gratuit (nombreux modeles accessibles sans carte), mais documente par ses propres sources comme 'best-effort' : modeles retires sans preavis, quota journalier le plus bas du groupe. Priorite la plus basse parmi les fournisseurs reels, juste avant Mock.",
    requiresKey: 'OPENROUTER_API_KEY',
  },
  {
    id: 'mock',
    name: 'Mock (reserve locale)',
    model: () => 'mock-v1',
    gratuit: true,
    quota: 'Illimite (aucun appel reseau)',
    capacite: 'Aucune generation IA reelle : reponse structuree deterministe de secours',
    scores: {
      raisonnement: 1,
      vitesse: 5,
      fiabilite: 5,
      contexte: 1,
      quota_gratuit: 5,
      disponibilite: 5,
    },
    justification:
      "Ne remplace jamais une vraie IA generative (raisonnement/contexte notes au minimum par honnetete), mais garantit que le systeme ne plante jamais, meme sans aucune cle configuree ni aucun fournisseur disponible.",
    requiresKey: null,
  },
];

/**
 * Etat vivant de chaque fournisseur (statut, derniere erreur, dernier appel).
 * Conserve en memoire du processus - reinitialise a chaque cold start de
 * fonction Netlify, ce qui est acceptable : il ne s'agit que d'un indicateur
 * d'observabilite recent, pas d'une source de verite (celle-ci reste le
 * journal d'execution en memoire persistante, voir taskEngine.js).
 */
const liveState = new Map(
  PROVIDER_DEFINITIONS.map((p) => [
    p.id,
    {
      status: 'inconnu',
      lastError: null,
      lastUsedAt: null,
      lastSuccessAt: null,
      callCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      manuallyDisabled: false,
      manuallyDisabledReason: null,
      circuitOpenUntil: null,
    },
  ])
);

// Section 6 (boost pass) : protection contre les boucles de fallback -
// apres N echecs CONSECUTIFS, le fournisseur est automatiquement mis en
// pause ("circuit ouvert") pendant une duree de refroidissement, plutot que
// d'etre retente inutilement a chaque appel suivant. Configurable, jamais
// applique a Mock (qui ne doit jamais pouvoir se desactiver lui-meme :
// c'est le dernier recours absolu).
const CIRCUIT_BREAKER_THRESHOLD = int(process.env.AI_CIRCUIT_BREAKER_THRESHOLD, 3);
const CIRCUIT_BREAKER_COOLDOWN_MS = int(process.env.AI_CIRCUIT_BREAKER_COOLDOWN_MS, 60000);

function recordAttempt(providerId, { success, error }) {
  const state = liveState.get(providerId);
  if (!state) return;
  state.lastUsedAt = new Date().toISOString();
  state.callCount += 1;
  if (success) {
    state.status = 'ok';
    state.lastSuccessAt = state.lastUsedAt;
    state.lastError = null;
    state.consecutiveErrors = 0;
    state.circuitOpenUntil = null;
  } else {
    state.status = 'erreur';
    state.errorCount += 1;
    state.consecutiveErrors += 1;
    state.lastError = { message: error, at: state.lastUsedAt };
    // Protection contre les boucles de fallback (section 6) : Mock ne peut
    // jamais etre mis en pause, c'est le dernier recours absolu.
    if (providerId !== 'mock' && state.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
      state.circuitOpenUntil = new Date(Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS).toISOString();
      logger.warn('aiProviders: circuit ouvert (echecs consecutifs), fournisseur mis en pause temporaire', {
        providerId,
        consecutiveErrors: state.consecutiveErrors,
        cooldownUntil: state.circuitOpenUntil,
      });
    }
  }
}

/**
 * Un fournisseur est indisponible pour cet appel si : desactive
 * manuellement (section 2 : bouton d'activation/desactivation), OU circuit
 * ouvert (trop d'echecs consecutifs recents, en cours de refroidissement).
 * Mock n'est jamais considere indisponible.
 */
function isTemporarilyUnavailable(providerId) {
  if (providerId === 'mock') return false;
  const state = liveState.get(providerId);
  if (!state) return false;
  if (state.manuallyDisabled) return true;
  if (state.circuitOpenUntil && new Date(state.circuitOpenUntil) > new Date()) return true;
  if (state.circuitOpenUntil && new Date(state.circuitOpenUntil) <= new Date()) {
    // Refroidissement termine : on referme le circuit automatiquement pour
    // laisser une nouvelle chance au fournisseur au prochain appel.
    state.circuitOpenUntil = null;
    state.consecutiveErrors = 0;
  }
  return false;
}

/** Active/desactive manuellement un fournisseur (section 6 : "possibilite de desactiver temporairement"). */
function setManuallyDisabled(providerId, disabled, reason) {
  if (providerId === 'mock' && disabled) {
    throw new Error('Mock ne peut jamais etre desactive : c\'est le dernier recours absolu du systeme.');
  }
  const state = liveState.get(providerId);
  if (!state) throw new Error(`Fournisseur inconnu: "${providerId}"`);
  state.manuallyDisabled = Boolean(disabled);
  state.manuallyDisabledReason = disabled ? (reason || 'Desactive manuellement') : null;
  return { providerId, manuallyDisabled: state.manuallyDisabled, raison: state.manuallyDisabledReason };
}

function isConfigured(providerId) {
  const def = PROVIDER_DEFINITIONS.find((p) => p.id === providerId);
  if (!def) return false;
  if (!def.requiresKey) return true; // mock
  if (def.requiresKey === 'GEMINI_API_KEY') return Boolean(config.ai.geminiApiKey);
  if (def.requiresKey === 'GROQ_API_KEY') return Boolean(config.ai.groqApiKey && config.ai.groqAllowPaid);
  if (def.requiresKey === 'OPENROUTER_API_KEY') return Boolean(config.ai.openrouterApiKey);
  return false;
}

/**
 * Profils de tache pour le routage intelligent (section 5 du prompt maitre).
 * Chaque profil choisit et ordonne sa chaîne selon la tâche et ses garde-fous
 * de coût. Mock reste toujours en dernier recours absolu; strict_video exclut
 * intentionnellement Groq même si un administrateur a opté pour le payant.
 */
const TASK_PROFILES = {
  // Analyse complexe : privilegier le meilleur raisonnement + le plus grand contexte.
  reasoning: ['gemini', 'groq', 'openrouter'],
  // Generation rapide / volume : privilegier la vitesse brute.
  fast: ['groq', 'gemini', 'openrouter'],
  // Long contexte (ex: analyser un historique long) : privilegier le contexte le plus large.
  long_context: ['gemini', 'groq', 'openrouter'],
  // Tache simple/legere : n'importe quel fournisseur suffit, economiser le plus "rare" (Gemini/Groq) pour plus tard.
  simple: ['openrouter', 'groq', 'gemini'],
  // Le profil strict de production n'utilise que des routes dont le modèle
  // sélectionné est documenté gratuit; Groq est exclu même avec opt-in.
  strict_video: ['gemini', 'openrouter'],
  // Par defaut (aucun profil precise) : ordre de base demande explicitement par l'utilisateur.
  default: ['gemini', 'groq', 'openrouter'],
};

function chainForProfile(profile) {
  const order = TASK_PROFILES[profile] || TASK_PROFILES.default;
  return [...order, 'mock'];
}

function getRegistrySnapshot() {
  return PROVIDER_DEFINITIONS.map((def) => {
    const state = liveState.get(def.id);
    return {
      id: def.id,
      nom: def.name,
      modele: def.model(),
      gratuit: def.gratuit,
      quota: def.quota,
      capacite: def.capacite,
      scores: def.scores,
      justification: def.justification,
      configure: isConfigured(def.id),
      statut: state.status,
      derniere_erreur: state.lastError,
      dernier_appel: state.lastUsedAt,
      dernier_succes: state.lastSuccessAt,
      appels_total: state.callCount,
      erreurs_total: state.errorCount,
      echecs_consecutifs: state.consecutiveErrors,
      desactive_manuellement: state.manuallyDisabled,
      raison_desactivation: state.manuallyDisabledReason,
      circuit_ouvert_jusqua: state.circuitOpenUntil,
      indisponible_temporairement: isTemporarilyUnavailable(def.id),
    };
  });
}

module.exports = {
  PROVIDER_DEFINITIONS,
  TASK_PROFILES,
  chainForProfile,
  isConfigured,
  recordAttempt,
  getRegistrySnapshot,
  isTemporarilyUnavailable,
  setManuallyDisabled,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_COOLDOWN_MS,
};
