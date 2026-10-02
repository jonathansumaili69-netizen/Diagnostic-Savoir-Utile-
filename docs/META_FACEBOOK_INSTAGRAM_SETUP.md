# Connecter Facebook + Instagram à Conquistador OS

## État de cette livraison

L’infrastructure est maintenant présente dans le projet, mais **aucun identifiant Meta n’a été créé et aucune variable Meta n’a été renseignée**. Le dashboard doit donc continuer à afficher `NON CONNECTÉ` jusqu’à ce qu’une application Meta réelle soit autorisée et que son token soit vérifié par Graph API.

Le flux retenu est **Facebook Login for Business en mode serveur**. Il demande un code OAuth, l’échange côté Netlify avec l’App Secret, une vérification `/debug_token` et `/me/permissions`, puis la récupération des Pages via `/me/accounts`. Le token utilisateur et les Page access tokens sont chiffrés avec AES-256-GCM avant stockage dans `meta_connections`; le frontend ne reçoit jamais un token.

## Variables Netlify à créer uniquement après la création de l’application Meta

| Variable | Valeur attendue | Exposition |
|---|---|---|
| `META_APP_ID` | App ID Meta | serveur uniquement |
| `META_APP_SECRET` | App Secret Meta | serveur uniquement, secret |
| `META_CONFIGURATION_ID` | ID numérique de la configuration Facebook Login for Business | serveur uniquement |
| `META_OAUTH_REDIRECT_URI` | `https://conquistadoros1.netlify.app/api/meta/oauth/callback` | serveur |
| `META_TOKEN_ENCRYPTION_KEY` | 32 octets en hexadécimal de 64 caractères ou Base64 | serveur uniquement, secret |
| `META_WEBHOOK_VERIFY_TOKEN` | chaîne aléatoire choisie pour le challenge Meta | serveur uniquement, secret |
| `META_GRAPH_API_VERSION` | `v26.0` au moment de la rédaction | serveur |

Aucune de ces valeurs ne doit être ajoutée à `public/`, à `.env` commité, au navigateur ou à une conversation. `META_APP_SECRET`, `META_TOKEN_ENCRYPTION_KEY` et `META_WEBHOOK_VERIFY_TOKEN` doivent être marquées comme valeurs secrètes dans Netlify.

## Parcours Meta officiel à effectuer

Depuis [Meta for Developers](https://developers.facebook.com/apps/), créer une application de type adapté à l’usage Business/Login, puis ajouter le produit Facebook Login for Business. Dans ses réglages, ajouter exactement l’URI de redirection : `https://conquistadoros1.netlify.app/api/meta/oauth/callback`. Ne pas créer encore l’application avant que l’archive de cette livraison soit installée si l’on souhaite éviter un callback non disponible.

Pour le premier test, le compte qui autorise l’application doit administrer au moins une Page Facebook. Pour que l’Instagram soit découvert par la même connexion, le compte Instagram doit être un compte **Professional** et être lié à la Page Facebook. En environnement de développement Meta, le compte autorisant l’application doit également avoir un rôle de testeur, développeur ou administrateur selon le produit utilisé.

Le scope par défaut du code demande les permissions utiles à la lecture et à la gestion contrôlée : `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_manage_posts`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages` et `instagram_content_publish`. Meta peut refuser certains scopes ou exiger App Review/Advanced Access pour des comptes que l’application ne possède ou ne gère pas. Conquistador ne considère une capacité comme disponible que si Meta la retourne effectivement et si les tâches de Page l’autorisent.

## Parcours dans Conquistador OS

Après avoir configuré les variables serveur et redéployé, ouvrir le wizard à l’étape **Facebook / Instagram**, saisir la clé `x-conquistador-key` dans la barre prévue à cet effet, puis appuyer sur **Connecter via Meta**. Le navigateur est redirigé vers la page officielle Meta. Après consentement, le callback Netlify échange le code côté serveur et revient vers le dashboard sans mettre le token dans l’URL.

Appuyer ensuite sur **Tester les tokens**. Le serveur vérifie le token, récupère les Pages et l’Instagram professionnel lié, calcule les capacités réellement accordées et met à jour le registre. Une lecture peut alors être déclenchée via `POST /api/meta/read` avec une opération autorisée, par exemple `facebook_pages`, `facebook_posts`, `facebook_comments`, `instagram_profile`, `instagram_media` ou `instagram_comments`.

Les messages, réponses aux commentaires et publications ne sont jamais envoyés directement par le bouton de lecture. Ils passent par les tâches existantes `system.send_message` et `system.publish_post`, restent `APPROVAL_REQUIRED`, respectent l’expiration des approbations et sont bloqués par le kill switch. Une action n’est marquée exécutée qu’après une réponse Graph API réussie; un événement d’audit non sensible est enregistré côté serveur.

## Webhook Meta

Configurer l’URL de webhook Meta : `https://conquistadoros1.netlify.app/api/meta/webhook`. Le challenge GET doit utiliser la valeur exacte de `META_WEBHOOK_VERIFY_TOKEN`. Les POST Meta sont acceptés seulement avec une signature `X-Hub-Signature-256` valide calculée avec `META_APP_SECRET`; les événements sont dédupliqués avant journalisation.

## Documentation officielle consultée

[1] [Meta — Manually Build a Login Flow](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow) décrit `response_type=code`, `state`, l’échange serveur du code et la vérification du token.

[2] [Meta — Long-Lived Access Tokens](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived) décrit l’échange serveur des tokens et la récupération des Page access tokens.

[3] [Meta — Instagram Comment Moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation) décrit les commentaires, réponses et permissions Instagram.

[4] [Meta — Instagram Send Messages](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api) décrit les messages entrants, webhooks, fenêtres de réponse et permissions de messagerie.

[5] [Meta — Facebook Comments and Mentions](https://developers.facebook.com/documentation/pages-api/comments-mentions) décrit les permissions et opérations de commentaires de Page.
