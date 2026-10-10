'use strict';

const { askAI } = require('./base');
const visualContinuity = require('../core/visualContinuity');
const scenePlanner = require('../core/scenePlanner');

const SYSTEM = [
  "Tu es AGENT_CONTENU au sein de Conquistador OS, specialise dans la creation de",
  'contenu video et editorial pour Savoir Utile (TikTok/Reels/YouTube Shorts).',
  'Tu connais le pipeline : idee -> angle -> hook -> script -> scenes -> texte a',
  "l'ecran -> prompts d'images -> voix off -> CTA -> description -> hashtags -> miniature.",
].join('\n');

/**
 * Applique VISUAL_CONTINUITY_POLICY (src/core/visualContinuity.js) au champ
 * "scenes" d'un resultat IA, quand celui-ci a pu etre extrait comme JSON
 * structure. Si l'IA n'a pas renvoye un JSON exploitable (frequent avec de
 * petits modeles gratuits), on ne pretend PAS avoir verifie une continuite
 * que l'on n'a pas pu evaluer : le champ le precise honnetement.
 */
function mergeRevisionContent(previous, parsed) {
  if (!parsed || parsed.ok !== true || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) return parsed;
  const merged = { ...previous, ...parsed.data };
  for (const key of Object.keys(previous || {})) {
    const oldValue = previous[key];
    const nextValue = merged[key];
    const omitted = nextValue === undefined || nextValue === null || (typeof nextValue === 'string' && !nextValue.trim());
    const emptied = Array.isArray(oldValue) && oldValue.length > 0 && Array.isArray(nextValue) && nextValue.length === 0;
    if (omitted || emptied) merged[key] = oldValue;
  }
  return { ...parsed, data: merged };
}

function attachContinuity(parsed) {
  if (!parsed || parsed.ok !== true || !parsed.data) {
    return { continuite_verifiee: false, raison: "Sortie IA non structuree (JSON invalide) : continuite visuelle non evaluable." };
  }
  const scenes = Array.isArray(parsed.data.scenes) ? parsed.data.scenes : null;
  if (!scenes) {
    return { continuite_verifiee: false, raison: "Aucun champ 'scenes' exploitable dans la sortie IA." };
  }
  const evaluation = visualContinuity.evaluateScenes(scenes);
  return { continuite_verifiee: true, ...evaluation };
}

async function idea(input) {
  const prompt = [
    `Sujet ou contrainte donnee par l'utilisateur : ${input.sujet || input.brief || 'libre, propose une idee alignee avec la mission de Savoir Utile'}`,
    'Genere 3 idees de video courtes, distinctes, orientees emploi/competences en Afrique francophone.',
    'Format JSON attendu : { "idees": [ { "titre": "...", "angle": "...", "hook": "...", "public_cible": "..." } ] }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.9 });
  return { type: 'content.idea', provider: result.provider, model: result.model, output: result.parsed };
}

async function script(input) {
  const prompt = [
    `Idee/angle a developper en script complet : ${input.idee || input.titre || 'idee non precisee'}`,
    `Duree cible : ${input.duree || '45-60 secondes'}`,
    'Produit un script complet avec hook, corps, CTA.',
    'Format JSON attendu : { "hook": "...", "script": "...", "cta": "...", "duree_estimee": "..." }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.8 });
  return { type: 'content.script', provider: result.provider, model: result.model, output: result.parsed };
}

const SCENE_DECOUPAGE_GUIDANCE = [
  'Decoupage en scenes - regles de decision (aucun ratio fixe du type "X scenes pour Y secondes" ne doit etre applique) :',
  'Identifie mentalement les unites narratives presentes dans le script (hook, probleme, consequence, explication, exemple, solution, CTA - certaines peuvent etre absentes ou fusionnees selon le script reel).',
  'Determine le nombre de scenes necessaires en fonction de : duree totale, vitesse de narration, nombre d\'idees distinctes, changements de sujet/action, personnages presents, importance de chaque information, rythme emotionnel. Une meme idee peut tenir sur une seule scene ; une seule phrase riche en informations visuelles distinctes peut necessiter plusieurs scenes.',
  'Chaque scene doit reussir ce test avant d\'etre incluse : "Cette scene aide-t-elle reellement a illustrer ce qui est dit a ce moment precis du script ?" Rejette et remplace toute scene generique ou seulement decorative qui ne repond pas clairement a cette question.',
  'Personnages : Samuel et Marc restent les deux personnages principaux et ne doivent jamais etre remplaces, fusionnes ou substitues par un autre personnage. Un personnage secondaire sans reference officielle (ex: "un recruteur", "une collegue") peut etre ajoute UNIQUEMENT s\'il a une fonction narrative claire a ce moment du script - jamais pour remplir l\'image. Quand un personnage secondaire est present dans une scene, decris-le dans le champ "personnage" en gardant le nom de Samuel et/ou Marc s\'ils sont egalement presents (ex: "Samuel et un recruteur"), et note sa fonction dans "personnage_secondaire" si ce champ est renseigne.',
].join('\n');

async function scenes(input) {
  const prompt = [
    `Script a decouper en scenes filmables : ${input.script || 'script non fourni, propose un decoupage generique coherent avec le sujet suivant : ' + (input.sujet || 'recherche d\'emploi')}`,
    SCENE_DECOUPAGE_GUIDANCE,
    "Pour chaque scene, fournis : id, description, personnage (Samuel, Marc, une combinaison des deux, ou 'aucun'), personnage_secondaire (optionnel, texte libre avec sa fonction narrative), decor, cadrage, emotion, style, reference_necessaire, logo_requis (true/false), prompt_final, voix_off_scene (texte exact, pret a etre lu tel quel par la voix off pour cette scene precise - pas une indication de ton, le texte reel).",
    'Format JSON attendu : { "scenes": [ { "id": "scene_01", "description": "...", "personnage": "...", "personnage_secondaire": "...", "decor": "...", "cadrage": "...", "emotion": "...", "style": "...", "reference_necessaire": "...", "logo_requis": false, "prompt_final": "...", "voix_off_scene": "..." } ] }',
    'IMPORTANT : si un personnage officiel est utilise, ce doit etre Samuel ou Marc uniquement (references visuelles officielles existantes), jamais un personnage invente a leur place.',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.7 });
  return {
    type: 'content.scenes',
    provider: result.provider,
    model: result.model,
    output: result.parsed,
    continuite_visuelle: attachContinuity(result.parsed),
  };
}

async function fullVideo(input) {
  const strictProduction = input.production_profile === 'strict_multiscene';
  const targetDuration = Number(input.target_duration_seconds) || 60;
  const initialPlan = scenePlanner.planSceneCount({ targetDurationSeconds: targetDuration, minScenes: strictProduction ? 6 : 4, maxScenes: 12 });
  const strictGuidance = strictProduction ? [
    `PROFIL DE PRODUCTION STRICT : vise ${targetDuration} secondes, cible acceptable de 45 à 90 secondes après mesure de la voix réelle.`,
    `La durée seule donne un point de départ d’environ ${initialPlan.recommended_scene_count} plans (estimation ${initialPlan.rationale}); recalcule ce nombre après rédaction du script, selon les unités narratives et les changements visuels réellement utiles.`,
    'Produis entre 6 et 12 scènes, jamais un nombre fixe par habitude. Chaque scène a un id distinct, un prompt_final inédit et une narration originale dimensionnée pour sa durée réelle. Fusionne les idées qui tiennent dans un plan; ne scinde que lorsqu’une transition d’information ou d’action le justifie.',
    'Le script doit rester oral et utile à environ 2,2 mots par seconde de narration : hook immédiat, étapes concrètes, transitions naturelles, conclusion et CTA explicite dans la dernière scène. Après rédaction, compare la durée parlée estimée au nombre de plans et élimine tout remplissage.',
    "Format faceless : n'inclus pas Samuel, Marc, aucun personnage identifiable ni visage ; raconte avec des décors, objets et gestes non identifiants. Chaque visuel doit illustrer le texte précis de sa scène.",
    'Garde une direction artistique cohérente (palette bleu nuit, ivoire et touches ocre, lumière naturelle, réalisme éditorial), mais varie clairement le décor, le cadrage et les objets. Aucun texte lisible ni logo inventé dans les images.',
    'Ne produis pas de manifeste générique, de prompt répété, de scène décorative ou de remplissage.',
  ].join('\n') : '';
  const prompt = [
    `Brief video complet a produire de bout en bout : ${input.sujet || input.brief || "recherche d'emploi en Afrique francophone"}`,
    'Produis TOUS les elements suivants, coherents entre eux : idee, angle, hook, script,',
    'scenes (liste avec id/description/personnage/personnage_secondaire/decor/cadrage/emotion/style/reference_necessaire/logo_requis/prompt_final/voix_off_scene),',
    SCENE_DECOUPAGE_GUIDANCE,
    strictGuidance,
    'voix_off_scene = texte exact, pret a etre lu tel quel par la voix off pour cette scene precise (pas une indication de ton).',
    'N’invente aucune promesse d’emploi garanti, aucun salaire, statistique, témoignage, prix, remboursement ou délai qui ne figure pas dans les sources fournies.',
    'texte_ecran (liste de textes courts affiches a l\'ecran), voix_off (indication de ton, le',
    'fournisseur/voix technique est deja fixe et ne doit pas etre invente), cta, description,',
    'hashtags (liste), idee_miniature, plateforme cible, style de marque et transitions.',
  'Audience principale : République démocratique du Congo. Si et seulement si le sujet s\u2019y prête naturellement, intègre des repères RDC (Kinshasa, marché de l\u2019emploi congolais) et des hashtags comme #RDC #Kinshasa #EmploiRDC #TravailRDC. Ne les ajoute jamais aveuglément.',
    'Ajoute une timeline minutée : chaque segment contient scene_id, start_seconds, end_seconds, image_ref,',
    'voice_start_seconds, voice_end_seconds et subtitles [{start_seconds, end_seconds, text}]. Les intervalles voix-image',
    'doivent correspondre à la scène et chaque sous-titre doit rester dans sa scène.',
    'Format JSON attendu : { "idee": "...", "angle": "...", "hook": "...", "script": "...",',
    '"platform": "tiktok", "brand_style": "...", "scenes": [...], "timeline": [...],',
    '"texte_ecran": [...], "voix_off": "...", "cta": "...", "description": "...",',
    '"hashtags": [...], "idee_miniature": "..." }',
  ].join('\n');
  const result = await askAI({
    system: SYSTEM,
    prompt,
    expectJson: true,
    temperature: 0.8,
    maxTokens: 2048,
    profile: strictProduction ? 'strict_video' : undefined,
  });
  return {
    type: 'content.full_video',
    provider: result.provider,
    model: result.model,
    output: result.parsed,
    continuite_visuelle: attachContinuity(result.parsed),
  };
}

async function revise(input) {
  const previous = input.previous_content || input.contenu_precedent || {};
  const feedback = input.revision_feedback || input.feedback || {};
  const prompt = [
    'Révise le contenu vidéo précédent en appliquant uniquement les corrections signalées par les agents de contrôle.',
    `Contenu précédent : ${JSON.stringify(previous)}`,
    `Retour agent qualité éditoriale : ${JSON.stringify(feedback.editorial || [])}`,
    `Retour contrôleur vidéo — problèmes identifiés : ${JSON.stringify(feedback.video || [])}`,
    `Corrections demandées : ${JSON.stringify(feedback.corrections || [])}`,
    `Comment corriger : ${JSON.stringify(feedback.howToCorrect || [])}`,
    `Éléments à préserver : ${JSON.stringify(feedback.preserve || [])}`,
    `Avertissements : ${JSON.stringify(feedback.warnings || [])}`,
    `Preuves manquantes : ${JSON.stringify(feedback.missingEvidence || [])}`,
    'Conserve les éléments corrects, les personnages officiels Samuel/Marc et la cohérence Savoir Utile.',
    'Chaque scène conserve ou met à jour son champ voix_off_scene (texte exact à lire par la voix off pour cette scène).',
    'Ne modifie le nombre de scènes que si le retour qualité le justifie explicitement (scène hors sujet à retirer, idée mal illustrée à scinder) ; ne change jamais le découpage juste pour changer.',
    'Un personnage secondaire (personnage_secondaire) ne remplace jamais Samuel ou Marc et doit garder une fonction narrative claire.',
    'Ne prétends pas réparer une vidéo binaire, un audio ou des images qui ne sont pas fournis ; améliore le manifeste et les éléments éditoriaux seulement.',
    'Format JSON attendu : { "idee": "...", "angle": "...", "hook": "...", "script": "...", "scenes": [{ "id": "...", "voix_off_scene": "...", "...": "..." }], "texte_ecran": [...], "voix_off": "...", "cta": "...", "description": "...", "hashtags": [...], "idee_miniature": "..." }',
  'Ciblage : audience principale en RDC. N\u2019utilise les hashtags géographiques (#RDC, #Kinshasa, #Congo, #EmploiRDC, #TravailRDC) que lorsqu\u2019ils correspondent réellement au contenu.',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.55, maxTokens: 2048, profile: 'reasoning' });
  return { type: 'content.revise', provider: result.provider, model: result.model, output: mergeRevisionContent(previous, result.parsed) };
}

async function calendar(input) {
  const jours = input.jours || 7;
  const prompt = [
    `Propose un calendrier editorial de ${jours} jours pour Savoir Utile.`,
    "Alterne entre contenu de valeur (conseils emploi), contenu de preuve/temoignage, et contenu de vente douce.",
    'Format JSON attendu : { "calendrier": [ { "jour": 1, "type_contenu": "...", "sujet": "...", "objectif": "..." } ] }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.7 });
  return { type: 'content.calendar', provider: result.provider, model: result.model, output: result.parsed };
}

const PLATFORM_RULES = Object.freeze({
  tiktok: { label: 'TikTok', titleMax: 150, descriptionMax: 2200, hashtagMax: 8, format: 'vertical_9_16', note: 'Content Posting API : URL HTTPS et autorisation video.publish requises.' },
  instagram: { label: 'Instagram Reels', titleMax: 100, descriptionMax: 2200, hashtagMax: 8, format: 'vertical_9_16', note: 'Publication réelle dépend des permissions Meta et de l’asset vidéo.' },
  facebook: { label: 'Facebook Reels', titleMax: 100, descriptionMax: 63206, hashtagMax: 8, format: 'vertical_9_16', note: 'Publication réelle dépend des permissions Meta et de l’asset vidéo.' },
  youtube: { label: 'YouTube Shorts', titleMax: 100, descriptionMax: 5000, hashtagMax: 8, format: 'vertical_9_16', note: 'Téléversement réel dépend de l’autorisation YouTube et d’une URL HTTPS.' },
});

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

const CTA_DESTINATIONS = Object.freeze({
  tiktok: 'le profil TikTok',
  instagram: 'la bio Instagram',
  facebook: 'la publication Facebook',
  youtube: 'la description YouTube',
});

function adaptCta(cta, platform) {
  const clean = clip(cta, 280);
  if (!clean) return '';
  const destination = CTA_DESTINATIONS[platform];
  if (!destination) return clean;
  return clean
    .replace(/(?:dans la bio|en bio)/gi, `dans ${destination}`)
    .replace(/dans le profil/gi, `dans ${destination}`)
    .replace(/sur le profil/gi, `sur ${destination}`)
    .replace(/(?:le lien|un lien|link)/gi, `le lien vers ${destination}`);
}

const GEO_TAGS_RDC = ['#RDC', '#Kinshasa', '#Congo', '#EmploiRDC', '#TravailRDC'];
const GEO_RELEVANCE = /(rdc|congo|kinshasa|lubumbashi|goma|bukavu|afrique|emploi|travail|cv|entretien|recrut|candidat)/i;

/** Hashtags geo RDC ajoutes UNIQUEMENT si le contenu y est pertinent. */
function geoHashtags(contentText, existing, max) {
  const tags = Array.isArray(existing) ? [...existing] : [];
  if (!GEO_RELEVANCE.test(String(contentText || ''))) return tags.slice(0, max);
  for (const tag of GEO_TAGS_RDC) {
    if (tags.length >= max) break;
    if (!tags.some((t) => String(t).toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags.slice(0, max);
}

function adaptPlatformContent(input = {}) {
  const requested = Array.isArray(input.plateformes) && input.plateformes.length ? input.plateformes : Object.keys(PLATFORM_RULES);
  const baseDescription = String(input.description || input.texte || input.resume || '').trim();
  const baseTitle = String(input.title || input.titre || input.hook || '').trim();
  const baseCta = String(input.cta || '').trim();
  const baseHashtags = Array.isArray(input.hashtags) ? input.hashtags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const packs = requested.map((platform) => {
    const key = String(platform || '').toLowerCase();
    const rule = PLATFORM_RULES[key];
    if (!rule) return null;
    return {
      plateforme: key,
      label: rule.label,
      titre: clip(baseTitle, rule.titleMax),
      description: clip([baseDescription, baseCta].filter(Boolean).join('\n\n'), rule.descriptionMax),
      hashtags: geoHashtags(`${baseTitle} ${baseDescription} ${baseHashtags.join(' ')}`, baseHashtags, rule.hashtagMax),
      cta: clip(baseCta, 280),
      cta_adapte: adaptCta(baseCta, key),
      format_recommande: rule.format,
      note_integration: rule.note,
      statut: 'PREPARE_NON_PUBLIE',
    };
  }).filter(Boolean);
  return {
    statut: 'PACK_MULTIPLATEFORME_PREPARE',
    contenu_source: { title: baseTitle || null, description: baseDescription || null, hashtags: baseHashtags, cta: baseCta || null },
    plateformes: packs,
    publication_autorisee: false,
    note: 'Les variantes sont préparées séparément. Aucune plateforme n’est appelée par cette étape.',
  };
}

/**
 * PREPARE_POST (section 19 du prompt maitre V1.1) : prepare un post pret a
 * publier (texte + hashtags + reference visuelle) SANS jamais le publier.
 * Action distincte de system.publish_post (EXECUTE, APPROVAL_REQUIRED) - ce
 * decouplage PREPARE / EXECUTE est une exigence explicite du prompt maitre.
 */
async function preparePost(input) {
  const prompt = [
    `Contenu source pour le post : ${input.sujet || input.resume || 'aucun sujet precise, propose un post generique aligne avec Savoir Utile'}`,
    `Plateforme visee (adapte le ton/longueur) : ${input.plateforme || 'generique (TikTok/Instagram/WhatsApp)'}`,
    'Prepare un post complet : texte, hashtags, et une suggestion de visuel (texte descriptif, pas une image).',
    'Format JSON attendu : { "texte": "...", "hashtags": [...], "suggestion_visuelle": "..." }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.75 });
  return {
    type: 'content.prepare_post',
    provider: result.provider,
    model: result.model,
    output: result.parsed,
    statut: 'PREPARE_NON_PUBLIE',
  };
}

async function adaptPlatforms(input) {
  return {
    type: 'content.adapt_platforms',
    provider: null,
    model: null,
    output: adaptPlatformContent(input || {}),
  };
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'idea':
      return idea(input || {});
    case 'script':
      return script(input || {});
    case 'scenes':
      return scenes(input || {});
    case 'full_video':
      return fullVideo(input || {});
    case 'calendar':
      return calendar(input || {});
    case 'revise':
      return revise(input || {});
    case 'prepare_post':
      return preparePost(input || {});
    case 'adapt_platforms':
      return adaptPlatforms(input || {});
    default:
      throw new Error(`AGENT_CONTENU: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, idea, script, scenes, fullVideo, revise, calendar, preparePost, adaptPlatforms, adaptPlatformContent, adaptCta, attachContinuity, mergeRevisionContent, PLATFORM_RULES };
