'use strict';

const DEFAULT_WORDS_PER_SECOND = 2.2;
const DEFAULT_SECONDS_PER_SHOT = 4.5;
const DEFAULT_MIN_SCENES = 4;
const DEFAULT_MAX_SCENES = 12;

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function countNarrativeUnits(text) {
  const sentences = String(text || '').split(/[.!?;\n]+/).map((part) => part.trim()).filter((part) => part.length > 10);
  return sentences.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Recommande un nombre de scènes à partir de la durée et de l'information
 * réellement portée par le script. La plage est une garde de faisabilité,
 * pas un quota : chaque plan reste soumis à une raison narrative distincte.
 */
function planSceneCount({ script = '', targetDurationSeconds = null, wordsPerSecond = DEFAULT_WORDS_PER_SECOND,
  secondsPerShot = DEFAULT_SECONDS_PER_SHOT, minScenes = DEFAULT_MIN_SCENES, maxScenes = DEFAULT_MAX_SCENES } = {}) {
  const words = countWords(script);
  const safeRate = Number(wordsPerSecond) > 0 ? Number(wordsPerSecond) : DEFAULT_WORDS_PER_SECOND;
  const estimatedSpeechSeconds = words ? words / safeRate : null;
  const requested = Number(targetDurationSeconds);
  const durationSeconds = Number.isFinite(requested) && requested > 0
    ? requested
    : (estimatedSpeechSeconds || 30);
  const shotSeconds = Number(secondsPerShot) > 0 ? Number(secondsPerShot) : DEFAULT_SECONDS_PER_SHOT;
  const durationDriven = Math.ceil(durationSeconds / shotSeconds);
  const informationDriven = words ? Math.ceil(words / 16) : 0;
  const narrativeUnits = countNarrativeUnits(script);
  const unitDriven = Math.min(narrativeUnits, Math.max(4, Math.ceil(durationSeconds / 3.5)));
  const rawRecommendation = Math.max(durationDriven, informationDriven, unitDriven, minScenes);
  const recommendedSceneCount = clamp(rawRecommendation, minScenes, maxScenes);
  return {
    recommended_scene_count: recommendedSceneCount,
    duration_seconds_used: Number(durationSeconds.toFixed(2)),
    word_count: words,
    estimated_speech_seconds: estimatedSpeechSeconds == null ? null : Number(estimatedSpeechSeconds.toFixed(2)),
    narrative_units: narrativeUnits,
    seconds_per_shot_target: shotSeconds,
    constraints: { min_scenes: minScenes, max_scenes: maxScenes },
    rationale: `max(ceil(${durationSeconds.toFixed(1)} s / ${shotSeconds.toFixed(1)} s), ceil(${words} mots / 16), ${unitDriven} unité(s) narrative(s)), borné à ${minScenes}–${maxScenes} scènes; retirer tout plan redondant après découpage.`,
  };
}

function assessSceneCount({ actualSceneCount, script = '', targetDurationSeconds = null, ...options } = {}) {
  const plan = planSceneCount({ script, targetDurationSeconds, ...options });
  const actual = Number(actualSceneCount) || 0;
  const delta = actual - plan.recommended_scene_count;
  return {
    ...plan,
    actual_scene_count: actual,
    difference_from_recommendation: delta,
    status: actual > 0 && Math.abs(delta) <= 2 ? 'pass' : 'review',
  };
}

module.exports = { DEFAULT_WORDS_PER_SECOND, DEFAULT_SECONDS_PER_SHOT, DEFAULT_MIN_SCENES, DEFAULT_MAX_SCENES,
  countWords, countNarrativeUnits, planSceneCount, assessSceneCount };
