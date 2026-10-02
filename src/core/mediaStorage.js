'use strict';

const memory = require('./memory');
const { config } = require('./config');
const { logger } = require('./logger');

/**
 * Stockage durable de fichiers binaires (audio de voix off pour le moment,
 * potentiellement images/vidéos à l'avenir) via Supabase Storage.
 *
 * Réutilise volontairement les mêmes identifiants que le reste de la mémoire
 * (SUPABASE_URL / SUPABASE_SERVICE_KEY, voir memory.js) : aucune nouvelle
 * variable d'authentification à gérer, seul le nom du bucket est
 * configurable via SUPABASE_MEDIA_BUCKET.
 *
 * Honnêteté : si Supabase n'est pas configuré, si le paquet
 * @supabase/supabase-js est indisponible, ou si le bucket n'existe pas /
 * n'est pas rendu public côté Supabase, upload() renvoie explicitement
 * configured:false ou url:null accompagné d'une raison - jamais une URL
 * inventée. Le bucket doit être créé manuellement dans le projet Supabase
 * (Storage > New bucket, "Public bucket" activé) : ce module ne le crée pas
 * automatiquement pour éviter toute action destructive/silencieuse sur un
 * projet Supabase existant.
 */

const DEFAULT_BUCKET = process.env.SUPABASE_MEDIA_BUCKET || 'conquistador-media';

function configured() {
  return Boolean(config.memory.supabaseUrl && config.memory.supabaseServiceKey);
}

async function upload({ path, buffer, contentType, bucket = DEFAULT_BUCKET, upsert = true } = {}) {
  if (!path || !Buffer.isBuffer(buffer)) {
    throw new Error('mediaStorage.upload: "path" et "buffer" (Buffer) sont requis');
  }
  if (!configured()) {
    return {
      configured: false,
      url: null,
      bucket,
      path,
      raison: 'SUPABASE_URL / SUPABASE_SERVICE_KEY non configurés : ce fichier ne peut pas être stocké de façon durable pour le moment.',
    };
  }
  const client = memory.getSupabaseClient();
  if (!client) {
    return {
      configured: false,
      url: null,
      bucket,
      path,
      raison: '@supabase/supabase-js indisponible : impossible d’uploader ce fichier.',
    };
  }
  try {
    const { error: uploadError } = await client.storage.from(bucket).upload(path, buffer, {
      contentType: contentType || 'application/octet-stream',
      upsert,
    });
    if (uploadError) {
      logger.warn('mediaStorage: echec upload Supabase Storage', { bucket, path, error: uploadError.message });
      return { configured: true, url: null, bucket, path, raison: `Échec de l’upload Supabase Storage : ${uploadError.message}` };
    }
    const { data } = client.storage.from(bucket).getPublicUrl(path);
    const url = data && data.publicUrl ? data.publicUrl : null;
    if (!url) {
      return {
        configured: true,
        url: null,
        bucket,
        path,
        raison: 'Upload réussi mais aucune URL publique renvoyée : vérifier que le bucket Supabase est bien configuré en public.',
      };
    }
    return { configured: true, url, bucket, path };
  } catch (err) {
    logger.warn('mediaStorage: exception pendant l’upload', { bucket, path, error: err.message });
    return { configured: true, url: null, bucket, path, raison: `Exception pendant l’upload : ${err.message}` };
  }
}

module.exports = { upload, DEFAULT_BUCKET, configured };
