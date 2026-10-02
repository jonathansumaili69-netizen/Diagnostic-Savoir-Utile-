# Conception additive Facebook + Instagram

## Flux retenu

La première version utilise **Facebook Login for Business** avec le flux OAuth authorization-code. Ce flux permet de récupérer le compte Facebook de l’utilisateur, les Pages administrées, leurs Page access tokens et l’Instagram Professional account lié à une Page. Une seule autorisation peut donc alimenter les connecteurs Facebook Page et Instagram lié. Le parcours Instagram Login séparé reste possible plus tard, mais il ne remplace pas la connexion Facebook Page demandée ici.

## Données persistées

Deux nouvelles collections Supabase sont ajoutées sans toucher aux tables existantes : `meta_connections` et `meta_oauth_states`. Elles reprennent le contrat `id/created_at/updated_at/data` du projet. `meta_connections.data` contient uniquement des métadonnées et des tokens chiffrés AES-256-GCM ; aucun token en clair n’est conservé. `meta_oauth_states.data` contient un hash SHA-256 du state, sa date d’expiration, son usage et l’URI de retour. Un RPC atomique à usage unique consomme le state afin d’éviter la réutilisation et les races.

## Variables serveur futures

`META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI`, `META_TOKEN_ENCRYPTION_KEY`, `META_WEBHOOK_VERIFY_TOKEN` et éventuellement `META_GRAPH_API_VERSION` seront strictement côté serveur. Elles ne seront pas ajoutées maintenant et ne seront pas demandées avant la livraison du code et de la documentation.

## Routes prévues

| Route | Usage | Authentification |
|---|---|---|
| `/api/meta/oauth/start` | Génère une URL OAuth Meta et un state court | `CONQUISTADOR_API_KEY` |
| `/api/meta/oauth/callback` | Vérifie/consomme le state, échange le code, vérifie permissions et Page/Instagram, chiffre et stocke les tokens | state signé par stockage serveur ; pas de secret dans l’URL |
| `/api/meta/status` | État sanitaire et capacités réellement accordées | `CONQUISTADOR_API_KEY` |
| `/api/meta/test` | Vérification réelle des tokens et identités | `CONQUISTADOR_API_KEY` |
| `/api/meta/read` | Lecture Pages, médias, commentaires et conversations selon capacités | `CONQUISTADOR_API_KEY` |
| `/api/meta/disconnect` | Révocation logique et suppression du token chiffré | `CONQUISTADOR_API_KEY` |
| `/api/meta/webhook` | Vérification GET Meta et réception POST signé | signature/verify token Meta |

## Capacités et approbation

Les capacités sont calculées à partir des permissions réellement retournées par Meta et des tâches de Page, jamais à partir d’une configuration supposée. Les lectures sont exécutables automatiquement. Les réponses, messages et publications produisent des tâches `system.send_message` ou `system.publish_post` qui restent `APPROVAL_REQUIRED`; le kill switch est vérifié par le moteur juste avant l’appel externe.

## Limites explicites

Les actions ne seront déclarées exécutées qu’après réponse Meta confirmée. Les erreurs et limitations Meta sont journalisées sans token. Le stockage est serveur uniquement et repose sur `META_TOKEN_ENCRYPTION_KEY`; si cette clé manque, le callback refuse de stocker. Les webhooks sont dédupliqués par la collection `events` existante et vérifiés avec `X-Hub-Signature-256`.
