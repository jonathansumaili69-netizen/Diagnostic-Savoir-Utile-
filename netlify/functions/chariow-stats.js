'use strict';

const { json, wrapHandler } = require('../../src/utils/http');
const { assertApiKey, checkRateLimit, getRateLimitKey } = require('../../src/core/validation');
const chariow = require('../../src/core/chariow');
const chariowStats = require('../../src/core/chariowStats');

/**
 * AUDIT V7 -> V8 : cet endpoint calculait auparavant
 * `sales.reduce((s,x)=>s+(Number(x.amount??x.total)||0),0)` sans jamais
 * indiquer que "amount" et "total" sont des noms de champs devinés (la page
 * de documentation Chariow détaillant le schéma exact d'une vente n'a pas pu
 * être récupérée - voir docs/CHARIOW_AUDIT.md). Utilise maintenant le
 * mappeur honnête (src/core/chariowStats.js) qui déclare explicitement son
 * niveau de confiance au lieu d'annoncer un chiffre d'affaires comme certain.
 */
exports.handler = wrapHandler(async (event) => {
  checkRateLimit(getRateLimitKey(event.headers));
  assertApiKey(event.headers);
  const st = chariow.status();
  if (!st.configure) {
    return json(200, { statut: 'NON_CONFIGURE', connecteur: st, ventes: [], total: 0 });
  }
  try {
    const { sales } = await chariow.listSales({ perPage: 50 });
    const resume = chariowStats.summarize(sales);
    return json(200, {
      statut: 'OK',
      connecteur: st,
      total_ventes: resume.nombre_ventes,
      ventes_considerees_reussies: resume.nombre_ventes_considerees_reussies,
      chiffre_affaires_par_devise: resume.chiffre_affaires_par_devise,
      mapping_confidence: resume.mapping_confidence,
      avertissement: resume.avertissement,
      ventes: resume.ventes.slice(0, 50),
    });
  } catch (err) {
    return json(200, { statut: 'ERREUR', connecteur: st, raison: err.message, ventes: [] });
  }
});
