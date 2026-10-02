'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');
const { logger } = require('./logger');

/**
 * Moteur de stockage JSON (fallback gratuit sans base de donnees externe).
 *
 * IMPORTANT - LIMITE HONNETE :
 * Sur une fonction Netlify deployee, le systeme de fichiers du bundle est en
 * lecture seule et /tmp est ephemere (efface entre les "cold starts", non
 * partage entre plusieurs instances de la fonction). Ce moteur JSON est donc
 * pleinement fiable en developpement local (netlify dev) mais NE GARANTIT PAS
 * la persistance en production sur Netlify. Pour une persistance reelle en
 * production gratuite, configurer SUPABASE_URL et SUPABASE_SERVICE_KEY : le
 * systeme bascule alors automatiquement sur Supabase (voir memory.js).
 * Ce module ne pretend jamais etre autre chose qu'un fallback local/dev.
 */

function isDeployedOnNetlify() {
  return Boolean(process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT);
}

function dataDir() {
  if (isDeployedOnNetlify()) {
    // /tmp est le seul repertoire garanti inscriptible sur une fonction deployee.
    return path.join('/tmp', 'conquistador-data');
  }
  const configured = config.memory.jsonDataDir;
  // path.join() ne "reinitialise" pas un segment absolu : path.join(cwd, '/tmp/x')
  // renverrait a tort "<cwd>/tmp/x" au lieu de "/tmp/x". On respecte donc un
  // chemin deja absolu tel quel, et on ne resout par rapport a cwd que les
  // chemins relatifs (cas par defaut : "data").
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function ensureDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function filePath(collection) {
  return path.join(ensureDir(), `${collection}.json`);
}

function readCollection(collection) {
  const file = filePath(collection);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return [];
    return JSON.parse(raw);
  } catch (err) {
    logger.error('memoryStore.json: lecture corrompue, reinitialisation', {
      collection,
      error: err.message,
    });
    return [];
  }
}

function writeCollection(collection, rows) {
  const file = filePath(collection);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
}

async function insert(collection, data) {
  const rows = readCollection(collection);
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    data,
  };
  rows.push(record);
  writeCollection(collection, rows);
  return record;
}

async function list(collection, options = {}) {
  let rows = readCollection(collection);
  if (options.filter) {
    rows = rows.filter((row) => options.filter(row.data, row));
  }
  rows = rows.slice().sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  if (options.limit) {
    rows = rows.slice(0, options.limit);
  }
  return rows;
}

async function get(collection, id) {
  const rows = readCollection(collection);
  return rows.find((row) => row.id === id) || null;
}

async function update(collection, id, patch) {
  const rows = readCollection(collection);
  const idx = rows.findIndex((row) => row.id === id);
  if (idx === -1) return null;
  rows[idx] = {
    ...rows[idx],
    data: { ...rows[idx].data, ...patch },
    updated_at: new Date().toISOString(),
  };
  writeCollection(collection, rows);
  return rows[idx];
}

async function remove(collection, id) {
  const rows = readCollection(collection);
  const next = rows.filter((row) => row.id !== id);
  const removed = next.length !== rows.length;
  if (removed) writeCollection(collection, next);
  return removed;
}

module.exports = { insert, list, get, update, remove, isDeployedOnNetlify, dataDir };
