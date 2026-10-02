'use strict';

const { config } = require('./config');
const { safeErrorMessage } = require('./youtubeSecurity');

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

function normalizeScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : String(scopes || '').split(/[\s,]+/);
  return [...new Set(values.map((scope) => String(scope || '').trim()).filter(Boolean))];
}

function requireOAuthConfig() {
  if (!config.youtube.clientId || !config.youtube.clientSecret || !config.youtube.redirectUri) {
    const error = new Error('YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET et YOUTUBE_OAUTH_REDIRECT_URI doivent etre configures côté serveur');
    error.statusCode = 503;
    throw error;
  }
  if (config.isProduction && !/^https:\/\//i.test(config.youtube.redirectUri)) {
    const error = new Error('YOUTUBE_OAUTH_REDIRECT_URI doit utiliser HTTPS en production');
    error.statusCode = 503;
    throw error;
  }
}

function youtubeError(message, statusCode, payload) {
  const providerMessage = payload && (payload.error_description || payload.error && payload.error.message);
  const error = new Error(safeErrorMessage(message || providerMessage || 'Erreur YouTube'));
  error.statusCode = statusCode >= 400 && statusCode < 500 ? statusCode : 502;
  error.providerError = payload && payload.error ? String(payload.error) : null;
  return error;
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    throw youtubeError(`Echec reseau YouTube: ${err.name === 'AbortError' ? 'timeout' : err.message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (err) {
    payload = {};
  }
  if (!response.ok) {
    const providerCode = payload.error && payload.error.code ? payload.error.code : null;
    const status = providerCode === 'invalid_grant' || response.status === 401 ? 401 : response.status;
    throw youtubeError(`YouTube HTTP ${response.status}`, status, payload);
  }
  return payload;
}

function buildAuthorizeUrl(state) {
  requireOAuthConfig();
  const scopes = normalizeScopes(config.youtube.oauthScope);
  if (!scopes.length) {
    const error = new Error('YOUTUBE_OAUTH_SCOPE doit contenir au moins un scope Google');
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.youtube.clientId);
  url.searchParams.set('redirect_uri', config.youtube.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCode(code) {
  requireOAuthConfig();
  if (typeof code !== 'string' || code.length < 10 || code.length > 4096) {
    const error = new Error('Code OAuth YouTube absent ou invalide');
    error.statusCode = 400;
    throw error;
  }
  const body = new URLSearchParams({
    code,
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    redirect_uri: config.youtube.redirectUri,
    grant_type: 'authorization_code',
  });
  return requestJson(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

async function refreshAccessToken(refreshToken) {
  requireOAuthConfig();
  if (typeof refreshToken !== 'string' || !refreshToken) {
    const error = new Error('Refresh token YouTube absent');
    error.statusCode = 401;
    throw error;
  }
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    grant_type: 'refresh_token',
  });
  return requestJson(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

function capabilityForScopes(scopes) {
  const granted = new Set(normalizeScopes(scopes));
  const canRead = granted.has('https://www.googleapis.com/auth/youtube.readonly')
    || granted.has('https://www.googleapis.com/auth/youtube')
    || granted.has('https://www.googleapis.com/auth/youtube.force-ssl')
    || granted.has('https://www.googleapis.com/auth/youtube.upload');
  const canPublish = granted.has('https://www.googleapis.com/auth/youtube')
    || granted.has('https://www.googleapis.com/auth/youtube.upload');
  return {
    dm: false,
    lecture_commentaires: false,
    reponse_commentaires: false,
    lecture_chaine: canRead,
    publication: canPublish,
  };
}

async function requestYouTube(path, { accessToken, params = {} } = {}) {
  if (!accessToken) {
    const error = new Error('Access token YouTube absent');
    error.statusCode = 401;
    throw error;
  }
  const url = new URL(`${YOUTUBE_API_BASE}/${String(path).replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return requestJson(url.toString(), {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
  });
}

function normalizeChannel(item) {
  const snippet = item && item.snippet ? item.snippet : {};
  const thumbnails = snippet.thumbnails || {};
  const thumbnail = thumbnails.high || thumbnails.medium || thumbnails.default || {};
  return {
    id: item && item.id ? item.id : null,
    title: snippet.title || null,
    description: snippet.description || null,
    customUrl: snippet.customUrl || null,
    thumbnailUrl: thumbnail.url || null,
    publishedAt: snippet.publishedAt || null,
  };
}

async function inspectConnection({ accessToken, scopes }) {
  const payload = await requestYouTube('channels', {
    accessToken,
    params: { part: 'snippet,statistics', mine: 'true', maxResults: '1' },
  });
  const item = Array.isArray(payload.items) ? payload.items[0] : null;
  if (!item || !item.id) {
    const error = new Error('Aucune chaîne YouTube n’est associée à ce compte Google');
    error.statusCode = 404;
    throw error;
  }
  const permissions = normalizeScopes(scopes);
  return {
    channel: normalizeChannel(item),
    permissions,
    capabilities: capabilityForScopes(permissions),
  };
}

async function uploadVideoFromUrl({ accessToken, videoUrl, title = '', description = '', tags = [], privacyStatus = 'private', categoryId = '22' }) {
  if (!accessToken) {
    const error = new Error('Access token YouTube absent');
    error.statusCode = 401;
    throw error;
  }
  let source;
  try {
    source = new URL(String(videoUrl || ''));
  } catch (err) {
    const error = new Error('URL vidéo YouTube invalide');
    error.statusCode = 400;
    throw error;
  }
  if (source.protocol !== 'https:') {
    const error = new Error('YouTube exige une URL vidéo HTTPS');
    error.statusCode = 400;
    throw error;
  }
  const sourceResponse = await fetch(source.toString(), { redirect: 'follow' });
  if (!sourceResponse.ok) {
    throw youtubeError(`Téléchargement de la vidéo source impossible (HTTP ${sourceResponse.status})`, 502);
  }
  const contentLength = Number(sourceResponse.headers.get('content-length'));
  const maxBytes = 100 * 1024 * 1024;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error('La vidéo YouTube dépasse la limite de 100 Mo de cette première version');
    error.statusCode = 413;
    throw error;
  }
  const media = Buffer.from(await sourceResponse.arrayBuffer());
  if (!media.length) {
    const error = new Error('La vidéo source est vide');
    error.statusCode = 400;
    throw error;
  }
  if (media.length > maxBytes) {
    const error = new Error('La vidéo YouTube dépasse la limite de 100 Mo de cette première version');
    error.statusCode = 413;
    throw error;
  }
  const allowedPrivacy = new Set(['private', 'unlisted', 'public']);
  if (!allowedPrivacy.has(String(privacyStatus))) {
    const error = new Error('privacyStatus YouTube invalide');
    error.statusCode = 400;
    throw error;
  }
  const metadata = {
    snippet: {
      title: String(title || 'Vidéo Savoir Utile').slice(0, 100),
      description: String(description || '').slice(0, 5000),
      categoryId: String(categoryId || '22'),
      ...(Array.isArray(tags) && tags.length ? { tags: tags.map((tag) => String(tag).slice(0, 500)).slice(0, 500) } : {}),
    },
    status: { privacyStatus: String(privacyStatus), selfDeclaredMadeForKids: false },
  };
  const initController = new AbortController();
  const initTimeout = setTimeout(() => initController.abort(), 15000);
  let initResponse;
  try {
    initResponse = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': sourceResponse.headers.get('content-type') || 'video/mp4',
        'X-Upload-Content-Length': String(media.length),
      },
      body: JSON.stringify(metadata),
      signal: initController.signal,
    });
  } catch (err) {
    throw youtubeError(`Échec réseau YouTube lors de l’initialisation : ${err.name === 'AbortError' ? 'timeout' : err.message}`, 502);
  } finally {
    clearTimeout(initTimeout);
  }
  const initText = await initResponse.text();
  let initPayload = {};
  try { initPayload = initText ? JSON.parse(initText) : {}; } catch (err) { initPayload = {}; }
  if (!initResponse.ok) throw youtubeError(`YouTube HTTP ${initResponse.status}`, initResponse.status, initPayload);
  const uploadUrl = initResponse.headers.get('location');
  if (!uploadUrl || !/^https:\/\//i.test(uploadUrl)) {
    const error = new Error('YouTube n’a pas renvoyé d’URL de téléversement sûre');
    error.statusCode = 502;
    throw error;
  }
  const uploadController = new AbortController();
  const uploadTimeout = setTimeout(() => uploadController.abort(), 120000);
  let uploadResponse;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': sourceResponse.headers.get('content-type') || 'video/mp4',
        'Content-Length': String(media.length),
      },
      body: media,
      signal: uploadController.signal,
    });
  } catch (err) {
    throw youtubeError(`Échec réseau YouTube lors du téléversement : ${err.name === 'AbortError' ? 'timeout' : err.message}`, 502);
  } finally {
    clearTimeout(uploadTimeout);
  }
  const uploadText = await uploadResponse.text();
  let uploadPayload = {};
  try { uploadPayload = uploadText ? JSON.parse(uploadText) : {}; } catch (err) { uploadPayload = {}; }
  if (!uploadResponse.ok) throw youtubeError(`YouTube HTTP ${uploadResponse.status}`, uploadResponse.status, uploadPayload);
  if (!uploadPayload.id) {
    const error = new Error('YouTube n’a pas renvoyé l’identifiant de la vidéo téléversée');
    error.statusCode = 502;
    throw error;
  }
  return { id: uploadPayload.id, status: uploadPayload.status || { privacyStatus: privacyStatus } };
}

async function revokeToken(token) {
  if (!token) return false;
  const url = new URL(GOOGLE_REVOKE_URL);
  url.searchParams.set('token', token);
  try {
    await requestJson(url.toString(), { method: 'POST', headers: { Accept: 'application/json' } });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  normalizeScopes,
  requireOAuthConfig,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  capabilityForScopes,
  requestYouTube,
  inspectConnection,
  uploadVideoFromUrl,
  revokeToken,
};
