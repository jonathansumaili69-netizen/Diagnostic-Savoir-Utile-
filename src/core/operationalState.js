'use strict';

const memory = require('./memory');

const MODES = Object.freeze(['silencio', 'copilot', 'conquistador']);
const MODE_POLICIES = Object.freeze({
  silencio: Object.freeze({
    label: 'Silencio',
    description: 'Analyse et préparation autorisées ; aucune campagne ni action externe autonome.',
    campaigns_allowed: false,
    external_actions_autonomous: false,
    approval_required: true,
  }),
  copilot: Object.freeze({
    label: 'Copilot',
    description: 'L’IA prépare et recommande ; toute action externe attend une approbation humaine.',
    campaigns_allowed: false,
    external_actions_autonomous: false,
    approval_required: true,
  }),
  conquistador: Object.freeze({
    label: 'Conquistador',
    description: 'Autonomie réelle : campagnes, planification, publication et relances autorisées s\'exécutent seules (qualité minimale validée, connexions valides, règles de sécurité et kill switch respectés).',
    campaigns_allowed: true,
    external_actions_autonomous: true,
    approval_required: false,
  }),
});
const DEFAULT_SETTINGS = Object.freeze({
  mode: 'silencio',
  campaign: {
    enabled: false,
    max_publications_per_day: 0,
    requires_approval: true,
    allowed_platforms: [],
  },
});

function previousTimezoneFallback() {
  return null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function modePolicy(mode) {
  return clone(MODE_POLICIES[normalizeMode(mode) || DEFAULT_SETTINGS.mode]);
}

function normalizeMode(value) {
  const mode = String(value || '').toLowerCase();
  return MODES.includes(mode) ? mode : null;
}

function normalizeCampaign(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const rawMax = Number(source.max_publications_per_day);
  const max = Number.isFinite(rawMax) ? Math.max(0, Math.min(20, Math.floor(rawMax))) : 0;
  const platforms = Array.isArray(source.allowed_platforms)
    ? [...new Set(source.allowed_platforms.filter((item) => ['tiktok', 'youtube', 'facebook', 'instagram'].includes(String(item))))]
    : [];
  const rawQ = Number(source.quality_min_score);
  const qualityMin = Number.isFinite(rawQ) ? Math.max(0, Math.min(100, Math.floor(rawQ))) : 85;
  const hours = Array.isArray(source.allowed_hours)
    ? [...new Set(source.allowed_hours.filter((h)=>Number.isInteger(Number(h))&&Number(h)>=0&&Number(h)<=23).map((h)=>Number(h)))]
    : [];
  const themes = Array.isArray(source.allowed_themes)
    ? [...new Set(source.allowed_themes.map((t)=>String(t).trim().slice(0,120)).filter(Boolean))].slice(0,30)
    : [];
  let timezone = String(source.timezone || previousTimezoneFallback() || '').trim() || 'Africa/Bujumbura';
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: timezone }); } catch { timezone = 'Africa/Bujumbura'; }
  return {
    enabled: source.enabled === true,
    max_publications_per_day: max,
    requires_approval: source.requires_approval === true,
    allowed_platforms: platforms,
    quality_min_score: qualityMin,
    allowed_hours: hours,
    allowed_themes: themes,
    timezone,
  };
}

function normalizeSettings(input = {}, previous = DEFAULT_SETTINGS) {
  const mode = normalizeMode(input.mode) || normalizeMode(previous.mode) || DEFAULT_SETTINGS.mode;
  const campaign = normalizeCampaign({
    ...(previous.campaign || {}),
    ...(input.campaign || {}),
  });
  if (mode !== 'conquistador') {
    campaign.enabled = false;
  }
  return { mode, campaign };
}

async function latestByKind(collection, kind, limit = 100) {
  const rows = await memory.list(collection, { limit });
  let latest = null;
  let latestRevision = -Infinity;
  let latestAt = -Infinity;
  for (const row of rows) {
    if (!row || !row.data || row.data.kind !== kind) continue;
    const revision = Number(row.data.revision);
    const hasRevision = Number.isFinite(revision);
    const latestHasRevision = latest && Number.isFinite(Number(latest.data.revision));
    const at = new Date(row.updated_at || row.created_at || row.data.at || 0).getTime();
    const newer = latest === null
      || (hasRevision && !latestHasRevision)
      || (hasRevision && latestHasRevision && revision > latestRevision)
      || ((!hasRevision || !latestHasRevision) && at > latestAt);
    if (newer) {
      latest = row;
      latestRevision = hasRevision ? revision : latestRevision;
      latestAt = Number.isFinite(at) ? at : latestAt;
    }
  }
  return latest;
}

async function getSettings() {
  const row = await latestByKind(memory.COLLECTIONS.DECISIONS, 'autonomy.settings');
  const settings = row ? normalizeSettings(row.data.settings || {}) : clone(DEFAULT_SETTINGS);
  return {
    ...settings,
    mode_policy: modePolicy(settings.mode),
    // autonomy_active : vrai uniquement lorsque mode=conquistador ET
    // campagne activee ET approbation humaine explicitement desactivee -
    // c'est ce booleen (et non le seul mode) qui reflete si des publications
    // peuvent reellement partir sans approbation humaine (voir la meme regle
    // dans taskEngine.js et planner.js).
    autonomy_active: settings.mode === 'conquistador' && settings.campaign?.enabled === true && settings.campaign?.requires_approval === false,
    revision: row && Number.isFinite(Number(row.data.revision)) ? Number(row.data.revision) : null,
    updated_at: row ? row.updated_at || row.created_at : null,
    source: row ? 'persisted' : 'default',
  };
}

async function setSettings(input = {}, context = {}) {
  const current = await getSettings();
  const settings = normalizeSettings(input, current);
  const previousRevision = Number(current.revision);
  const revision = Number.isFinite(previousRevision) ? previousRevision + 1 : Date.now();
  const row = await memory.insert(memory.COLLECTIONS.DECISIONS, {
    kind: 'autonomy.settings',
    revision,
    settings,
    actor: context.actor || 'dashboard',
    reason: context.reason || null,
    at: new Date().toISOString(),
  });
  return {
    ...settings,
    mode_policy: modePolicy(settings.mode),
    autonomy_active: settings.mode === 'conquistador' && settings.campaign?.enabled === true && settings.campaign?.requires_approval === false,
    revision,
    updated_at: row.updated_at || row.created_at,
    source: 'persisted',
  };
}

async function listKnowledge({ limit = 50 } = {}) {
  const requested = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = await memory.list(memory.COLLECTIONS.CONTENT, { limit: 100 });
  return rows.filter((row) => row && row.data && row.data.kind === 'knowledge_asset').slice(0, requested);
}

function validateKnowledgeInput(input = {}) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!title) throw new Error('Le titre de la référence est requis');
  if (!content) throw new Error('Le contenu de la référence est requis');
  if (title.length > 240) throw new Error('Le titre de la référence dépasse 240 caractères');
  if (content.length > 30000) throw new Error('Le contenu de la référence dépasse 30000 caractères');
  const category = typeof input.category === 'string' && input.category.trim() ? input.category.trim().slice(0, 80) : 'general';
  const sourceUrl = typeof input.source_url === 'string' && input.source_url.trim() ? input.source_url.trim() : null;
  if (sourceUrl) {
    let parsed;
    try { parsed = new URL(sourceUrl); } catch (err) { throw new Error('source_url doit être une URL valide'); }
    if (parsed.protocol !== 'https:') throw new Error('source_url doit utiliser HTTPS');
  }
  const allowedAssetTypes = ['text', 'image', 'document', 'video', 'reference'];
  const assetType = allowedAssetTypes.includes(String(input.asset_type || '').toLowerCase())
    ? String(input.asset_type).toLowerCase()
    : 'text';
  return {
    title,
    content,
    category,
    source_url: sourceUrl,
    asset_type: assetType,
    official: input.official === true,
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 20) : [],
  };
}

async function addKnowledge(input, context = {}) {
  const asset = validateKnowledgeInput(input);
  const row = await memory.insert(memory.COLLECTIONS.CONTENT, {
    kind: 'knowledge_asset',
    ...asset,
    status: 'active',
    created_by: context.actor || 'dashboard',
    at: new Date().toISOString(),
  });
  return row;
}

async function listVideoReviews({ limit = 30 } = {}) {
  const requested = Math.max(1, Math.min(100, Number(limit) || 30));
  const rows = await memory.list(memory.COLLECTIONS.CONTENT, { limit: 100 });
  return rows.filter((row) => row && row.data && row.data.kind === 'video_review').slice(0, requested);
}

const CONTENT_STATES = Object.freeze([
  'creation',
  'en_controle',
  'corrections_requises',
  'validee',
  'prete_a_publier',
  'en_attente_approbation',
  'publiee',
  'erreur',
]);

const CONTENT_STATE_LABELS = Object.freeze({
  creation: 'Création',
  en_controle: 'En contrôle',
  corrections_requises: 'Corrections requises',
  validee: 'Validée',
  prete_a_publier: 'Prête à publier',
  en_attente_approbation: 'En attente d’approbation',
  publiee: 'Publiée',
  erreur: 'Erreur',
});

function contentKeyFromTask(task) {
  const data = task && task.data ? task.data : {};
  const input = data.input && typeof data.input === 'object' ? data.input : {};
  return String(input.content_key || input.content_id || data.content_key || task.id || '').trim() || null;
}

function contentTitleFromTask(task) {
  const input = task && task.data && task.data.input && typeof task.data.input === 'object' ? task.data.input : {};
  return String(input.titre || input.title || input.sujet || '').trim() || null;
}

function timestampOf(row) {
  const value = row && (row.updated_at || row.created_at || (row.data && row.data.at));
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function deriveTaskContentState(task) {
  const data = task && task.data ? task.data : {};
  const type = String(data.type || '');
  if (!type.startsWith('pipeline.video') && type !== 'content.full_video' && type !== 'content.revise') return null;
  const output = data.result && data.result.output && typeof data.result.output === 'object' ? data.result.output : {};
  let state = 'creation';
  if (data.status === 'running') state = 'en_controle';
  else if (data.status === 'error' || data.status === 'blocked' || data.status === 'rejected') state = 'erreur';
  else if (data.status === 'waiting_approval') state = 'en_attente_approbation';
  else if (output.statut === 'CORRECTIONS_REQUISES' || output.conforme === false) state = 'corrections_requises';
  else if (output.statut === 'PRET_POUR_APPROBATION') state = 'prete_a_publier';
  else if (data.status === 'done') state = type === 'content.revise' ? 'en_controle' : 'creation';
  return {
    key: contentKeyFromTask(task),
    title: contentTitleFromTask(task),
    state,
    updated_at: task.updated_at || task.created_at || null,
    task_id: task.id || null,
    source: 'task',
    conforme: output.conforme === true,
    publication_autorisee: output.publication_autorisee === true,
  };
}

function deriveReviewContentState(row) {
  const data = row && row.data ? row.data : {};
  const review = data.review && typeof data.review === 'object' ? data.review : {};
  return {
    key: String(data.content_key || data.task_id || review.content_key || row.id || '').trim() || null,
    title: data.content_title || review.content_title || null,
    state: review.conforme === true ? 'validee' : 'corrections_requises',
    updated_at: row.updated_at || row.created_at || data.at || null,
    task_id: data.task_id || null,
    review_id: row.id || null,
    source: 'video_review',
    conforme: review.conforme === true,
    publication_autorisee: review.publication_autorisee === true,
  };
}

function summarizeContentStates({ tasks = [], videoReviews = [] } = {}) {
  const byKey = new Map();
  const candidates = [
    ...(Array.isArray(tasks) ? tasks.map(deriveTaskContentState).filter(Boolean) : []),
    ...(Array.isArray(videoReviews) ? videoReviews.map(deriveReviewContentState).filter(Boolean) : []),
  ];
  for (const candidate of candidates) {
    if (!candidate.key) continue;
    const previous = byKey.get(candidate.key);
    if (!previous || timestampOf(candidate) >= timestampOf(previous)) byKey.set(candidate.key, candidate);
  }
  const contenus = [...byKey.values()]
    .sort((a, b) => timestampOf(b) - timestampOf(a))
    .slice(0, 50)
    .map((item) => ({ ...item, label: CONTENT_STATE_LABELS[item.state] || item.state }));
  const parEtat = Object.fromEntries(CONTENT_STATES.map((state) => [state, 0]));
  for (const item of contenus) parEtat[item.state] = (parEtat[item.state] || 0) + 1;
  return {
    total: contenus.length,
    par_etat: parEtat,
    contenus,
    etats_disponibles: CONTENT_STATES.map((state) => ({ id: state, label: CONTENT_STATE_LABELS[state] })),
  };
}

async function saveVideoReview(review, context = {}) {
  const output = review && typeof review === 'object' ? review : {};
  const row = await memory.insert(memory.COLLECTIONS.CONTENT, {
    kind: 'video_review',
    status: output.conforme === true ? 'ready_for_approval' : 'corrections_required',
    review: output,
    content_key: context.contentKey || output.content_key || context.taskId || null,
    content_title: context.contentTitle || output.content_title || null,
    task_id: context.taskId || null,
    at: new Date().toISOString(),
  });
  return row;
}

async function listCommercialFollowups({ limit = 20 } = {}) {
  const requested = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await memory.list(memory.COLLECTIONS.CONTENT, { limit: 100 });
  return rows.filter((row) => row && row.data && row.data.kind === 'commercial_followup').slice(0, requested);
}

async function saveCommercialFollowup(followup, context = {}) {
  const output = followup && typeof followup === 'object' ? followup : {};
  const row = await memory.insert(memory.COLLECTIONS.CONTENT, {
    kind: 'commercial_followup',
    status: 'prepared',
    followup: output,
    contact_key: context.contactKey || output.contact_key || null,
    plateforme: context.plateforme || output.plateforme || null,
    at: new Date().toISOString(),
  });
  return row;
}

/**
 * OBJECTIFS HEBDOMADAIRES (cahier des charges section "objectifs
 * hebdomadaires puissants"). Volontairement distincts des paramètres de
 * campagne (quotas/plateformes/horaires) : ce sont des résultats visés, pas
 * des règles d'exécution. Un champ à 0 signifie "aucun objectif défini" -
 * jamais interprété comme un objectif "atteint à 100%" (voir
 * statistiques.weeklyProgress qui applique cette règle).
 */
const OBJECTIVE_FIELDS = Object.freeze([
  // Argent et ventes
  'chiffre_affaires', 'ventes',
  // Acquisition
  'nouveaux_prospects', 'conversations_commerciales', 'prospects_convertis',
  // Audience
  'vues', 'nouveaux_abonnes', 'engagement',
  // Conversion
  'visites_boutique', 'clics', 'conversions',
  // Production (ajout : "nombre de contenus réellement publiés" - mesuré à
  // partir des executions PUBLISH_POST reellement reussies, jamais un
  // comptage de contenus juste "prepares")
  'contenus_publies',
]);

// Les 6 objectifs mis en avant dans l'interface dashboard (cahier des
// charges "espace Objectifs") ; les autres champs restent disponibles via
// l'API pour un usage avance mais ne surchargent pas l'ecran principal sur
// mobile.
const OBJECTIVE_FIELDS_PRINCIPAUX = Object.freeze(['chiffre_affaires', 'ventes', 'nouveaux_prospects', 'vues', 'nouveaux_abonnes', 'contenus_publies']);

function normalizeObjectives(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const field of OBJECTIVE_FIELDS) {
    const raw = Number(source[field]);
    out[field] = Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) / 100 : 0;
  }
  return out;
}

async function getWeeklyObjectives() {
  const row = await latestByKind(memory.COLLECTIONS.DECISIONS, 'objectifs.hebdomadaires');
  const objectifs = row ? normalizeObjectives(row.data.objectifs || {}) : normalizeObjectives({});
  return {
    objectifs,
    revision: row && Number.isFinite(Number(row.data.revision)) ? Number(row.data.revision) : null,
    updated_at: row ? row.updated_at || row.created_at : null,
    source: row ? 'persisted' : 'default',
  };
}

async function setWeeklyObjectives(input, context = {}) {
  const current = await getWeeklyObjectives();
  const objectifs = normalizeObjectives({ ...current.objectifs, ...(input || {}) });
  const previousRevision = Number(current.revision);
  const revision = Number.isFinite(previousRevision) ? previousRevision + 1 : Date.now();
  const row = await memory.insert(memory.COLLECTIONS.DECISIONS, {
    kind: 'objectifs.hebdomadaires',
    revision,
    objectifs,
    actor: context.actor || 'dashboard',
    at: new Date().toISOString(),
  });
  return { objectifs, revision, updated_at: row.updated_at || row.created_at, source: 'persisted' };
}

module.exports = {
  MODES,
  DEFAULT_SETTINGS,
  normalizeMode,
  normalizeCampaign,
  normalizeSettings,
  getSettings,
  setSettings,
  listKnowledge,
  addKnowledge,
  listVideoReviews,
  saveVideoReview,
  CONTENT_STATES,
  CONTENT_STATE_LABELS,
  MODE_POLICIES,
  modePolicy,
  summarizeContentStates,
  listCommercialFollowups,
  saveCommercialFollowup,
  OBJECTIVE_FIELDS,
  OBJECTIVE_FIELDS_PRINCIPAUX,
  normalizeObjectives,
  getWeeklyObjectives,
  setWeeklyObjectives,
};
