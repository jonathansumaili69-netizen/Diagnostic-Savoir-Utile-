'use strict';

/**
 * Catalogue de fuseaux horaires - villes pertinentes pour Savoir Utile.
 *
 * IMPORTANT (cahier des charges section "fuseaux horaires") : la RDC utilise
 * REELLEMENT deux fuseaux distincts, verifies via la base IANA officielle le
 * 28/08/2026 (time.is, worldometers.info, whatisthetime.now - sources
 * concordantes) :
 *   - Ouest de la RDC (Kinshasa, Mbandaka, Kikwit...) -> Africa/Kinshasa,
 *     UTC+1 (WAT), pas d'heure d'ete.
 *   - Est de la RDC (Goma, Lubumbashi, Bukavu, Kisangani, Kindu...) ->
 *     Africa/Lubumbashi, UTC+2 (CAT), pas d'heure d'ete. Il n'existe pas
 *     d'identifiant IANA distinct "Africa/Goma" : Goma partage exactement
 *     les memes regles que Lubumbashi (meme decalage, jamais de changement
 *     d'heure), donc la base IANA les regroupe sous ce meme identifiant
 *     canonique - ce n'est PAS une approximation, c'est la donnee officielle.
 *
 * Ne JAMAIS deduire le fuseau d'une ville a partir du nom du pays seul (le
 * bug que ce module corrige) : chaque ville de la liste a ete verifiee
 * individuellement.
 */

const CITIES = Object.freeze([
  { id: 'Africa/Kinshasa', ville: 'Kinshasa', pays: 'RDC', drapeau: '🇨🇩', abbr: 'WAT' },
  { id: 'Africa/Lubumbashi', ville: 'Goma', pays: 'RDC', drapeau: '🇨🇩', abbr: 'CAT' },
  { id: 'Africa/Lubumbashi', ville: 'Lubumbashi', pays: 'RDC', drapeau: '🇨🇩', abbr: 'CAT' },
  { id: 'Africa/Lubumbashi', ville: 'Bukavu', pays: 'RDC', drapeau: '🇨🇩', abbr: 'CAT' },
  { id: 'Africa/Lubumbashi', ville: 'Kisangani', pays: 'RDC', drapeau: '🇨🇩', abbr: 'CAT' },
  { id: 'Africa/Bujumbura', ville: 'Bujumbura', pays: 'Burundi', drapeau: '🇧🇮', abbr: 'CAT' },
  { id: 'Africa/Dakar', ville: 'Dakar', pays: 'Sénégal', drapeau: '🇸🇳', abbr: 'GMT' },
  { id: 'Africa/Douala', ville: 'Douala', pays: 'Cameroun', drapeau: '🇨🇲', abbr: 'WAT' },
  { id: 'Africa/Kigali', ville: 'Kigali', pays: 'Rwanda', drapeau: '🇷🇼', abbr: 'CAT' },
  { id: 'Africa/Nairobi', ville: 'Nairobi', pays: 'Kenya', drapeau: '🇰🇪', abbr: 'EAT' },
  { id: 'Africa/Lagos', ville: 'Lagos', pays: 'Nigéria', drapeau: '🇳🇬', abbr: 'WAT' },
  { id: 'Africa/Brazzaville', ville: 'Brazzaville', pays: 'Congo-Brazzaville', drapeau: '🇨🇬', abbr: 'WAT' },
  { id: 'Europe/Paris', ville: 'Paris', pays: 'France', drapeau: '🇫🇷', abbr: 'CET/CEST' },
]);

const DEFAULT_TIMEZONE = 'Africa/Bujumbura';

function isValidIana(id) {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('fr-FR', { timeZone: id });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Decalage UTC courant (en heures, ex: "+02:00") calcule reellement via
 * Intl - jamais une table statique qui pourrait se perimer (heure d'ete
 * ailleurs dans le monde, changements de regles, etc.).
 *
 * BUG CORRIGE (audit externe) : selon la version ICU/Node, un fuseau a
 * decalage zero (ex: Africa/Dakar, UTC+0) peut renvoyer "GMT+0", "GMT" seul
 * ou "UTC" seul via Intl - le remplacement "GMT"->"UTC" seul ne produisait
 * alors PAS de suffixe numerique ("UTC" au lieu de "UTC+0"), faisant
 * echouer la validation qui exige un signe et un chiffre. Normalise
 * maintenant explicitement toute forme sans decalage numerique vers
 * "UTC+0", quelle que soit la version ICU utilisee.
 */
function currentUtcOffsetLabel(id) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    const offsetPart = parts.find((p) => p.type === 'timeZoneName');
    if (!offsetPart || !offsetPart.value) return null;
    let label = offsetPart.value.trim().replace(/^GMT/i, 'UTC');
    if (/^UTC$/i.test(label)) label = 'UTC+0';
    // Defensif : si jamais un chiffre suit directement "UTC" sans signe
    // (forme non standard mais possible selon l'implementation), ajoute le
    // signe positif plutot que de laisser passer une valeur invalide.
    if (/^UTC\d/.test(label)) label = label.replace('UTC', 'UTC+');
    return label;
  } catch (err) {
    return null;
  }
}

function list() {
  return CITIES.map((c) => ({ ...c, utc_actuel: currentUtcOffsetLabel(c.id) }));
}

/**
 * Valide un identifiant de fuseau fourni par l'utilisateur. Accepte tout
 * identifiant IANA reel (pas seulement ceux du catalogue ci-dessus, pour ne
 * pas bloquer une ville legitime absente de cette courte liste), retombe sur
 * DEFAULT_TIMEZONE si invalide - jamais sur UTC silencieusement choisi a la
 * place d'un fuseau demande.
 */
function normalize(value) {
  const id = String(value || '').trim();
  if (id && isValidIana(id)) return id;
  return DEFAULT_TIMEZONE;
}

/**
 * Heure locale actuelle (0-23) dans le fuseau donne, utilisee par le
 * planificateur pour respecter les fenetres horaires configurees.
 *
 * BUG CRITIQUE CORRIGE (audit V7) : l'implementation d'origine utilisait
 * `Number(new Intl.DateTimeFormat('fr-FR', {hour:'numeric', hour12:false}).format(date))`.
 * En locale fr-FR, ce format renvoie une chaine comme "04 h" (avec un
 * suffixe) - `Number("04 h")` vaut NaN. Consequence reelle verifiee : des
 * qu'un utilisateur configurait des heures autorisees (allowed_hours),
 * `hours.includes(NaN)` valait toujours false et bloquait la publication
 * autonome 24h/24, sans qu'aucune heure ne soit jamais consideree valide.
 * Corrige ici en utilisant formatToParts() avec hourCycle:'h23' et la
 * locale 'en-US' (jamais de suffixe texte), qui renvoie une vraie chaine
 * numerique ("00".."23") de facon fiable et testee.
 */
function resolveHour(timezone) {
  const tz = normalize(timezone);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === 'hour');
    const hour = hourPart ? Number(hourPart.value) : NaN;
    return Number.isFinite(hour) ? hour : new Date().getUTCHours();
  } catch (err) {
    return new Date().getUTCHours();
  }
}

module.exports = { CITIES, DEFAULT_TIMEZONE, list, normalize, isValidIana, currentUtcOffsetLabel, resolveHour };
