'use strict';

const memory = require('./memory');
const { encryptSecret, decryptSecret, hashState } = require('./metaSecurity');

const CONNECTION_COLLECTION = memory.COLLECTIONS.META_CONNECTIONS;
const STATE_COLLECTION = memory.COLLECTIONS.META_OAUTH_STATES;

function publicConnection(row) {
  if (!row) return null;
  const data = row.data || {};
  return {
    id: row.id,
    plateforme: 'meta',
    statut: data.status || 'unknown',
    compte_facebook: data.facebook ? {
      id: data.facebook.id || null,
      nom: data.facebook.name || null,
      tasks: Array.isArray(data.facebook.tasks) ? data.facebook.tasks : [],
    } : null,
    pages: Array.isArray(data.pages)
      ? data.pages.map((page) => ({
        id: page.id || null,
        nom: page.name || null,
        tasks: Array.isArray(page.tasks) ? page.tasks : [],
      }))
      : [],
    instagram: data.instagram ? {
      id: data.instagram.id || null,
      username: data.instagram.username || null,
      name: data.instagram.name || null,
    } : null,
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
    capabilities: data.capabilities || {},
    token_expires_at: data.userTokenExpiresAt || null,
    last_verified_at: data.lastVerifiedAt || null,
    last_error: data.lastError || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function saveOAuthState({ state, redirectUri, expiresAt }) {
  return memory.insert(STATE_COLLECTION, {
    state_hash: hashState(state),
    redirect_uri: redirectUri,
    expires_at: expiresAt,
    status: 'pending',
    provider: 'meta',
  });
}

async function consumeOAuthState(state) {
  const stateHash = hashState(state);
  const rows = await memory.list(STATE_COLLECTION, {
    filter: (data) => data.state_hash === stateHash,
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

function securePages(pages, previousPages = []) {
  const priorById = new Map((Array.isArray(previousPages) ? previousPages : []).map((page) => [page.id, page]));
  return Array.isArray(pages)
    ? pages.map((page) => {
      const copy = { ...page };
      if (copy.accessToken) {
        copy.accessTokenEncrypted = encryptSecret(copy.accessToken);
        delete copy.accessToken;
      } else if (!copy.accessTokenEncrypted && priorById.get(copy.id) && priorById.get(copy.id).accessTokenEncrypted) {
        copy.accessTokenEncrypted = priorById.get(copy.id).accessTokenEncrypted;
      }
      return copy;
    })
    : [];
}

async function saveConnection({ rowId, userAccessToken, pageAccessToken, data }) {
  const existing = rowId ? await memory.get(CONNECTION_COLLECTION, rowId) : await getActiveConnection();
  const securePagesData = securePages(data.pages, existing && existing.data && existing.data.pages);

  const secureData = {
    ...data,
    pages: securePagesData,
    status: 'active',
    userAccessTokenEncrypted: encryptSecret(userAccessToken),
    pageAccessTokenEncrypted: pageAccessToken ? encryptSecret(pageAccessToken) : null,
    lastError: null,
  };
  if (rowId) return memory.update(CONNECTION_COLLECTION, rowId, secureData);
  if (existing) return memory.update(CONNECTION_COLLECTION, existing.id, secureData);
  return memory.insert(CONNECTION_COLLECTION, secureData);
}

async function getDecryptedConnection(row) {
  if (!row || !row.data || row.data.status !== 'active') return null;
  const data = row.data;
  const pages = Array.isArray(data.pages)
    ? data.pages.map((page) => ({
      ...page,
      accessToken: page.accessTokenEncrypted ? decryptSecret(page.accessTokenEncrypted) : null,
    }))
    : [];
  return {
    row,
    data: { ...data, pages },
    userAccessToken: data.userAccessTokenEncrypted ? decryptSecret(data.userAccessTokenEncrypted) : null,
    pageAccessToken: data.pageAccessTokenEncrypted ? decryptSecret(data.pageAccessTokenEncrypted) : (pages[0] && pages[0].accessToken) || null,
  };
}

async function updateVerification(rowId, patch) {
  const existing = await memory.get(CONNECTION_COLLECTION, rowId);
  const next = { ...patch };
  if (Array.isArray(patch.pages)) {
    next.pages = securePages(patch.pages, existing && existing.data && existing.data.pages);
  }
  return memory.update(CONNECTION_COLLECTION, rowId, {
    ...next,
    lastVerifiedAt: patch.lastVerifiedAt || new Date().toISOString(),
  });
}

async function disconnect(rowId) {
  const row = await memory.get(CONNECTION_COLLECTION, rowId);
  if (!row) return null;
  return memory.update(CONNECTION_COLLECTION, rowId, {
    status: 'revoked',
    userAccessTokenEncrypted: null,
    pageAccessTokenEncrypted: null,
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
  disconnect,
};
