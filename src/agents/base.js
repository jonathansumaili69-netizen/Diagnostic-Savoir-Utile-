'use strict';

const aiProvider = require('../core/aiProvider');
const { config } = require('../core/config');
const operationalState = require('../core/operationalState');

/**
 * Contexte de marque injecte dans chaque prompt systeme, pour que tous les
 * agents restent coherents avec l'identite de Savoir Utile (sections 2, 4, 5, 6).
 */
function brandContext() {
  const refLine = (name) => {
    const ref = config.brand.characterRefs[name];
    return ref
      ? `Reference visuelle officielle disponible et OBLIGATOIRE pour ${name} : ${ref} (voir assets/README.md). Toute scene utilisant ${name} doit explicitement citer cette reference.`
      : `AUCUNE reference visuelle officielle configuree pour ${name} actuellement (variable CHARACTER_REF_${name.toUpperCase()} vide) : la continuite visuelle ne peut pas etre garantie tant que ce n'est pas corrige.`;
  };
  return [
    `Marque : ${config.brand.name}`,
    `Mission : aider les personnes en Afrique francophone a progresser dans l'emploi, la recherche d'emploi, les competences et les opportunites.`,
    `Produit principal : "${config.brand.productName}"`,
    `Lien du produit (a inclure naturellement si pertinent, jamais invente) : ${config.brand.productUrl}`,
    `Boutique : ${config.brand.shopUrl}`,
    `Personnages officiels a reutiliser si un personnage est necessaire : ${config.brand.characters.join(' et ')}. Ne jamais inventer de nouveau personnage.`,
    `Description physique et role de Samuel (a respecter scrupuleusement dans toute description de scene) : ${config.brand.characterBible.Samuel}`,
    refLine('Samuel'),
    `Description physique et role de Marc (a respecter scrupuleusement dans toute description de scene) : ${config.brand.characterBible.Marc}`,
    refLine('Marc'),
    config.brand.logo.assetId
      ? `Logo officiel disponible et OBLIGATOIRE lorsqu'un logo est requis : ${config.brand.logo.assetId}. Ne jamais recreer, approximer ou remplacer ce logo.`
      : "AUCUN asset logo officiel configure actuellement (variable LOGO_ASSET_ID vide) : ne jamais generer de logo de substitution.",
    `Voix off utilisee pour les videos : ${config.brand.voiceProvider} - voix "${config.brand.voiceName}".`,
    `Canal WhatsApp : ${config.brand.whatsapp.name} (c'est une CHAINE, pas un groupe). Aucun acces API WhatsApp reel n'est suppose disponible.`,
    'Ton : humain, chaleureux, naturel, utile, jamais robotique ni excessivement court, jamais agressif.',
  ].join('\n');
}

/**
 * Tente de parser une reponse IA en JSON. Si l'IA n'a pas respecte le format
 * demande (frequent avec de petits modeles gratuits), on renvoie le texte brut
 * dans le champ "raw" plutot que d'echouer silencieusement ou d'inventer une
 * structure : le systeme ne doit jamais pretendre avoir un resultat structure
 * qu'il n'a pas reellement obtenu.
 */
function safeJsonParse(text) {
  if (!text) return { ok: false, raw: text };
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return { ok: true, data: JSON.parse(candidate) };
  } catch (err) {
    return { ok: false, raw: text };
  }
}

/**
 * Appelle le fournisseur IA avec le contexte de marque en prefixe du prompt
 * systeme, et journalise quel fournisseur a effectivement repondu (utile pour
 * le rapport quotidien et la transparence sur le mode MOCK).
 */
async function askAI({ system, prompt, temperature, maxTokens, expectJson, profile }) {
  let knowledge = [];
  try {
    knowledge = await operationalState.listKnowledge({ limit: 20 });
  } catch (err) {
    // La mémoire de connaissance est additive : son indisponibilité ne doit pas
    // empêcher les agents historiques de fonctionner, mais elle n’est jamais
    // remplacée par du contenu inventé.
    knowledge = [];
  }
  const knowledgeText = knowledge.length
    ? `Références réelles de la base de connaissances Savoir Utile. Utilise-les seulement si elles sont pertinentes et ne complète jamais un manque par une invention :\n${knowledge.map((row) => {
      const data = row.data || {};
      const marker = data.official === true ? 'OFFICIELLE' : 'référence';
      const source = data.source_url ? `\nSource HTTPS : ${data.source_url}` : '';
      return `[${data.category || 'general'} · ${data.asset_type || 'text'} · ${marker}] ${data.title}\n${String(data.content || '').slice(0, 1200)}${source}`;
    }).join('\n\n').slice(0, 18000)}`
    : '';
  const fullSystem = [brandContext(), knowledgeText, system].filter(Boolean).join('\n\n');
  const finalPrompt = expectJson
    ? `${prompt}\n\nReponds UNIQUEMENT avec un JSON valide, sans texte autour, sans balises markdown.`
    : prompt;
  const result = await aiProvider.generate({
    system: fullSystem,
    prompt: finalPrompt,
    temperature,
    maxTokens,
    profile,
  });
  if (expectJson) {
    const parsed = safeJsonParse(result.text);
    return { ...result, parsed };
  }
  return result;
}

module.exports = { brandContext, safeJsonParse, askAI };
