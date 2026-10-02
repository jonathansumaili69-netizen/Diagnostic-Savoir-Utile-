'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * CHARACTER REGISTRY / CHARACTER BIBLE (module ADDITIF, non destructif).
 *
 * Objectif (prompt maitre, sections 3-6) : « Ce personnage = cette identite
 * visuelle officielle ». Le registre relie un character_id stable a des
 * REFERENCES VISUELLES OFFICIELLES reellement presentes sur disque (image
 * principale + references secondaires versionnees), avec hash/identifiant
 * stable, description visuelle, metadonnees et tracabilite.
 *
 * REGLES ABSOLUES :
 *   - aucune reference officielle existante n'est supprimee, ecrasee ni
 *     remplacee : ce module ne fait que LIRE le disque et exposer une vue
 *     deterministe (l'enregistrement se fait via scripts/register-character-refs.js
 *     qui n'ecrit QUE dans des sous-dossiers refs/ versionnes) ;
 *   - aucun personnage generique n'est jamais fabrique pour remplacer une
 *     reference manquante : resolveCharacterId() renvoie null, et
 *     assertOfficialCharacter() leve une erreur explicite ;
 *   - si une reference manque, l'etat est signale comme tel (statut
 *     explicite), jamais masque derriere un succes apparent.
 *
 * Aucune dependance reseau, aucun secret : uniquement du systeme de fichiers.
 */

const ASSETS_ROOT = path.join(__dirname, '..', '..', 'assets');
const PERSONNAGES_ROOT = path.join(ASSETS_ROOT, 'personnages');
const REGISTRY_VERSION = 1;

/**
 * Definitions officielles (Character Bible). Les descriptions sont derivees
 * de assets/personnages/bible-personnages-samuel-marc.jpg et de l'analyse
 * visuelle des references officielles fournies par Savoir Utile.
 * `reference_principale` = fichier PRIORITAIRE historique, jamais remplace.
 */
const CHARACTER_DEFINITIONS = Object.freeze({
  samuel: {
    character_id: 'samuel',
    nom: 'Samuel',
    version: REGISTRY_VERSION,
    role: "Personnage principal / public cible : jeune chercheur d'emploi",
    reference_principale: 'personnages/samuel/samuel-reference-principale.jpeg',
    references_secondaires_dir: 'personnages/samuel/refs',
    aliases: ['samuel', 'sam'],
    description_visuelle:
      'Homme africain francophone, 22-24 ans, silhouette athletique moyenne, posture droite. ' +
      'Expression ouverte et expressive, regard direct. Palette dominante bleu clair / jean.',
    caracteristiques_visage:
      'Visage jeune et sympathique, yeux marron fonce, peau noire aux traits africains authentiques, ' +
      'front degage, sourcils fournis, nez droit, levres pleines, pas de barbe.',
    coiffure: 'Cheveux noirs courts, coiffure moderne nette, lignes propres, sans degrade marque.',
    apparence_generale: 'Jeune adulte, corpulence moyenne, posture engagee, gestuelle expressive.',
    vetements_style:
      'Chemise bleue claire manches retroussees, jean bleu fonce, chaussures en cuir marron, ' +
      "sac a dos beige/pratique. Style simple, propre, accessible.",
    elements_distinctifs:
      'Chemise bleue claire systematique, sac a dos beige, documents/CV a la main dans les scenes narratives.',
    style_visuel:
      'Illustration realiste 3D semi-realiste, eclairage doux, decor bureautique / chambre / rue urbaine africaine.',
    metadata: {
      age: '22-24 ans',
      genre: 'homme',
      origine: 'africain francophone',
      langue: 'francais',
      role_narratif: 'chercheur emploi',
      personnalite: 'determine, intelligent, curieux, humble, parfois stresse mais toujours pret a apprendre',
      palette: ['#8FC1E3', '#1B3A5C', '#6B4A2F'],
    },
  },
  marc: {
    character_id: 'marc',
    nom: 'Marc',
    version: REGISTRY_VERSION,
    role: "Mentor / recruteur experimente, guide Samuel",
    reference_principale: 'personnages/marc/marc-reference-principale.jpg',
    references_secondaires_dir: 'personnages/marc/refs',
    aliases: ['marc', 'marc d.'],
    description_visuelle:
      'Homme africain francophone, 35-45 ans, silhouette athletique moyenne, posture confiante. ' +
      'Barbe taillee, expression rassurante. Palette dominante bleu marine / chemise bleue claire.',
    caracteristiques_visage:
      'Visage mature rassurant et professionnel, yeux marron fonce, peau noire aux traits africains ' +
      'authentiques, barbe bien entretenue, pommettes marquees.',
    coiffure: 'Cheveux noirs courts, coupe professionnelle, ligne nette.',
    apparence_generale: 'Adulte etabli, prestance de recruteur, sourire bienveillant.',
    vetements_style:
      'Costume bleu marine elegant, chemise bleue claire, ceinture et chaussures en cuir marron, ' +
      'montre classique. Style professionnel et credible.',
    elements_distinctifs:
      'Costume bleu marine systematique, barbe taillee, documents/checklists et parfois ordinateur portable.',
    style_visuel:
      'Illustration realiste 3D semi-realiste, eclairage de bureau moderne, decor professionnel lumineux.',
    metadata: {
      age: '35-45 ans',
      genre: 'homme',
      origine: 'africain francophone',
      langue: 'francais',
      role_narratif: 'mentor / recruteur',
      personnalite: 'calme, patient, pedagogue, honnete, bienveillant, autoritaire mais accessible',
      palette: ['#1F3A5F', '#8FC1E3', '#2E2E2E'],
    },
  },
});

const CHARACTER_IDS = Object.freeze(Object.keys(CHARACTER_DEFINITIONS));
const UUID_NAMESPACE = 'savoir-utile/character-registry/v1';

function absFromRel(rel) {
  return path.join(ASSETS_ROOT, rel);
}

function sha256File(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (err) {
    return null;
  }
}

/** Identifiant stable et deterministe d'une reference : sha256(nom|hash contenu). */
function referenceId(characterId, filename, contentHash) {
  return crypto
    .createHash('sha256')
    .update(`${UUID_NAMESPACE}/${characterId}/${filename}/${contentHash || 'unknown'}`)
    .digest('hex')
    .slice(0, 16);
}

/** Normalise un nom de personnage cite dans un script (jamais de fuzzy-matching creatif). */
function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const NON_CHARACTER = new Set(['', 'aucun', 'none', 'nul', 'personne', 'sans personnage', 'na']);

/**
 * Resout un nom cite vers un character_id officiel. Renvoie null si le nom ne
 * correspond a AUCUN personnage officiel — le moteur ne doit alors JAMAIS
 * inventer un personnage de substitution (voir assertOfficialCharacter).
 */
function resolveCharacterId(name) {
  const n = normalizeName(name);
  if (NON_CHARACTER.has(n)) return null;
  for (const id of CHARACTER_IDS) {
    if (n === id) return id;
    if (CHARACTER_DEFINITIONS[id].aliases.some((a) => n === a || n.includes(a))) return id;
  }
  return null;
}

/** Vrai si la scene cite les DEUX personnages officiels (scene a deux personnages). */
function involvesBoth(name) {
  const n = normalizeName(name);
  if (!n) return false;
  const hasSamuel = n.includes('samuel');
  const hasMarc = n.includes('marc');
  return hasSamuel && hasMarc;
}

/**
 * Leve une erreur explicite si le personnage cite n'est pas officiel.
 * Utilise par le pipeline pour refuser une scene plutot que de la produire
 * avec un personnage invente.
 */
function assertOfficialCharacter(name) {
  const id = resolveCharacterId(name);
  if (!id) {
    const err = new Error(
      `characterRegistry: le personnage "${String(name || '')}" n'est PAS un personnage officiel ` +
        `(officiels : ${CHARACTER_IDS.join(', ')}). Aucun personnage generique ne sera fabrique en substitution.`,
    );
    err.code = 'CHARACTER_NOT_OFFICIAL';
    throw err;
  }
  return id;
}

/** Liste les references secondaires versionnees presentes dans le dossier refs/ (lecture seule). */
function listSecondaryReferences(characterId) {
  const def = CHARACTER_DEFINITIONS[characterId];
  if (!def) return [];
  const dir = absFromRel(def.references_secondaires_dir);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return [];
  }
  return files
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .map((filename) => {
      const abs = path.join(dir, filename);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch (err) {
        size = 0;
      }
      const contentHash = sha256File(abs);
      return {
        role: 'SECONDARY',
        versionne: true,
        filename,
        rel_path: path.relative(ASSETS_ROOT, abs).split(path.sep).join('/'),
        abs_path: abs,
        size_bytes: size,
        content_sha256: contentHash,
        reference_id: referenceId(characterId, filename, contentHash),
      };
    });
}

function primaryReference(characterId) {
  const def = CHARACTER_DEFINITIONS[characterId];
  if (!def) return null;
  const abs = absFromRel(def.reference_principale);
  let exists = false;
  let size = 0;
  try {
    const st = fs.statSync(abs);
    exists = st.isFile();
    size = st.size;
  } catch (err) {
    exists = false;
  }
  const contentHash = exists ? sha256File(abs) : null;
  return {
    role: 'PRIMARY',
    versionne: false,
    filename: path.basename(abs),
    rel_path: def.reference_principale,
    abs_path: abs,
    size_bytes: size,
    content_sha256: contentHash,
    reference_id: referenceId(characterId, path.basename(abs), contentHash),
    disponible: exists,
  };
}

/**
 * Vue complete d'un personnage : identite visuelle officielle + references
 * ordonnees (principale d'abord, puis secondaires versionnees) + statut
 * explicite de disponibilite.
 */
function getCharacter(characterId, { includeSecondary = true } = {}) {
  const id = resolveCharacterId(characterId);
  if (!id) return null;
  const def = CHARACTER_DEFINITIONS[id];
  const primary = primaryReference(id);
  const secondary = includeSecondary ? listSecondaryReferences(id) : [];
  const references = [primary, ...secondary].filter((r) => r && r.disponible !== false);
  return {
    character_id: def.character_id,
    nom: def.nom,
    version: def.version,
    role: def.role,
    description_visuelle: def.description_visuelle,
    caracteristiques_visage: def.caracteristiques_visage,
    coiffure: def.coiffure,
    apparence_generale: def.apparence_generale,
    vetements_style: def.vetements_style,
    elements_distinctifs: def.elements_distinctifs,
    style_visuel: def.style_visuel,
    metadata: def.metadata,
    reference_principale: primary,
    references_secondaires: secondary,
    references,
    reference_count: references.length,
    statut_reference: primary.disponible
      ? (references.length > 1 ? 'PRIMARY_AND_SECONDARY' : 'PRIMARY_ONLY')
      : (references.length ? 'SECONDARY_ONLY' : 'NO_REFERENCE'),
  };
}

/** Registre complet (tous les personnages officiels). Deterministe. */
function loadRegistry() {
  const characters = {};
  for (const id of CHARACTER_IDS) characters[id] = getCharacter(id);
  return {
    registry: 'conquistador-character-registry',
    version: REGISTRY_VERSION,
    generated_at: new Date().toISOString(),
    unknown_character_policy:
      'Aucun personnage non officiel ne peut etre genere : resolveCharacterId() renvoie null et le pipeline marque la scene FAILED / NEEDS_REVIEW plutot que de substituer un visage.',
    characters,
    character_count: CHARACTER_IDS.length,
  };
}

/**
 * Selectionne les references a envoyer a un provider image-to-image, dans
 * l'ordre de priorite : reference principale D'ABORD (poids le plus fort),
 * puis references secondaires (limite configurable pour respecter les quotas
 * des providers multi-reference).
 *
 * IMPORTANT : cette fonction ne fabrique jamais de reference. Si aucune
 * reference n'est disponible, elle renvoie une liste vide + `raison`, et
 * l'appelant DOIT refuser la generation conditionnee.
 */
function selectReferenceImages(characterId, { max = 4, preferBoth = false } = {}) {
  const id = resolveCharacterId(characterId);
  if (!id) {
    return { character_id: null, references: [], raison: `Personnage non officiel : aucune reference ne sera inventee.` };
  }
  const character = getCharacter(id);
  const pool = character.references.slice();
  // Une scene a deux personnages : on privilegie les references communes.
  if (preferBoth) {
    const both = listSecondaryReferences(id).filter((r) => /ensemble|both|duo/i.test(r.filename));
    if (both.length) pool.sort((a, b) => (both.includes(b) ? 1 : 0) - (both.includes(a) ? 1 : 0));
  }
  const selected = pool.slice(0, Math.max(1, max));
  return {
    character_id: id,
    references: selected,
    primary: character.reference_principale,
    raison: selected.length ? null : `Aucune reference visuelle disponible pour "${id}" : generation conditionnee impossible.`,
  };
}

/**
 * Strategie de reference par capacite provider (section 5). Determine ce qui
 * est RELLEMENT possible, sans promettre plus que le provider ne permet.
 */
function referenceStrategyFor(characterId, { providerCapabilities = {} } = {}) {
  const id = resolveCharacterId(characterId);
  if (!id) return { strategy: 'REFUSED', raison: 'Personnage non officiel.' };
  const caps = {
    image_to_image: false,
    reference_image: false,
    character_reference: false,
    multi_reference: false,
    seed: false,
    ...providerCapabilities,
  };
  const hasRefs = getCharacter(id, { includeSecondary: true }).references.length > 0;
  if (!hasRefs) return { strategy: 'REFUSED', character_id: id, raison: 'Aucune reference officielle disponible.' };
  if (caps.character_reference) return { strategy: 'CHARACTER_REFERENCE', character_id: id, fidelity: 'high' };
  if (caps.multi_reference) return { strategy: 'MULTI_REFERENCE', character_id: id, fidelity: 'high' };
  if (caps.reference_image) return { strategy: 'SINGLE_REFERENCE', character_id: id, fidelity: 'medium' };
  if (caps.image_to_image) return { strategy: 'IMAGE_TO_IMAGE', character_id: id, fidelity: 'medium' };
  return {
    strategy: 'FALLBACK_OFFICIAL_ASSET',
    character_id: id,
    fidelity: 'exact_but_static',
    raison:
      "Le provider ne supporte aucune forme de conditionnement par image de reference : " +
      "le moteur reutilise l'asset OFFICIEL tel quel (identite exacte, mise en scene figee) " +
      "au lieu de risquer un visage different.",
  };
}

/**
 * Verifie l'integrite du registre : references declarees reellement presentes,
 * hash non nul, aucune reference primaire manquante. Utilise par les
 * diagnostics et les tests.
 */
function verifyIntegrity() {
  const problems = [];
  for (const id of CHARACTER_IDS) {
    const character = getCharacter(id);
    if (!character.reference_principale.disponible) {
      problems.push({ character_id: id, type: 'PRIMARY_REFERENCE_MISSING', detail: character.reference_principale.rel_path });
    }
    for (const ref of character.references) {
      if (!ref.content_sha256) problems.push({ character_id: id, type: 'REFERENCE_HASH_UNAVAILABLE', detail: ref.rel_path });
      if (!ref.size_bytes) problems.push({ character_id: id, type: 'REFERENCE_EMPTY', detail: ref.rel_path });
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    characters: CHARACTER_IDS.map((id) => {
      const c = getCharacter(id);
      return {
        character_id: id,
        statut_reference: c.statut_reference,
        references_principales: c.reference_principale.disponible ? 1 : 0,
        references_secondaires: c.references_secondaires.length,
      };
    }),
  };
}

/** Ecrit un manifeste JSON du registre (documentation / tracabilite). */
async function writeRegistryManifest(destPath) {
  const target = destPath || path.join(PERSONNAGES_ROOT, 'character-registry.json');
  const registry = loadRegistry();
  const serializable = {
    ...registry,
    characters: Object.fromEntries(
      Object.entries(registry.characters).map(([id, c]) => [
        id,
        { ...c, references: undefined, reference_principale: { ...c.reference_principale, abs_path: undefined }, references_secondaires: c.references_secondaires.map(({ abs_path, ...rest }) => rest) },
      ]),
    ),
  };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
  return target;
}

module.exports = {
  REGISTRY_VERSION,
  ASSETS_ROOT,
  CHARACTER_DEFINITIONS,
  CHARACTER_IDS,
  NON_CHARACTER,
  normalizeName,
  resolveCharacterId,
  involvesBoth,
  assertOfficialCharacter,
  primaryReference,
  listSecondaryReferences,
  getCharacter,
  loadRegistry,
  selectReferenceImages,
  referenceStrategyFor,
  verifyIntegrity,
  writeRegistryManifest,
  referenceId,
};
