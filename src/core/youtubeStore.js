'use strict';

const memory = require('./memory');
const { encryptSecret, decryptSecret, hashState } = require('./youtubeSecurity');

const CONNECTION_COLLECTION = memory.COLLECTIONS.YOUTUBE_CONNECTIONS;
const STATE_COLLECTION = memory.COLLECTIONS.YOUTUBE_OAUTH_STATES;

function publicConnection(row) {
  if (!row) return null;
  const data = row.data || {};
  return {
    id: row.id,
    plateforme: 'youtube',
    statut: data.status || 'unknown',
    chaine: data.channel ? {
      id: data.channel.id || null,
      titre: data.channel.title || null,
      description: data.channel.description || null,
      url_personnalisee: data.channel.customUrl || null,
      miniature_url: data.channel.thumbnailUrl || null,
    } : null,
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
    capacites: data.capabilities || {
      lecture_chaine: false,
      publication: false,
    },
    token_expires_at: data.tokenExpiresAt || null,
    dernier_verifie_at: data.lastVerifiedAt || null,
    derniere_erreur: data.lastError || null,
    connecte_at: data.connectedAt || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function saveOAuthState({ state, redirectUri, scopes, expiresAt }) {
  return memory.insert(STATE_COLLECTION, {
    state_hash: hashState(state),
    redirect_uri: redirectUri,
    scopes: Array.isArray(scopes) ? scopes : [],
    expires_at: expiresAt,
    status: 'pending',
    provider: 'youtube',
  });
}

async function consumeOAuthState(state) {
  const stateHash = hashState(state);
  const rows = await memory.list(STATE_COLLECTION, {
    filter: (data) => data.state_hash === stateHash && data.provider === 'youtube',
    limit: 5,
  });
  const row = rows[0];
  if (!row || row.data.status !== 'pending') return null;
  if (!row.data.expires_at || new Date(row.data.expires_at).getTime() <= Date.now()) {
    await memory.updateIf(STATE_COLLECTION, row.id, { status: 'pending' }, {
      status: 'expired',
      consumed_at: new Date().toISOString(),
    });
    return null;
  }
  const consumed = await memory.updateIf(STATE_COLLECTION, row.id, { status: 'pending' }, {
    status: 'consumed',
    consumed_at: new Date().toISOString(),
  });
  return consumed ? consumed.data : null;
}

async function listActiveConnections() {
  return memory.list(CONNECTION_COLLECTION, {
    filter: (data) => data.status === 'active',
    limit: 20,
  });
}

async function getActiveConnection() {
  const rows = await listActiveConnections();
  return rows[0] || null;
}

async function saveConnection({ rowId, accessToken, refreshToken, tokenExpiresAt, data }) {
  const existing = rowId ? await memory.get(CONNECTION_COLLECTION, rowId) : await getActiveConnection();
  const previous = existing && existing.data ? existing.data : {};
  const nextAccessToken = accessToken || (previous.accessTokenEncrypted ? decryptSecret(previous.accessTokenEncrypted) : null);
  const nextRefreshToken = refreshToken || (previous.refreshTokenEncrypted ? decryptSecret(previous.refreshTokenEncrypted) : null);
  if (!nextAccessToken || !nextRefreshToken) {
    const error = new Error('YouTube doit renvoyer un access token et un refresh token');
    error.statusCode = 502;
    throw error;
  }
  const secureData = {
    ...data,
    status: 'active',
    accessTokenEncrypted: encryptSecret(nextAccessToken),
    refreshTokenEncrypted: encryptSecret(nextRefreshToken),
    tokenExpiresAt: tokenExpiresAt || previous.tokenExpiresAt || null,
    lastError: null,
  };
  if (rowId) return memory.update(CONNECTION_COLLECTION, rowId, secureData);
  if (existing) return memory.update(CONNECTION_COLLECTION, existing.id, secureData);
  return memory.insert(CONNECTION_COLLECTION, secureData);
}

async function getDecryptedConnection(row) {
  if (!row || !row.data || row.data.status !== 'active') return null;
  const data = row.data;
  return {
    row,
    data: { ...data },
    accessToken: data.accessTokenEncrypted ? decryptSecret(data.accessTokenEncrypted) : null,
    refreshToken: data.refreshTokenEncrypted ? decryptSecret(data.refreshTokenEncrypted) : null,
  };
}

async function updateVerification(rowId, patch) {
  return memory.update(CONNECTION_COLLECTION, rowId, {
    ...patch,
    lastVerifiedAt: patch.lastVerifiedAt || new Date().toISOString(),
  });
}

async function updateAccessToken(rowId, accessToken, tokenExpiresAt) {
  return memory.update(CONNECTION_COLLECTION, rowId, {
    accessTokenEncrypted: encryptSecret(accessToken),
    tokenExpiresAt: tokenExpiresAt || null,
    lastError: null,
  });
}

async function disconnect(rowId) {
  const row = await memory.get(CONNECTION_COLLECTION, rowId);
  if (!row) return null;
  return memory.update(CONNECTION_COLLECTION, rowId, {
    status: 'revoked',
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    capabilities: {},
    lastError: null,
    disconnectedAt: new Date().toISOString(),
  });
}

module.exports = {
  publicConnection,
  saveOAuthState,
  consumeOAuthState,
  listActiveConnections,
  getActiveConnection,
  saveConnection,
  getDecryptedConnection,
  updateVerification,
  updateAccessToken,
  disconnect,
};
