'use strict';

const { config } = require('./config');

/**
 * VISUAL_CONTINUITY_POLICY (sections 12-14 du prompt maitre V1.1).
 *
 * Regle absolue : Samuel et Marc sont les SEULES references de personnages
 * autorisees, et le logo officiel est un asset IMMUABLE. Ce module ne genere
 * jamais d'image ni n'invente une reference : il verifie seulement que les
 * references officielles necessaires sont bien identifiees avant qu'un
 * contenu visuel puisse etre considere comme pret. Si une reference requise
 * est absente, le module retourne explicitement un probleme a corriger -
 * il ne "garantit" jamais une continuite qu'il n'a pas reellement verifiee.
 *
 * Ce code ne peut pas acceder au Drive/dossier reel du projet
 * (CONQUISTADOR_OS/04_PERSONNAGES, CONQUISTADOR_OS/03_LOGOS) : les
 * identifiants de reference doivent etre renseignes via les variables
 * d'environnement CHARACTER_REF_SAMUEL, CHARACTER_REF_MARC, LOGO_ASSET_ID
 * (voir .env.example et SETUP.md). Tant qu'ils ne le sont pas, ce module
 * bloque honnetement la continuite plutot que de l'inventer.
 */

const OFFICIAL_CHARACTERS = config.brand.characters; // ['Samuel', 'Marc']

/**
 * Verifie qu'un personnage cite dans une scene est bien l'un des personnages
 * officiels, ET qu'une reference visuelle officielle est configuree pour lui.
 */
function checkCharacter(personnage) {
  const problems = [];
  if (!personnage) return problems; // scene sans personnage : rien a verifier
  const normalized = String(personnage).trim();
  const lower = normalized.toLowerCase();
  if (lower === 'aucun' || lower === 'none' || lower === '') return problems;

  const officialMatch = OFFICIAL_CHARACTERS.find((c) => lower.includes(c.toLowerCase()));
  if (!officialMatch) {
    problems.push({
      type: 'personnage_non_officiel',
      detail: `Personnage "${normalized}" non reconnu. Seuls ${OFFICIAL_CHARACTERS.join(' et ')} sont des references officielles. Interdiction absolue d'inventer un nouveau personnage.`,
    });
    return problems;
  }

  const refId = config.brand.characterRefs[officialMatch];
  if (!refId) {
    problems.push({
      type: 'reference_manquante',
      detail: `Personnage officiel "${officialMatch}" cite, mais aucune reference visuelle n'est configuree (variable CHARACTER_REF_${officialMatch.toUpperCase()}). La continuite visuelle ne peut pas etre garantie tant que cette reference n'est pas renseignee.`,
    });
  }
  return problems;
}

/**
 * Verifie que si un logo est requis dans la scene, l'asset officiel est
 * identifie. Ne genere jamais de substitut.
 */
function checkLogo(logoRequis) {
  const problems = [];
  if (!logoRequis) return problems;
  if (!config.brand.logo.assetId) {
    problems.push({
      type: 'logo_non_configure',
      detail: "Logo officiel requis pour cette scene, mais aucun asset n'est identifie (variable LOGO_ASSET_ID). Interdiction de generer ou de substituer un logo : configurer l'identifiant du fichier officiel avant validation.",
    });
  }
  return problems;
}

/**
 * Verifie la coherence de style entre une scene et les scenes precedentes
 * (meme video ou continuite entre videos, section 12 : "La continuite doit
 * etre conservee entre les scenes d'une meme video ET entre les differentes
 * videos de Savoir Utile."). Verification heuristique simple : signale un
 * ecart, ne bloque pas (le style peut legitimement evoluer), mais ne le
 * passe jamais sous silence.
 */
function checkStyleContinuity(scene, priorScenes) {
  const problems = [];
  if (!scene.style || !Array.isArray(priorScenes) || priorScenes.length === 0) return problems;
  const referenceStyle = priorScenes[0].style;
  if (referenceStyle && scene.style && referenceStyle.trim().toLowerCase() !== scene.style.trim().toLowerCase()) {
    problems.push({
      type: 'incoherence_style',
      detail: `Style "${scene.style}" different du style de reference etabli ("${referenceStyle}") dans cette sequence. A verifier avant validation - un changement de style peut etre volontaire, mais doit etre confirme.`,
    });
  }
  return problems;
}

/**
 * Evalue une scene individuelle. Retourne { ok, problemes } - ok est true
 * uniquement si aucun probleme bloquant (personnage_non_officiel,
 * reference_manquante, logo_non_configure) n'a ete detecte. Les
 * incoherences de style sont remontees mais non bloquantes (avertissement).
 */
function evaluateScene(scene, priorScenes = []) {
  const blocking = [
    ...checkCharacter(scene.personnage),
    ...checkLogo(scene.logo_requis === true),
  ];
  const warnings = checkStyleContinuity(scene, priorScenes);
  return {
    scene_id: scene.id || scene.numero || null,
    continuite_garantie: blocking.length === 0,
    problemes_bloquants: blocking,
    avertissements: warnings,
  };
}

/**
 * Evalue un ensemble de scenes (typiquement une video complete), dans
 * l'ordre, en propageant la reference de style de la premiere scene.
 */
function evaluateScenes(scenes) {
  if (!Array.isArray(scenes)) return { continuite_garantie: true, scenes: [] };
  const results = [];
  for (let i = 0; i < scenes.length; i += 1) {
    results.push(evaluateScene(scenes[i], scenes.slice(0, i)));
  }
  return {
    continuite_garantie: results.every((r) => r.continuite_garantie),
    scenes: results,
  };
}

module.exports = {
  OFFICIAL_CHARACTERS,
  checkCharacter,
  checkLogo,
  checkStyleContinuity,
  evaluateScene,
  evaluateScenes,
};
