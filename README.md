# GlobalExam Auto-Answer

Extension Chrome qui répond automatiquement aux QCM de **global-exam.com** et
enchaîne les pages, avec un taux de bonnes réponses réglable.

> Projet personnel, sans aucun lien avec l'éditeur de global-exam.com.

## Installation

1. Ouvrir `chrome://extensions`
2. Activer **Mode développeur** (en haut à droite)
3. **Charger l'extension non empaquetée** → sélectionner le dossier `extension/`
4. Recharger l'onglet global-exam.com déjà ouvert (F5)

## Utilisation

Ouvrir un exercice, cliquer sur l'icône de l'extension, **Démarrer**.
L'arrêt se fait depuis le popup ou depuis le panneau flottant sur la page.

| Réglage | Défaut | Rôle |
|---|---|---|
| Bonnes réponses | 100 % | Part des questions répondues juste. À 60 %, quatre questions sur dix reçoivent une mauvaise réponse tirée au sort |
| Pause avant « suivant » | 3 s | Temps d'attente avant de valider la page |
| Panneau flottant | activé | Compteurs et bouton d'arrêt, en bas à droite |

Les compteurs ne repartent de zéro qu'en changeant d'exercice, pas à chaque
redémarrage.

## Comment ça marche

Trois points valent le détour, parce qu'aucun n'était évident au départ.

**Repérer les questions.** Le site rend chaque question dans son propre bloc,
mais donne à tous ces blocs le même `id="question-wrapper"` — ce qui est invalide
en HTML. `querySelector` n'en renvoie donc qu'un seul, et une page de cinq
questions n'en montre qu'une. L'extension récupère tous les conteneurs, puis
regroupe les cases par attribut `name`, qui porte l'identifiant de la question.

**Trouver le bouton pour avancer.** Sa position *et* son libellé changent : il
vaut « Passer » tant que la question n'est pas répondue, « Suivant » une fois
cochée, « Valider » sur la dernière question d'un texte, et il est tantôt dans
une barre de pagination, tantôt dans un pied de page. Aucun chemin figé ne tient.
Chaque bouton visible est donc noté selon son libellé, sa place dans la page et
son conteneur ; le mieux noté est cliqué, avec une liste d'exclusions stricte
(précédent, fermer, transcription, audio, rejouer…).

**Lire la bonne réponse.** Le site l'envoie au navigateur *en même temps que la
question* : le bouton « Voir la correction » ne fait que révéler une donnée déjà
présente, dans l'état des composants Vue. Mais un script de contenu s'exécute
dans un **monde isolé** — il voit le DOM, pas les objets JavaScript de la page.
`page-bridge.js` est donc déclaré avec `"world": "MAIN"` : il tourne dans le
contexte de la page, lit l'information et la transmet par `postMessage`.
À défaut, l'extension ouvre puis referme réellement la correction.

Le statut affiche la source entre crochets, `[pont]` ou `[correction]`.

## Limites

- **Onglet en arrière-plan** : Chrome bride les minuteurs à environ une action
  par seconde. L'extension continue, mais nettement plus lentement.
- **Sans correction accessible** — un examen blanc, par exemple — aucune réponse
  ne peut être identifiée : l'extension coche au hasard et l'indique.
- Le drapeau marche/arrêt est global : plusieurs onglets GlobalExam ouverts
  démarrent tous ensemble.
- L'extension dépend de la structure du site, qui peut changer sans préavis.

## Structure

```
extension/
├── manifest.json     Manifest V3, actif sur *.global-exam.com
├── content.js        Boucle : détection, réponse, bouton suivant, panneau
├── page-bridge.js    Lecture de la bonne réponse, dans le monde de la page
├── popup.html/css/js Interface Démarrer/Arrêter et réglages
└── icons/            16 / 48 / 128 px
```

`store-listing.md` contient les textes de la fiche Chrome Web Store.

## Vie privée

Aucune donnée collectée, aucun serveur, aucun code distant. Les réglages et deux
compteurs sont enregistrés localement par `chrome.storage`, et n'en sortent
jamais. L'extension n'a accès qu'à `global-exam.com`.
