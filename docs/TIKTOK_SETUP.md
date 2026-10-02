# Configuration TikTok — Conquistador OS

## Périmètre réel

Le connecteur TikTok utilise Login Kit Web pour l’autorisation du compte, puis le Content Posting API pour lire les vidéos autorisées et préparer une publication vidéo. Le code ne déclare une connexion active qu’après un retour OAuth réel, une vérification du compte et le stockage chiffré des tokens côté serveur.

La publication directe utilise le mode `PULL_FROM_URL` avec une URL vidéo HTTPS. TikTok exige que l’application soit enregistrée, que le produit Content Posting API soit ajouté, que Direct Post soit activé et que le scope `video.publish` soit approuvé et accordé à l’utilisateur. Les clients non audités peuvent rester limités à une visibilité privée jusqu’à l’audit de conformité TikTok.

## Variables Netlify côté serveur

| Variable | Valeur attendue | Exposition |
|---|---|---|
| `TIKTOK_CLIENT_KEY` | Client key obtenue dans TikTok for Developers | Serveur uniquement |
| `TIKTOK_CLIENT_SECRET` | Client secret obtenu dans TikTok for Developers | Secret, serveur uniquement |
| `TIKTOK_OAUTH_REDIRECT_URI` | `https://conquistadoros1.netlify.app/api/tiktok/oauth/callback` | Serveur |
| `TIKTOK_TOKEN_ENCRYPTION_KEY` | Clé AES-256-GCM de 32 octets, hexadécimal 64 caractères ou Base64 | Secret, serveur uniquement |
| `TIKTOK_OAUTH_SCOPE` | `user.info.basic,video.list,video.publish` si ces scopes sont effectivement validés | Serveur |

Aucune de ces valeurs ne doit être placée dans `public/`, dans le navigateur, dans un fichier commité ou dans une conversation. Le serveur utilise `TIKTOK_CLIENT_SECRET` et les tokens uniquement dans les fonctions Netlify ; les tokens sont chiffrés avant leur stockage Supabase.

## Parcours officiel TikTok

1. Enregistrer l’application sur [TikTok for Developers](https://developers.tiktok.com/) et obtenir la client key et le secret.
2. Ajouter **Login Kit** et configurer le produit Web.
3. Enregistrer exactement l’URI HTTPS suivante dans Login Kit : `https://conquistadoros1.netlify.app/api/tiktok/oauth/callback`.
4. Ajouter **Content Posting API** et activer la configuration **Direct Post**.
5. Demander ou activer les scopes disponibles : `user.info.basic`, `video.list` et `video.publish`.
6. Tester d’abord avec le compte TikTok réel autorisé. Tant que l’audit Content Posting n’est pas accordé, considérer la visibilité publique comme non garantie.

## Routes Conquistador

- `GET /api/tiktok/oauth/start` démarre l’autorisation officielle et exige la clé Conquistador.
- `GET /api/tiktok/oauth/callback` consomme le state à usage unique et ne met aucun token dans l’URL de retour.
- `GET /api/tiktok/status` expose uniquement des booléens de configuration et des métadonnées publiques.
- `POST /api/tiktok/test` vérifie le compte réel et actualise le token côté serveur si nécessaire.
- `GET /api/tiktok/read` lit les vidéos autorisées sans retourner de token.
- `POST /api/tiktok/disconnect` supprime les tokens locaux chiffrés.
- `GET /api/tiktok/publish-status?publication_id=...` relit le statut réel d’une soumission et ne renvoie jamais de token.

### Correspondance exacte d’une publication

Le parcours conserve la relation suivante dans la mémoire persistante additive : `content_key`/`content_id` du contenu Conquistador → `publish_id` retourné par TikTok → `provider_status` relu par l’API TikTok → `public_post_id` si TikTok confirme une publication finale. Après `initVideoPost`, le statut est `EN_TRAITEMENT`, pas `PUBLIE`. Le dashboard propose **Actualiser** pour interroger `publish-status`. Seul un état final positif comme `PUBLISH_COMPLETE` devient `PUBLIE`; un échec devient `ECHEC`, et un état intermédiaire reste `EN_TRAITEMENT`.

La publication ne dispose pas d’un bouton d’exécution directe dans le dashboard. Elle passe par une tâche `system.publish_post`, reste soumise à l’approbation humaine et au kill switch, et ne doit utiliser qu’une URL vidéo HTTPS autorisée. Le statut retourné par TikTok est conservé comme preuve de l’identifiant de publication ; Conquistador ne transforme pas une préparation en publication confirmée.

## Références officielles

- [TikTok Login Kit Web](https://developers.tiktok.com/docs/en/login-kit-web)
- [TikTok Content Posting API — Get Started](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
- [TikTok Developer Portal](https://developers.tiktok.com/)
