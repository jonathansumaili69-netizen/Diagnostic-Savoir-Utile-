'use strict';

const voiceStudio = require('../core/voiceStudio');

/**
 * AGENT_VOIX_OFF — génère la voix off réelle (Rémy Neural via le studio
 * externe, voir src/core/voiceStudio.js) pour les scènes d'un contenu vidéo,
 * et mesure sa durée réelle (au lieu de faire confiance à une estimation
 * devinée par le modèle IA de rédaction).
 *
 * N'invente jamais une piste audio : si le studio vocal n'est pas configuré,
 * ou si une scène n'a pas de texte de narration exploitable, le champ
 * concerné le documente honnêtement (voir voiceStudio.synthesizeScenes).
 */

function sceneNarrationEntries(content = {}) {
  const scenes = Array.isArray(content.scenes) ? content.scenes : [];
  if (scenes.length) {
    return scenes.map((scene, index) => {
      const s = scene && typeof scene === 'object' ? scene : {};
      const sceneId = String(s.id || s.scene_id || `scene_${index + 1}`);
      // voix_off_scene : texte de narration propre a cette scene (cf. prompts
      // AGENT_CONTENU). A defaut (contenu genere avant cet ajout, ou petit
      // modele qui ignore le champ), on retombe honnetement sur la
      // description de la scene plutot que sur rien du tout, mais ce n'est
      // PAS la meme chose qu'un vrai texte de narration ecrit pour la voix.
      const text = typeof s.voix_off_scene === 'string' && s.voix_off_scene.trim()
        ? s.voix_off_scene.trim()
        : '';
      return { scene_id: sceneId, text, source: text ? 'voix_off_scene' : 'absent' };
    });
  }
  // Aucune scene structuree : pas de decoupage possible, on ne fabrique pas
  // de scenes artificielles a partir du script global.
  return [];
}

async function generateForContent(content = {}, { rate } = {}) {
  const entries = sceneNarrationEntries(content);
  if (!entries.length) {
    return {
      configured: Boolean(voiceStudio.studioBaseUrl()),
      raison: 'Aucune scène structurée avec texte de narration (voix_off_scene) : impossible de générer une voix off par scène.',
      tracks: [],
      total_duration_estimated_seconds: null,
    };
  }
  return voiceStudio.synthesizeScenes(entries, { rate });
}

async function handle(task) {
  const { subtype, input } = task;
  if (subtype !== 'generate_scenes') {
    throw new Error(`AGENT_VOIX_OFF: sous-type de tache inconnu "${subtype}"`);
  }
  const content = input && typeof input.content === 'object' ? input.content : input || {};
  const result = await generateForContent(content, { rate: input && input.rate });
  return { type: 'voice_over.generate_scenes', provider: result.provider || null, output: result };
}

module.exports = { handle, generateForContent, sceneNarrationEntries };
