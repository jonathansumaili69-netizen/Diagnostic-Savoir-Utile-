'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/core/scenePlanner');

test('scenePlanner adapte le nombre recommandé à la durée et à la densité du script', () => {
  const short = planner.planSceneCount({ script: 'Prépare ton CV avec des faits précis.', targetDurationSeconds: 18, minScenes: 2, maxScenes: 12 });
  const long = planner.planSceneCount({ script: 'Prépare ton CV avec des faits précis.', targetDurationSeconds: 54, minScenes: 2, maxScenes: 12 });
  const dense = planner.planSceneCount({
    script: Array.from({ length: 24 }, (_, i) => `Étape ${i + 1} : prépare une action différente pour mieux organiser ta recherche.`).join(' '),
    targetDurationSeconds: 30,
    minScenes: 2,
    maxScenes: 12,
  });

  assert.ok(short.recommended_scene_count < long.recommended_scene_count);
  assert.ok(dense.recommended_scene_count >= 2);
  assert.ok(dense.recommended_scene_count <= 12);
  assert.notEqual(long.recommended_scene_count, 8, 'le planificateur ne fixe pas huit scènes par défaut');
});

test('scenePlanner signale un écart plutôt que de forcer une segmentation uniforme', () => {
  const plan = planner.assessSceneCount({
    script: 'Accroche. Conseil utile. Présentation du guide. CTA.',
    targetDurationSeconds: 24,
    actualSceneCount: 4,
    minScenes: 2,
    maxScenes: 12,
  });
  assert.equal(plan.actual_scene_count, 4);
  assert.ok(['pass', 'review'].includes(plan.status));
  assert.match(plan.rationale, /durée|s|scènes/i);
});
