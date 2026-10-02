## Vérification locale depuis l’extraction fraîche

Le dashboard local a été ouvert avec Netlify Dev depuis `final-fresh-check/conquistador-os`. Le wizard est présent avec cinq boutons d’étape. Un clic réel sur l’étape WhatsApp a affiché `Etape 5 sur 5`, le panneau WhatsApp et le statut `NON CONNECTE`, avec le bouton `Terminer`. Le tableau de bord conserve les sections système, kill switch, approbations, tâches, IA et connecteurs.

Le mode mémoire local est `json` dans cette extraction car les variables Supabase de production ne sont volontairement pas incluses dans le ZIP ; ce résultat est attendu et ne préjuge pas du déploiement public, qui a déjà retourné `memoire_backend: supabase`.

## Vérification publique Netlify

Le site `https://conquistadoros1.netlify.app/` répond et rend le dashboard public. Après chargement, il affiche `Backend memoire actuel : supabase. Persistance serveur active.`, l’ordre IA public Gemini → Groq → OpenRouter → Mock, cinq étapes d’onboarding, le kill switch en mode normal, aucune approbation en attente, aucune tâche, aucune exécution, aucune erreur, et les connecteurs Facebook, Instagram, TikTok, WhatsApp et YouTube en `non connecte`. Le dashboard ne reçoit pas la clé `service_role`.

## Vérification responsive publique

Une capture du site public en 390×844 a d’abord montré un état transitoire `connexion...`, puis une capture stabilisée après 6 secondes a affiché l’état final `IA: Gemini → Groq → OpenRouter → Mock · memoire: supabase`, le wizard lisible, l’étape Supabase et `Backend memoire actuel : supabase. Persistance serveur active.`. Aucun débordement horizontal visible dans la largeur mobile contrôlée.

La console du dashboard public et celle du dashboard local n’ont retourné aucune erreur.

## Vérification CORS de l’archive corrigée

Le ZIP réellement publié précédemment ne contenait pas encore le garde d’origine serveur ; sa réponse étrangère était 200 avec une valeur `Access-Control-Allow-Origin` non correspondante, ce qui ne bloquait que la lecture navigateur. La correction a été appliquée dans `src/utils/http.js` et la nouvelle archive `conquistador-os-final-cors-fixed.zip` a été testée depuis une extraction vierge.

Test direct production de l’enveloppe HTTP avec `ALLOWED_ORIGIN=https://conquistadoros1.netlify.app` : l’origine exacte reçoit HTTP 200 et l’en-tête correspondant ; `https://evil.example` reçoit HTTP 403 ; une requête sans en-tête Origin reste acceptée pour le trafic same-origin. Les 126 tests passent depuis cette extraction vierge.

## Redéploiement final et vérification live

Le ZIP de déploiement compact de 7,19 Mo a été déposé depuis la page Netlify dédiée `/projects/conquistadoros1/deploys`, ce qui a créé le déploiement `6a81a4cc9bd23fdf8de62464`. Netlify a terminé l’initialisation, le build, le bundling des 19 fonctions, le déploiement et le scan de secrets sans détection de secret dans le code ou la sortie de build ; le site a été déclaré live.

La vérification publique finale de `https://conquistadoros1.netlify.app/api/health` donne, avec l’origine exacte, HTTP 200, `Access-Control-Allow-Origin: https://conquistadoros1.netlify.app`, `memoire_backend: supabase` et l’ordre IA `gemini, groq, openrouter, mock`. Avec `Origin: https://evil.example`, elle donne HTTP 403 et `{"erreur":"Origine non autorisee"}`.

La vérification webhook finale, sans afficher les secrets, donne : absence de signature HTTP 401 ; signature erronée HTTP 401 ; signature correcte avec corps non conforme HTTP 400 ; JSON invalide HTTP 400 ; corps supérieur à 1 Mo HTTP 413.
