'use strict';

const graphicEngine = require('../graphicEngine');

/**
 * Provider "graphic_engine" : enveloppe le Graphic Engine (SVG -> PNG, voir
 * src/core/graphicEngine.js) dans le contrat commun des providers d'image.
 * Ne depend d'aucun reseau, d'aucune cle API, d'aucun quota : c'est le
 * fallback de dernier recours garanti de la chaine (voir index.js).
 *
 * Choisit un template en fonction des indices disponibles sur la scene :
 * une citation explicite -> carte citation ; une statistique/valeur
 * chiffree -> carte stat ; sinon -> titre (texte de la scene ou prompt).
 */

const id = 'graphic_engine';
const requiresNetwork = false;
const requiresApiKey = false;

function pickTemplate(scene = {}) {
  if (scene.quote || scene.citation) return 'quote';
  if (scene.stat_value || scene.valeur_stat) return 'stat';
  if (scene.chart_bars || scene.barres) return 'bar_chart';
  if (scene.background_only) return 'background';
  return 'title';
}

async function generate({ scene = {}, width, height, mode } = {}) {
  const template = pickTemplate(scene);
  const params = { width, height, mode };
  if (template === 'quote') {
    params.quote = scene.quote || scene.citation || scene.voix_off_scene || scene.description || '';
    params.author = scene.personnage && scene.personnage.toLowerCase() !== 'aucun' ? scene.personnage : undefined;
  } else if (template === 'stat') {
    params.value = scene.stat_value || scene.valeur_stat;
    params.label = scene.description || scene.stat_label || '';
  } else if (template === 'bar_chart') {
    params.title = scene.description || '';
    params.bars = scene.chart_bars || scene.barres || [];
  } else if (template === 'background') {
    params.variant = scene.background_variant || 'panel';
  } else {
    params.title = scene.texte_ecran || scene.description || scene.prompt_final || 'Savoir Utile';
    params.subtitle = scene.sous_titre || undefined;
    params.brandLabel = scene.brand_label;
  }
  const rendered = await graphicEngine.render(template, params);
  return {
    buffer: rendered.buffer,
    contentType: rendered.contentType,
    width: rendered.width,
    height: rendered.height,
    provider: id,
    model: `graphic_engine:${template}`,
    asset_type: 'GENERATED_GRAPHIC',
  };
}

module.exports = { id, requiresNetwork, requiresApiKey, generate };
