'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, requireString, assertApiKey, checkRateLimit, getRateLimitKey} = require('../../src/core/validation');
const taskEngine = require('../../src/core/taskEngine');

/**
 * Point d'entree unique pour /api/tasks. Les redirections Netlify (netlify.toml)
 * ne garantissent pas un aiguillage fiable par methode HTTP sur un meme chemin :
 * ce fichier gere donc lui-meme GET (liste) et POST (creation), comme le fait
 * deja chaque fonction pour son propre verbe. Conserve task-create.js et
 * task-list.js tels quels pour un usage direct via /.netlify/functions/... si
 * besoin, mais /api/tasks passe desormais par ce point d'entree unifie.
 */
async function handleList(event) {
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));
  const params = event.queryStringParameters || {};
  const limit = params.limit ? parseInt(params.limit, 10) : 50;
  const status = params.status;
  const tasks = await taskEngine.listTasks({
    limit,
    filter: status ? (data) => data.status === status : undefined,
  });
  return json(200, { taches: tasks, total: tasks.length });
}

async function handleCreate(event) {
  assertApiKey(event.headers);
  checkRateLimit(getRateLimitKey(event.headers));
  const body = parseJsonBody(event.body);
  const type = requireString(body.type, 'type');
  const priority = body.priority;
  const declencheur = body.declencheur || 'api';
  const executeNow = body.executeNow !== false;

  const task = await taskEngine.createTask({ type, input: body.input || {}, priority, declencheur });
  if (!executeNow) return json(201, { tache: task });

  const executed = await taskEngine.runTask(task.id);
  return json(201, { tache: executed });
}

exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod === 'GET') return handleList(event);
  if (event.httpMethod === 'POST') return handleCreate(event);
  return json(405, { erreur: 'Methode non autorisee, utiliser GET ou POST' });
});
