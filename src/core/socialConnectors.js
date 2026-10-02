'use strict';

const metaStore = require('./metaStore');
const metaGraph = require('./metaGraph');
const youtubeStore = require('./youtubeStore');
const youtubeService = require('./youtubeService');
const tiktokStore = require('./tiktokStore');
const tiktokService = require('./tiktokService');
const memory = require('./memory');
const { safeErrorMessage } = require('./metaSecurity');
const { safeErrorMessage: safeYouTubeError } = require('./youtubeSecurity');
const { safeErrorMessage: safeTikTokError } = require('./tiktokSecurity');

/**
 * Registre structurel des connecteurs historiques. Les connexions Meta sont
 * chargées depuis le stockage serveur via getDynamicSnapshot/activeClientFor;
 * elles ne sont jamais déclarées connectées sur la seule présence de variables.
 */
const REGISTRY = {};
const liveStatus = new Map();

function normalizePlatform(plateforme) {
  return String(plateforme || '').trim().toLowerCase();
}

function emptyCapabilities() {
  return { dm: false, lecture_commentaires: false, reponse_commentaires: false, publication: false };
}

function capabilities(plateforme) {
  const key = normalizePlatform(plateforme);
  const entry = REGISTRY[key];
  const status = liveStatus.get(key);
  if (!entry) {
    return {
      plateforme: key || 'inconnue',
      connecte: false,
      compte: null,
      avatar: null,
      permissions: [],
      capacites: emptyCapabilities(),
      statut: 'non_connecte',
      raison: `Aucun connecteur reel enregistre pour "${key || 'cette plateforme'}". La plateforme devient connectee uniquement apres autorisation et verification du token côté serveur.`,
      derniere_verification: status ? status.lastCheckedAt : null,
      derniere_erreur: status ? status.lastError : null,
    };
  }
  return {
    plateforme: entry.plateforme,
    connecte: true,
    compte: entry.compte || null,
    avatar: entry.avatar || null,
    permissions: entry.permissions || [],
    capacites: entry.capacites || emptyCapabilities(),
    statut: status ? status.statut : 'jamais_teste',
    raison: null,
    derniere_verification: status ? status.lastCheckedAt : null,
    derniere_erreur: status ? status.lastError : null,
  };
}

function clientFor(plateforme) {
  const entry = REGISTRY[normalizePlatform(plateforme)];
  return entry ? entry.client || null : null;
}

function metaEntry(platform, connection) {
  const isFacebook = platform === 'facebook';
  const capability = connection.data.capabilities && connection.data.capabilities[platform];
  const account = isFacebook ? connection.data.facebook : connection.data.instagram;
  if (!account) return null;
  return {
    plateforme: platform,
    connecte: !connection.data.lastError,
    compte: account.name || account.username || account.id || null,
    // Avatar reellement fourni par l'API Meta (picture.data.url pour la
    // page/utilisateur Facebook, profile_picture_url pour Instagram) -
    // jamais invente : null si l'API ne l'a pas renvoye.
    avatar: account.avatar || null,
    permissions: Array.isArray(connection.data.permissions) ? connection.data.permissions : [],
    capacites: capability || emptyCapabilities(),
    statut: connection.data.lastError ? 'echec' : 'ok',
    raison: connection.data.lastError || null,
    derniere_verification: connection.data.lastVerifiedAt || null,
    derniere_erreur: connection.data.lastError || null,
    connection_id: connection.row.id,
  };
}

function youtubeEntry(connection) {
  const data = connection.data || {};
  const channel = data.channel || {};
  const capabilities = {
    ...emptyCapabilities(),
    ...(data.capabilities || {}),
    // La publication n’est vraie que si YouTube a effectivement accordé un
    // scope upload/youtube à la connexion OAuth.
    publication: Boolean(data.capabilities && data.capabilities.publication === true),
  };
  return {
    plateforme: 'youtube',
    connecte: !data.lastError,
    compte: channel.title || channel.id || null,
    // thumbnailUrl est deja recupere aupres de l'API YouTube Data (part=snippet)
    // lors de la connexion - jamais une nouvelle donnee inventee ici.
    avatar: channel.thumbnailUrl || null,
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
    capacites: capabilities,
    statut: data.lastError ? 'echec' : 'ok',
    raison: data.lastError || null,
    derniere_verification: data.lastVerifiedAt || null,
    derniere_erreur: data.lastError || null,
    connection_id: connection.row.id,
  };
}

function tiktokEntry(connection) {
  const data = connection.data || {};
  const user = data.user || {};
  return {
    plateforme: 'tiktok',
    connecte: !data.lastError,
    compte: user.username || user.displayName || user.openId || null,
    // avatarUrl est deja recupere aupres de l'API TikTok (/user/info/) lors
    // de la connexion - jamais une nouvelle donnee inventee ici.
    avatar: user.avatarUrl || null,
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
    capacites: data.capabilities || emptyCapabilities(),
    statut: data.lastError ? 'echec' : 'ok',
    raison: data.lastError || null,
    derniere_verification: data.lastVerifiedAt || null,
    derniere_erreur: data.lastError || null,
    connection_id: connection.row.id,
  };
}

async function getDynamicSnapshot() {
  const base = getRegistrySnapshot();
  const [row, youtubeRow, tiktokRow] = await Promise.all([
    metaStore.getActiveConnection(),
    youtubeStore.getActiveConnection().catch(() => null),
    tiktokStore.getActiveConnection().catch(() => null),
  ]);
  const byPlatform = new Map(base.map((entry) => [entry.plateforme, entry]));
  if (row) {
    const connection = { row, data: row.data };
    for (const platform of ['facebook', 'instagram']) {
      const entry = metaEntry(platform, connection);
      if (entry) byPlatform.set(platform, entry);
    }
  }
  if (youtubeRow) byPlatform.set('youtube', youtubeEntry({ row: youtubeRow, data: youtubeRow.data }));
  if (tiktokRow) byPlatform.set('tiktok', tiktokEntry({ row: tiktokRow, data: tiktokRow.data }));
  return [...byPlatform.values()].sort((a, b) => a.plateforme.localeCompare(b.plateforme));
}

async function activeClientFor(plateforme, requiredCapability) {
  const key = normalizePlatform(plateforme);
  const legacy = clientFor(key);
  if (legacy) return legacy;
  if (key === 'youtube') {
    const row = await youtubeStore.getActiveConnection();
    if (!row) return null;
    const connection = await youtubeStore.getDecryptedConnection(row);
    if (!connection) return null;
    const granted = {
      ...emptyCapabilities(),
      ...(connection.data.capabilities || {}),
      publication: Boolean(connection.data.capabilities && connection.data.capabilities.publication === true),
    };
    if (requiredCapability && granted[requiredCapability] !== true) return null;
    return {
      test: async () => {
        try {
          const { inspected } = await youtubeService.inspectWithRefresh(connection);
          await youtubeStore.updateVerification(row.id, {
            channel: inspected.channel,
            permissions: inspected.permissions,
            capabilities: inspected.capabilities,
            lastError: null,
          });
          liveStatus.set(key, { statut: 'ok', lastCheckedAt: new Date().toISOString(), lastError: null });
          return { ok: true, plateforme: key };
        } catch (err) {
          const message = safeYouTubeError(err);
          await youtubeStore.updateVerification(row.id, { lastError: message });
          liveStatus.set(key, { statut: 'echec', lastCheckedAt: new Date().toISOString(), lastError: message });
          throw err;
        }
      },
      readChannel: async () => {
        const { inspected } = await youtubeService.inspectWithRefresh(connection);
        return inspected.channel;
      },
      publish: async (input) => {
        try {
          const result = await youtubeService.publishVideo(connection, input || {});
          await memory.recordEvent('youtube.action.post_published', {
            plateforme: 'youtube',
            externalId: result && result.id ? result.id : null,
            statut: 'confirme_par_youtube',
          }).catch(() => undefined);
          return result;
        } catch (err) {
          await memory.recordEvent('youtube.action.post_published.failed', {
            plateforme: 'youtube',
            raison: safeYouTubeError(err),
          }).catch(() => undefined);
          throw err;
        }
      },
    };
  }
  if (key === 'tiktok') {
    const row = await tiktokStore.getActiveConnection();
    if (!row) return null;
    const connection = await tiktokStore.getDecryptedConnection(row);
    if (!connection) return null;
    const granted = { ...(connection.data.capabilities || {}) };
    if (requiredCapability && granted[requiredCapability] !== true) return null;
    const audit = async (eventType, input, operation) => {
      try {
        const result = await operation();
        await memory.recordEvent(eventType, {
          plateforme: 'tiktok',
          externalId: result && (result.publication_id || result.id || null),
          statut: result && result.statut === 'PUBLIE' ? 'confirme_par_tiktok' : 'soumis_a_tiktok_en_traitement',
        }).catch(() => undefined);
        return result;
      } catch (err) {
        await memory.recordEvent(`${eventType}.failed`, {
          plateforme: 'tiktok',
          raison: safeTikTokError(err),
        }).catch(() => undefined);
        throw err;
      }
    };
    return {
      test: async () => {
        try {
          const inspected = await tiktokService.safeVerify(row);
          liveStatus.set(key, { statut: 'ok', lastCheckedAt: new Date().toISOString(), lastError: null });
          return { ok: true, plateforme: key, compte: inspected.user.username || inspected.user.displayName || null };
        } catch (err) {
          const message = safeTikTokError(err);
          await tiktokStore.updateVerification(row.id, { lastError: message });
          liveStatus.set(key, { statut: 'echec', lastCheckedAt: new Date().toISOString(), lastError: message });
          throw err;
        }
      },
      readProfile: async () => {
        const inspected = await tiktokService.safeVerify(row);
        return inspected.user;
      },
      publish: async (input) => audit('tiktok.action.post_submitted', input, async () => {
        const activeRow = await tiktokStore.getActiveConnection();
        const activeConnection = await tiktokStore.getDecryptedConnection(activeRow);
        return tiktokService.publishVideo(activeConnection, input);
      }),
    };
  }
  if (key !== 'facebook' && key !== 'instagram') return null;
  const row = await metaStore.getActiveConnection();
  if (!row) return null;
  const connection = await metaStore.getDecryptedConnection(row);
  if (!connection) return null;
  if (requiredCapability) {
    const granted = connection.data.capabilities && connection.data.capabilities[key];
    if (!granted || granted[requiredCapability] !== true) return null;
  }
  const audit = async (eventType, input, operation) => {
    try {
      const result = await operation();
      await memory.recordEvent(eventType, {
        plateforme: key,
        pageId: input && input.page_id ? input.page_id : null,
        externalId: result && (result.id || result.message_id || result.post_id || null),
        statut: 'confirme_par_meta',
      }).catch(() => undefined);
      return result;
    } catch (err) {
      await memory.recordEvent(`${eventType}.failed`, {
        plateforme: key,
        pageId: input && input.page_id ? input.page_id : null,
        raison: safeErrorMessage(err),
      }).catch(() => undefined);
      throw err;
    }
  };
  const client = {
    test: async () => {
      try {
        const inspected = await metaGraph.inspectConnection({ userAccessToken: connection.userAccessToken });
        await metaStore.updateVerification(row.id, {
          capabilities: inspected.capabilities,
          lastError: null,
        });
        liveStatus.set(key, { statut: 'ok', lastCheckedAt: new Date().toISOString(), lastError: null });
        return { ok: true, plateforme: key };
      } catch (err) {
        const message = safeErrorMessage(err);
        await metaStore.updateVerification(row.id, { lastError: message });
        liveStatus.set(key, { statut: 'echec', lastCheckedAt: new Date().toISOString(), lastError: message });
        throw err;
      }
    },
    send: async (input) => audit('meta.action.message_sent', input, () => key === 'facebook' ? metaGraph.sendFacebookMessage(connection, input) : metaGraph.sendInstagramMessage(connection, input)),
    publish: async (input) => audit('meta.action.post_published', input, () => key === 'facebook' ? metaGraph.publishFacebook(connection, input) : metaGraph.publishInstagram(connection, input)),
    replyComment: async (input) => audit('meta.action.comment_replied', input, () => key === 'facebook' ? metaGraph.replyFacebookComment(connection, input) : metaGraph.replyInstagramComment(connection, input)),
  };
  return client;
}

async function testConnection(plateforme) {
  const key = normalizePlatform(plateforme);
  const at = new Date().toISOString();
  const client = await activeClientFor(key);
  if (!client) {
    liveStatus.set(key, { statut: 'echec', lastCheckedAt: at, lastError: 'Aucun connecteur enregistre' });
    return { plateforme: key, succes: false, raison: 'Aucun connecteur enregistre pour cette plateforme.' };
  }
  try {
    if (typeof client.test === 'function') await client.test();
    liveStatus.set(key, { statut: 'ok', lastCheckedAt: at, lastError: null });
    return { plateforme: key, succes: true };
  } catch (err) {
    liveStatus.set(key, { statut: 'echec', lastCheckedAt: at, lastError: safeErrorMessage(err) });
    return { plateforme: key, succes: false, raison: safeErrorMessage(err) };
  }
}

function listRegisteredPlatforms() {
  return Object.keys(REGISTRY);
}

function getRegistrySnapshot() {
  const knownPlatforms = new Set([...Object.keys(REGISTRY), 'tiktok', 'instagram', 'facebook', 'youtube', 'whatsapp']);
  return [...knownPlatforms].sort().map((p) => capabilities(p));
}

module.exports = {
  REGISTRY,
  capabilities,
  clientFor,
  activeClientFor,
  testConnection,
  listRegisteredPlatforms,
  getRegistrySnapshot,
  getDynamicSnapshot,
  normalizePlatform,
};
