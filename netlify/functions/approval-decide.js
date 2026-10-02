'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { requireString, parseJsonBody, assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const approval = require('../../src/core/approval');
const taskEngine = require('../../src/core/taskEngine');
const memory = require('../../src/core/memory');

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'PATCH') {
    return json(405, { erreur: 'Methode non autorisee, utiliser POST ou PATCH' });
  }
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));

  const body = parseJsonBody(event.body);
  const params = event.queryStringParameters || {};
  const id = requireString(body.id || params.id, 'id');
  const approve = body.approve === true || body.approve === 'true';

  const record = await memory.get(memory.COLLECTIONS.APPROVALS, id);
  if (!record) {
    return json(404, { erreur: `Aucune demande d'approbation trouvee pour l'id "${id}"` });
  }
  if (record.data.status !== 'pending') {
    return json(409, { erreur: `Cette demande a deja ete traitee (statut actuel : ${record.data.status})` });
  }

  const decided = await approval.decide(id, {
    approve,
    decidedBy: body.decidedBy || 'utilisateur',
    note: body.note,
  });

  if (!decided) {
    return json(404, { erreur: `Aucune demande d'approbation trouvee pour l'id "${id}"` });
  }

  let task = null;
  if (approve && decided.data.status === 'approved' && record.data.taskId) {
    task = await taskEngine.resumeAfterApproval(record.data.taskId, id);
  } else if (!approve && decided.data.status === 'rejected' && record.data.taskId) {
    task = await taskEngine.markRejected(record.data.taskId, body.note);
  } else if ((approve && decided.data.status !== 'approved') || (!approve && decided.data.status !== 'rejected')) {
    return json(409, {
      erreur: `La demande ne peut pas etre reprise (statut final : ${decided.data.status})`,
      approbation: decided,
      tache: null,
    });
  }

  return json(200, { approbation: decided, tache: task });
});
