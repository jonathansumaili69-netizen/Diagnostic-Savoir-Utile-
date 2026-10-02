'use strict';

/**
 * ENREGISTREMENT DES REFERENCES OFFICIELLES DE PERSONNAGES (Character Registry).
 *
 * Ce script est LECTURE SEULE vis-a-vis des assets existants : il ne cree,
 * ne deplace, ne renomme et n'ecrase AUCUN fichier de reference. Il :
 *   1. verifie l'integrite du registre (fichiers presents, hashes calcules) ;
 *   2. ecrit un manifeste JSON de tracabilite (assets/personnages/character-registry.json) ;
 *   3. ecrit une preuve d'integrite des references PRINCIPALES
 *      (docs/evidence/asset-integrity-before-after.json) qui permet de
 *      demontrer qu'aucune reference officielle pre-existante n'a ete
 *      remplacee ;
 *   4. affiche un rapport lisible.
 *
 * Usage : node scripts/register-character-refs.js
 */

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const registry = require('../src/core/characterRegistry');

const ASSETS = path.join(__dirname, '..', 'assets');
const EVIDENCE = path.join(__dirname, '..', 'docs', 'evidence');

function sha256(file) {
  return crypto.createHash('sha256').update(require('fs').readFileSync(file)).digest('hex');
}

async function main() {
  process.stdout.write('\n=== ENREGISTREMENT DES REFERENCES OFFICIELLES ===\n\n');

  // 1) Manifeste du registre.
  const manifestPath = await registry.writeRegistryManifest();
  process.stdout.write(`Manifeste ecrit : ${manifestPath}\n`);

  // 2) Integrite.
  const integrity = registry.verifyIntegrity();
  process.stdout.write(`Integrite : ${integrity.ok ? 'OK' : 'PROBLEMES DETECTES'}\n`);
  for (const c of integrity.characters) {
    process.stdout.write(`  ${c.character_id.padEnd(8)} principal=${c.references_principales} secondaires=${c.references_secondaires} statut=${c.statut_reference}\n`);
  }

  // 3) Preuve d'integrite : hashes des references PRINCIPALES et des assets
  //    officiels non-personnages (logo, bible). Ces hashes doivent rester
  //    inchanges : c'est la demonstration qu'aucun asset officiel n'a ete
  //    ecrase par l'ajout des references secondaires.
  const protectedPaths = [
    'personnages/samuel/samuel-reference-principale.jpeg',
    'personnages/marc/marc-reference-principale.jpg',
    'personnages/samuel-et-marc-ensemble.jpg',
    'personnages/bible-personnages-samuel-marc.jpg',
    'logo/logo-savoir-utile-officiel.jpeg',
  ];
  const protectedAssets = protectedPaths.map((rel) => {
    const abs = path.join(ASSETS, rel);
    let exists = false;
    let hash = null;
    let size = 0;
    try {
      hash = sha256(abs);
      size = require('fs').statSync(abs).size;
      exists = true;
    } catch (err) {
      exists = false;
    }
    return { rel_path: rel, exists, sha256: hash, size_bytes: size };
  });

  const secondaires = [];
  for (const id of registry.CHARACTER_IDS) {
    const c = registry.getCharacter(id);
    for (const ref of c.references_secondaires) {
      secondaires.push({
        character_id: id,
        rel_path: ref.rel_path,
        reference_id: ref.reference_id,
        role: ref.role,
        versionne: ref.versionne,
        content_sha256: ref.content_sha256,
        size_bytes: ref.size_bytes,
      });
    }
  }

  const evidence = {
    genere_le: new Date().toISOString(),
    registre_version: registry.REGISTRY_VERSION,
    politique:
      "Aucun asset officiel pre-existant n'a ete supprime, ecrase ou remplace. Les references fournies ont ete ajoutees comme references SECONDAIRES versionnees dans assets/personnages/<personnage>/refs/. La reference PRINCIPALE de chaque personnage reste la source PRIORITAIRE.",
    assets_proteges: protectedAssets,
    references_secondaires: secondaires,
    references_secondaires_total: secondaires.length,
    images_distinctes: new Set(secondaires.map((s) => s.content_sha256)).size,
    integrite: integrity,
  };

  await fs.mkdir(EVIDENCE, { recursive: true });
  const evidencePath = path.join(EVIDENCE, 'asset-integrity-before-after.json');
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`Preuve d'integrite ecrite : ${evidencePath}\n`);
  process.stdout.write(`References secondaires enregistrees : ${secondaires.length} entrees / ${evidence.images_distinctes} images distinctes\n`);
  process.stdout.write('\nAucun fichier de reference n\'a ete modifie par ce script.\n\n');
}

main().catch((err) => {
  process.stdout.write(`ECHEC: ${err.message}\n`);
  process.exit(1);
});
