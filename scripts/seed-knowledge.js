#!/usr/bin/env node
'use strict';

/**
 * Enregistre une référence officielle dans la base de connaissances de
 * Conquistador OS (memory.COLLECTIONS.CONTENT, kind: "knowledge_asset").
 *
 * Utilise automatiquement Supabase si SUPABASE_URL / SUPABASE_SERVICE_KEY
 * sont configurees dans l'environnement (production réelle), sinon le
 * magasin JSON local (./data par défaut - voir src/core/memoryStoreJson.js).
 *
 * Usage :
 *   node scripts/seed-knowledge.js docs/REFERENCE_VIDEO_6_ANALYSE.md \
 *     --title "Analyse Vidéo 6 (référence qualité)" \
 *     --category "reference_video" \
 *     --asset-type reference \
 *     --official
 *
 * Ce script ne fabrique aucun contenu : il enregistre tel quel le fichier
 * texte/documentation que vous lui donnez.
 */

const fs = require('fs');
const path = require('path');
const operationalState = require('../src/core/operationalState');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--official') {
      args.official = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i += 1;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args._[0];
  if (!filePath) {
    console.error('Usage : node scripts/seed-knowledge.js <fichier.md> --title "..." [--category ...] [--asset-type text|image|document|video|reference] [--official] [--source-url https://...] [--tags a,b,c]');
    process.exit(1);
  }
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Fichier introuvable : ${resolved}`);
    process.exit(1);
  }
  const content = fs.readFileSync(resolved, 'utf8');
  const title = args.title || path.basename(resolved);
  const input = {
    title,
    content,
    category: args.category || 'general',
    asset_type: args['asset-type'] || 'reference',
    official: Boolean(args.official),
    source_url: args['source-url'] || null,
    tags: args.tags ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
  };
  const saved = await operationalState.addKnowledge(input, { actor: 'seed-script' });
  console.log(`Référence enregistrée : id=${saved.id} title="${title}" backend=${require('../src/core/memory').currentBackend()}`);
}

main().catch((err) => {
  console.error('Échec de l’enregistrement :', err.message);
  process.exit(1);
});
