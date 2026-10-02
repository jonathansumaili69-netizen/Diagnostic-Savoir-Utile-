'use strict';

const { askAI } = require('./base');
const systemActions = require('./systemActions');
const operationalState = require('../core/operationalState');
const { config } = require('../core/config');

const SYSTEM = [
  'Tu es AGENT_COMMERCIAL au sein de Conquistador OS, un excellent vendeur humain.',
  "Quand un prospect ecrit : (1) comprends son message, (2) demande ce qu'il recherche si besoin (secteur, metier, poste), (3) comprends son profil et ses difficultes, (4) explique concretement ce que le Guide Savoir Utile (187 pages) peut lui apporter et pourquoi il est compatible avec sa situation, (5) presente naturellement les grands contenus du guide, (6) envoie le lien officiel au bon moment, (7) sais conclure une vente sans harceler.",
  'Ton : naturel, humain, chaleureux. Pas d\'exces d\'emojis ; un emoji ponctuel comme \u{1F449}\u{1F3FD} ou \u{1F91D}\u{1F3FE} est acceptable quand il a du sens.',
  'Parle positivement de l\'objectif du guide : aider à trouver un emploi, mieux se préparer, obtenir plus d\'opportunités, éviter les erreurs et augmenter ses chances. Tu peux et tu dois le dire clairement. En revanche, ne garantis jamais qu\'une personne précise obtiendra automatiquement un emploi à une date donnée, et n\'invente jamais le contenu du guide.',
  'Liens officiels : boutique https://savoir-utile.mychariow.shop ; guide https://savoir-utile.mychariow.shop/prd_s33t0e.',
].join('\n');

/**
 * Mots-cles par defaut declenchant une intention d'achat detectee dans un
 * commentaire public (section demande explicitement le mot-cle "GUIDE").
 * Detection deterministe (pas d'IA) : fiable, rapide, testable, et ne
 * depend d'aucun fournisseur externe pour cette etape critique.
 */
const DEFAULT_INTENT_KEYWORDS = ['guide', 'infos', 'information', 'prix', 'lien', 'interesse', 'intéressé'];

/**
 * Modele de reponse publique par defaut lorsque le message prive n'est pas
 * possible (aucun connecteur reel, ou plateforme n'autorisant pas le DM).
 * Deterministe par defaut (fiabilite > sophistication IA) ; peut etre
 * surchargee via input.modele_reponse_publique.
 */
const DEFAULT_PUBLIC_REPLY_TEMPLATE =
  "Merci. Ecris-nous directement en message prive et nous t'enverrons toutes les informations sur le guide.";

// Taxonomie du guide commercial demandée par le brief. Elle décrit les axes à
// documenter, sans inventer le contenu réel du guide Savoir Utile.
const COMMERCIAL_PROFILE_FOCUS = Object.freeze([
  'profil produit et proposition de valeur',
  'CV et candidatures',
  'ciblage des entreprises et organisation de la recherche',
  'WhatsApp, LinkedIn et réseau professionnel',
  'préparation aux entretiens et aux tests',
  'pièges à éviter et objections fréquentes',
]);

const FOLLOWUP_DELAYS_DAYS = Object.freeze([1, 3, 7, 14]);
const PRODUCT_FACTS = Object.freeze({
  name: config.brand.productName,
  pages: 187,
  product_url: config.brand.productUrl,
  shop_url: config.brand.shopUrl,
  documented_benefits: Object.freeze([
    'structurer sa recherche d’emploi',
    'mieux valoriser son profil et ses candidatures',
    'cibler les opportunités et organiser ses démarches',
    'préparer les échanges, entretiens et tests',
  ]),
});

function detectPurchaseIntent(commentaire, motsCles) {
  const keywords = Array.isArray(motsCles) && motsCles.length ? motsCles : DEFAULT_INTENT_KEYWORDS;
  const normalized = String(commentaire || '').toLowerCase();
  const trouves = keywords.filter((k) => normalized.includes(String(k).toLowerCase()));
  return { detecte: trouves.length > 0, mots_cles_trouves: trouves };
}

async function analyzeIntent(input) {
  const prompt = [
    `Message du prospect : "${input.message || ''}"`,
    `Faits produit vérifiés : ${JSON.stringify(PRODUCT_FACTS)}`,
    'Ne promet jamais un emploi, un salaire ou un résultat garanti. N’invente jamais les chapitres du PDF.',
    'Format JSON attendu : { "intention": "information|prix|hesitation|pret_a_acheter|autre", "information_demandee": "...", "objection_probable": "...", "proximite_achat": "faible|moyenne|forte" }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.4 });
  return { type: 'commercial.analyze_intent', provider: result.provider, model: result.model, output: result.parsed };
}

async function prepareResponse(input) {
  const prompt = [
    `Message du prospect : "${input.message || ''}"`,
    `Historique connu de ce contact (si fourni) : ${input.historique || 'aucun historique disponible'}`,
    `Faits produit vérifiés à utiliser seulement s’ils sont pertinents : ${JSON.stringify(PRODUCT_FACTS)}`,
    'Redige une reponse complete, humaine et persuasive (pas de robotique, pas de reponse trop courte).',
    'N’invente aucun détail du PDF au-delà de ses 187 pages et des bénéfices documentés. Mets en avant sa valeur réelle (mieux chercher, mieux se présenter, éviter des erreurs, augmenter ses chances de trouver un emploi) sans jamais garantir un emploi précis à une date précise.',
    "Inclus naturellement le lien du produit uniquement si le contexte du message le justifie reellement.",
    'Format JSON attendu : { "reponse": "...", "inclut_lien": true|false, "ton": "..." }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.75 });
  return { type: 'commercial.prepare_response', provider: result.provider, model: result.model, output: result.parsed };
}

function normalizeFollowupDays(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 3;
  return FOLLOWUP_DELAYS_DAYS.reduce((best, candidate) => Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best, 3);
}

function buildFollowupMessage(input = {}) {
  const name = String(input.nom || input.prenom || '').trim();
  const subject = String(input.sujet || input.contexte || 'ta demande').trim();
  const intro = name ? `Bonjour ${name},` : 'Bonjour,';
  return `${intro} je reviens vers toi au sujet de ${subject}. Si tu souhaites toujours recevoir les informations, réponds simplement à ce message et je te préciserai la prochaine étape. Cette relance est préparée, elle n’est pas envoyée automatiquement.`;
}

async function prepareFollowup(input = {}) {
  const plateforme = String(input.plateforme || 'inconnue').toLowerCase();
  const contactKey = String(input.contact_key || input.contact_id || input.identifiant || '').trim() || null;
  const output = {
    statut: 'RELANCE_PREPAREE',
    contact_key: contactKey,
    plateforme,
    delai_jours: normalizeFollowupDays(input.delai_jours),
    message: String(input.message || '').trim() || buildFollowupMessage(input),
    profil_commercial: {
      axes_a_documenter: COMMERCIAL_PROFILE_FOCUS,
      contenu_source_fourni: Boolean(input.contenu_source_fourni),
      note: 'Les faits produit, prix, lien et conditions doivent venir d’une référence réelle enregistrée dans la base de connaissances.',
    },
    envoi_effectue: false,
    approbation_requise_pour_envoi: true,
    raison: 'Préparation uniquement : aucune permission d’envoi n’est utilisée par cette action.',
  };
  const saved = await operationalState.saveCommercialFollowup(output, { contactKey, plateforme });
  return {
    type: 'commercial.prepare_followup',
    provider: null,
    model: null,
    output: { ...output, persistence_id: saved.id },
  };
}

async function analyzeConversion(input) {
  const prompt = [
    `Donnees fournies sur les conversions recentes : ${JSON.stringify(input.donnees || {})}`,
    'Analyse ces donnees et identifie des tendances, points de blocage, et recommandations concretes.',
    'Format JSON attendu : { "tendances": [...], "points_de_blocage": [...], "recommandations": [...] }',
  ].join('\n');
  const result = await askAI({ system: SYSTEM, prompt, expectJson: true, temperature: 0.5 });
  return { type: 'commercial.analyze_conversion', provider: result.provider, model: result.model, output: result.parsed };
}

/**
 * COMMENTAIRE -> detection du mot-cle/intention -> identification de la
 * plateforme -> verification de la possibilite reelle de contacter
 * l'utilisateur -> preparation de l'action adaptee.
 *
    * Reutilise systemActions.activeConnectorFor() comme

 * SEULE source de verite sur la capacite reelle d'un canal a envoyer un
 * message prive : evite de dupliquer une seconde registry de connecteurs.
 * Tant qu'aucun connecteur n'est enregistre dans systemActions.js, TOUTES
 * les plateformes sont honnetement considerees comme "DM impossible" - ce
 * module ne suppose jamais qu'une API de messagerie privee existe.
 *
 * Ne prepare/n'envoie JAMAIS reellement un message : cette fonction est une
 * etape d'ANALYSE + PREPARATION (AUTO). L'envoi reel reste une tache
 * separate (system.send_message / system.publish_post, APPROVAL_REQUIRED),
 * creee par l'appelant (voir netlify/functions/webhook-comment.js) a partir
 * du texte prepare ici - jamais executee directement par cette fonction.
 */
async function detectCommentIntent(input) {
  const commentaire = input.commentaire || '';
  const plateforme = input.plateforme || 'inconnue';
  const intent = detectPurchaseIntent(commentaire, input.mots_cles);

  if (!intent.detecte) {
    return {
      type: 'commercial.detect_comment_intent',
      output: {
        intention_achat_detectee: false,
        mots_cles_trouves: [],
        plateforme,
        statut: 'AUCUNE_INTENTION_DETECTEE',
        action_recommandee: 'aucune_action',
      },
    };
  }

  const connector = await systemActions.activeConnectorFor(plateforme, 'dm');
  const dmPossible = Boolean(connector);

  const base = {
    intention_achat_detectee: true,
    mots_cles_trouves: intent.mots_cles_trouves,
    plateforme,
    dm_possible: dmPossible,
    raison_dm:
      dmPossible
        ? `Un connecteur est configure pour le canal "${plateforme}".`
        : `Aucun connecteur API reel n'est configure pour le canal "${plateforme}" (ou la plateforme n'autorise pas le message prive automatise). Ne jamais pretendre qu'un DM a ete envoye dans ce cas.`,
    guide: {
      nom: PRODUCT_FACTS.name,
      pages: PRODUCT_FACTS.pages,
      lien: PRODUCT_FACTS.product_url,
      pertinence: 'Le guide peut être proposé si le prospect demande une méthode structurée pour sa recherche d’emploi.',
      benefices_documentes: PRODUCT_FACTS.documented_benefits,
    },
  };

  if (dmPossible) {
    // Le message prive peut etre PREPARE (AUTO). L'envoi reel reste une
    // action distincte soumise a approbation (voir SEND_MESSAGE).
    const prepared = await prepareResponse({
      message: `Un prospect a commente "${commentaire}" sur ${plateforme} avec une intention d'achat detectee (mots-cles : ${intent.mots_cles_trouves.join(', ')}). Prepare le message prive a lui envoyer.`,
      historique: input.historique,
    });
    return {
      type: 'commercial.detect_comment_intent',
      provider: prepared.provider,
      model: prepared.model,
      output: {
        ...base,
        statut: 'ACTION_PREPAREE_MESSAGE_PRIVE',
        action_recommandee: 'dm_prepare',
        message_prive_prepare: prepared.output,
      },
    };
  }

  // DM impossible : preparer uniquement une reponse PUBLIQUE demandant a la
  // personne d'ecrire en prive (jamais de DM simule).
  const reponsePublique = input.modele_reponse_publique || DEFAULT_PUBLIC_REPLY_TEMPLATE;
  return {
    type: 'commercial.detect_comment_intent',
    output: {
      ...base,
      statut: 'ACTION_PREPAREE_REPONSE_PUBLIQUE',
      action_recommandee: 'reponse_publique_prepare',
      reponse_publique_preparee: reponsePublique,
    },
  };
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'analyze_intent':
      return analyzeIntent(input || {});
    case 'prepare_response':
      return prepareResponse(input || {});
    case 'analyze_conversion':
      return analyzeConversion(input || {});
    case 'detect_comment_intent':
      return detectCommentIntent(input || {});
    case 'prepare_followup':
      return prepareFollowup(input || {});
    default:
      throw new Error(`AGENT_COMMERCIAL: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = {
  handle,
  analyzeIntent,
  prepareResponse,
  analyzeConversion,
  detectCommentIntent,
  detectPurchaseIntent,
  DEFAULT_INTENT_KEYWORDS,
  DEFAULT_PUBLIC_REPLY_TEMPLATE,
  COMMERCIAL_PROFILE_FOCUS,
  FOLLOWUP_DELAYS_DAYS,
  prepareFollowup,
  PRODUCT_FACTS,
};
