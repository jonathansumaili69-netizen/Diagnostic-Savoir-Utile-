# Comparaison des alternatives gratuites a n8n

Section 23-24 du prompt maitre demandait d'evaluer objectivement les
alternatives avant d'imposer n8n. Voici le resultat de cette evaluation,
avec les faits verifies en aout 2026.

## Point de depart important

**Conquistador OS n'a besoin d'aucun de ces outils pour fonctionner.** Le
moteur de taches (`src/core/taskEngine.js`) integre deja tout le pipeline
evenement -> observation -> analyse -> raisonnement -> decision -> action ->
verification -> journalisation -> apprentissage, et expose des endpoints
webhook standard (`/api/webhook/message`, `/api/webhook/sale`,
`/api/webhook/stat`). Un outil d'automatisation externe (n8n ou autre) n'est
donc utile que pour deux choses :

1. **Declencher** des webhooks Conquistador depuis des evenements externes
   (nouveau message WhatsApp, nouveau commentaire, etc.) quand le service
   source ne peut pas appeler directement une URL.
2. **Planifier** un appel regulier (par exemple `/api/report/daily`) si les
   fonctions planifiees Netlify deviennent indisponibles ou changent.

Aucune de ces deux taches n'exige une infrastructure lourde.

## Tableau comparatif (verifie aout 2026)

| Outil | Gratuite reelle | Limites | Hebergement | Webhooks | Planification | Simplicite | Mobile | Maintenance |
|---|---|---|---|---|---|---|---|---|
| **n8n Cloud** | Non (essai 14 jours seulement) | A partir de 24€/mois pour 2500 executions | Gere par n8n | Oui | Oui | Elevee | Oui (web) | Aucune |
| **n8n self-hosted (Community)** | Oui (licence "fair-code", logiciel gratuit) | Aucune limite logicielle ; le cout reel est le serveur (~5-7$/mois VPS, ou une plateforme gratuite limitee) | A votre charge | Oui | Oui (cron interne) | Moyenne (installation Docker) | Oui (web) | A votre charge (mises a jour, uptime) |
| **Activepieces** | Oui en self-hosted (open source) ; offre cloud avec palier gratuit limite | Palier cloud gratuit restreint en executions/mois | Self-host ou cloud | Oui | Oui | Moyenne | Oui (web) | A votre charge en self-host |
| **Windmill** | Oui en self-hosted (open source) | Palier cloud gratuit existe mais limite | Self-host ou cloud | Oui | Oui | Moyenne-elevee (plus oriente code) | Oui (web) | A votre charge en self-host |
| **Node-RED** | Oui (open source, aucune limite logicielle) | Aucune limite logicielle ; necessite un serveur toujours actif | Self-host uniquement | Oui (via nodes HTTP) | Oui (nodes cron) | Moyenne | Correct (web) | A votre charge |
| **Pipedream** | Oui, palier gratuit hebergé disponible | Quota d'executions/mois sur le palier gratuit (verifier le quota actuel avant usage intensif) | Gere par Pipedream | Oui | Oui | Elevee | Oui (web) | Aucune |
| **GitHub Actions (cron)** | Oui, minutes gratuites genereuses sur depots publics, quota mensuel sur prive | Quota de minutes/mois sur repos prives ; execution "au mieux", pas un vrai temps reel | Gere par GitHub | Peut appeler un webhook via `curl` dans un step | Oui (cron natif) | Elevee si vous savez ecrire un YAML simple | Non (pas d'UI dediee, mais declenchement invisible) | Tres faible |
| **Netlify Scheduled Functions** (deja integre) | Oui, dans le quota credits du plan Free | Consomme des credits Netlify (voir docs/LIMITES.md) | Deja utilise par ce projet | N/A (c'est la cible, pas la source) | Oui | Elevee (deja code) | N/A | Tres faible |
| **cron-job.org** | Oui | Frequence minimale limitee sur le palier gratuit | Gere par cron-job.org | Peut appeler une URL a intervalle regulier | Oui (c'est son unique fonction) | Tres elevee | Oui (web) | Tres faible |

## Recommandation retenue pour la V1

- **Le moteur reste independant** : aucune dependance dure a n8n dans le code
  (voir netlify.toml : "NE PAS rendre le systeme dependant de n8n").
- **Pour declencher des webhooks externes** (ex: transferer un message reçu
  sur une autre plateforme vers `/api/webhook/message`), n8n self-hosted
  reste le plus flexible si vous avez deja un petit serveur ou une
  plateforme gratuite compatible Docker. Si vous ne voulez vraiment aucune
  infrastructure a maintenir, **Pipedream** (palier gratuit hebergé) ou
  **GitHub Actions** (pour de la logique simple de relai) evitent d'avoir un
  serveur a soi.
- **Pour la planification seule** (le rapport quotidien), la fonction
  planifiee Netlify deja integree (`report-daily-scheduled.js`) suffit et ne
  demande aucun outil supplementaire. **cron-job.org** ou **GitHub Actions**
  restent les filets de securite les plus simples si ce mecanisme venait a
  changer chez Netlify (voir docs/n8n-workflows/daily-report.json pour
  l'equivalent n8n).
- **n8n n'est donc jamais impose** : il reste une option parmi d'autres pour
  la couche d'automatisation externe, jamais une dependance du moteur.

## Limitation de cette comparaison

Les tarifs et quotas des services cites changent frequemment. Les chiffres
ci-dessus ont ete verifies par recherche web en aout 2026 ; verifiez les
pages de tarification officielles avant toute decision d'architecture a long
terme.
