'use strict';

const tiktokApi = require('./tiktokApi');
const tiktokStore = require('./tiktokStore');
const { safeErrorMessage } = require('./tiktokSecurity');

const TERMINAL_SUCCESS = new Set(['PUBLISH_COMPLETE', 'PUBLISHED', 'COMPLETE', 'SUCCESS']);
const TERMINAL_FAILURE = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED']);

async function inspectWithRefresh(connection) {
  if (!connection || !connection.row) throw new Error('Connexion TikTok absente');
  try {
    const userPayload = await tiktokApi.getUserInfo({ accessToken: connection.accessToken });
    return {
      inspected: {
        user: tiktokApi.normalizeUser(userPayload),
        permissions: connection.data.permissions || [],
        capabilities: tiktokApi.capabilityForScopes(connection.data.permissions || []),
      },
      refreshed: false,
      accessToken: connection.accessToken,
    };
  } catch (err) {
    if (!connection.refreshToken || Number(err.statusCode) !== 401) throw err;
    const tokenResponse = await tiktokApi.refreshAccessToken(connection.refreshToken);
    await tiktokStore.updateAccessToken(connection.row.id, tokenResponse);
    const userPayload = await tiktokApi.getUserInfo({ accessToken: tokenResponse.access_token });
    return {
      inspected: {
        user: tiktokApi.normalizeUser(userPayload),
        permissions: tiktokApi.normalizeGrantedScopes(tokenResponse, connection.data.permissions || []),
        capabilities: tiktokApi.capabilityForScopes(tiktokApi.normalizeGrantedScopes(tokenResponse, connection.data.permissions || [])),
      },
      refreshed: true,
      tokenResponse,
      accessToken: tokenResponse.access_token,
    };
  }
}

async function verifyConnection(row) {
  const connection = await tiktokStore.getDecryptedConnection(row);
  if (!connection) throw new Error('Connexion TikTok inactive ou tokens indisponibles');
  const result = await inspectWithRefresh(connection);
  await tiktokStore.updateVerification(row.id, {
    user: result.inspected.user,
    permissions: result.inspected.permissions,
    capabilities: result.inspected.capabilities,
    lastError: null,
  });
  return result.inspected;
}

async function publishVideo(connection, input) {
  if (!connection || !connection.row) throw new Error('Connexion TikTok absente');
  let active = connection;
  let result;
  try {
    result = await tiktokApi.initVideoPost({
      accessToken: active.accessToken,
      title: input.title || input.contenu || '',
      videoUrl: input.video_url || input.videoUrl,
      privacyLevel: input.privacy_level || input.privacyLevel || 'SELF_ONLY',
      disableComment: input.disable_comment,
      disableDuet: input.disable_duet,
      disableStitch: input.disable_stitch,
      coverTimestampMs: input.video_cover_timestamp_ms,
    });
  } catch (err) {
    if (Number(err.statusCode) !== 401 || !active.refreshToken) throw err;
    const tokenResponse = await tiktokApi.refreshAccessToken(active.refreshToken);
    await tiktokStore.updateAccessToken(active.row.id, tokenResponse);
    active = await tiktokStore.getDecryptedConnection(await tiktokStore.getActiveConnection());
    result = await tiktokApi.initVideoPost({
      accessToken: active.accessToken,
      title: input.title || input.contenu || '',
      videoUrl: input.video_url || input.videoUrl,
      privacyLevel: input.privacy_level || input.privacyLevel || 'SELF_ONLY',
      disableComment: input.disable_comment,
      disableDuet: input.disable_duet,
      disableStitch: input.disable_stitch,
      coverTimestampMs: input.video_cover_timestamp_ms,
    });
  }
  const data = result && result.data ? result.data : {};
  if (!data.publish_id) throw new Error('TikTok n’a pas renvoyé d’identifiant de publication');
  const title = input.title || input.contenu || '';
  const videoUrl = input.video_url || input.videoUrl;
  const privacyLevel = input.privacy_level || input.privacyLevel || 'SELF_ONLY';
  await tiktokStore.savePublication({
    publishId: data.publish_id,
    contentKey: input.content_key || input.contentKey || null,
    title,
    videoUrl,
    privacyLevel,
  });
  return {
    publication_id: data.publish_id,
    statut: 'EN_TRAITEMENT',
    provider_status: 'PROCESSING',
    mode: 'PULL_FROM_URL',
    privacy_level: privacyLevel,
    suivi: `GET /api/tiktok/publish-status?publication_id=${encodeURIComponent(data.publish_id)}`,
    note: 'TikTok a accepté la soumission. Le statut final doit être relu via publish-status; ceci ne confirme pas encore la publication.',
  };
}

function normalizePublishStatus(payload) {
  const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : (payload || {});
  const providerStatus = String(data.status || data.publish_status || data.publishStatus || data.state || '').trim().toUpperCase() || 'UNKNOWN';
  const statut = TERMINAL_SUCCESS.has(providerStatus)
    ? 'PUBLIE'
    : (TERMINAL_FAILURE.has(providerStatus) ? 'ECHEC' : 'EN_TRAITEMENT');
  const publicPostId = data.publicaly_available_post_id || data.publicly_available_post_id || data.post_id || null;
  const error = data.fail_reason || data.error_message || data.error || null;
  return {
    provider_status: providerStatus,
    statut,
    public_post_id: publicPostId ? String(publicPostId) : null,
    erreur: error ? safeErrorMessage(String(error)) : null,
    uploaded_bytes: Number.isFinite(Number(data.uploaded_bytes)) ? Number(data.uploaded_bytes) : null,
    raw_fields: Object.keys(data).filter((key) => !/token|secret|authorization/i.test(key)).slice(0, 30),
  };
}

async function fetchPublicationStatus(row) {
  if (!row || !row.data || !row.data.publish_id) throw new Error('Publication TikTok absente');
  const connection = await tiktokStore.getDecryptedConnection(await tiktokStore.getActiveConnection());
  if (!connection) throw new Error('Connexion TikTok absente ou inactive');
  let active = connection;
  let payload;
  try {
    payload = await tiktokApi.fetchPublishStatus({ accessToken: active.accessToken, publishId: row.data.publish_id });
  } catch (err) {
    if (Number(err.statusCode) !== 401 || !active.refreshToken) throw err;
    const tokenResponse = await tiktokApi.refreshAccessToken(active.refreshToken);
    await tiktokStore.updateAccessToken(active.row.id, tokenResponse);
    active = await tiktokStore.getDecryptedConnection(await tiktokStore.getActiveConnection());
    payload = await tiktokApi.fetchPublishStatus({ accessToken: active.accessToken, publishId: row.data.publish_id });
  }
  const normalized = normalizePublishStatus(payload);
  const terminal = normalized.statut === 'PUBLIE' || normalized.statut === 'ECHEC';
  await tiktokStore.updatePublication(row.id, {
    ...normalized,
    dernier_controle_at: new Date().toISOString(),
    termine_at: terminal ? new Date().toISOString() : null,
  });
  return { publication_id: row.data.publish_id, ...normalized, derniere_verification: new Date().toISOString() };
}

async function safePublicationStatus(row) {
  try {
    return await fetchPublicationStatus(row);
  } catch (err) {
    const message = safeErrorMessage(err);
    await tiktokStore.updatePublication(row.id, {
      statut: 'ERREUR_CONTROLE',
      erreur: message,
      dernier_controle_at: new Date().toISOString(),
    }).catch(() => undefined);
    throw err;
  }
}

async function safeVerify(row) {
  try {
    return await verifyConnection(row);
  } catch (err) {
    const message = safeErrorMessage(err);
    await tiktokStore.updateVerification(row.id, { lastError: message }).catch(() => undefined);
    throw err;
  }
}

module.exports = {
  inspectWithRefresh,
  verifyConnection,
  publishVideo,
  normalizePublishStatus,
  fetchPublicationStatus,
  safePublicationStatus,
  safeVerify,
};
