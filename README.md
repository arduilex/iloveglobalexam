# GlobalExam Auto-Answer

Extension Chrome qui coche **une réponse au hasard** dans chaque question d'une page
GlobalExam, clique sur le bouton « suivant », et recommence en boucle jusqu'à ce que
tu appuies sur **Stop**.

## Installation (mode développeur)

1. Ouvre `chrome://extensions`
2. Active **Mode développeur** (interrupteur en haut à droite)
3. Clique sur **Charger l'extension non empaquetée**
4. Sélectionne le dossier **`extension/`** de ce projet
5. Épingle l'extension à la barre d'outils (icône puzzle → punaise)

Si un onglet global-exam.com était déjà ouvert, **recharge-le** (F5) pour que le
script s'y injecte.

## Utilisation

1. Ouvre ton exercice sur global-exam.com
2. Clique sur l'icône de l'extension → **▶ Démarrer**
3. Pour arrêter : **■ Arrêter** dans le popup, ou le bouton **Stop** du petit
   panneau flottant en bas à droite de la page

L'état est conservé dans `chrome.storage`, donc la boucle **reprend toute seule**
après un rechargement de page tant que tu ne l'as pas arrêtée.

Les compteurs (réponses, justes, pages) ne repartent de zéro qu'en **changeant
d'exercice** : l'extension compare l'identifiant d'activité de l'URL à celui
auquel appartiennent les compteurs. Un arrêt puis un redémarrage au milieu d'un
exercice les conserve, tout comme un rechargement de page.

## Réglages (popup)

Les délais se saisissent **en secondes** (décimales acceptées, ex. `1,5`).

| Réglage | Défaut | Rôle |
|---|---|---|
| Bonnes réponses | 100 % | Part des questions répondues juste **quand la correction est lisible**. À 60 %, six questions sur dix reçoivent la bonne réponse, les quatre autres une mauvaise tirée au sort |
| Pause avant « suivant » | 1 s | Temps d'attente avant de valider la page. Les flèches du champ montent et descendent **de 10 s en 10 s** ; n'importe quelle valeur reste saisissable au clavier |
| Panneau flottant sur la page | activé | Le petit HUD avec les compteurs |

C'est le seul réglage de temps, et il vaut exactement ce qu'il affiche : régler 30 s
donne bien une page toutes les ~30 s.

Trois constantes internes ne sont volontairement pas exposées, parce que leur valeur
exacte n'a aucun effet perceptible — et parce que Chrome bride de toute façon les
minuteurs à 1 Hz dès que l'onglet passe en arrière-plan : pause entre deux cases
d'une même page (0,3 s), cadence de réessai quand la page n'est pas prête (0,6 s),
et écart minimal entre deux clics sur « suivant » (0,7 s).

## Réponses justes sans ouvrir la correction

GlobalExam est une application **Vue**, et l'état de ses composants contient déjà
la bonne réponse **avant** toute ouverture de la correction :

```
SingleSelection.props.examAnswers[0].is_right_answer = true   (showCorrection = false)
```

L'extension parcourt l'arbre de composants Vue (`#app.__vue_app__`), relève pour
chaque question l'option marquée `is_right_answer`, et la relie à la case du DOM :
les identifiants suivent le schéma `radio-{question}-{réponse}`. Aucun clic, aucune
attente, et **rien qui signale au site que la correction a été consultée**.

Si ces champs venaient à disparaître d'une mise à jour du site, l'extension ne
devinerait plus rien et cocherait au hasard — le statut l'indique.

En mode examen, ces champs ne sont pas envoyés au navigateur et aucun bouton de
correction n'existe : l'extension retombe sur le tirage au hasard, et le statut
l'indique.

## Le pont vers le monde de la page

Les scripts de contenu d'une extension Chrome vivent dans un **monde isolé** :
ils partagent le DOM avec la page, mais **pas ses objets JavaScript**. Or la
bonne réponse se trouve dans l'état des composants Vue, atteignable seulement
via `#app.__vue_app__` — une propriété posée par le code du site, donc invisible
depuis le monde isolé.

`page-bridge.js` est déclaré avec `"world": "MAIN"` : il s'exécute dans le
contexte de la page, lit `is_right_answer` pour chaque question, et transmet la
table au script de contenu par `window.postMessage`. Réponse mesurée en **3 ms**.

Si le pont ne répond pas — Chrome antérieur à la version 111, état Vue modifié —
l'extension retombe sur l'ouverture puis la fermeture de la correction. Le statut
affiche la source entre crochets, `[pont]` ou `[correction]`, ce qui permet de
voir d'un coup d'œil quel chemin est actif.

## Comment ça marche

- **Questions déjà répondues** : l'extension ne les retouche jamais, elle passe à la suivante.
- **Détection des questions** : piège majeur du site — sur les pages *listening*,
  chaque question est dans son propre bloc, mais **tous ces blocs portent le même
  `id="question-wrapper"`** (id dupliqué, ce qui est invalide en HTML). Or
  `querySelector('#question-wrapper')` n'en renvoie qu'un seul : se fier à lui ne
  fait voir qu'une question sur cinq. L'extension récupère donc **tous** les
  conteneurs (`querySelectorAll('[id="question-wrapper"]')`), puis regroupe les
  `input[type=radio]` visibles par attribut `name` (qui vaut l'id de la question) ;
  à défaut de `name`, un conteneur = une question. Le nombre de questions par page
  (1, 3, 5…) et d'options (3, 4…) n'a donc plus d'importance.
- **Clic** : un vrai enchaînement `pointerdown / mousedown / mouseup / click` est
  envoyé sur la pastille ronde du `<label>`, ce qui traverse bien la couche Vue du
  site. Si la case ne se coche pas, l'extension retente sur l'`input` masqué, puis en
  dernier recours force l'état via le setter natif + événement `change`.
- **Bouton « suivant »** : sa position **et** son libellé changent selon la page —
  il vaut « Passer » tant que la question n'est pas répondue, « Suivant » une fois
  cochée, et « Valider » sur la dernière question d'un texte. Il est tantôt dans un
  `<nav>` de pagination, tantôt dans un pied de page simple. Aucun chemin figé ne
  tient : chaque bouton visible est donc **noté** (libellé, présence dans un `<nav>`,
  position en bas à droite), et le mieux noté est cliqué. Les boutons interdits
  (précédent, fermer, transcription, audio, formulaire de retour, rejouer…) sont
  exclus d'office. Repli : si un `<nav>` de pagination ne contient que des flèches
  sans libellé, c'est le dernier bouton qui est pris.
- **Sécurités** : jamais deux clics « suivant » d'affilée ; attente que toutes les
  questions visibles soient répondues avant de valider ; attente si le bouton est
  désactivé (lecture audio en cours en mode `SEMI_AUTO`) ; attente du changement de
  question avant de repartir ; **arrêt automatique** sur une page de résultats ou de
  correction, pour ne jamais relancer une activité par accident.

## Vérifié en conditions réelles

Testé en direct sur des examens blancs TOEIC, sur les deux moitiés de l'épreuve :

| Passe | Résultat |
|---|---|
| Reading | 40 questions en 83 s, jusqu'à la page de résultats où l'extension s'arrête seule |
| Listening + conversations | 33 pages / 116 réponses, **toutes les questions de chaque page répondues avant validation** |

Gabarits de page effectivement rencontrés et gérés : **5 questions × 3 options**,
**3 × 4**, **5 × 4**, **1 × 4**, avec pagination interne (1/2, 1/4, 1/5),
changements de section et écrans de validation de fin de texte.

## Bon à savoir

- **Onglet en arrière-plan** : Chrome bride les minuteurs des onglets cachés à
  environ 1 action/seconde. L'extension continue de fonctionner, mais ~5× plus
  lentement. Laisse l'onglet visible pour la vitesse maximale.
- L'extension ne connaît pas les bonnes réponses : le tirage est **uniformément
  aléatoire** (vérifié sur 145 réponses : 49 A / 46 B / 50 C). Sur un examen blanc
  complet, ça donne un score de l'ordre de 500/990.
- Le drapeau marche/arrêt est global : si plusieurs onglets GlobalExam sont ouverts,
  ils démarrent tous.

## Fichiers

```
extension/
├── manifest.json   Manifest V3, actif sur *.global-exam.com
├── content.js      Boucle : détection, clic aléatoire, bouton suivant, HUD
├── popup.html/.css/.js   Interface Démarrer/Arrêter + réglages
└── icons/          16 / 48 / 128 px
```
