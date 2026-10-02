'use strict';

const memory = require('./memory');

/**
 * VIDEO JOB SYSTEM — cycle de vie reel d'une video, persiste (Supabase ou
 * fallback JSON, voir memory.js) dans la collection VIDEO_JOBS (voir
 * docs/migrations/20260915_video_jobs.sql). Chaque job traverse :
 *   QUEUED -> PREPARING -> GENERATING_ASSETS -> GENERATING_VOICE ->
 *   COMPOSING -> RENDERING -> QUALITY_CHECK -> COMPLETED
 * ou FAILED / CANCELLED a tout moment. Voir videoOrchestrator.js pour la
 * logique qui fait REELLEMENT avancer un job d'un statut au suivant.
 *
 * EXTENSION (sections 16-19 du prompt maitre) — ADDITIVE, non destructive :
 * la machine a etats de PRODUCTION complete est exposee en plus de la
 * precedente, qui reste STRICTEMENT inchangee (aucun test existant ne
 * depend de nouveaux statuts, et aucun ancien statut n'est renomme) :
 *   GENERATING_SCRIPT, PREPARING_REFERENCES, GENERATING_ASSETS, GENERATING_VOICE,
 *   BUILDING_TIMELINE, COMPOSING, RENDERING, QUALITY_CHECK, READY,
 *   SCHEDULED, PUBLISHING, PUBLISHED, FAILED, CANCELLED
 *
 * Les etapes d'ORCHESTRATION (videoOrchestrator.ORDER) restent les memes ;
 * les etats de DIFFUSION (READY / SCHEDULED / PUBLISHING / PUBLISHED) sont
 * poses par videoJobs.markReady / schedulePublication / markPublishing /
 * markPublished, appeles par la jonction planificateur (schedulerBridge.js).
 */

const STATUSES = Object.freeze([
  'QUEUED', 'PREPARING', 'GENERATING_SCRIPT', 'PREPARING_REFERENCES',
  'GENERATING_ASSETS', 'GENERATING_VOICE', 'BUILDING_TIMELINE', 'COMPOSING',
  'RENDERING', 'QUALITY_CHECK', 'COMPLETED', 'READY', 'SCHEDULED',
  'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED',
]);

const TERMINAL_STATUSES = new Set(['COMPLETED', 'PUBLISHED', 'FAILED', 'CANCELLED']);

/** Etats pour lesquels un job rendu est candidat a la diffusion. */
const PUBLICATION_STATUSES = Object.freeze(['READY', 'SCHEDULED', 'PUBLISHING']);

const PROGRESS_BY_STATUS = Object.freeze({
  QUEUED: 0, PREPARING: 8, GENERATING_SCRIPT: 12, PREPARING_REFERENCES: 18,
  GENERATING_ASSETS: 25, GENERATING_VOICE: 50, BUILDING_TIMELINE: 56,
  COMPOSING: 62, RENDERING: 78, QUALITY_CHECK: 92, COMPLETED: 100,
  READY: 100, SCHEDULED: 100, PUBLISHING: 100, PUBLISHED: 100,
  FAILED: 100, CANCELLED: 100,
});

function nowIso() { return new Date().toISOString(); }

function toJob(record) {
  if (!record) return null;
  return { id: record.id, created_at: record.created_at, updated_at: record.updated_at, ...record.data };
}

/**
 * Creation idempotente : si `idempotencyKey` correspond a un job DEJA
 * existant (quel que soit son statut), le job EXISTANT est renvoye
 * (created: false) au lieu d'en creer un second — "pas de double rendu
 * accidentel" (mission). Contrairement a l'idempotence webhook
 * (idempotency.js, marqueurs ephemeres dans EVENTS), un job est une entite
 * longue duree qu'on veut pouvoir RETROUVER, pas seulement bloquer : d'ou
 * une recherche directe sur `idempotency_key` plutot qu'un marqueur separe.
 */
async function createJob(input = {}, { idempotencyKey = null } = {}) {
  if (idempotencyKey) {
    const existing = await memory.list(memory.COLLECTIONS.VIDEO_JOBS, {
      filter: (data) => data.idempotency_key === idempotencyKey,
      limit: 1,
    });
    if (existing.length) {
      return { job: toJob(existing[0]), created: false };
    }
  }
  const record = await memory.insert(memory.COLLECTIONS.VIDEO_JOBS, {
    status: 'QUEUED',
    progress: 0,
    idempotency_key: idempotencyKey,
    input,
    mode_at_creation: input.mode_at_creation || null,
    kill_switch_engaged_at_creation: Boolean(input.kill_switch_engaged_at_creation),
    format: input.format || { ratio: '9:16', width: 1080, height: 1920 },
    manifest: null,
    characters: null,
    timeline: null,
    assets: null,
    voice: null,
    subtitles: null,
    render: null,
    quality_check: null,
    storage: null,
    publication: null,
    ready_for_publication: false,
    error: null,
    error_step: null,
    timestamps: { queued_at: nowIso(), started_at: null, completed_at: null, failed_at: null },
  });
  return { job: toJob(record), created: true };
}

async function getJob(id) {
  const record = await memory.get(memory.COLLECTIONS.VIDEO_JOBS, id);
  return toJob(record);
}

async function listJobs({ status, limit = 50 } = {}) {
  const records = await memory.list(memory.COLLECTIONS.VIDEO_JOBS, {
    filter: status ? (data) => data.status === status : undefined,
    limit,
  });
  return records.map(toJob).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/**
 * Fait avancer un job d'un statut a l'autre (jamais en arriere, jamais
 * depuis un statut terminal). Rejette toute transition non prevue plutot
 * que de laisser un job dans un etat incoherent silencieusement.
 */
async function transition(id, status, patch = {}) {
  if (!STATUSES.includes(status)) throw new Error(`videoJobs.transition: statut inconnu "${status}"`);
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.transition: job "${id}" introuvable`);
  if (TERMINAL_STATUSES.has(current.status)) {
    throw new Error(`videoJobs.transition: le job "${id}" est deja dans un statut terminal (${current.status}), impossible de le faire transitionner vers "${status}".`);
  }
  // MEME GARDE-FOU ANTI FAUX SUCCES que patchJob (mission, sections 9 et 19) :
  // une output_url n'est enregistrable que si l'upload durable a ete VERIFIE.
  if (patch.output_url != null && patch.storage_ok !== true) {
    throw new Error('videoJobs.transition: "output_url" ne peut etre enregistre qu avec "storage_ok: true" (upload durable verifie) — un fichier cree n est pas une video recuperable.');
  }
  const timestamps = { ...current.timestamps };
  if (status !== 'QUEUED' && !timestamps.started_at) timestamps.started_at = nowIso();
  if (status === 'COMPLETED') timestamps.completed_at = nowIso();
  if (status === 'FAILED') timestamps.failed_at = nowIso();
  const record = await memory.update(memory.COLLECTIONS.VIDEO_JOBS, id, {
    ...patch,
    status,
    progress: PROGRESS_BY_STATUS[status] != null ? PROGRESS_BY_STATUS[status] : current.progress,
    timestamps,
  });
  return toJob(record);
}

/**
 * Mise a jour directe d'un job pour les etats de DIFFUSION, qui suivent
 * COMPLETED (donc terminal pour `transition`). Garde-fou : la transition
 * n'est autorisee que depuis la liste `allowedFrom` — une publication ne
 * peut pas ressusciter un job FAILED.
 */
async function patchJob(id, patch, { allowedFrom = null, status = null } = {}) {
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.patchJob: job "${id}" introuvable`);
  // GARDE-FOU ANTI FAUX SUCCES (mission, sections 9 et 19) : une URL de
  // sortie n'est enregistrable QUE si elle a ete VERIFIEE (upload durable
  // reel + URL recuperee, voir mediaStorage + stepFinalize). Un simple
  // chemin local ou une URL supposee ne fait pas un job "recuperable".
  if (patch.output_url != null && patch.storage_ok !== true) {
    throw new Error('videoJobs.patchJob: "output_url" ne peut etre enregistre qu avec "storage_ok: true" (upload durable verifie) — un fichier cree n est pas une video recuperable.');
  }
  if (allowedFrom && !allowedFrom.includes(current.status)) {
    throw new Error(`videoJobs.patchJob: transition refusee (statut actuel "${current.status}", autorise depuis ${allowedFrom.join('/')}).`);
  }
  const record = await memory.update(memory.COLLECTIONS.VIDEO_JOBS, id, {
    ...patch,
    ...(status ? { status, progress: PROGRESS_BY_STATUS[status] != null ? PROGRESS_BY_STATUS[status] : current.progress } : {}),
    updated_at: nowIso(),
  });
  return toJob(record);
}

/**
 * Promeut un rendu COMPLETED en READY (pret a diffuser). Idempotent : un job
 * deja READY/SCHEDULED/PUBLISHING/PUBLISHED n'est jamais retrograde.
 */
async function markReady(id, patch = {}) {
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.markReady: job "${id}" introuvable`);
  if (PUBLICATION_STATUSES.includes(current.status) || current.status === 'PUBLISHED') {
    return current;
  }
  if (current.status !== 'COMPLETED') {
    throw new Error(`videoJobs.markReady: le job "${id}" doit etre COMPLETED avant de devenir READY (statut actuel : ${current.status}). Un rendu non termine ne peut pas etre declare pret.`);
  }
  if (!current.output_url) {
    throw new Error(`videoJobs.markReady: le job "${id}" n'a pas d'URL de sortie : une video non recuperable ne peut pas etre declaree prete a diffuser.`);
  }
  return patchJob(id, { ...patch, ready_for_publication: true, ready_at: nowIso() }, { status: 'READY', allowedFrom: ['COMPLETED'] });
}

/** Programme la diffusion. Exige un job READY et une date ISO. */
async function schedulePublication(id, { scheduled_for, platform, timezone = null } = {}) {
  if (!scheduled_for) throw new Error('videoJobs.schedulePublication: "scheduled_for" (ISO) est requis');
  const when = new Date(scheduled_for);
  if (Number.isNaN(when.getTime())) throw new Error(`videoJobs.schedulePublication: date invalide "${scheduled_for}"`);
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.schedulePublication: job "${id}" introuvable`);
  const platformFinal = String(platform || (current.publication && current.publication.platform) || 'tiktok').toLowerCase();
  return patchJob(id, {
    publication: {
      ...(current.publication || {}),
      platform: platformFinal,
      scheduled_for: when.toISOString(),
      timezone,
      state: 'SCHEDULED',
      attempts: (current.publication && current.publication.attempts) || 0,
      last_error: null,
      scheduled_at: nowIso(),
    },
  }, { status: 'SCHEDULED', allowedFrom: ['COMPLETED', 'READY', 'SCHEDULED'] });
}

/** Marque la soumission en cours (avant appel provider). */
async function markPublishing(id, { platform, attempt } = {}) {
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.markPublishing: job "${id}" introuvable`);
  return patchJob(id, {
    publication: {
      ...(current.publication || {}),
      platform: String(platform || (current.publication && current.publication.platform) || 'tiktok').toLowerCase(),
      state: 'PUBLISHING',
      attempts: attempt != null ? attempt : ((current.publication && current.publication.attempts) || 0) + 1,
      last_attempt_at: nowIso(),
    },
  }, { status: 'PUBLISHING', allowedFrom: ['COMPLETED', 'READY', 'SCHEDULED', 'PUBLISHING'] });
}

/**
 * Marque PUBLISHED — UNIQUEMENT apres confirmation reelle du provider
 * (external_post_id ou statut explicite de succes fourni par l'appelant).
 * Refuse explicitement de marquer publie sans identifiant externe : un
 * fichier cree n'est pas une video publiee.
 */
async function markPublished(id, { external_post_id, platform, response = null, statut_provider = null } = {}) {
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.markPublished: job "${id}" introuvable`);
  if (!external_post_id) {
    throw new Error(`videoJobs.markPublished: confirmation provider requise (external_post_id absent) — une video generee n'est pas une video publiee.`);
  }
  const platformFinal = String(platform || (current.publication && current.publication.platform) || 'tiktok').toLowerCase();
  // La reponse provider est conservee telle quelle pour tracabilite, mais
  // SANS jamais recopier de secret : seuls les champs d'identification et de
  // statut sont conserves (voir schedulerBridge qui n'y place que cela).
  const safeResponse = response && typeof response === 'object'
    ? {
      id: response.id != null ? String(response.id) : undefined,
      status: response.status != null ? String(response.status) : undefined,
      statut: response.statut != null ? String(response.statut) : undefined,
      code: response.code != null ? String(response.code) : undefined,
    }
    : null;
  return patchJob(id, {
    publication: {
      ...(current.publication || {}),
      platform: platformFinal,
      state: 'PUBLISHED',
      external_post_id: String(external_post_id),
      published_at: nowIso(),
      statut_provider: statut_provider || null,
      response: safeResponse,
      last_error: null,
    },
  }, { status: 'PUBLISHED', allowedFrom: ['PUBLISHING', 'SCHEDULED', 'READY', 'COMPLETED'] });
}

/** Enregistre un echec de diffusion sans perdre le rendu (retry possible). */
async function markPublicationFailed(id, { platform, error, maxAttempts = 3 } = {}) {
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.markPublicationFailed: job "${id}" introuvable`);
  const attempts = ((current.publication && current.publication.attempts) || 0);
  const exhausted = attempts >= maxAttempts;
  const platformFinal = String(platform || (current.publication && current.publication.platform) || 'tiktok').toLowerCase();
  return patchJob(id, {
    publication: {
      ...(current.publication || {}),
      platform: platformFinal,
      state: exhausted ? 'FAILED' : 'RETRY_PENDING',
      last_error: String(error && error.message ? error.message : error),
      last_error_at: nowIso(),
      attempts,
    },
    error: exhausted ? String(error && error.message ? error.message : error) : current.error,
    error_step: exhausted ? 'PUBLISHING' : current.error_step,
  }, { status: exhausted ? 'FAILED' : 'READY', allowedFrom: ['PUBLISHING', 'SCHEDULED', 'READY', 'COMPLETED'] });
}

async function markFailed(id, { step, error }) {
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.markFailed: job "${id}" introuvable`);
  if (TERMINAL_STATUSES.has(current.status)) return current; // deja termine (succes ou echec) : ne jamais ecraser un resultat terminal existant
  const timestamps = { ...current.timestamps, failed_at: nowIso() };
  const record = await memory.update(memory.COLLECTIONS.VIDEO_JOBS, id, {
    status: 'FAILED',
    progress: 100,
    error: String(error && error.message ? error.message : error),
    error_step: step,
    timestamps,
  });
  return toJob(record);
}

async function cancelJob(id) {
  const current = await getJob(id);
  if (!current) throw new Error(`videoJobs.cancelJob: job "${id}" introuvable`);
  if (TERMINAL_STATUSES.has(current.status)) return current;
  const record = await memory.update(memory.COLLECTIONS.VIDEO_JOBS, id, {
    status: 'CANCELLED',
    progress: 100,
    timestamps: { ...current.timestamps, completed_at: nowIso() },
  });
  return toJob(record);
}

/**
 * Jobs candidats a la diffusion : READY, ou SCHEDULED dont l'echeance est
 * atteinte. `COMPLETED` avec ready_for_publication=true est aussi accepte
 * (chemin retrocompatible : un job rendu par l'ancien pipeline peut entrer
 * dans le planificateur sans etre prealablement promu).
 */
async function listPublicationCandidates({ now = new Date(), limit = 100 } = {}) {
  const records = await memory.list(memory.COLLECTIONS.VIDEO_JOBS, { limit: Math.max(limit, 100) });
  const jobs = records.map(toJob);
  return jobs.filter((job) => {
    if (job.status === 'READY') return true;
    if (job.status === 'COMPLETED' && job.ready_for_publication === true) return true;
    if (job.status === 'SCHEDULED') {
      const when = job.publication && job.publication.scheduled_for;
      if (!when) return true; // programmee sans date : due immediatement, mais jamais publiee sans decision explicite
      return new Date(when).getTime() <= new Date(now).getTime();
    }
    return false;
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, limit);
}

module.exports = {
  STATUSES,
  TERMINAL_STATUSES,
  PROGRESS_BY_STATUS,
  PUBLICATION_STATUSES,
  createJob,
  getJob,
  listJobs,
  transition,
  patchJob,
  markReady,
  schedulePublication,
  markPublishing,
  markPublished,
  markPublicationFailed,
  listPublicationCandidates,
  markFailed,
  cancelJob,
  toJob,
};
