'use strict';

const { config } = require('./config');
const { safeErrorMessage } = require('./tiktokSecurity');

const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

function normalizeScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : String(scopes || '').split(/[\s,]+/);
  return [...new Set(values.map((scope) => String(scope || '').trim()).filter(Boolean))];
}

function requireOAuthConfig() {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret || !config.tiktok.redirectUri) {
    const error = new Error('TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET et TIKTOK_OAUTH_REDIRECT_URI doivent etre configures côté serveur');
    error.statusCode = 503;
    throw error;
  }
  if (config.isProduction && !/^https:\/\//i.test(config.tiktok.redirectUri)) {
    const error = new Error('TIKTOK_OAUTH_REDIRECT_URI doit utiliser HTTPS en production');
    error.statusCode = 503;
    throw error;
  }
}

function tiktokError(message, statusCode, payload) {
  const providerError = payload && payload.error;
  const providerMessage = providerError && (providerError.message || providerError.code);
  const error = new Error(safeErrorMessage(message || providerMessage || 'Erreur TikTok'));
  error.statusCode = statusCode >= 400 && statusCode < 500 ? statusCode : 502;
  error.providerCode = providerError && providerError.code ? String(providerError.code) : null;
  error.providerLogId = providerError && providerError.log_id ? String(providerError.log_id) : null;
  return error;
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    throw tiktokError(`Echec reseau TikTok: ${err.name === 'AbortError' ? 'timeout' : err.message}`, 502);
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
  const providerFailed = payload && payload.error && payload.error.code && payload.error.code !== 'ok';
  if (!response.ok || providerFailed) {
    throw tiktokError(`TikTok HTTP ${response.status}`, response.status, payload);
  }
  return payload;
}

function buildAuthorizeUrl(state) {
  requireOAuthConfig();
  const scopes = normalizeScopes(config.tiktok.oauthScope);
  if (!scopes.length) {
    const error = new Error('TIKTOK_OAUTH_SCOPE doit contenir au moins un scope TikTok');
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set('client_key', config.tiktok.clientKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(','));
  url.searchParams.set('redirect_uri', config.tiktok.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('disable_auto_auth', '1');
  return url.toString();
}

function validateCode(code) {
  if (typeof code !== 'string' || code.length < 10 || code.length > 4096) {
    const error = new Error('Code OAuth TikTok absent ou invalide');
    error.statusCode = 400;
    throw error;
  }
}

async function exchangeCode(code) {
  requireOAuthConfig();
  validateCode(code);
  const body = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.tiktok.redirectUri,
  });
  return requestJson(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

async function refreshAccessToken(refreshToken) {
  requireOAuthConfig();
  if (typeof refreshToken !== 'string' || !refreshToken) {
    const error = new Error('Refresh token TikTok absent');
    error.statusCode = 401;
    throw error;
  }
  const body = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return requestJson(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

function tokenExpiresAt(response, fallback = null) {
  const expiresIn = Number(response && response.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return new Date(Date.now() + expiresIn * 1000).toISOString();
  return fallback;
}

function normalizeGrantedScopes(response, fallback = []) {
  return normalizeScopes(response && (response.scope || response.scopes || fallback));
}

function capabilityForScopes(scopes) {
  const granted = new Set(normalizeScopes(scopes));
  return {
    dm: false,
    lecture_commentaires: false,
    reponse_commentaires: false,
    lecture_chaine: granted.has('video.list') || granted.has('user.info.basic'),
    publication: granted.has('video.publish'),
  };
}

async function requestTikTok(path, { accessToken, method = 'GET', params = {}, body } = {}) {
  if (!accessToken) {
    const error = new Error('Access token TikTok absent');
    error.statusCode = 401;
    throw error;
  }
  const url = new URL(`${TIKTOK_API_BASE}/${String(path).replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return requestJson(url.toString(), {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getUserInfo({ accessToken }) {
  return requestTikTok('/user/info/', {
    accessToken,
    params: { fields: 'open_id,union_id,avatar_url,display_name,username' },
  });
}

function normalizeUser(payload) {
  const data = payload && payload.data ? payload.data : {};
  return {
    openId: data.open_id || null,
    unionId: data.union_id || null,
    username: data.username || null,
    displayName: data.display_name || null,
    avatarUrl: data.avatar_url || null,
  };
}

async function listVideos({ accessToken, cursor, maxCount = 20 }) {
  const count = Math.max(1, Math.min(Number(maxCount) || 20, 20));
  return requestTikTok('/video/list/', {
    accessToken,
    method: 'POST',
    params: { fields: 'id,create_time,title,cover_image_url,share_url,video_description' },
    body: { max_count: count, ...(cursor ? { cursor } : {}) },
  });
}

async function queryCreatorInfo({ accessToken }) {
  return requestTikTok('/post/publish/creator_info/query/', {
    accessToken,
    method: 'POST',
    body: {},
  });
}

function normalizeCreatorInfo(payload) {
  const data = payload && payload.data ? payload.data : {};
  return {
    username: data.creator_username || null,
    nickname: data.creator_nickname || null,
    privacyLevels: Array.isArray(data.privacy_level_options) ? data.privacy_level_options : [],
    commentDisabled: data.comment_disabled === true,
    duetDisabled: data.duet_disabled === true,
    stitchDisabled: data.stitch_disabled === true,
    maxVideoDurationSec: Number.isFinite(Number(data.max_video_post_duration_sec)) ? Number(data.max_video_post_duration_sec) : null,
  };
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch (err) {
    return null;
  }
}

async function initVideoPost({ accessToken, title = '', videoUrl, privacyLevel = 'SELF_ONLY', disableComment = false, disableDuet = false, disableStitch = false, coverTimestampMs = 0 }) {
  const normalizedUrl = httpsUrl(videoUrl);
  if (!normalizedUrl) {
    const error = new Error('TikTok exige une URL vidéo HTTPS vérifiée pour ce premier mode de publication');
    error.statusCode = 400;
    throw error;
  }
  const creator = normalizeCreatorInfo(await queryCreatorInfo({ accessToken }));
  if (creator.privacyLevels.length && !creator.privacyLevels.includes(privacyLevel)) {
    const error = new Error('Le niveau de confidentialité TikTok demandé n’est pas autorisé pour ce compte');
    error.statusCode = 400;
    throw error;
  }
  return requestTikTok('/post/publish/video/init/', {
    accessToken,
    method: 'POST',
    body: {
      post_info: {
        title: String(title || '').slice(0, 2200),
        privacy_level: privacyLevel,
        disable_comment: Boolean(disableComment),
        disable_duet: Boolean(disableDuet),
        disable_stitch: Boolean(disableStitch),
        video_cover_timestamp_ms: Math.max(0, Number(coverTimestampMs) || 0),
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: normalizedUrl,
      },
    },
  });
}

async function fetchPublishStatus({ accessToken, publishId }) {
  if (typeof publishId !== 'string' || !publishId || publishId.length > 512) {
    const error = new Error('Identifiant de publication TikTok absent ou invalide');
    error.statusCode = 400;
    throw error;
  }
  return requestTikTok('/post/publish/status/fetch/', {
    accessToken,
    method: 'POST',
    body: { publish_id: publishId },
  });
}

module.exports = {
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_TOKEN_URL,
  TIKTOK_API_BASE,
  normalizeScopes,
  requireOAuthConfig,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  tokenExpiresAt,
  normalizeGrantedScopes,
  capabilityForScopes,
  requestTikTok,
  getUserInfo,
  normalizeUser,
  listVideos,
  queryCreatorInfo,
  normalizeCreatorInfo,
  initVideoPost,
  fetchPublishStatus,
};
