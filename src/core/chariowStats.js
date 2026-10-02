'use strict';

/**
 * Interprétation "best effort" d'un objet vente Chariow brut.
 *
 * La documentation officielle consultée (voir docs/CHARIOW_AUDIT.md)
 * confirme l'existence de la ressource /sales et le nom d'évènement Pulse
 * "successful_sale", mais la page détaillant les champs exacts d'un objet
 * vente n'a pas pu être récupérée au moment de l'implémentation. Plutôt que
 * d'inventer un schéma, ce module essaie plusieurs noms de champs
 * plausibles et déclare explicitement sa confiance : `mapping_confidence`
 * vaut 'verifie' seulement si un champ candidat a été trouvé, jamais
 * 'suppose'. La donnée brute est toujours conservée intacte à côté du
 * mappage pour permettre une vérification et une correction manuelle une
 * fois un compte réel connecté.
 */

const AMOUNT_FIELDS = ['amount', 'total_amount', 'total', 'price', 'montant'];
const CURRENCY_FIELDS = ['currency', 'devise'];
const STATUS_FIELDS = ['status', 'statut', 'state'];
const SUCCESS_STATUS_VALUES = ['successful', 'success', 'completed', 'paid', 'complete'];
const DATE_FIELDS = ['created_at', 'paid_at', 'date', 'completed_at'];

function firstPresentField(obj, candidates) {
  for (const key of candidates) {
    if (obj && obj[key] !== undefined && obj[key] !== null) {
      return { key, value: obj[key] };
    }
  }
  return null;
}

function mapSale(rawSale) {
  const sale = rawSale && typeof rawSale === 'object' ? rawSale : {};
  const amountField = firstPresentField(sale, AMOUNT_FIELDS);
  const currencyField = firstPresentField(sale, CURRENCY_FIELDS);
  const statusField = firstPresentField(sale, STATUS_FIELDS);
  const dateField = firstPresentField(sale, DATE_FIELDS);

  const statusValue = statusField ? String(statusField.value).toLowerCase() : null;
  const estSuccessful = statusValue ? SUCCESS_STATUS_VALUES.includes(statusValue) : null;

  return {
    id: sale.id || sale.uuid || null,
    montant: amountField ? Number(amountField.value) || 0 : null,
    montant_champ_source: amountField ? amountField.key : null,
    devise: currencyField ? String(currencyField.value) : null,
    statut: statusField ? statusField.value : null,
    considere_reussi: estSuccessful,
    date: dateField ? dateField.value : null,
    mapping_confidence: amountField && statusField ? 'verifie_par_champ_present' : 'partiel_champs_manquants',
    raw: sale,
  };
}

function summarize(rawSales = []) {
  const mapped = rawSales.map(mapSale);
  const successful = mapped.filter((s) => s.considere_reussi !== false);
  const byDevise = {};
  for (const sale of successful) {
    if (sale.montant === null) continue;
    const devise = sale.devise || 'devise_inconnue';
    byDevise[devise] = (byDevise[devise] || 0) + sale.montant;
  }
  const anyAmountFound = mapped.some((s) => s.montant !== null);
  return {
    nombre_ventes: mapped.length,
    nombre_ventes_considerees_reussies: successful.length,
    chiffre_affaires_par_devise: byDevise,
    mapping_confidence: anyAmountFound ? 'best_effort_champs_detectes' : 'aucun_champ_montant_detecte',
    avertissement: anyAmountFound
      ? 'Montants extraits par détection de nom de champ, à vérifier avec un vrai compte Chariow avant de faire confiance à ce chiffre.'
      : 'Aucun champ de montant reconnu dans les objets renvoyés : chiffre d’affaires non calculable automatiquement pour le moment.',
    ventes: mapped,
  };
}

module.exports = { mapSale, summarize, AMOUNT_FIELDS, CURRENCY_FIELDS, STATUS_FIELDS, SUCCESS_STATUS_VALUES };
