'use strict';

const fs = require('fs/promises');

const characterRegistry = require('../characterRegistry');
const visualConsistency = require('../visualConsistency');
const providerAdapter = require('./providerAdapter');
const { logger } = require('../logger');

/**
 * PROVIDER "character_reference" (prompt maitre, sections 3-6).
 *
 * Genere une NOUVELLE scene en conservant l'identite visuelle du personnage
 * OFFICIEL, a partir de ses references reellement enregistrees (principale
 * d'abord, secondaires versionnees ensuite).
 *
 * GARANTIES (et limites honnetement declarees) :
 *   - ne fabrique JAMAIS un personnage generique en remplacement : si le
 *     personnage n'est pas officiel -> erreur notApplicable, la chaine
 *     retombe sur existing_asset (identite EXACTE, mise en scene figee) ;
 *   - si aucun provider image-to-image n'est configure -> notApplicable avec
 *     la raison exacte (aucun appel reseau, aucun faux succes) ;
 *   - apres chaque generation reelle, controle de coherence visuelle
 *     (pHash + couleur) : PASS accepte, REVIEW accepte sous statut REVIEW,
 *     FAIL -> regeneration controlee puis, si le seuil n'est jamais atteint,
 *     echec explicite (jamais un succes masque) ;
 *   - conserve existing_asset comme seul repli et ne pretend jamais avoir
 *     produit la reference demandee s'il ne l'a pas fait.
 */

const id = 'character_reference';
const requiresNetwork = true;
const requiresApiKey = true;

const CAPABILITIES = { image_to_image: true, reference_image: true, multi_reference: true, character_reference: true, seed: true };

function isEnabled() {
  return providerAdapter.configured();
}

function maxAttempts() {
  const n = parseInt(process.env.CHARACTER_REFERENCE_MAX_ATTEMPTS, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5) : 2;
}

function maxReferences() {
  const n = parseInt(process.env.CHARACTER_REFERENCE_MAX_REFS, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 6) : 3;
}

/** Construit un prompt d'identite explicite : jamais "un africain dans un bureau". */
function buildIdentityPrompt(scene = {}, character) {
  const parts = [
    `Utiliser LE PERSONNAGE OFFICIEL "${character.nom}" (character_id: ${character.character_id}) tel qu'il apparait dans les images de reference fournies.`,
    "Preserver strictement son identite visuelle : mêmes traits du visage, même coiffure, même carnation, même morphologie.",
    `Description officielle : ${character.description_visuelle}`,
    `Visage : ${character.caracteristiques_visage}`,
    `Coiffure : ${character.coiffure}`,
    `Vêtements / style : ${character.vetements_style}`,
    `Éléments distinctifs : ${character.elements_distinctifs}`,
    `Style visuel de la série : ${character.style_visuel}`,
  ];
  const sceneDesc = scene.prompt_final || scene.description || scene.voix_off_scene;
  if (sceneDesc) parts.push(`Mise en scène demandée : ${sceneDesc}`);
  if (scene.decor) parts.push(`Décor : ${scene.decor}`);
  if (scene.cadrage) parts.push(`Cadrage : ${scene.cadrage}`);
  parts.push("Conserver la mise en scène demandée SANS modifier l'apparence du personnage. Ne pas substituer un autre visage.");
  return parts.join('\n');
}

async function generate({ scene = {}, width, height, seed } = {}) {
  const label = scene.personnage || scene.character_id || scene.personnage_id;
  const characterId = characterRegistry.resolveCharacterId(label);

  if (!characterId) {
    const err = new Error(
      `characterReferenceProvider: le personnage "${String(label || '')}" n'est pas un personnage officiel — ` +
        'aucune generation conditionnee par reference n\'est possible et AUCUN personnage generique ne sera fabrique.',
    );
    err.notApplicable = true;
    throw err;
  }

  if (!isEnabled()) {
    const st = providerAdapter.status();
    const err = new Error(
      `characterReferenceProvider: provider image-to-image non configure (${st.raison}) — ` +
        'impossible de garantir l\'identite officielle par generation ; repli sur la reference officielle.',
    );
    err.notApplicable = true;
    err.provider_status = st;
    throw err;
  }

  const character = characterRegistry.getCharacter(characterId);
  const both = characterRegistry.involvesBoth(label);
  const selection = characterRegistry.selectReferenceImages(characterId, { max: maxReferences(), preferBoth: both });

  if (!selection.references.length) {
    const err = new Error(`characterReferenceProvider: aucune reference officielle disponible pour "${characterId}" (${selection.raison}).`);
    err.notApplicable = true;
    throw err;
  }

  const referenceBuffers = [];
  const referenceLabels = [];
  for (const ref of selection.references) {
    // eslint-disable-next-line no-await-in-loop
    referenceBuffers.push(await fs.readFile(ref.abs_path));
    referenceLabels.push(`${ref.role}:${ref.filename}`);
  }

  const prompt = buildIdentityPrompt(scene, character);
  const attempts = [];
  const limit = maxAttempts();
  let best = null;

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const generated = await providerAdapter.generate({
      prompt,
      referenceBuffers,
      width,
      height,
      seed: Number.isFinite(seed) ? seed : undefined,
    });
    // eslint-disable-next-line no-await-in-loop
    const consistency = await visualConsistency.checkConsistency({
      generated: generated.buffer,
      references: selection.references.map((r) => r.abs_path),
      referenceLabels,
    });
    attempts.push({ attempt, provider: generated.provider, consistency_status: consistency.status, score: consistency.score });
    logger.info('characterReferenceProvider: controle de coherence', {
      character_id: characterId, attempt, statut: consistency.status, score: consistency.score,
    });

    const candidate = { ...generated, consistency, reference_selection: selection, prompt };
    if (!best || consistency.score > best.consistency.score) best = candidate;
    if (consistency.status === 'PASS') return candidate;
  }

  // HONNETETE ABSOLUE (mission, section 3) : si la MEILLEURE tentative reste
  // en dessous du seuil REVIEW (FAIL), on refuse de la presenter comme un
  // resultat utilisable. Un "me resultat disponible" en FAIL n'est PAS un
  // resultat de coherence valide : echec explicite, la chaine de repli
  // (existing_asset, reference officielle exacte) prend le relais.
  if (!best || best.consistency.status === 'FAIL') {
    const detail = attempts.map((a) => `tentative ${a.attempt}: ${a.consistency_status} (score ${a.score})`).join(' ; ');
    const err = new Error(
      `characterReferenceProvider: la coherence avec les references officielles de "${characterId}" n'a jamais atteint le seuil ` +
        `apres ${limit} tentative(s) (${detail || 'aucune tentative executee'}). Aucun visuel non conforme n'est accepte.` +
        ' La chaine de repli doit utiliser la reference officielle exacte (existing_asset).',
    );
    err.consistency_attempts = attempts;
    throw err;
  }
  return best;
}

/** Strategie declaree pour ce provider (documentation / diagnostics). */
function strategyFor(scene = {}) {
  const characterId = characterRegistry.resolveCharacterId(scene.personnage || scene.character_id);
  return characterRegistry.referenceStrategyFor(characterId, { providerCapabilities: CAPABILITIES });
}

module.exports = {
  id,
  requiresNetwork,
  requiresApiKey,
  CAPABILITIES,
  isEnabled,
  generate,
  strategyFor,
  buildIdentityPrompt,
  maxReferences,
  maxAttempts,
};
