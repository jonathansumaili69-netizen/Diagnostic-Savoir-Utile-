'use strict';

const { config } = require('./config');
const { safeErrorMessage } = require('./metaSecurity');

function graphBase() {
  return `https://graph.facebook.com/${config.meta.graphApiVersion}`;
}

function metaError(message, statusCode, payload) {
  const error = new Error(safeErrorMessage(message || 'Erreur Meta'));
  error.statusCode = statusCode >= 400 && statusCode < 500 ? statusCode : 502;
  error.meta = payload && payload.error ? {
    code: payload.error.code || null,
    type: payload.error.type || null,
    subcode: payload.error.error_subcode || null,
  } : null;
  return error;
}

async function request(path, { method = 'GET', token, params = {}, body, form = false } = {}) {
  const url = new URL(`${graphBase()}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = { Accept: 'application/json' };
  const options = { method, headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    options.body = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  options.signal = controller.signal;
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    throw metaError(`Echec reseau Meta: ${err.name === 'AbortError' ? 'timeout' : err.message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (err) {
    payload = { raw: text.slice(0, 500) };
  }
  if (!response.ok || payload.error) {
    throw metaError(payload.error && payload.error.message ? payload.error.message : `Meta HTTP ${response.status}`, response.status, payload);
  }
  return payload;
}

function requireMetaApp() {
  if (!config.meta.appId || !config.meta.appSecret || !config.meta.redirectUri) {
    const error = new Error('META_APP_ID, META_APP_SECRET et META_OAUTH_REDIRECT_URI doivent etre configures côté serveur');
    error.statusCode = 503;
    throw error;
  }
}

function buildAuthorizeUrl(state) {
  requireMetaApp();
  const url = new URL(`https://www.facebook.com/${config.meta.graphApiVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.meta.appId);
  url.searchParams.set('redirect_uri', config.meta.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (config.meta.configurationId) url.searchParams.set('config_id', config.meta.configurationId);
  url.searchParams.set('scope', config.meta.oauthScope);
  return url.toString();
}

async function exchangeCode(code) {
  requireMetaApp();
  return request('/oauth/access_token', {
    params: {
      client_id: config.meta.appId,
      redirect_uri: config.meta.redirectUri,
      client_secret: config.meta.appSecret,
      code,
    },
  });
}

async function exchangeLongLivedToken(shortToken) {
  requireMetaApp();
  return request('/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      fb_exchange_token: shortToken,
    },
  });
}

async function debugToken(token) {
  requireMetaApp();
  return request('/debug_token', {
    params: {
      input_token: token,
      access_token: `${config.meta.appId}|${config.meta.appSecret}`,
    },
  });
}

async function permissions(token) {
  return request('/me/permissions', { token });
}

async function currentUser(token) {
  return request('/me', { token, params: { fields: 'id,name,picture' } });
}

async function pages(token) {
  return request('/me/accounts', {
    token,
    params: {
      fields: 'id,name,access_token,tasks,instagram_business_account{id}',
      limit: 100,
    },
  });
}

async function instagramProfile(igId, token) {
  return request(`/${encodeURIComponent(igId)}`, {
    token,
    params: { fields: 'id,username,name,profile_picture_url' },
  });
}

function grantedPermissions(permissionPayload) {
  const rows = Array.isArray(permissionPayload && permissionPayload.data) ? permissionPayload.data : [];
  return rows.filter((row) => row.status === 'granted').map((row) => row.permission).filter(Boolean);
}

function pageTaskAllows(page, ...allowed) {
  const tasks = Array.isArray(page && page.tasks) ? page.tasks : [];
  return allowed.some((task) => tasks.includes(task));
}

function calculateCapabilities({ permissions: granted, page }) {
  const p = new Set(granted || []);
  const pageCanModerate = pageTaskAllows(page, 'MODERATE', 'MANAGE');
  const pageCanCreate = pageTaskAllows(page, 'CREATE_CONTENT', 'MANAGE');
  const pageCanMessage = pageTaskAllows(page, 'MESSAGING', 'MODERATE', 'MANAGE');
  return {
    facebook: {
      dm: p.has('pages_messaging') && p.has('pages_manage_metadata') && pageCanMessage,
      lecture_commentaires: p.has('pages_read_engagement') && pageCanModerate,
      reponse_commentaires: p.has('pages_manage_engagement') && pageCanModerate,
      publication: p.has('pages_manage_posts') && pageCanCreate,
    },
    instagram: {
      dm: p.has('instagram_basic') && p.has('instagram_manage_messages') && pageCanMessage,
      lecture_commentaires: p.has('instagram_basic') && p.has('instagram_manage_comments'),
      reponse_commentaires: p.has('instagram_basic') && p.has('instagram_manage_comments'),
      publication: p.has('instagram_content_publish'),
    },
  };
}

async function inspectConnection({ userAccessToken }) {
  const debug = await debugToken(userAccessToken);
  const tokenData = debug && debug.data ? debug.data : {};
  if (!tokenData.is_valid || String(tokenData.app_id) !== String(config.meta.appId)) {
    const error = new Error('Le token Meta est invalide ou associe a une autre application');
    error.statusCode = 401;
    throw error;
  }
  const permissionPayload = await permissions(userAccessToken);
  const granted = grantedPermissions(permissionPayload);
  const user = await currentUser(userAccessToken);
  const pagePayload = await pages(userAccessToken);
  const normalizedPages = [];
  let instagram = null;
  for (const page of Array.isArray(pagePayload.data) ? pagePayload.data : []) {
    const normalized = {
      id: page.id,
      name: page.name || null,
      tasks: Array.isArray(page.tasks) ? page.tasks : [],
      accessToken: page.access_token || null,
    };
    if (page.instagram_business_account && page.instagram_business_account.id) {
      try {
        const ig = await instagramProfile(page.instagram_business_account.id, page.access_token || userAccessToken);
        instagram = { id: ig.id, username: ig.username || null, name: ig.name || null, avatar: ig.profile_picture_url || null };
        normalized.instagramId = ig.id;
      } catch (err) {
        normalized.instagramId = page.instagram_business_account.id;
      }
    }
    normalizedPages.push(normalized);
  }
  const selectedPage = normalizedPages.find((page) => page.instagramId) || normalizedPages[0] || null;
  const capabilities = calculateCapabilities({ permissions: granted, page: selectedPage });
  const expiresAt = tokenData.expires_at ? new Date(Number(tokenData.expires_at) * 1000).toISOString() : null;
  return {
    user: { id: user.id || tokenData.user_id || null, name: user.name || null, avatar: (user.picture && user.picture.data && user.picture.data.url) || null },
    pages: normalizedPages,
    instagram,
    permissions: granted,
    capabilities,
    userTokenExpiresAt: expiresAt,
    tokenType: tokenData.type || null,
    appId: String(tokenData.app_id),
  };
}

function choosePage(connection, pageId) {
  const rows = Array.isArray(connection.data.pages) ? connection.data.pages : [];
  const page = pageId ? rows.find((item) => item.id === pageId) : rows.find((item) => item.accessToken) || rows[0];
  if (!page) {
    const error = new Error('Aucune Page Facebook disponible dans la connexion Meta');
    error.statusCode = 409;
    throw error;
  }
  const token = page.accessToken || connection.pageAccessToken;
  if (!token) {
    const error = new Error('Aucun Page access token disponible pour cette Page');
    error.statusCode = 409;
    throw error;
  }
  return { page, token };
}

function limitValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 25;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

async function readData(connection, input = {}) {
  const operation = String(input.operation || '').trim();
  const limit = limitValue(input.limit);
  if (operation === 'facebook_pages') {
    return { operation, data: (connection.data.pages || []).map(({ accessToken, accessTokenEncrypted, ...safe }) => safe) };
  }
  if (operation === 'instagram_profile') {
    if (!connection.data.instagram || !connection.pageAccessToken) throw metaError('Compte Instagram non disponible', 409);
    return { operation, data: await instagramProfile(connection.data.instagram.id, connection.pageAccessToken) };
  }
  if (operation === 'facebook_posts') {
    const { page, token } = choosePage(connection, input.page_id);
    return { operation, page_id: page.id, data: await request(`/${page.id}/feed`, { token, params: { fields: 'id,message,created_time,permalink_url', limit } }) };
  }
  if (operation === 'facebook_comments') {
    const { token } = choosePage(connection, input.page_id);
    if (!input.post_id) throw metaError('post_id requis', 400);
    return { operation, post_id: input.post_id, data: await request(`/${encodeURIComponent(input.post_id)}/comments`, { token, params: { fields: 'id,message,from,created_time', limit } }) };
  }
  if (operation === 'facebook_conversations') {
    const { page, token } = choosePage(connection, input.page_id);
    return { operation, page_id: page.id, data: await request(`/${page.id}/conversations`, { token, params: { platform: 'messenger', limit } }) };
  }
  if (operation === 'instagram_media') {
    if (!connection.data.instagram || !connection.pageAccessToken) throw metaError('Compte Instagram non disponible', 409);
    return { operation, data: await request(`/${connection.data.instagram.id}/media`, { token: connection.pageAccessToken, params: { fields: 'id,caption,media_type,media_url,permalink,timestamp', limit } }) };
  }
  if (operation === 'instagram_comments') {
    if (!input.media_id) throw metaError('media_id requis', 400);
    if (!connection.pageAccessToken) throw metaError('Token Instagram indisponible', 409);
    return { operation, media_id: input.media_id, data: await request(`/${encodeURIComponent(input.media_id)}/comments`, { token: connection.pageAccessToken, params: { fields: 'id,text,from,timestamp', limit } }) };
  }
  if (operation === 'instagram_conversations') {
    const { page, token } = choosePage(connection, input.page_id);
    return { operation, page_id: page.id, data: await request(`/${page.id}/conversations`, { token, params: { platform: 'instagram', limit } }) };
  }
  throw metaError(`Operation de lecture Meta inconnue: ${operation}`, 400);
}

async function sendFacebookMessage(connection, input) {
  const { page, token } = choosePage(connection, input.page_id);
  if (!input.destinataire) throw metaError('destinataire requis', 400);
  if (!input.message) throw metaError('message requis', 400);
  return request(`/${page.id}/messages`, { method: 'POST', token, body: { recipient: { id: input.destinataire }, message: { text: input.message } } });
}

async function publishFacebook(connection, input) {
  const { page, token } = choosePage(connection, input.page_id);
  if (!input.contenu) throw metaError('contenu requis', 400);
  const body = { message: input.contenu };
  if (input.lien) body.link = input.lien;
  return request(`/${page.id}/feed`, { method: 'POST', token, body });
}

async function replyFacebookComment(connection, input) {
  const { token } = choosePage(connection, input.page_id);
  if (!input.comment_id || !input.message) throw metaError('comment_id et message requis', 400);
  return request(`/${encodeURIComponent(input.comment_id)}`, { method: 'POST', token, body: { message: input.message }, form: true });
}

async function sendInstagramMessage(connection, input) {
  if (!connection.data.instagram || !connection.pageAccessToken) throw metaError('Compte Instagram ou token indisponible', 409);
  if (!input.destinataire || !input.message) throw metaError('destinataire et message requis', 400);
  const { page, token } = choosePage(connection, input.page_id);
  return request(`/${page.id}/messages`, {
    method: 'POST',
    token,
    body: { recipient: { id: input.destinataire }, message: { text: input.message } },
  });
}

async function replyInstagramComment(connection, input) {
  if (!connection.pageAccessToken) throw metaError('Token Instagram indisponible', 409);
  if (!input.comment_id || !input.message) throw metaError('comment_id et message requis', 400);
  return request(`/${encodeURIComponent(input.comment_id)}/replies`, { method: 'POST', token: connection.pageAccessToken, body: { message: input.message }, form: true });
}

async function publishInstagram(connection, input) {
  if (!connection.data.instagram || !connection.pageAccessToken) throw metaError('Compte Instagram ou token indisponible', 409);
  if (!input.image_url || !input.contenu) throw metaError('image_url et contenu requis pour une publication Instagram photo', 400);
  const container = await request(`/${connection.data.instagram.id}/media`, {
    method: 'POST',
    token: connection.pageAccessToken,
    body: { image_url: input.image_url, caption: input.contenu },
    form: true,
  });
  return request(`/${connection.data.instagram.id}/media_publish`, {
    method: 'POST',
    token: connection.pageAccessToken,
    body: { creation_id: container.id },
    form: true,
  });
}

module.exports = {
  graphBase,
  buildAuthorizeUrl,
  exchangeCode,
  exchangeLongLivedToken,
  debugToken,
  permissions,
  currentUser,
  pages,
  instagramProfile,
  grantedPermissions,
  calculateCapabilities,
  inspectConnection,
  readData,
  sendFacebookMessage,
  publishFacebook,
  replyFacebookComment,
  sendInstagramMessage,
  replyInstagramComment,
  publishInstagram,
};
