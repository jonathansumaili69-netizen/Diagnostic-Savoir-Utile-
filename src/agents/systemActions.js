'use strict';

const socialConnectors = require('../core/socialConnectors');
const videoQuality = require('./videoQuality');
const operationalState = require('../core/operationalState');

/**
 * Actions externes. Le registre Meta est consulte dans le backend et ne
 * renvoie un client actif qu’après chargement d’une connexion vérifiée.
 * Sans connexion, aucune action n’est présentée comme exécutée.
 */
const SYSTEM_CONNECTORS = {};

function connectorFor(channel) {
  const social = socialConnectors.clientFor(channel);
  if (social) return social;
  return SYSTEM_CONNECTORS[channel] || null;
}

async function activeConnectorFor(channel, requiredCapability) {
  const social = await socialConnectors.activeClientFor(channel, requiredCapability);
  if (social) return social;
  return SYSTEM_CONNECTORS[channel] || null;
}

/**
 * AUDIT (bug [object Object]) : certains connecteurs (YouTube) renvoient un
 * champ "status" qui est un OBJET (ex: { uploadStatus, privacyStatus }), pas
 * une chaîne. L'ancien code faisait
 *   `publishResult.statut || publishResult.status`
 * et affectait directement ce résultat au statut interne : si c'était un
 * objet, `statut` devenait cet objet, et tout affichage/log/serialisation en
 * chaîne produisait "[object Object]". Cette fonction normalise TOUJOURS le
 * statut interne vers une chaîne connue, sans jamais réutiliser un objet brut
 * comme statut.
 *
 * uploadStatus YouTube possibles : uploaded, processed, rejected, failed,
 * deleted (cf. YouTube Data API v3, ressource Video.status.uploadStatus).
 * - uploaded / processed  -> le fichier est bien reçu par YouTube (PUBLIE
 *   au sens "action externe confirmée" ; le traitement définitif de la
 *   vidéo par YouTube reste asynchrone et n'est pas garanti par ce seul
 *   champ, mais l'upload a réussi).
 * - rejected / failed / deleted -> échec, ne doit jamais devenir PUBLIE.
 * - absent / valeur inconnue -> on ne peut pas confirmer : EN_TRAITEMENT,
 *   jamais PUBLIE par défaut.
 */
const YOUTUBE_UPLOAD_STATUS_MAP = {
  uploaded: 'PUBLIE',
  processed: 'PUBLIE',
  rejected: 'ECHEC',
  failed: 'ECHEC',
  deleted: 'ECHEC',
};

function deriveStatut(publishResult, plateforme) {
  const plateformeNorm = String(plateforme || '').toLowerCase();
  if (!publishResult) {
    return plateformeNorm === 'tiktok' ? 'EN_TRAITEMENT' : 'PUBLIE';
  }
  // 1) Un connecteur qui fournit déjà un statut sous forme de chaîne
  //    (TikTok, retour normalisé) est prioritaire et n'est jamais réinterprété.
  if (typeof publishResult.statut === 'string' && publishResult.statut) {
    return publishResult.statut;
  }
  const rawStatus = publishResult.status;
  // 2) "status" est un objet (cas YouTube) : ne JAMAIS l'utiliser tel quel.
  if (rawStatus && typeof rawStatus === 'object' && !Array.isArray(rawStatus)) {
    const uploadStatus = String(rawStatus.uploadStatus || '').toLowerCase();
    if (uploadStatus && YOUTUBE_UPLOAD_STATUS_MAP[uploadStatus]) {
      return YOUTUBE_UPLOAD_STATUS_MAP[uploadStatus];
    }
    // uploadStatus absent/inconnu (ex: seul privacyStatus renvoyé) : le
    // téléversement a été accepté par l'API mais la confirmation de
    // traitement n'est pas certaine -> statut prudent, jamais PUBLIE.
    return 'EN_TRAITEMENT';
  }
  // 3) "status" est déjà une chaîne exploitable.
  if (typeof rawStatus === 'string' && rawStatus) {
    return rawStatus;
  }
  // 4) Rien d'exploitable : comportement historique par plateforme.
  return plateformeNorm === 'tiktok' ? 'EN_TRAITEMENT' : 'PUBLIE';
}

async function sendMessage(input) {
  const connector = await activeConnectorFor(input.canal, 'dm');
  if (!connector) {
    return {
      type: 'system.send_message',
      output: {
        statut: 'NON_EXECUTE_AUCUNE_CONNEXION',
        canal: input.canal || 'inconnu',
        message_prepare: input.message || null,
        destinataire: input.destinataire || null,
        raison: `Aucune connexion API reelle n'est configuree pour le canal "${input.canal || 'inconnu'}". Le message a ete prepare mais pas envoye.`,
      },
    };
  }
  const sendResult = await connector.send(input);
  return { type: 'system.send_message', output: { statut: 'ENVOYE', ...sendResult } };
}

function requiresVideoReview(input = {}) {
  const nestedVideo = input.video && typeof input.video === 'object' ? input.video : {};
  const mediaType = String(input.media_type || input.mediaType || nestedVideo.media_type || '').toLowerCase();
  return Boolean(
    input.video_url || input.source_url || nestedVideo.video_url || nestedVideo.source_url || mediaType.includes('video'),
  );
}

/**
 * Reponse a un commentaire via le VRAI mecanisme prevu par la plateforme
 * (Meta : POST /{comment-id}/replies). N'est jamais transformee en
 * publication. Sans connecteur reel disposant de la capacite
 * 'reponse_commentaires', l'action est honnetement NON_EXECUTE.
 */
async function replyComment(input) {
  const connector = await activeConnectorFor(input.plateforme, 'reponse_commentaires');
  if (!connector || typeof connector.replyComment !== 'function') {
    return {
      type: 'system.reply_comment',
      output: {
        statut: 'NON_EXECUTE_AUCUNE_CONNEXION',
        plateforme: input.plateforme || 'inconnu',
        comment_id: input.comment_id || null,
        message_prepare: input.message || null,
        raison: `Aucune connexion API reelle avec la capacite "reponse_commentaires" n'est configuree pour la plateforme "${input.plateforme || 'inconnu'}". La reponse a ete preparee mais pas publiee.`,
      },
    };
  }
  const replyResult = await connector.replyComment(input);
  return { type: 'system.reply_comment', output: { statut: 'ENVOYE', ...replyResult } };
}

async function publishPost(input) {
  const connector = await activeConnectorFor(input.plateforme, 'publication');
  if (!connector) {
    return {
      type: 'system.publish_post',
      output: {
        statut: 'NON_EXECUTE_AUCUNE_CONNEXION',
        plateforme: input.plateforme || 'inconnu',
        contenu_prepare: input.contenu || null,
        raison: `Aucune connexion API reelle n'est configuree pour la plateforme "${input.plateforme || 'inconnu'}". Le post a ete prepare mais pas publie.`,
      },
    };
  }

  if (requiresVideoReview(input)) {
    const review = await videoQuality.review({
      video: input.video && typeof input.video === 'object' ? input.video : input,
      contentReview: input.contentReview || input.quality_review || null,
      use_ai: input.use_ai_quality !== false,
      use_media_ai: input.use_media_ai !== false,
    });
    const conforme = review.output && review.output.conforme === true;
    // AUDIT V7 -> V8 : review.output.conforme (booleen "pas de probleme
    // bloquant") etait la SEULE condition verifiee ici. Le score numerique
    // configurable (campaign.quality_min_score, 85/100 par defaut) n'etait
    // jamais compare a ce point - un appel direct a publishPost() (hors du
    // planificateur, qui lui verifiait deja le score en amont) pouvait donc
    // publier un contenu "conforme" mais sous le seuil de qualite choisi.
    // Verification de defense en profondeur ajoutee ici, jamais retiree du
    // planificateur qui reste la premiere ligne de decision.
    const settings = await operationalState.getSettings();
    const seuil = Number(settings.campaign?.quality_min_score) || 85;
    const score = review.output && Number.isFinite(Number(review.output.score_qualite)) ? Number(review.output.score_qualite) : null;
    const scoreOk = score !== null && score >= seuil;
    if (!conforme || !scoreOk) {
      return {
        type: 'system.publish_post',
        output: {
          statut: 'NON_EXECUTE_QUALITE_VIDEO',
          plateforme: input.plateforme || 'inconnu',
          raison: !conforme
            ? 'La revue vidéo obligatoire n’a pas validé les preuves fournies. Aucun appel externe de publication n’a été effectué.'
            : `Le score de qualité (${score}/100) est sous le seuil configuré (${seuil}/100). Aucun appel externe de publication n’a été effectué.`,
          score_qualite: score,
          seuil_configure: seuil,
          revue_video: review.output || null,
        },
      };
    }
  }

  const publishResult = await connector.publish(input);
  const statut = deriveStatut(publishResult, input.plateforme);
  return { type: 'system.publish_post', output: { ...publishResult, statut } };
}

async function updateExternalData(input) {
  const connector = connectorFor(input.systeme);
  if (!connector) {
    return {
      type: 'system.update_data',
      output: {
        statut: 'NON_EXECUTE_AUCUNE_CONNEXION',
        systeme: input.systeme || 'inconnu',
        raison: `Aucune connexion reelle n'est configuree pour le systeme "${input.systeme || 'inconnu'}".`,
      },
    };
  }
  const updateResult = await connector.update(input);
  return { type: 'system.update_data', output: { statut: 'MIS_A_JOUR', ...updateResult } };
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'send_message':
      return sendMessage(input || {});
    case 'reply_comment':
      return replyComment(input || {});
    case 'publish_post':
      return publishPost(input || {});
    case 'update_data':
      return updateExternalData(input || {});
    default:
      throw new Error(`SYSTEM_ACTIONS: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, sendMessage, replyComment, publishPost, updateExternalData, connectorFor, activeConnectorFor, requiresVideoReview, deriveStatut };
