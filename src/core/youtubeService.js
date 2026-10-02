'use strict';

const youtubeApi = require('./youtubeApi');
const youtubeStore = require('./youtubeStore');
const { safeErrorMessage } = require('./youtubeSecurity');

function tokenExpiryFromResponse(tokenResponse) {
  const seconds = Number(tokenResponse && tokenResponse.expires_in);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null;
}

async function inspectWithRefresh(connection) {
  if (!connection) {
    const error = new Error('Aucune connexion YouTube active');
    error.statusCode = 404;
    throw error;
  }
  const scopes = connection.data && connection.data.permissions ? connection.data.permissions : [];
  try {
    const inspected = await youtubeApi.inspectConnection({ accessToken: connection.accessToken, scopes });
    return { inspected, refreshed: false };
  } catch (err) {
    if (err.statusCode !== 401 || !connection.refreshToken) throw err;
    const refreshed = await youtubeApi.refreshAccessToken(connection.refreshToken);
    if (!refreshed.access_token) {
      const error = new Error('YouTube n’a pas renvoyé un nouvel access token');
      error.statusCode = 502;
      throw error;
    }
    await youtubeStore.updateAccessToken(connection.row.id, refreshed.access_token, tokenExpiryFromResponse(refreshed));
    const inspected = await youtubeApi.inspectConnection({ accessToken: refreshed.access_token, scopes });
    return { inspected, refreshed: true };
  }
}

async function publishVideo(connection, input) {
  if (!connection || !connection.row) {
    const error = new Error('Aucune connexion YouTube active');
    error.statusCode = 404;
    throw error;
  }
  const options = {
    accessToken: connection.accessToken,
    videoUrl: input.video_url || input.videoUrl,
    title: input.title || input.contenu || 'Vidéo Savoir Utile',
    description: input.description || '',
    tags: input.tags,
    privacyStatus: input.privacy_status || input.privacyStatus || 'private',
    categoryId: input.category_id || input.categoryId || '22',
  };
  try {
    return await youtubeApi.uploadVideoFromUrl(options);
  } catch (err) {
    if (err.statusCode !== 401 || !connection.refreshToken) throw err;
    const refreshed = await youtubeApi.refreshAccessToken(connection.refreshToken);
    if (!refreshed.access_token) {
      const error = new Error('YouTube n’a pas renvoyé un nouvel access token');
      error.statusCode = 502;
      throw error;
    }
    await youtubeStore.updateAccessToken(connection.row.id, refreshed.access_token, tokenExpiryFromResponse(refreshed));
    return youtubeApi.uploadVideoFromUrl({ ...options, accessToken: refreshed.access_token });
  }
}

async function safeVerify(row) {
  try {
    const connection = await youtubeStore.getDecryptedConnection(row);
    const result = await inspectWithRefresh(connection);
    return result;
  } catch (err) {
    const safe = new Error(safeErrorMessage(err));
    safe.statusCode = err.statusCode || 502;
    throw safe;
  }
}

module.exports = {
  tokenExpiryFromResponse,
  inspectWithRefresh,
  publishVideo,
  safeVerify,
};
