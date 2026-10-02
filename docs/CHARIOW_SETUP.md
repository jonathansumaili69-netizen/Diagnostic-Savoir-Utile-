# Connecter votre compte Chariow à Conquistador OS

Source officielle : https://help.chariow.com/en/articles/259-developer-documentation-and-api
et https://chariow.dev/en/guides/pulses

## 1. Créer la clé API
1. Connectez-vous à votre tableau de bord Chariow.
2. Ouvrez la section **Développeur → API Keys**.
3. Créez une clé API et copiez-la immédiatement (elle n'est affichée qu'une fois).

## 2. Déclarer la clé côté serveur (jamais dans le frontend)
Dans Netlify → Site settings → Environment variables :
- `CHARIOW_API_KEY` = votre clé
- `CHARIOW_STORE_ID` = (optionnel) l'identifiant de votre boutique
- `CHARIOW_BASE_URL` = `https://api.chariow.com/v1` (déjà la valeur par défaut)

La clé n'apparaît jamais dans le frontend, le ZIP, les logs ni les réponses API :
elle est lue exclusivement depuis `process.env` dans `src/core/chariow.js`.

## 3. Ce que fait le connecteur
- `GET /api/chariow/stats` : ventes réelles et chiffre d'affaires calculé depuis
  les montants retournés par l'API (jamais inventés ; `NON_CONFIGURE` sans clé).
- Synchronisation automatique toutes les 3 h (`chariow-sync-scheduled`),
  idempotente (aucune vente importée en double).
- Réponse API parsée de façon tolérante : `data` / `results` / tableau, montants
  lus depuis `amount` ou `total`, sans supposer un schéma non documenté.

## 4. Pulses (webhooks temps réel)
1. Dans Chariow → Développeur → Pulses, créez un Pulse sur le déclencheur
   `successful_sale` vers : `https://<votre-site>.netlify.app/api/webhook/chariow`
2. Conquistador OS applique l'idempotence atomique sur l'identifiant d'événement
   et persiste chaque vente comme mesure — sans déclencher de publication ni de
   message automatique.
3. Note honnête : la documentation officielle ne décrit pas de signature HMAC
   entrante ; si Chariow en ajoute une, configurez-la et nous ajouterons la
   vérification côté serveur.
