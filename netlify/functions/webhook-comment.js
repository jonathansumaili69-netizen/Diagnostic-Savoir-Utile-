'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { parseJsonBody, requireString, optionalString, assertApiKey, assertWebhookSignature, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const taskEngine = require('../../src/core/taskEngine');
const memory = require('../../src/core/memory');
const idempotency = require('../../src/core/idempotency');

/**
 * Webhook : nouveau commentaire recu sur une plateforme (TikTok, Instagram,
 * YouTube, etc.), relaye par une source tierce (ex: outil de veille, n8n).
 * Suit le workflow :
 *
 * COMMENTAIRE -> detection du mot-cle/intention -> identification de la
 * plateforme -> verification de la possibilite reelle de contacter
 * l'utilisateur -> si DM reellement possible : tache SEND_MESSAGE
 * (APPROVAL_REQUIRED) avec le message prive prepare -> sinon : tache
 * REPLY_COMMENT (APPROVAL_REQUIRED) avec la reponse publique preparee,
 * attachee au comment_id d'origine.
 *
 * AUDIT : ce chemin creait auparavant une tache PUBLISH_POST pour la
 * reponse publique au lieu de REPLY_COMMENT, et ne collectait meme pas de
 * comment_id - une "reponse a un commentaire" aurait donc en realite publie
 * un nouveau post independant. Corrige : reponse publique = REPLY_COMMENT
 * avec comment_id obligatoire ; sans comment_id fourni par la source, on ne
 * cree JAMAIS de publication de repli, on renvoie une erreur explicite.
 *
 * Aucune branche de ce workflow ne pretend avoir reellement envoye ou
 * publie quoi que ce soit : voir src/agents/systemActions.js, qui reste la
 * seule source de verite sur les connecteurs reellement disponibles.
 */
exports.handler = wrapHandler(async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { erreur: 'Methode non autorisee, utiliser POST' });
  }
  assertApiKey(event.headers);
  assertWebhookSignature(event.headers, event.body);
  checkRateLimit(getRateLimitKey(event.headers));

  const body = parseJsonBody(event.body);
  const commentaire = requireString(body.commentaire, 'commentaire', { maxLength: 2000 });
  const plateforme = requireString(body.plateforme, 'plateforme');
  const identifiantAuteur = optionalString(body.identifiant_auteur, 'identifiant_auteur');
  const nomAuteur = optionalString(body.nom_auteur, 'nom_auteur');
  const commentId = optionalString(body.comment_id, 'comment_id') || optionalString(body.identifiant_commentaire, 'identifiant_commentaire');

  await memory.recordEvent('webhook.commentaire_recu', { plateforme, identifiantAuteur });

  // Idempotence (section 5) : evite de retraiter deux fois le meme
  // commentaire si la source webhook le renvoie plusieurs fois.
  const idemKey =
    optionalString(body.idempotency_key, 'idempotency_key') ||
    idempotency.deriveKey({ commentaire, plateforme, identifiantAuteur });
  const dedupCheck = await idempotency.checkAndMark('webhook.comment', idemKey);
  if (dedupCheck.doublon) {
    return json(200, { deja_traite: true, premiere_fois: dedupCheck.premiere_fois, detection: null, action: null });
  }

  const detectionTask = await taskEngine.createTask({
    type: 'commercial.detect_comment_intent',
    input: { commentaire, plateforme, historique: body.historique },
    declencheur: 'webhook',
  });
  const detectionResult = await taskEngine.runTask(detectionTask.id);
  const detection = detectionResult.data.result && detectionResult.data.result.output;

  if (!detection || !detection.intention_achat_detectee) {
    return json(200, { deja_traite: false, detection: detectionResult, action: null });
  }

  let actionTask = null;
  if (detection.action_recommandee === 'dm_prepare') {
    const message =
      (detection.message_prive_prepare && detection.message_prive_prepare.data && detection.message_prive_prepare.data.reponse) ||
      (detection.message_prive_prepare && detection.message_prive_prepare.raw) ||
      null;
    actionTask = await taskEngine.createTask({
      type: 'system.send_message',
      input: {
        canal: plateforme,
        destinataire: identifiantAuteur || nomAuteur || 'auteur_du_commentaire',
        message,
      },
      declencheur: 'webhook',
    });
  } else if (detection.action_recommandee === 'reponse_publique_prepare' && detection.reponse_publique_preparee) {
    if (!commentId) {
      // Sans identifiant reel du commentaire, impossible de repondre au bon
      // endroit : on ne substitue JAMAIS une publication a la place d'une
      // reponse (voir audit ci-dessus). On journalise et on renvoie une
      // erreur explicite plutot qu'un faux succes ou une action erronee.
      await memory.recordEvent('webhook.commentaire_reponse_impossible', {
        plateforme,
        raison: 'comment_id manquant dans le payload webhook',
      });
      return json(200, {
        deja_traite: false,
        detection: detectionResult,
        action: null,
        erreur: "comment_id manquant : impossible de creer une tache reply_comment sans l'identifiant reel du commentaire d'origine. Ajoutez le champ \"comment_id\" (ou \"identifiant_commentaire\") au payload envoye a ce webhook.",
      });
    }
    actionTask = await taskEngine.createTask({
      type: 'system.reply_comment',
      input: {
        plateforme,
        comment_id: commentId,
        message: detection.reponse_publique_preparee,
      },
      declencheur: 'webhook',
    });
  }

  if (actionTask) {
    actionTask = await taskEngine.runTask(actionTask.id);
  }

  return json(200, { deja_traite: false, detection: detectionResult, action: actionTask });
});
