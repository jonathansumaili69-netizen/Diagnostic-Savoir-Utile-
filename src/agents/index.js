'use strict';

const contenu = require('./contenu');
const commercial = require('./commercial');
const clients = require('./clients');
const analyste = require('./analyste');
const statistiques = require('./statistiques');
const affiliation = require('./affiliation');
const recherche = require('./recherche');
const qualite = require('./qualite');
const directeur = require('./directeur');
const systemActions = require('./systemActions');
const videoQuality = require('./videoQuality');
const pipeline = require('./pipeline');
const voiceOver = require('./voiceOver');
const approval = require('../core/approval');

const MODULES = {
  content: contenu,
  commercial,
  client: clients,
  analysis: analyste,
  stats: statistiques,
  affiliation,
  research: recherche,
  quality: qualite,
  directeur,
  system: systemActions,
  video: videoQuality,
  pipeline,
  voice_over: voiceOver,
};

/**
 * Type de tache ("domain.subtype") -> type d'action pour la politique
 * d'approbation (section 13). Toute combinaison absente de cette table est
 * traitee comme APPROVAL_REQUIRED par defaut (voir src/core/approval.js).
 */
const ACTION_TYPE_MAP = {
  'content.idea': 'GENERATE_IDEA',
  'content.script': 'GENERATE',
  'content.scenes': 'GENERATE',
  'content.full_video': 'GENERATE',
  'content.calendar': 'GENERATE_IDEA',
  'content.prepare_post': 'PREPARE_POST',
  'content.adapt_platforms': 'PREPARE_POST',
  'content.revise': 'GENERATE',
  'pipeline.video': 'GENERATE',
  'voice_over.generate_scenes': 'GENERATE',
  'commercial.analyze_intent': 'ANALYZE',
  'commercial.prepare_response': 'PREPARE_RESPONSE',
  'commercial.detect_comment_intent': 'ANALYZE',
  'commercial.analyze_conversion': 'ANALYZE',
  'commercial.prepare_followup': 'PREPARE_RESPONSE',
  'client.upsert_contact': 'UPDATE_MEMORY',
  'client.answer_question': 'PREPARE_RESPONSE',
  'analysis.performance': 'ANALYZE',
  'analysis.opportunity': 'ANALYZE',
  'stats.record': 'UPDATE_MEMORY',
  'stats.summary': 'ANALYZE',
  'stats.timeseries': 'ANALYZE',
  'stats.ranking': 'ANALYZE',
  'stats.commercial_summary': 'ANALYZE',
  'stats.weekly_progress': 'ANALYZE',
  'stats.period_comparison': 'ANALYZE',
  'affiliation.register': 'UPDATE_MEMORY',
  'affiliation.followup': 'PREPARE_RESPONSE',
  'affiliation.report': 'GENERATE_REPORT',
  'research.topic': 'ANALYZE',
  'quality.review': 'ANALYZE',
  'video.review': 'ANALYZE',
  'directeur.priorities': 'GENERATE_REPORT',
  'system.send_message': 'SEND_MESSAGE',
  'system.reply_comment': 'REPLY_COMMENT',
  'system.publish_post': 'PUBLISH_POST',
  'system.update_data': 'UPDATE_DATA',
};

function parseType(type) {
  const idx = type.indexOf('.');
  if (idx === -1) {
    throw new Error(`Type de tache invalide "${type}" (format attendu "domaine.sous_type")`);
  }
  return { domain: type.slice(0, idx), subtype: type.slice(idx + 1) };
}

function resolve(type) {
  const { domain, subtype } = parseType(type);
  const mod = MODULES[domain];
  if (!mod) {
    throw new Error(`Domaine d'agent inconnu "${domain}" pour le type de tache "${type}"`);
  }
  const actionType = ACTION_TYPE_MAP[type] || approval.APPROVAL_REQUIRED;
  return { domain, subtype, module: mod, actionType };
}

function listTaskTypes() {
  return Object.keys(ACTION_TYPE_MAP);
}

module.exports = { MODULES, ACTION_TYPE_MAP, resolve, parseType, listTaskTypes };
