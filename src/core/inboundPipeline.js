'use strict';

const taskEngine = require('./taskEngine');
const memory = require('./memory');
const { logger } = require('./logger');
const { safeErrorMessage } = require('./metaSecurity');

/**
 * PIPELINE DES EVENEMENTS ENTRANTS META (Instagram / Facebook).
 *
 * Avant ce module, netlify/functions/meta-webhook.js verifiait la signature,
 * dedoublait et enregistrait l'evenement... puis s'arretait : aucun DM ou
 * commentaire entrant n'atteignait jamais le moteur operationnel. Ce module
 * realise la chaine complete, uniquement a partir des briques existantes :
 *
 *   evenement Meta -> parsing -> idempotence par evenement -> contact
 *   (agent client.upsert_contact) -> memoire (historique) -> analyse
 *   commerciale (agent commercial) -> preparation de reponse -> tache
 *   d'action (system.send_message / system.reply_comment) -> Copilot
 *   (waiting_approval, visible dans le dashboard via /approval-list) ou
 *   execution auto en mode Conquistador ou blocage en mode Silencio.
 *
 * Aucune action externe n'est executee ici directement : tout passe par
 * taskEngine, qui applique kill switch, modes et approbations. Aucun faux
 * succes : si aucun connecteur reel n'est actif, systemActions renvoie
 * honnetement NON_EXECUTE_AUCUNE_CONNEXION.
 */

function truncate(text, max = 4000) {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max) : value;
}

function normalizePlatform(value, fallback) {
  const key = String(value || '').trim().toLowerCase();
  return ['instagram', 'facebook'].includes(key) ? key : fallback;
}

/**
 * Transforme le payload brut du webhook Meta en evenements entrants
 * normalises. Ignore les echos (messages envoyes par le compte pro) et les
 * evenements sans contenu exploitable.
 */
function parseInboundEvents(body, connection) {
  const object = String(body && body.object || '').toLowerCase();
  const instagramId = connection && connection.instagram && connection.instagram.id
    ? String(connection.instagram.id)
    : null;
  const pageIds = new Set(
    connection && Array.isArray(connection.pages)
      ? connection.pages.map((p) => String(p && p.id || '')).filter(Boolean)
      : [],
  );
  const events = [];

  for (const entry of Array.isArray(body && body.entry) ? body.entry : []) {
    const entryId = String(entry && entry.id || '');

    // --- Messages directs (Messenger API pour Instagram / Facebook) -------
    for (const item of Array.isArray(entry && entry.messaging) ? entry.messaging : []) {
      const senderId = item && item.sender && item.sender.id ? String(item.sender.id) : null;
      const recipientId = item && item.recipient && item.recipient.id ? String(item.recipient.id) : null;
      const message = item && item.message ? item.message : null;
      if (!senderId || !message || message.is_echo === true) continue;
      if (recipientId && senderId === recipientId) continue; // echo defensif
      const text = truncate(message.text || '', 4000);
      if (!text && !Array.isArray(message.attachments)) continue;
      let platform = object === 'instagram' ? 'instagram' : object === 'page' ? 'facebook' : null;
      if (!platform) platform = instagramId && entryId === instagramId ? 'instagram' : 'facebook';
      if (platform === 'facebook' && instagramId && (entryId === instagramId || recipientId === instagramId)) {
        platform = 'instagram';
      }
      const key = message.mid || `${senderId}:${item.timestamp || ''}`;
      events.push({
        type: 'dm',
        platform,
        eventKey: `${platform}.dm.${key}`,
        providerMessageId: message.mid || null,
        actorId: senderId,
        actorName: null,
        text: text || '[piece jointe sans texte]',
        raw: item,
      });
    }

    // --- Commentaires (changes: field=comments / live_comments etc.) ------
    for (const change of Array.isArray(entry && entry.changes) ? entry.changes : []) {
      const field = String(change && change.field || '');
      if (!field.includes('comment')) continue;
      const value = change && change.value ? change.value : {};
      const commentId = value.comment_id || value.id || null;
      const text = truncate(value.text || value.message || '', 2000);
      if (!commentId || !text) continue;
      const from = value.from && typeof value.from === 'object' ? value.from : {};
      const actorId = from.id ? String(from.id) : (value.sender_id ? String(value.sender_id) : null);
      if (actorId && (actorId === instagramId || pageIds.has(actorId) || actorId === entryId)) continue;
      let platform = object === 'instagram' ? 'instagram' : object === 'page' ? 'facebook' : null;
      if (!platform) platform = value.media || instagramId === entryId ? 'instagram' : 'facebook';
      events.push({
        type: 'comment',
        platform,
        eventKey: `${platform}.comment.${commentId}`,
        providerCommentId: commentId,
        mediaId: value.media && value.media.id ? String(value.media.id) : null,
        postId: value.post_id ? String(value.post_id) : null,
        actorId: actorId || 'inconnu',
        actorName: from.name || from.username || null,
        text,
        raw: value,
      });
    }
  }
  return events;
}

function extractHistory(contactResult) {
  const output = contactResult && contactResult.data && contactResult.data.result
    ? contactResult.data.result.output
    : null;
  const data = output && output.data ? output.data : null;
  return data && Array.isArray(data.historique) ? data.historique : [];
}

function extractPreparedText(result) {
  const output = result && result.data && result.data.result ? result.data.result.output : null;
  if (!output) return null;
  if (output.data && typeof output.data.reponse === 'string' && output.data.reponse.trim()) {
    return output.data.reponse.trim();
  }
  if (typeof output.raw === 'string' && output.raw.trim()) return output.raw.trim();
  return null;
}

async function runAgentTask(type, input, declencheur) {
  const created = await taskEngine.createTask({ type, input, declencheur });
  return taskEngine.runTask(created.id);
}

/** DM entrant : contact -> memoire -> analyse -> preparation -> proposition/action. */
async function processInboundDm(evt) {
  const contactResult = await runAgentTask('client.upsert_contact', {
    identifiant: `${evt.platform}:${evt.actorId}`,
    nom: evt.actorName,
    canal: evt.platform,
    message: evt.text,
  }, 'webhook');
  const historique = extractHistory(contactResult);

  const intentResult = await runAgentTask('commercial.analyze_intent', {
    message: evt.text,
    plateforme: evt.platform,
    historique,
  }, 'webhook');

  const responseResult = await runAgentTask('commercial.prepare_response', {
    message: evt.text,
    plateforme: evt.platform,
    historique,
  }, 'webhook');

  const prepared = extractPreparedText(responseResult);
  let sendTask = null;
  if (prepared) {
    // SEND_MESSAGE : APPROVAL_REQUIRED -> proposition Copilot visible dans le
    // dashboard ; executee apres approbation, ou directement en mode
    // Conquistador, ou bloquee en Silencio. Jamais marquee envoyee sans
    // reponse reelle du connecteur (voir systemActions.sendMessage).
    sendTask = await runAgentTask('system.send_message', {
      canal: evt.platform,
      destinataire: evt.actorId,
      message: prepared,
      provider_event_key: evt.eventKey,
    }, 'webhook');
  }

  return {
    contact_task_id: contactResult.id,
    intent_task_id: intentResult.id,
    response_task_id: responseResult.id,
    send_task_id: sendTask ? sendTask.id : null,
    send_status: sendTask ? sendTask.data.status : 'aucune_reponse_preparee',
  };
}

/** Commentaire entrant : contact -> detection intention -> DM ou reponse au commentaire. */
async function processInboundComment(evt) {
  const contactResult = await runAgentTask('client.upsert_contact', {
    identifiant: `${evt.platform}:${evt.actorId}`,
    nom: evt.actorName,
    canal: evt.platform,
    message: `[commentaire] ${evt.text}`,
  }, 'webhook');
  const historique = extractHistory(contactResult);

  const detectionResult = await runAgentTask('commercial.detect_comment_intent', {
    commentaire: evt.text,
    plateforme: evt.platform,
    historique,
  }, 'webhook');
  const detection = detectionResult && detectionResult.data && detectionResult.data.result
    ? detectionResult.data.result.output
    : null;

  let actionTask = null;
  let actionType = null;
  if (detection && detection.intention_achat_detectee === true) {
    if (detection.action_recommandee === 'dm_prepare') {
      const prepared = detection.message_prive_prepare
        && detection.message_prive_prepare.data
        && typeof detection.message_prive_prepare.data.reponse === 'string'
        ? detection.message_prive_prepare.data.reponse
        : (detection.message_prive_prepare && detection.message_prive_prepare.raw) || null;
      if (prepared) {
        actionType = 'system.send_message';
        actionTask = await runAgentTask('system.send_message', {
          canal: evt.platform,
          destinataire: evt.actorId,
          message: prepared,
          provider_event_key: evt.eventKey,
        }, 'webhook');
      }
    } else if (detection.action_recommandee === 'reponse_publique_prepare' && detection.reponse_publique_preparee) {
      // Reponse a un commentaire : utilise le VRAI mecanisme de reponse aux
      // commentaires (POST /{comment-id}/replies), jamais une publication.
      actionType = 'system.reply_comment';
      actionTask = await runAgentTask('system.reply_comment', {
        plateforme: evt.platform,
        comment_id: evt.providerCommentId,
        message: detection.reponse_publique_preparee,
        provider_event_key: evt.eventKey,
      }, 'webhook');
    }
  }

  return {
    contact_task_id: contactResult.id,
    detection_task_id: detectionResult.id,
    intention_achat_detectee: Boolean(detection && detection.intention_achat_detectee),
    action_type: actionType,
    action_task_id: actionTask ? actionTask.id : null,
    action_status: actionTask ? actionTask.data.status : 'aucune_action',
  };
}

async function processInboundEvent(evt) {
  const idempotency = require('./idempotency');
  // AUDIT (bug critique) : l'ancien code appelait checkAndMark() (claim +
  // confirmation immediate) AVANT tout traitement. Dans un payload
  // contenant plusieurs evenements (A + B), si A reussissait et B echouait,
  // B restait marque comme definitivement traite : un retry ne le
  // retraitait jamais, sans erreur visible. Desormais : CLAIM avant
  // traitement, CONFIRM uniquement apres succes reel, RELEASE en cas
  // d'echec pour permettre un nouvel essai immediat (voir
  // src/core/memory.js et src/core/idempotency.js).
  const claimResult = await idempotency.claim('meta.inbound', evt.eventKey);
  if (claimResult.doublon) {
    return {
      type: evt.type,
      plateforme: evt.platform,
      traite: false,
      raison: 'doublon',
      statut_idempotence: claimResult.statut,
      premiere_fois: claimResult.premiere_fois || null,
    };
  }

  await memory.recordEvent(`meta.inbound.${evt.type}.received`, {
    plateforme: evt.platform,
    event_key: evt.eventKey,
    acteur: evt.actorId,
    longueur_message: evt.text.length,
  });

  try {
    const detail = evt.type === 'dm' ? await processInboundDm(evt) : await processInboundComment(evt);
    await memory.recordEvent(`meta.inbound.${evt.type}.processed`, {
      plateforme: evt.platform,
      event_key: evt.eventKey,
      ...detail,
    });
    await idempotency.confirm('meta.inbound', evt.eventKey);
    return { type: evt.type, plateforme: evt.platform, traite: true, ...detail };
  } catch (err) {
    logger.error('inboundPipeline: echec de traitement d un evenement entrant', {
      plateforme: evt.platform, type: evt.type, error: err.message,
    });
    await memory.recordError({ source: 'meta.inbound', plateforme: evt.platform, type: evt.type }, err);
    try {
      // Libere immediatement l'evenement plutot que de laisser expirer la
      // fenetre EN_COURS : le prochain retry Meta le retraite sans attendre.
      await idempotency.release('meta.inbound', evt.eventKey);
    } catch (releaseErr) {
      logger.error('inboundPipeline: echec de liberation du verrou idempotence', {
        plateforme: evt.platform, type: evt.type, error: releaseErr.message,
      });
    }
    return { type: evt.type, plateforme: evt.platform, traite: false, raison: safeErrorMessage(err) };
  }
}

/**
 * Point d'entree appele par le webhook Meta apres verification de signature
 * et deduplication du payload. Ne leve jamais d'erreur : le webhook doit
 * toujours repondre 200 une fois l'evenement accepte, les echecs internes
 * sont journalises (ERRORS) et renvoyes dans le detail de traitement.
 */
async function processMetaWebhookEvent(body, eventKey) {
  let connection = null;
  try {
    const metaStore = require('./metaStore');
    const row = await metaStore.getActiveConnection();
    connection = row && row.data ? row.data : null;
  } catch (err) {
    connection = null;
  }
  const events = parseInboundEvents(body, connection);
  const results = [];
  for (const evt of events) {
    // Sequentiel volontairement : chaque evenement cree ses taches dans
    // l'ordre et les doublons restent strictement idempotents.
    results.push(await processInboundEvent(evt));
  }
  return { event_key: eventKey || null, total: events.length, results };
}

module.exports = { processMetaWebhookEvent, processInboundEvent, parseInboundEvents };
