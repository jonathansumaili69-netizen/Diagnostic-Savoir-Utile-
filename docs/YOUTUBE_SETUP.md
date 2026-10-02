# Configuration YouTube — Conquistador OS

## Périmètre réel

Le connecteur utilise OAuth 2.0 serveur avec `access_type=offline`, state anti-CSRF et tokens chiffrés côté serveur. Il vérifie la chaîne authentifiée auprès de YouTube Data API v3 et ne présente une connexion comme active qu’après une autorisation et une vérification réelles.

La publication vidéo est maintenant préparée via l’upload résumable YouTube Data API v3. La première version accepte une **URL vidéo HTTPS publiquement accessible** ; elle télécharge la vidéo côté fonction puis la transmet à YouTube. Elle ne prétend pas accepter un fichier local du téléphone ni une URL privée. La limite prudente de cette version est de 100 Mo et la confidentialité par défaut est `private`.

## Variables Netlify côté serveur

| Variable | Valeur attendue | Exposition |
|---|---|---|
| `YOUTUBE_CLIENT_ID` | Client ID OAuth de l’application Google Cloud | Serveur |
| `YOUTUBE_CLIENT_SECRET` | Client secret OAuth | Secret, serveur uniquement |
| `YOUTUBE_OAUTH_REDIRECT_URI` | `https://conquistadoros1.netlify.app/api/youtube/oauth/callback` | Serveur |
| `YOUTUBE_TOKEN_ENCRYPTION_KEY` | Clé AES-256-GCM de 32 octets, hexadécimal 64 caractères ou Base64 | Secret, serveur uniquement |
| `YOUTUBE_OAUTH_SCOPE` | `https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload` | Serveur |

Le scope `youtube.upload` est indispensable à la capacité `publication`. Une chaîne connectée uniquement avec `youtube.readonly` reste lisible mais ne peut pas publier. La capacité retournée au dashboard est calculée sur les scopes réellement présents dans le token ; aucune variable ne force un faux statut.

## Parcours Google Cloud

1. Utiliser le projet Google Cloud associé à la chaîne YouTube qui doit être administrée.
2. Activer **YouTube Data API v3** dans la bibliothèque des API.
3. Configurer l’écran de consentement OAuth selon le type de compte et ajouter le compte Google de test si le projet reste en mode test.
4. Créer ou vérifier un identifiant **OAuth Client ID — Web application**.
5. Ajouter exactement l’URI de redirection autorisée : `https://conquistadoros1.netlify.app/api/youtube/oauth/callback`.
6. Conserver le JSON client téléchargé hors du projet et ne jamais poster le client secret dans le chat.

L’autorisation doit être effectuée avec le compte Google qui possède ou gère la chaîne YouTube visée. Les comptes Google différents peuvent administrer des chaînes différentes ; le compte choisi dans l’écran d’autorisation détermine la chaîne inspectée.

## Publication contrôlée

La publication utilise une action `system.publish_post` et passe par les contrôles existants : en modes Silencio/Copilot, approbation humaine, expiration et idempotence ; en mode Conquistador, vérifications automatiques (qualité, quota, fuseau horaire) ; dans tous les cas, kill switch prioritaire. Un exemple de données métier, sans secret, est :

```json
{
  "plateforme": "youtube",
  "video_url": "https://cdn.exemple.com/video.mp4",
  "title": "Titre validé",
  "description": "Description validée",
  "tags": ["savoir utile", "emploi"],
  "privacy_status": "private",
  "category_id": "22"
}
```

`privacy_status` accepte `private`, `unlisted` ou `public`. La valeur `private` est le choix initial sûr. La fonction ne marque la publication comme réussie qu’après réception d’un identifiant vidéo de YouTube ; une préparation ou une approbation ne sont pas présentées comme une publication.

L’URL source doit être HTTPS, accessible depuis Netlify et servir réellement une vidéo. Une URL nécessitant une connexion, expirée, locale ou non durable n’est pas adaptée. Les limites de taille, de temps d’exécution et de quota YouTube peuvent encore refuser un téléversement réel ; le code retourne alors une erreur assainie sans exposer le token.

## Routes du dashboard

- `GET /api/youtube/oauth/start` démarre OAuth Google.
- `GET /api/youtube/oauth/callback` consomme le state et stocke le token chiffré.
- `GET /api/youtube/status` expose uniquement les booléens de configuration.
- `POST /api/youtube/test` vérifie la chaîne réelle et rafraîchit le token si nécessaire.
- `GET /api/youtube/read` lit les métadonnées autorisées sans token.
- `POST /api/youtube/disconnect` supprime la connexion locale.

## Références officielles

- [YouTube Data API — Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [YouTube Data API — Resumable upload](https://developers.google.com/youtube/v3/guides/implementation/upload)
- [Google OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [YouTube Data API v3](https://developers.google.com/youtube/v3)
