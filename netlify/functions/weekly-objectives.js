'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const operationalState = require('../../src/core/operationalState');
const statistiques = require('../../src/agents/statistiques');

exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  if (event.httpMethod === 'GET') {
    assertApiKey(event.headers);
    const [objectifs, progres] = await Promise.all([
      operationalState.getWeeklyObjectives(),
      statistiques.weeklyProgress({}),
    ]);
    return json(200, { objectifs, progres: progres.output, champs_disponibles: operationalState.OBJECTIVE_FIELDS });
  }
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'PUT') {
    return json(405, { erreur: 'Methode non autorisee, utiliser GET, POST ou PUT' });
  }
  assertApiKey(event.headers);
  const body = parseJsonBody(event.body);
  const objectifs = await operationalState.setWeeklyObjectives(body, { actor: 'dashboard' });
  return json(200, { objectifs });
});
