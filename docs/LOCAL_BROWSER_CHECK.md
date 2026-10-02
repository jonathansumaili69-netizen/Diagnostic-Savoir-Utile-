# Vérification navigateur locale — 25 août 2026

L’instance Netlify Dev du dépôt courant répond sur `http://localhost:8890/` et charge le dashboard sans erreur JavaScript visible au premier rendu.

Les nouveaux contrôles DOM sont présents : `videoPipelineResult`, `refreshVideoReviewsBtn`, `contentStateGrid`, `videoReviewsList`, `prepareFollowupBtn`, `followupResult` et `commercialFollowupsList`. La liste des tâches du dashboard contient également `commercial.prepare_followup`.

Le navigateur a conservé uniquement une valeur de clé dédiée au test local. Aucun secret de production n’a été utilisé. Les routes protégées peuvent donc être vérifiées dans cette session sans exposer de valeur sensible.

Le rendu initial affiche honnêtement les connecteurs sociaux comme non connectés et le backend local comme `json`. Les compteurs d’états de contenu sont rendus à zéro lorsqu’aucune revue récente n’est disponible dans cette instance. Le kill switch apparaît dans l’interface et les données historiques affichent qu’une action externe peut être bloquée.

Une première exécution a rencontré un timeout lié à l’ancienne alerte native du bouton. Le bouton a ensuite été corrigé : le clic vérifié affiche maintenant un message inline accessible et ne bloque plus la page.

## Résultats complémentaires

Le clic sur `Enregistrer` affiche désormais un message inline et ne bloque plus la page. Le parcours de relance a été exercé dans le navigateur avec un contact fictif de test et a affiché `RELANCE_PREPAREE`, un délai de trois jours, `envoi effectué : non`, puis la ligne d’historique correspondante. Le journal des tâches a enregistré `commercial.prepare_followup` comme tâche terminée. Le statut des connecteurs est resté `non connecté`, comme attendu.

## Vérification HTTP locale

Avec `Origin: http://localhost:8890`, `GET /api/settings` répond `200` et renvoie l’en-tête CORS attendu. Avec `Origin: http://evil.example`, la même route répond `403 Forbidden`; l’origine non autorisée n’est donc pas acceptée.

`GET /api/knowledge` sans clé répond `401 Unauthorized`; avec la clé de test locale il répond `200`. `GET /api/voice/health` avec la clé répond `200` et reste non configuré/non disponible, sans tentative de prétendre qu’un studio vocal existe.

## Vérification complémentaire du 25 août 2026

Le dashboard local sur `http://localhost:8890/` affiche bien le nouveau type `content.adapt_platforms`, la section de suivi vidéo, la base de connaissances avec type d’asset, le panneau Rémy Neural, les trois modes et le suivi TikTok. Le backend local affiche honnêtement TikTok, Meta, YouTube et WhatsApp comme non connectés en l’absence de connexion réelle. La section statistiques contient désormais un emplacement de graphique des vues par source ; elle reste vide lorsqu’aucune métrique réelle n’est enregistrée. Le panneau Rémy signale `VOICE_STUDIO_API_URL` non configurée au lieu de simuler une disponibilité. Le rendu étroit reste lisible pendant le défilement ; aucune action externe n’a été déclenchée.
