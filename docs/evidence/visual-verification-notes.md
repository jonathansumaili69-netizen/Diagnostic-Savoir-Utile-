# Vérification visuelle intermédiaire

La page locale `http://localhost:8888` rend correctement le dashboard sombre-or existant et le nouveau wizard d’onboarding. Le masthead conserve le compas, la typographie Fraunces/IBM Plex et la palette encre, parchemin, laiton et signal.

Le statut général affiche bien `Gemini → Groq → OpenRouter → Mock`. Le wizard affiche cinq étapes : Supabase, IA, Facebook/Instagram, TikTok et WhatsApp. La navigation vers l’étape 5 fonctionne ; le panneau WhatsApp indique explicitement `NON CONNECTE — aucune connexion fictive`. Les cartes sociales existantes affichent elles aussi `non connecte` avec des capacités à faux et une raison backend, sans connexion simulée.

Le dashboard conserve ses stations existantes : diagnostic, kill switch, approbations, lancement de tâche, tâches récentes, statistiques, fournisseurs IA, connecteurs, prospects, journal d’exécution, erreurs et rapport quotidien. Les tâches montrent désormais un libellé complémentaire, par exemple `workflow terminé`, `validation requise` ou `en cours`, et le journal indique le fournisseur IA utilisé lorsqu’il est présent.

La suite de navigation est lisible sur le viewport de vérification. Une vérification mobile dédiée sera rejouée après l’ajout des tests permanents et de la documentation.

La capture `dashboard-mobile.png` en 390×844 confirme un reflow vertical propre : le masthead, la clé API, le wizard et le panneau actif restent dans la largeur. Les cinq étapes forment une rangée horizontale scrollable, ce qui conserve des cibles tactiles lisibles sans écraser les libellés. Le statut général se replie sur deux lignes sans débordement fatal ; les actions utilisent des boutons pleine largeur ou suffisamment hauts pour le tactile.
