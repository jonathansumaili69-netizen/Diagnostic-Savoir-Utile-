'use strict';

const memory = require('./memory');
const { encryptSecret, decryptSecret, hashState } = require('./tiktokSecurity');

const CONNECTION_COLLECTION = memory.COLLECTIONS.TIKTOK_CONNECTIONS;
const STATE_COLLECTION = memory.COLLECTIONS.TIKTOK_OAUTH_STATES;
const PUBLICATION_COLLECTION = memory.COLLECTIONS.CONTENT;
const PUBLICATION_KIND = 'tiktok.publication';

function publicConnection(row) {
  if (!row) return null;
  const data = row.data || {};
  const user = data.user || {};
  return {
    id: row.id,
    plateforme: 'tiktok',
    statut: data.status || 'unknown',
    compte: {
      open_id: user.openId || null,
      nom: user.displayName || null,
      nom_utilisateur: user.username || null,
      avatar_url: user.avatarUrl || null,
    },
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
    capacites: data.capabilities || {
      dm: false,
      lecture_commentaires: false,
      reponse_commentaires: false,
      lecture_chaine: false,
      publication: false,
    },
    token_expires_at: data.tokenExpiresAt || null,
    refresh_token_expires_at: data.refreshTokenExpiresAt || null,
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
    provider: 'tiktok',
  });
}

async function consumeOAuthState(state) {
  const stateHash = hashState(state);
  const rows = await memory.list(STATE_COLLECTION, {
    filter: (data) => data.state_hash === stateHash && data.provider === 'tiktok',
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

function publicPublication(row) {
  if (!row) return null;
  const data = row.data || {};
  return {
    id: row.id,
    plateforme: 'tiktok',
    publish_id: data.publish_id || null,
    content_key: data.content_key || null,
    title: data.title || null,
    video_url: data.video_url || null,
    privacy_level: data.privacy_level || null,
    statut: data.statut || 'EN_TRAITEMENT',
    provider_status: data.provider_status || null,
    erreur: data.erreur || null,
    public_post_id: data.public_post_id || null,
    uploaded_bytes: Number.isFinite(Number(data.uploaded_bytes)) ? Number(data.uploaded_bytes) : null,
    soumis_at: data.soumis_at || row.created_at || null,
    dernier_controle_at: data.dernier_controle_at || null,
    termine_at: data.termine_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getPublication(publishId) {
  const target = String(publishId || '').trim();
  if (!target) return null;
  const rows = await memory.list(PUBLICATION_COLLECTION, {
    filter: (data) => data.kind === PUBLICATION_KIND && data.publish_id === target,
    limit: 5,
  });
  return rows[0] || null;
}

async function savePublication({ publishId, contentKey = null, title = null, videoUrl = null, privacyLevel = null } = {}) {
  const target = String(publishId || '').trim();
  if (!target || target.length > 512) throw new Error('publish_id TikTok absent ou invalide');
  const existing = await getPublication(target);
  const patch = {
    kind: PUBLICATION_KIND,
    provider: 'tiktok',
    publish_id: target,
    content_key: contentKey || null,
    title: title ? String(title).slice(0, 2200) : null,
    video_url: videoUrl || null,
    privacy_level: privacyLevel || null,
    statut: 'EN_TRAITEMENT',
    provider_status: null,
    public_post_id: null,
    uploaded_bytes: null,
    erreur: null,
    soumis_at: existing?.data?.soumis_at || new Date().toISOString(),
    dernier_controle_at: null,
    termine_at: null,
  };
  if (existing) return memory.update(PUBLICATION_COLLECTION, existing.id, patch);
  return memory.insert(PUBLICATION_COLLECTION, patch);
}

async function updatePublication(rowId, patch = {}) {
  if (!rowId) return null;
  const allowed = {};
  for (const key of ['statut', 'provider_status', 'public_post_id', 'uploaded_bytes', 'erreur', 'dernier_controle_at', 'termine_at']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) allowed[key] = patch[key];
  }
  return memory.update(PUBLICATION_COLLECTION, rowId, allowed);
}

async function listPublications({ limit = 20 } = {}) {
  const requested = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await memory.list(PUBLICATION_COLLECTION, {
    filter: (data) => data.kind === PUBLICATION_KIND,
    limit: requested,
  });
  return rows.map(publicPublication);
}

async function saveConnection({ rowId, tokenResponse, user, permissions, capabilities }) {
  const existing = rowId ? await memory.get(CONNECTION_COLLECTION, rowId) : await getActiveConnection();
  const previous = existing && existing.data ? existing.data : {};
  const accessToken = tokenResponse && tokenResponse.access_token
    ? String(tokenResponse.access_token)
    : (previous.accessTokenEncrypted ? decryptSecret(previous.accessTokenEncrypted) : null);
  const refreshToken = tokenResponse && tokenResponse.refresh_token
    ? String(tokenResponse.refresh_token)
    : (previous.refreshTokenEncrypted ? decryptSecret(previous.refreshTokenEncrypted) : null);
  if (!accessToken || !refreshToken) {
    const error = new Error('TikTok doit renvoyer un access token et un refresh token');
    error.statusCode = 502;
    throw error;
  }
  const expiresIn = Number(tokenResponse && tokenResponse.expires_in);
  const refreshExpiresIn = Number(tokenResponse && tokenResponse.refresh_expires_in);
  const secureData = {
    ...(previous || {}),
    status: 'active',
    connection_key: user && (user.openId || user.unionId) ? `tiktok:${user.openId || user.unionId}` : (previous.connection_key || 'tiktok:primary'),
    user: user || previous.user || {},
    permissions: Array.isArray(permissions) && permissions.length ? permissions : (previous.permissions || []),
    capabilities: capabilities || previous.capabilities || {},
    accessTokenEncrypted: encryptSecret(accessToken),
    refreshTokenEncrypted: encryptSecret(refreshToken),
    tokenExpiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : (previous.tokenExpiresAt || null),
    refreshTokenExpiresAt: Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0 ? new Date(Date.now() + refreshExpiresIn * 1000).toISOString() : (previous.refreshTokenExpiresAt || null),
    connectedAt: previous.connectedAt || new Date().toISOString(),
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

async function updateAccessToken(rowId, tokenResponse) {
  const row = await memory.get(CONNECTION_COLLECTION, rowId);
  if (!row || !row.data) return null;
  const patch = {
    accessTokenEncrypted: tokenResponse.access_token ? encryptSecret(tokenResponse.access_token) : row.data.accessTokenEncrypted,
    refreshTokenEncrypted: tokenResponse.refresh_token ? encryptSecret(tokenResponse.refresh_token) : row.data.refreshTokenEncrypted,
    tokenExpiresAt: tokenResponse.expires_in ? new Date(Date.now() + Number(tokenResponse.expires_in) * 1000).toISOString() : row.data.tokenExpiresAt || null,
    refreshTokenExpiresAt: tokenResponse.refresh_expires_in ? new Date(Date.now() + Number(tokenResponse.refresh_expires_in) * 1000).toISOString() : row.data.refreshTokenExpiresAt || null,
    lastError: null,
  };
  return memory.update(CONNECTION_COLLECTION, rowId, patch);
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
  publicPublication,
  getPublication,
  savePublication,
  updatePublication,
  listPublications,
};
