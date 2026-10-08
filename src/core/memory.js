'use strict';

const { config } = require('./config');
const { logger } = require('./logger');
const jsonStore = require('./memoryStoreJson');

/**
 * Collections minimales requises par le prompt maitre (section 9 - MEMOIRE).
 * Chaque collection est une table Supabase (schema generique id/created_at/
 * updated_at/data jsonb, voir SETUP.md) ou un fichier JSON du meme nom.
 */
const COLLECTIONS = Object.freeze({
  EVENTS: 'events',
  TASKS: 'tasks',
  CONTACTS: 'contacts',
  CONTENT: 'content',
  METRICS: 'metrics',
  DECISIONS: 'decisions',
  ERRORS: 'errors',
  LEARNINGS: 'learnings',
  APPROVALS: 'approvals',
  EXECUTIONS: 'executions',
  META_CONNECTIONS: 'meta_connections',
  META_OAUTH_STATES: 'meta_oauth_states',
  YOUTUBE_CONNECTIONS: 'youtube_connections',
  YOUTUBE_OAUTH_STATES: 'youtube_oauth_states',
  TIKTOK_CONNECTIONS: 'tiktok_connections',
  TIKTOK_OAUTH_STATES: 'tiktok_oauth_states',
  VIDEO_JOBS: 'video_jobs',
});

let supabaseClient = null;
let supabaseInitTried = false;
let backendName = 'json';
const SUPABASE_REQUEST_TIMEOUT_MS = 120000;
const localIdempotencyLocks = new Map();
const localRowLocks = new Map();

function fetchWithTimeout(input, init = {}) {
  const timeoutSignal = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}

function getSupabaseClient() {
  if (supabaseInitTried) return supabaseClient;
  supabaseInitTried = true;
  if (!config.memory.supabaseUrl || !config.memory.supabaseServiceKey) {
    return null;
  }
  try {
    // Import differe : le paquet est optionnel tant que Supabase n'est pas utilise.
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(config.memory.supabaseUrl, config.memory.supabaseServiceKey, {
      auth: { persistSession: false },
      global: { fetch: fetchWithTimeout },
    });
    backendName = 'supabase';
    logger.info('memory: backend Supabase actif');
    return supabaseClient;
  } catch (err) {
    logger.warn('memory: @supabase/supabase-js indisponible, fallback JSON', {
      error: err.message,
    });
    return null;
  }
}

function currentBackend() {
  return getSupabaseClient() ? 'supabase' : 'json';
}

async function withFallback(supabaseFn, jsonFn, context) {
  const client = getSupabaseClient();
  if (client) {
    try {
      return await supabaseFn(client);
    } catch (err) {
      logger.error('memory: erreur Supabase, operation interrompue sans fallback silencieux', {
        context,
        error: err.message,
      });
      throw err;
    }
  }
  return jsonFn();
}

async function insert(collection, data) {
  return withFallback(
    async (client) => {
      const { data: rows, error } = await client
        .from(collection)
        .insert({ data })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return rows;
    },
    () => jsonStore.insert(collection, data),
    { op: 'insert', collection }
  );
}

/**
 * Idempotence en deux temps : CLAIM (EN_COURS) -> traitement par
 * l'appelant -> CONFIRM (TERMINE) uniquement si ce traitement reussit
 * reellement.
 *
 * AUDIT (bug critique) : l'ancienne version marquait un evenement comme
 * definitivement traite des sa premiere reclamation, avant meme que le
 * traitement associe n'ait commence. Consequence reelle : un payload Meta
 * contenant plusieurs evenements (A + B) ou seul A reussissait laissait B
 * marque "deja vu" pour toujours - un retry ne retraitait jamais B, sans
 * qu'aucune erreur ne soit visible. Desormais :
 *   - premiere reclamation  -> statut EN_COURS, doublon=false ;
 *   - reclamation pendant que EN_COURS est encore valide (traitement en
 *     cours, ou echec pas encore libere) -> doublon=true ;
 *   - reclamation apres confirmIdempotencyEvent()               -> statut
 *     TERMINE, doublon=true, pour toujours (comportement historique) ;
 *   - reclamation apres expiration de la fenetre EN_COURS (voir
 *     config.memory.idempotencyTtlMs) sans confirmation ni liberation
 *     explicite (crash, timeout) -> reprise raisonnable : la marque est
 *     reclamee (nouveau claimed_at), doublon=false.
 * Les marqueurs ecrits par l'ancien code (aucun champ `statut`) sont
 * traites comme TERMINE par securite : jamais de retraitement silencieux
 * de donnees anterieures a cette correction.
 */
async function claimIdempotencyEvent(scope, key, options = {}) {
  if (!scope || !key) throw new Error('memory.claimIdempotencyEvent: scope et key sont requis');
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : config.memory.idempotencyTtlMs;
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.rpc('claim_idempotency_event', {
      p_scope: scope,
      p_cle: key,
      p_ttl_ms: ttlMs,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    const statut = row && row.statut ? row.statut : 'EN_COURS';
    return {
      doublon: Boolean(row && row.claimed === false),
      statut,
      premiere_fois: row && row.first_claimed_at ? row.first_claimed_at : null,
      cle: key,
      backend: 'supabase',
      atomique: true,
    };
  }

  // Le verrou couvre les appels concurrents dans un même processus local. Il
  // ne remplace pas la contrainte PostgreSQL entre instances serverless.
  const composite = `${scope}\u0000${key}`;
  const previous = localIdempotencyLocks.get(composite) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  localIdempotencyLocks.set(composite, turn);
  await previous;
  try {
    const existing = await jsonStore.list(COLLECTIONS.EVENTS, {
      filter: (data) => data.type === 'idempotency.marker' && data.scope === scope && data.cle === key,
      limit: 1,
    });
    if (existing.length === 0) {
      const nowIso = new Date().toISOString();
      const created = await jsonStore.insert(COLLECTIONS.EVENTS, {
        type: 'idempotency.marker',
        scope,
        cle: key,
        statut: 'EN_COURS',
        claimed_at: nowIso,
        confirmed_at: null,
        at: nowIso,
      });
      return { doublon: false, statut: 'EN_COURS', cle: key, backend: 'json', atomique: true, markerId: created.id };
    }

    const marker = existing[0];
    // Marqueur pre-existant sans `statut` (ecrit avant cette correction) :
    // considere TERMINE, jamais retraite silencieusement.
    const statut = marker.data.statut || 'TERMINE';
    if (statut === 'TERMINE') {
      return {
        doublon: true,
        statut: 'TERMINE',
        premiere_fois: marker.data.confirmed_at || marker.data.claimed_at || marker.created_at,
        cle: key,
        backend: 'json',
        atomique: true,
        markerId: marker.id,
      };
    }

    const claimedAtMs = new Date(marker.data.claimed_at || marker.created_at).getTime();
    if (Date.now() - claimedAtMs < ttlMs) {
      return {
        doublon: true,
        statut: 'EN_COURS',
        premiere_fois: marker.data.claimed_at || marker.created_at,
        cle: key,
        backend: 'json',
        atomique: true,
        markerId: marker.id,
      };
    }

    // EN_COURS expire (crash / timeout du traitement precedent) : reprise
    // raisonnable, on reclame la marque plutot que de rester bloque.
    await jsonStore.update(COLLECTIONS.EVENTS, marker.id, {
      statut: 'EN_COURS',
      claimed_at: new Date().toISOString(),
      reclaimed: true,
    });
    return { doublon: false, statut: 'EN_COURS', cle: key, backend: 'json', atomique: true, markerId: marker.id, reclaimed: true };
  } finally {
    release();
    if (localIdempotencyLocks.get(composite) === turn) localIdempotencyLocks.delete(composite);
  }
}

/** CONFIRM : transition EN_COURS -> TERMINE apres succes reel du traitement. */
async function confirmIdempotencyEvent(scope, key) {
  if (!scope || !key) throw new Error('memory.confirmIdempotencyEvent: scope et key sont requis');
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.rpc('confirm_idempotency_event', { p_scope: scope, p_cle: key });
    if (error) throw new Error(error.message);
    return Boolean(data);
  }

  const composite = `${scope}\u0000${key}`;
  const previous = localIdempotencyLocks.get(composite) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  localIdempotencyLocks.set(composite, turn);
  await previous;
  try {
    const existing = await jsonStore.list(COLLECTIONS.EVENTS, {
      filter: (data) => data.type === 'idempotency.marker' && data.scope === scope && data.cle === key,
      limit: 1,
    });
    if (existing.length === 0) return false;
    await jsonStore.update(COLLECTIONS.EVENTS, existing[0].id, {
      statut: 'TERMINE',
      confirmed_at: new Date().toISOString(),
    });
    return true;
  } finally {
    release();
    if (localIdempotencyLocks.get(composite) === turn) localIdempotencyLocks.delete(composite);
  }
}

/**
 * RELEASE : libere un evenement EN_COURS suite a un echec de traitement,
 * pour permettre un nouvel essai immediat (sans attendre l'expiration de la
 * fenetre EN_COURS). Ne touche jamais une marque deja TERMINE : un succes
 * confirme ne peut pas etre annule par un appel tardif.
 */
async function releaseIdempotencyEvent(scope, key) {
  if (!scope || !key) throw new Error('memory.releaseIdempotencyEvent: scope et key sont requis');
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.rpc('release_idempotency_event', { p_scope: scope, p_cle: key });
    if (error) throw new Error(error.message);
    return Boolean(data);
  }

  const composite = `${scope}\u0000${key}`;
  const previous = localIdempotencyLocks.get(composite) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  localIdempotencyLocks.set(composite, turn);
  await previous;
  try {
    const existing = await jsonStore.list(COLLECTIONS.EVENTS, {
      filter: (data) => data.type === 'idempotency.marker' && data.scope === scope && data.cle === key && data.statut !== 'TERMINE',
      limit: 1,
    });
    if (existing.length === 0) return false;
    return jsonStore.remove(COLLECTIONS.EVENTS, existing[0].id);
  } finally {
    release();
    if (localIdempotencyLocks.get(composite) === turn) localIdempotencyLocks.delete(composite);
  }
}

async function list(collection, options = {}) {
  return withFallback(
    async (client) => {
      let query = client
        .from(collection)
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
      if (options.limit) query = query.limit(options.limit);
      const { data: rows, error } = await query;
      if (error) throw new Error(error.message);
      if (options.filter) {
        return rows.filter((row) => options.filter(row.data, row));
      }
      return rows;
    },
    () => jsonStore.list(collection, options),
    { op: 'list', collection }
  );
}

async function get(collection, id) {
  return withFallback(
    async (client) => {
      const { data: row, error } = await client
        .from(collection)
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return row;
    },
    () => jsonStore.get(collection, id),
    { op: 'get', collection }
  );
}

async function updateIf(collection, id, expectedData, patch) {
  const client = getSupabaseClient();
  if (client) {
    const { data: existing, error: readError } = await client
      .from(collection)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) return null;
    for (const [key, value] of Object.entries(expectedData || {})) {
      if (existing.data[key] !== value) return null;
    }
    const merged = { ...existing.data, ...patch };
    const { data: row, error } = await client
      .from(collection)
      .update({ data: merged, updated_at: new Date().toISOString() })
      .eq('id', id)
      .contains('data', expectedData || {})
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row || null;
  }

  const lockKey = `${collection}:${id}`;
  const previous = localRowLocks.get(lockKey) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  localRowLocks.set(lockKey, turn);
  await previous;
  try {
    const existing = await jsonStore.get(collection, id);
    if (!existing) return null;
    for (const [key, value] of Object.entries(expectedData || {})) {
      if (existing.data[key] !== value) return null;
    }
    return jsonStore.update(collection, id, patch);
  } finally {
    release();
    if (localRowLocks.get(lockKey) === turn) localRowLocks.delete(lockKey);
  }
}

async function update(collection, id, patch) {
  return withFallback(
    async (client) => {
      const existing = await get(collection, id);
      if (!existing) return null;
      const merged = { ...existing.data, ...patch };
      const { data: row, error } = await client
        .from(collection)
        .update({ data: merged, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return row;
    },
    () => jsonStore.update(collection, id, patch),
    { op: 'update', collection }
  );
}

async function remove(collection, id) {
  return withFallback(
    async (client) => {
      const { error } = await client.from(collection).delete().eq('id', id);
      if (error) throw new Error(error.message);
      return true;
    },
    () => jsonStore.remove(collection, id),
    { op: 'remove', collection }
  );
}

/** Enregistre un evenement dans la collection EVENTS (section 9 + section 21). */
async function recordEvent(type, payload) {
  return insert(COLLECTIONS.EVENTS, { type, payload, at: new Date().toISOString() });
}

/** Enregistre une ligne du journal d'execution (section 21 - JOURNAL D'EXECUTION). */
async function recordExecution(entry) {
  return insert(COLLECTIONS.EXECUTIONS, {
    date: new Date().toISOString().slice(0, 10),
    heure: new Date().toISOString().slice(11, 19),
    workflow: entry.workflow,
    declencheur: entry.declencheur,
    agent: entry.agent || null,
    action: entry.action,
    // Fournisseur IA reellement utilise pour cette execution (gemini/groq/
    // openrouter/mock/null si l'agent n'a pas appele l'IA) - section 6 et
    // 23 du prompt maitre V1.1 : le fournisseur utilise doit toujours etre
    // journalise, jamais suppose ou omis silencieusement.
    fournisseur_ia: entry.fournisseur_ia || null,
    resultat: entry.resultat,
    // AUDIT (bug critique silencieux) : ce champ etait absent d'ici alors
    // que taskEngine.js et scheduler-tick.js le fournissent systematiquement
    // pour PUBLISH_POST/SEND_MESSAGE/REPLY_COMMENT/UPDATE_DATA. Consequence :
    // `statut_sortie` etait TOUJOURS perdu a l'ecriture, silencieusement -
    // toute lecture ulterieure (ex: taskEngine.js verifiant
    // `row.data.statut_sortie === 'PUBLIE'` pour le quota de campagne, ou
    // statistiques.js pour "contenus_publies") ne voyait jamais que
    // `undefined`, rendant ces verifications inoperantes sans qu'aucune
    // erreur ne soit levee.
    statut_sortie: entry.statut_sortie || null,
    duree_ms: entry.duree_ms,
    erreur: entry.erreur || null,
  });
}

/** Enregistre une erreur (collection ERRORS) et le journal d'execution associe. */
async function recordError(context, error) {
  return insert(COLLECTIONS.ERRORS, {
    context,
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : null,
    at: new Date().toISOString(),
  });
}

module.exports = {
  COLLECTIONS,
  // AUDIT (bug pre-existant corrige) : getSupabaseClient() etait definie
  // mais jamais exportee, alors que src/core/mediaStorage.js l'appelle via
  // `memory.getSupabaseClient()`. Consequence reelle : des que Supabase est
  // reellement configure (production), tout appel a mediaStorage.upload()
  // levait `TypeError: memory.getSupabaseClient is not a function` au lieu
  // de fonctionner — stockage de la voix off, puis des assets/rendus video
  // (voir visualEngine.js, videoOrchestrator.js), casse silencieusement
  // dans l'environnement ou cela compte le plus. Corrige en exportant la
  // fonction existante, sans en changer le comportement.
  getSupabaseClient,
  insert,
  claimIdempotencyEvent,
  confirmIdempotencyEvent,
  releaseIdempotencyEvent,
  list,
  updateIf,
  get,
  update,
  remove,
  recordEvent,
  recordExecution,
  recordError,
  currentBackend,
};
