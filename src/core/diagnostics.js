'use strict';

const { config } = require('./config');
const memory = require('./memory');
const aiProviders = require('./aiProviders');
const socialConnectors = require('./socialConnectors');
const killswitch = require('./killswitch');
const fs = require('fs');
const path = require('path');

/**
 * DIAGNOSTIC AUTOMATIQUE (section 18 du prompt maitre V1.1 - boost pass).
 * Chaque verification renvoie un statut :
 *   'ok'          (OK) - fonctionnel
 *   'a_configurer' (A CONFIGURER) - optionnel, pas encore configure, systeme reste utilisable (fallback actif)
 *   'erreur'      (ERREUR) - probleme reel necessitant une action
 *
 * Ne fait jamais d'appel reseau couteux par defaut (sauf si explicitement
 * demande via l'option { verifierReseau: true }, qui declenche un ping reel
 * Supabase). Les fournisseurs IA ne sont jamais reellement appeles ici (un
 * diagnostic ne doit pas consommer de quota) : seule leur configuration
 * (cle presente) est verifiee. Utiliser /api/ai-providers ou le bouton
 * "tester" dedie pour un vrai appel.
 */

function checkEnvVars() {
  const required = ['CONQUISTADOR_API_KEY'];
  const recommended = [
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'YOUTUBE_CLIENT_ID',
    'YOUTUBE_CLIENT_SECRET',
    'YOUTUBE_OAUTH_REDIRECT_URI',
    'YOUTUBE_TOKEN_ENCRYPTION_KEY',
    'META_APP_ID',
    'META_APP_SECRET',
    'META_CONFIGURATION_ID',
    'META_OAUTH_REDIRECT_URI',
    'META_TOKEN_ENCRYPTION_KEY',
    'META_WEBHOOK_VERIFY_TOKEN',
    'TIKTOK_CLIENT_KEY',
    'TIKTOK_CLIENT_SECRET',
    'TIKTOK_OAUTH_REDIRECT_URI',
    'TIKTOK_TOKEN_ENCRYPTION_KEY',
  ];
  const missingRequired = required.filter((k) => !process.env[k]);
  const missingRecommended = recommended.filter((k) => !process.env[k]);

  if (missingRequired.length > 0) {
    return {
      id: 'variables_environnement',
      statut: 'erreur',
      message: `Variable(s) obligatoire(s) manquante(s) : ${missingRequired.join(', ')}. Les endpoints de creation/modification resteront non proteges.`,
    };
  }
  if (missingRecommended.length > 0) {
    return {
      id: 'variables_environnement',
      statut: 'a_configurer',
      message: `Variables optionnelles non definies : ${missingRecommended.join(', ')}. Le systeme fonctionne (mode MOCK et/ou fallback JSON) mais sans generation IA reelle et/ou sans persistance garantie.`,
    };
  }
  return { id: 'variables_environnement', statut: 'ok', message: 'Toutes les variables recommandees sont definies.' };
}

async function checkMemory({ verifierReseau } = {}) {
  const backend = memory.currentBackend();
  if (backend === 'supabase') {
    if (verifierReseau) {
      try {
        const start = Date.now();
        await memory.list(memory.COLLECTIONS.EVENTS, { limit: 1 });
        return {
          id: 'memoire',
          statut: 'ok',
          message: `Supabase actif et joignable (${Date.now() - start} ms pour une lecture test).`,
        };
      } catch (err) {
        return {
          id: 'memoire',
          statut: 'erreur',
          message: `Supabase configure mais injoignable : ${err.message}. Le fallback JSON prendra le relais automatiquement a la prochaine ecriture.`,
        };
      }
    }
    return { id: 'memoire', statut: 'ok', message: 'Supabase configure comme backend principal (non teste en reseau, voir option verifierReseau).' };
  }
  return {
    id: 'memoire',
    statut: 'a_configurer',
    message: "Fallback JSON local actif (Supabase non configure). Fonctionnel, mais non garanti persistant sur une fonction Netlify deployee.",
  };
}

function checkAiProviders() {
  const snapshot = aiProviders.getRegistrySnapshot();
  const configured = snapshot.filter((p) => p.id !== 'mock' && p.configure);
  if (configured.length === 0) {
    return {
      id: 'fournisseurs_ia',
      statut: 'a_configurer',
      message: 'Aucun fournisseur IA reel configure : le systeme fonctionne entierement en mode MOCK.',
    };
  }
  const enErreur = configured.filter((p) => p.statut === 'erreur' && !p.indisponible_temporairement);
  if (enErreur.length === configured.length) {
    return {
      id: 'fournisseurs_ia',
      statut: 'erreur',
      message: `Tous les fournisseurs configures (${configured.map((p) => p.id).join(', ')}) sont actuellement en erreur.`,
    };
  }
  return {
    id: 'fournisseurs_ia',
    statut: 'ok',
    message: `${configured.length} fournisseur(s) reel(s) configure(s) : ${configured.map((p) => p.id).join(', ')}.`,
  };
}

function checkAssets() {
  const checks = [
    ['CHARACTER_REF_SAMUEL', config.brand.characterRefs.Samuel],
    ['CHARACTER_REF_MARC', config.brand.characterRefs.Marc],
    ['LOGO_ASSET_ID', config.brand.logo.assetId],
  ];
  const missing = checks.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length === checks.length) {
    return {
      id: 'assets_branding',
      statut: 'a_configurer',
      message: 'Aucune reference visuelle officielle configuree (Samuel/Marc/logo). La continuite visuelle ne peut pas etre garantie.',
    };
  }
  if (missing.length > 0) {
    return {
      id: 'assets_branding',
      statut: 'a_configurer',
      message: `Reference(s) manquante(s) : ${missing.join(', ')}.`,
    };
  }
  const notFound = checks.filter(([, value]) => {
    if (!value || path.isAbsolute(value) || value.startsWith('http')) return false;
    return !fs.existsSync(path.join(process.cwd(), value));
  });
  if (notFound.length > 0) {
    return {
      id: 'assets_branding',
      statut: 'erreur',
      message: `Reference(s) configuree(s) mais fichier introuvable sur le disque : ${notFound.map((n) => n[0]).join(', ')}.`,
    };
  }
  return { id: 'assets_branding', statut: 'ok', message: 'Samuel, Marc et le logo officiel sont configures et presents.' };
}

async function checkConnectors() {
  const snapshot = await socialConnectors.getDynamicSnapshot();
  const connected = snapshot.filter((c) => c.connecte);
  if (connected.length === 0) {
      const youtubeReady = Boolean(
        config.youtube.clientId
        && config.youtube.clientSecret
        && config.youtube.redirectUri
        && config.youtube.tokenEncryptionKey
      );
      const tiktokReady = Boolean(
        config.tiktok.clientKey
        && config.tiktok.clientSecret
        && config.tiktok.redirectUri
        && config.tiktok.tokenEncryptionKey
      );
      return {
        id: 'connecteurs_sociaux',
        statut: 'a_configurer',
        message: `Aucun connecteur social reel enregistre. YouTube serveur ${youtubeReady ? 'pret pour une connexion OAuth' : 'a configurer'} ; TikTok ${tiktokReady ? 'pret pour une connexion OAuth et publication soumise à approbation' : 'a configurer'} ; Meta ${config.meta.appId && config.meta.appSecret && config.meta.tokenEncryptionKey ? 'disponible pour une connexion OAuth' : 'non configure'}. Les DM/publications restent prepares mais jamais envoyes automatiquement.`,
      };
  }
  return { id: 'connecteurs_sociaux', statut: 'ok', message: `${connected.length} connecteur(s) enregistre(s) : ${connected.map((c) => c.plateforme).join(', ')}.` };
}

async function checkKillSwitch() {
  const status = await killswitch.getStatus();
  return {
    id: 'kill_switch',
    statut: status.engage ? 'a_configurer' : 'ok',
    message: status.engage
      ? `Mode securise ACTIF (${status.raison || 'raison non precisee'}) : toutes les actions externes sont bloquees.`
      : "Mode securise inactif : les actions externes approuvees peuvent s'executer normalement.",
  };
}

function checkSecurityBasics() {
  const problems = [];
  if (!config.apiKey) problems.push('CONQUISTADOR_API_KEY non definie : endpoints de creation/modification non proteges');
  if (config.rateLimitPerMinute > 300) problems.push('RATE_LIMIT_PER_MINUTE tres eleve, protection anti-abus faible');
  if (problems.length > 0) {
    return { id: 'securite_base', statut: 'erreur', message: problems.join(' ; ') };
  }
  return { id: 'securite_base', statut: 'ok', message: 'Cle API definie, limitation de requetes active.' };
}

/**
 * Execute l'ensemble du diagnostic et renvoie un resultat structure avec un
 * statut global (le pire des statuts individuels) et le detail de chaque
 * verification.
 */
async function runDiagnostics({ verifierReseau = false } = {}) {
  const checks = [
    checkEnvVars(),
    await checkMemory({ verifierReseau }),
    checkAiProviders(),
    checkAssets(),
    await checkConnectors(),
    await checkKillSwitch(),
    checkSecurityBasics(),
  ];

  const rank = { erreur: 2, a_configurer: 1, ok: 0 };
  const pire = checks.reduce((acc, c) => (rank[c.statut] > rank[acc] ? c.statut : acc), 'ok');

  return {
    statut_global: pire,
    genere_le: new Date().toISOString(),
    verifications: checks,
  };
}

module.exports = {
  runDiagnostics,
  checkEnvVars,
  checkMemory,
  checkAiProviders,
  checkAssets,
  checkConnectors,
  checkKillSwitch,
  checkSecurityBasics,
};
