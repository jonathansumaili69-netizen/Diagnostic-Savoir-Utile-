'use strict';

const { config } = require('../core/config');
const visualContinuity = require('../core/visualContinuity');

/**
 * AGENT_QUALITE ne fait pas appel a l'IA generative : il applique des regles
 * de coherence deterministes et verifiables sur un contenu avant qu'il ne
 * soit propose a l'approbation humaine (section 17 : "Le systeme doit
 * verifier que tous les elements sont coherents.").
 */

function review(input) {
  const content = input.content || {};
  const issues = [];
  const text = JSON.stringify(content).toLowerCase();

  // Verifie qu'aucun personnage non officiel n'est explicitement introduit
  // par un nom propre autre que Samuel/Marc dans les champs "personnage".
  const personnageFields = extractPersonnageFields(content);
  for (const p of personnageFields) {
    const normalized = String(p).trim().toLowerCase();
    if (
      normalized &&
      normalized !== 'aucun' &&
      normalized !== 'none' &&
      !config.brand.characters.some((c) => normalized.includes(c.toLowerCase()))
    ) {
      issues.push(`Personnage non reconnu detecte : "${p}". Seuls Samuel et Marc sont des references officielles.`);
    }
  }

  // Verifie que si un lien produit est mentionne, c'est bien le lien officiel.
  if (text.includes('mychariow') && !text.includes(config.brand.productUrl.toLowerCase())) {
    issues.push('Un lien de type boutique est present mais ne correspond pas exactement au lien produit officiel.');
  }

  // Verifie qu'un CTA existe si le contenu pretend etre une video complete.
  if (content.script || content.hook) {
    if (!content.cta) {
      issues.push("Aucun CTA (appel a l'action) n'est present dans ce contenu.");
    }
  }

  // VISUAL_CONTINUITY_POLICY (sections 12-14, prompt maitre V1.1) : verifie,
  // en plus des controles ci-dessus, que les references officielles
  // (personnage + logo) sont bien identifiees pour chaque scene fournie.
  // Champ SEPARE de "problemes"/"conforme" ci-dessus par conception : ce
  // sont deux politiques distinctes (qualite editoriale generale vs
  // continuite visuelle stricte), et le melange des deux romprait la
  // retrocompatibilite du contrat existant de cet agent.
  const scenes = Array.isArray(content.scenes) ? content.scenes : null;
  const continuiteVisuelle = scenes ? visualContinuity.evaluateScenes(scenes) : null;

  return {
    type: 'quality.review',
    output: {
      conforme: issues.length === 0,
      problemes: issues,
      continuite_visuelle: continuiteVisuelle,
      verifie_le: new Date().toISOString(),
    },
  };
}

function extractPersonnageFields(obj, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'personnage' && typeof value === 'string') {
      acc.push(value);
    } else if (typeof value === 'object') {
      extractPersonnageFields(value, acc);
    } else if (Array.isArray(value)) {
      value.forEach((v) => extractPersonnageFields(v, acc));
    }
  }
  return acc;
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'review':
      return review(input || {});
    default:
      throw new Error(`AGENT_QUALITE: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, review };
