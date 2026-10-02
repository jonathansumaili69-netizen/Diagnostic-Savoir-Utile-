'use strict';

const memory = require('../core/memory');

const NUMERIC_FIELDS = [
  'vues', 'commentaires', 'partages', 'abonnes', 'clics', 'prospects', 'ventes', 'conversions',
  // Ajouts additifs (cahier des charges section "statistiques completes") :
  // aucun champ existant n'est retire, ces noms s'ajoutent simplement a la liste.
  'likes', 'enregistrements', 'abonnes_gagnes', 'abonnes_perdus', 'visites_boutique', 'chiffre_affaires', 'achats',
];

async function record(input) {
  const entry = {};
  for (const field of NUMERIC_FIELDS) {
    if (input[field] !== undefined) {
      const n = Number(input[field]);
      entry[field] = Number.isFinite(n) ? n : 0;
    }
  }
  entry.source = input.source || 'manuel';
  // Dimensions optionnelles pour "evolution par plateforme" / "classement des
  // contenus" (cahier des charges section statistiques). Additives : absentes,
  // elles ne changent rien au comportement existant.
  if (input.plateforme || input.platform) entry.plateforme = String(input.plateforme || input.platform).toLowerCase();
  if (input.content_key || input.contenu_id) entry.content_key = String(input.content_key || input.contenu_id);
  // "date" reste au format YYYY-MM-DD pour le regroupement par jour (rapports),
  // tandis que "at" conserve l'horodatage precis pour les filtres temporels
  // fiables (comparer une date sans heure a un "since" precis sous-estimerait
  // systematiquement les entrees du jour meme).
  entry.date = input.date || new Date().toISOString().slice(0, 10);
  entry.at = new Date().toISOString();
  const saved = await memory.insert(memory.COLLECTIONS.METRICS, entry);
  return { type: 'stats.record', output: saved };
}

async function summary(input) {
  const since = input.since ? new Date(input.since) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const rows = await memory.list(memory.COLLECTIONS.METRICS, {
    filter: (data) => new Date(data.at || data.date) >= since,
  });
  const totals = NUMERIC_FIELDS.reduce((acc, field) => {
    acc[field] = rows.reduce((sum, row) => sum + (row.data[field] || 0), 0);
    return acc;
  }, {});
  const parSource = {};
  for (const row of rows) {
    const source = String(row.data.source || 'manuel');
    if (!parSource[source]) {
      parSource[source] = { entrees: 0 };
      for (const field of NUMERIC_FIELDS) parSource[source][field] = 0;
    }
    parSource[source].entrees += 1;
    for (const field of NUMERIC_FIELDS) {
      parSource[source][field] += Number(row.data[field] || 0);
    }
  }
  const parPlateforme = {};
  for (const row of rows) {
    if (!row.data.plateforme) continue;
    const plateforme = row.data.plateforme;
    if (!parPlateforme[plateforme]) {
      parPlateforme[plateforme] = { entrees: 0 };
      for (const field of NUMERIC_FIELDS) parPlateforme[plateforme][field] = 0;
    }
    parPlateforme[plateforme].entrees += 1;
    for (const field of NUMERIC_FIELDS) {
      parPlateforme[plateforme][field] += Number(row.data[field] || 0);
    }
  }
  return {
    type: 'stats.summary',
    output: {
      periode_depuis: since.toISOString().slice(0, 10),
      nombre_entrees: rows.length,
      totaux: totals,
      par_source: parSource,
      par_plateforme: parPlateforme,
    },
  };
}

const GRANULARITY_TO_SLICE_LENGTH = { jour: 10, semaine: 10, mois: 7 };

function bucketKey(dateStr, granularite) {
  const date = new Date(dateStr);
  if (granularite === 'mois') return dateStr.slice(0, 7); // YYYY-MM
  if (granularite === 'semaine') {
    // Semaine ISO approximative (suffisante pour un regroupement de dashboard,
    // pas pour une conformite comptable) : annee + numero de semaine calcule
    // a partir du 1er janvier.
    const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const days = Math.floor((date - start) / 86400000);
    const week = Math.ceil((days + start.getUTCDay() + 1) / 7);
    return `${date.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
  }
  return dateStr.slice(0, GRANULARITY_TO_SLICE_LENGTH.jour); // YYYY-MM-DD
}

/**
 * Série temporelle quotidienne/hebdomadaire/mensuelle prête pour un
 * graphique (labels + valeurs par champ), construite uniquement à partir des
 * métriques réellement enregistrées - aucune valeur interpolée ou inventée
 * pour une période sans données (le bucket est simplement absent).
 */
async function timeseries(input = {}) {
  const granularite = ['jour', 'semaine', 'mois'].includes(input.granularite) ? input.granularite : 'jour';
  const since = input.since ? new Date(input.since) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const rows = await memory.list(memory.COLLECTIONS.METRICS, {
    filter: (data) => new Date(data.at || data.date) >= since,
  });
  const buckets = {};
  for (const row of rows) {
    const key = bucketKey(row.data.date || row.data.at.slice(0, 10), granularite);
    if (!buckets[key]) {
      buckets[key] = {};
      for (const field of NUMERIC_FIELDS) buckets[key][field] = 0;
    }
    for (const field of NUMERIC_FIELDS) buckets[key][field] += Number(row.data[field] || 0);
  }
  const labels = Object.keys(buckets).sort();
  const series = {};
  for (const field of NUMERIC_FIELDS) {
    series[field] = labels.map((label) => buckets[label][field]);
  }
  return {
    type: 'stats.timeseries',
    output: { granularite, labels, series, nombre_entrees: rows.length },
  };
}

/**
 * Classement des contenus (par content_key) sur une plateforme donnée,
 * trie par un score d'engagement simple = vues + likes + commentaires +
 * partages + enregistrements. Fournit aussi un taux d'engagement descriptif
 * (engagement / vues) pour aider a comprendre pourquoi un contenu performe,
 * sans jamais inventer de cause qui ne soit pas directement lisible dans les
 * chiffres enregistres.
 */
async function ranking(input = {}) {
  const since = input.since ? new Date(input.since) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const top = Math.max(1, Math.min(50, Number(input.top) || 10));
  const rows = await memory.list(memory.COLLECTIONS.METRICS, {
    filter: (data) => new Date(data.at || data.date) >= since && Boolean(data.content_key) && (!input.plateforme || data.plateforme === input.plateforme),
  });
  const parContenu = {};
  for (const row of rows) {
    const key = row.data.content_key;
    if (!parContenu[key]) {
      parContenu[key] = { content_key: key, plateforme: row.data.plateforme || null, entrees: 0 };
      for (const field of NUMERIC_FIELDS) parContenu[key][field] = 0;
    }
    parContenu[key].entrees += 1;
    for (const field of NUMERIC_FIELDS) parContenu[key][field] += Number(row.data[field] || 0);
  }
  const classement = Object.values(parContenu).map((c) => {
    const engagement = (c.likes || 0) + (c.commentaires || 0) + (c.partages || 0) + (c.enregistrements || 0);
    return {
      ...c,
      score_engagement: engagement,
      taux_engagement: c.vues > 0 ? Number((engagement / c.vues).toFixed(4)) : null,
    };
  }).sort((a, b) => b.score_engagement - a.score_engagement).slice(0, top);
  const moyenneTop = classement.length
    ? classement.reduce((sum, c) => sum + (c.taux_engagement || 0), 0) / classement.length
    : null;
  return {
    type: 'stats.ranking',
    output: {
      classement,
      lecture: classement.length
        ? `Les ${classement.length} contenus les mieux classés ont un taux d’engagement moyen de ${moyenneTop !== null ? (moyenneTop * 100).toFixed(1) : '0'}% (calculé uniquement à partir des chiffres enregistrés, sans interprétation supplémentaire).`
        : 'Aucun contenu avec content_key enregistré sur cette période.',
    },
  };
}

/**
 * Résumé commercial (prospects/relances/conversions) demandé par le cahier
 * des charges section "statistiques". Construit uniquement à partir de ce
 * qui est réellement enregistré par AGENT_CLIENTS (stade, demande_guide) et
 * AGENT_COMMERCIAL (relances préparées) - aucune catégorie n'est inventée :
 * un contact sans stade explicite reste 'nouveau', jamais reclassé en
 * 'chaud' par une supposition du système.
 */
async function commercialSummary() {
  const operationalState = require('../core/operationalState');
  const contacts = await memory.list(memory.COLLECTIONS.CONTACTS, { limit: 500 });
  const parStade = {};
  let demandeGuide = 0;
  for (const row of contacts) {
    const stade = row.data.stade || 'nouveau';
    parStade[stade] = (parStade[stade] || 0) + 1;
    if (row.data.demande_guide === true) demandeGuide += 1;
  }
  const followups = await operationalState.listCommercialFollowups({ limit: 100 });
  const now = Date.now();
  const relancesEnAttente = [];
  for (const row of followups) {
    const followup = row.data.followup || {};
    if (followup.envoi_effectue === true) continue;
    const preparedAt = new Date(row.created_at || row.data.at);
    const delaiMs = (Number(followup.delai_jours) || 0) * 24 * 3600 * 1000;
    const dateRelance = new Date(preparedAt.getTime() + delaiMs);
    relancesEnAttente.push({
      contact_key: row.data.contact_key,
      plateforme: row.data.plateforme,
      date_prevue: dateRelance.toISOString(),
      en_retard: dateRelance.getTime() < now,
    });
  }
  relancesEnAttente.sort((a, b) => new Date(a.date_prevue) - new Date(b.date_prevue));
  return {
    type: 'stats.commercial_summary',
    output: {
      nombre_total_prospects: contacts.length,
      par_stade: parStade,
      demandes_guide: demandeGuide,
      conversions: parStade.client || 0,
      relances_en_attente: relancesEnAttente.length,
      prochaines_relances: relancesEnAttente.slice(0, 20),
    },
  };
}

function startOfIsoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = dimanche
  const diff = (day === 0 ? -6 : 1) - day; // recule jusqu'au lundi
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function sumMetrics(start, end) {
  const rows = await memory.list(memory.COLLECTIONS.METRICS, {
    filter: (data) => {
      const at = new Date(data.at || data.date);
      return at >= start && at < end;
    },
  });
  const totals = {};
  for (const field of NUMERIC_FIELDS) totals[field] = 0;
  for (const row of rows) {
    for (const field of NUMERIC_FIELDS) totals[field] += Number(row.data[field] || 0);
  }
  return totals;
}

/**
 * Compare les résultats réels de la semaine à des objectifs configurés
 * (operationalState.getWeeklyObjectives). N'affiche JAMAIS un pourcentage
 * lorsque l'objectif vaut 0 (pourcentage: null) - un objectif à zéro
 * signifie "non défini", pas "atteint" (cahier des charges section
 * "pourcentage de progression des objectifs").
 */
async function weeklyProgress({ weekStart } = {}) {
  const operationalState = require('../core/operationalState');
  const start = weekStart ? startOfIsoWeek(new Date(weekStart)) : startOfIsoWeek(new Date());
  const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);

  const [objectifsState, totals, contacts, followups, executions] = await Promise.all([
    operationalState.getWeeklyObjectives(),
    sumMetrics(start, end),
    memory.list(memory.COLLECTIONS.CONTACTS, { limit: 1000 }),
    operationalState.listCommercialFollowups({ limit: 300 }),
    memory.list(memory.COLLECTIONS.EXECUTIONS, { limit: 1000 }),
  ]);

  const weekContacts = contacts.filter((r) => {
    const at = new Date(r.created_at || 0);
    return at >= start && at < end;
  });
  const nouveaux_prospects = weekContacts.length;
  // Approximation honnête : compte les contacts CRÉÉS cette semaine dont le
  // stade ACTUEL est 'client'. Un contact créé plus tôt et converti cette
  // semaine n'est pas compté ici - limite documentée plutôt que cachée.
  const prospects_convertis_semaine = weekContacts.filter((r) => r.data.stade === 'client').length;
  const conversations_commerciales = followups.filter((r) => {
    const at = new Date(r.created_at || r.data.at || 0);
    return at >= start && at < end;
  }).length;
  // "contenus réellement publiés" : compte les PUBLISH_POST reellement
  // confirmes (statut_sortie === 'PUBLIE') cette semaine - jamais un
  // contenu simplement "prepare", "en attente d'approbation", ou encore
  // EN_TRAITEMENT (soumission acceptee mais traitement asynchrone non
  // confirme, ex. TikTok) : EN_TRAITEMENT compte comme un succes pour le
  // quota (planner.js/scheduler-tick.js), pas comme une publication
  // confirmee pour l'affichage utilisateur.
  const contenus_publies = executions.filter((r) => {
    const at = new Date(r.created_at || 0);
    const d = r.data || {};
    return at >= start && at < end && d.action === 'PUBLISH_POST' && d.resultat === 'succes' && d.statut_sortie === 'PUBLIE';
  }).length;

  const actuels = {
    chiffre_affaires: totals.chiffre_affaires,
    ventes: totals.ventes,
    nouveaux_prospects,
    conversations_commerciales,
    prospects_convertis: prospects_convertis_semaine,
    vues: totals.vues,
    nouveaux_abonnes: totals.abonnes_gagnes,
    engagement: (totals.likes || 0) + (totals.commentaires || 0) + (totals.partages || 0) + (totals.enregistrements || 0),
    visites_boutique: totals.visites_boutique,
    clics: totals.clics,
    conversions: totals.conversions,
    contenus_publies,
  };

  const progres = {};
  for (const field of operationalState.OBJECTIVE_FIELDS) {
    const objectif = objectifsState.objectifs[field] || 0;
    const actuel = actuels[field] || 0;
    progres[field] = {
      actuel,
      objectif,
      pourcentage: objectif > 0 ? Math.round((actuel / objectif) * 1000) / 10 : null,
      reste: objectif > 0 ? Math.max(0, Math.round((objectif - actuel) * 100) / 100) : null,
    };
  }

  return {
    type: 'stats.weekly_progress',
    output: {
      periode_debut: start.toISOString(),
      periode_fin: end.toISOString(),
      progres,
      avertissement: 'prospects_convertis compte les contacts créés cette semaine et actuellement au stade "client" ; une conversion tardive d’un contact plus ancien n’est pas comptée dans ce chiffre.',
    },
  };
}

/**
 * Compare une période (semaine ou mois) en cours à la période précédente
 * équivalente (cahier des charges section "historique des statistiques").
 * Les données passées restent celles réellement enregistrées à l'époque
 * (jamais recalculées ou remplacées) : ce sont simplement deux sommes sur
 * deux fenêtres temporelles différentes de la même collection METRICS.
 */
/**
 * `offset` permet de reculer dans l'historique par pas d'une periode
 * complete (0 = semaine/mois en cours vs precedente, 1 = semaine/mois
 * precedente vs celle d'avant, etc.) - cahier des charges "Navigation et
 * utilisabilite" section 9 : consulter les periodes anterieures sans
 * ecraser les donnees (aucune ecriture ici, uniquement des lectures sur des
 * fenetres temporelles differentes de la meme collection METRICS).
 */
async function periodComparison({ granularite = 'semaine', offset = 0 } = {}) {
  const decalage = Number.isFinite(Number(offset)) && Number(offset) >= 0 ? Math.floor(Number(offset)) : 0;
  const now = new Date();
  let currentStart;
  let currentEnd;
  let previousStart;
  let previousEnd;
  if (granularite === 'mois') {
    currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - decalage, 1));
    currentEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - decalage + 1, 1));
    previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - decalage - 1, 1));
    previousEnd = currentStart;
  } else {
    const currentBase = startOfIsoWeek(now);
    currentStart = new Date(currentBase.getTime() - decalage * 7 * 24 * 3600 * 1000);
    currentEnd = new Date(currentStart.getTime() + 7 * 24 * 3600 * 1000);
    previousStart = new Date(currentStart.getTime() - 7 * 24 * 3600 * 1000);
    previousEnd = currentStart;
  }
  const [actuel, precedent] = await Promise.all([
    sumMetrics(currentStart, currentEnd),
    sumMetrics(previousStart, previousEnd),
  ]);
  const comparaison = {};
  for (const field of NUMERIC_FIELDS) {
    const delta = actuel[field] - precedent[field];
    comparaison[field] = {
      periode_actuelle: actuel[field],
      periode_precedente: precedent[field],
      variation: Math.round(delta * 100) / 100,
      variation_pourcentage: precedent[field] > 0 ? Math.round((delta / precedent[field]) * 1000) / 10 : null,
      comparaison_possible: precedent[field] > 0,
    };
  }
  return {
    type: 'stats.period_comparison',
    output: {
      granularite,
      offset: decalage,
      periode_actuelle: { debut: currentStart.toISOString(), fin: currentEnd.toISOString() },
      periode_precedente: { debut: previousStart.toISOString(), fin: previousEnd.toISOString() },
      comparaison,
    },
  };
}

async function handle(task) {
  const { subtype, input } = task;
  switch (subtype) {
    case 'record':
      return record(input || {});
    case 'summary':
      return summary(input || {});
    case 'timeseries':
      return timeseries(input || {});
    case 'ranking':
      return ranking(input || {});
    case 'commercial_summary':
      return commercialSummary();
    case 'weekly_progress':
      return weeklyProgress(input || {});
    case 'period_comparison':
      return periodComparison(input || {});
    default:
      throw new Error(`AGENT_STATISTIQUES: sous-type de tache inconnu "${subtype}"`);
  }
}

module.exports = { handle, record, summary, timeseries, ranking, commercialSummary, weeklyProgress, periodComparison, NUMERIC_FIELDS };
