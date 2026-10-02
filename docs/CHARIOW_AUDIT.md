# Audit officiel Chariow — 25 août 2026

La référence développeur officielle [API Introduction](https://chariow.dev/api-reference/introduction) confirme une API REST Chariow avec la base URL `https://api.chariow.com/v1`. L’authentification documentée utilise une clé API dans l’en-tête `Authorization: Bearer ...`. La documentation renvoie vers le tableau de bord Chariow pour générer les clés : `https://app.chariow.com/settings/api`.

Les ressources officiellement listées comprennent le magasin, les produits, le checkout, les ventes, les clients, les licences, les remises, les affiliés et les **Pulses**, décrits comme des notifications webhook. La pagination des listes est cursor-based, avec `cursor` et `per_page`. La page d’introduction documente une limite générale de 100 requêtes par minute par clé, mais les limites propres à chaque ressource doivent encore être respectées selon la référence correspondante.

À ce stade, aucune clé Chariow n’a été demandée, copiée, stockée ou utilisée. Aucun endpoint Chariow n’a encore été ajouté à Conquistador OS. Le prochain travail nécessaire est de vérifier la page officielle d’authentification et la référence Pulses avant de choisir les événements et le format de signature à implémenter.

## Authentification vérifiée

La page officielle [Authentication](https://chariow.dev/api-reference/authentication) précise le parcours : se connecter au tableau de bord Chariow, ouvrir **Settings**, puis **API Keys**, choisir **Create API Key**, donner un nom descriptif et copier la clé immédiatement. La clé complète n’est affichée qu’une seule fois.

La même page confirme l’en-tête `Authorization: Bearer YOUR_API_KEY`, les réponses `401` en cas de clé absente/invalide et l’interdiction d’exposer la clé dans du code client ou un dépôt public. Elle recommande une variable d’environnement distincte pour chaque environnement et une rotation périodique. La variable Conquistador OS à prévoir, si l’intégration est réellement ajoutée, est donc `CHARIOW_API_KEY`; sa valeur devra être saisie directement dans les variables Netlify côté serveur, jamais dans la conversation ni dans le frontend.

## Pulses / webhooks vérifiés

La référence officielle [List Pulses](https://chariow.dev/api-reference/pulses/list-pulses) confirme que les **Pulses** sont des webhooks configurés pour une boutique. Les réponses exposent notamment l’URL, l’état activé, la source, les déclencheurs, les produits concernés et une pagination cursor-based. Les exemples de déclencheurs vérifiés sont `successful_sale` et `license_activated`; la page mentionne aussi les ventes abandonnées dans sa description, mais les déclencheurs à activer devront être confirmés dans le tableau de bord Chariow.

Cette page documente la lecture des Pulses, pas un schéma de signature HMAC des appels entrants. Il serait donc incorrect d’inventer un secret ou une vérification Chariow à ce stade. Pour une future intégration, Conquistador OS devra recevoir uniquement des notifications HTTPS, vérifier le mécanisme d’authentification réellement configuré côté Chariow, appliquer son idempotence et persister les événements comme préparation/mesure, sans déclencher directement une publication ou un message.
