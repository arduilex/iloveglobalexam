# GlobalExam Auto-Answer

Extension Chrome (Manifest V3) qui enchaîne les entraînements de
global-exam.com : elle coche la bonne réponse, passe à la page suivante, puis à
l'exercice suivant, et tient un journal des résultats. JavaScript nu, aucune
dépendance, aucune étape de build : le dossier `extension/` se charge tel quel.

> Projet personnel, sans lien avec l'éditeur de global-exam.com.

## Architecture

Le point structurant est la frontière entre les deux mondes d'exécution. Un
script de contenu ordinaire voit le DOM mais **aucun objet JavaScript de la
page** — or la bonne réponse vit dans l'état des composants Vue du site. D'où le
second script, déclaré `"world": "MAIN"`.

```
  popup.html / popup.js          ← marche/arrêt, rythme, durée de session
  dashboard.html / .js           ← statistiques, réglages, éditeur de sélecteurs
          │  chrome.storage.local
          ▼
┌─────────────────────────────────────────────────────────────┐
│  onglet global-exam.com                                     │
│                                                             │
│   ge-selectors.js + content.js     world: ISOLATED          │
│     │  ▲                                                    │
│     │  │  postMessage  { __geAuto: 'ask' | 'answers' }      │
│     ▼  │                                                    │
│   page-bridge.js                   world: MAIN              │
│     │                                                       │
│     │  lit #app.__vue_app__ → is_right_answer               │
│     ▼                                                       │
│   application Vue du site ──── DOM ────► clics simulés      │
└─────────────────────────────────────────────────────────────┘
```

`content.js` interroge le pont, résout la case correspondante, puis émet une
séquence `pointerdown / mousedown / pointerup / mouseup / click` sur le `<label>`
— les `<input type="radio">` du site sont masqués en `sr-only`.

Si le pont ne répond pas dans les 600 ms, `readCorrection()` prend le relais :
ouverture puis fermeture réelles du panneau de correction.

## Carte du code

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV3, deux entrées `content_scripts` (ISOLATED + MAIN), permission `storage`, hôte restreint à `*.global-exam.com` |
| `ge-selectors.js` | Table des cibles DOM. Chargée par le script de contenu **et** par le tableau de bord |
| `content.js` | Boucle principale, aiguillage par type de page, réponses, enchaînement, journal, panneau flottant |
| `page-bridge.js` | Répond aux requêtes du script de contenu en lisant l'arbre de composants Vue |
| `popup.{html,css,js}` | Marche/arrêt et réglages courants |
| `dashboard.{html,css,js}` | Statistiques par période, réglages complets, éditeur de sélecteurs |
| `selftest.js` (racine) | Vérification hors navigateur : `node selftest.js` |

## Boucle — `step()` dans `content.js`

`step()` classe d'abord l'URL, puis branche sur l'un des trois traitements.

**Page de contenu** — `/training/activity/{id}/content/{n}`

1. Un tirage d'attente par page, dépensé **en une fois, avant de cocher**. Une
   fois les réponses cochées, la validation est immédiate : hésiter après avoir
   répondu ne correspond à rien.
2. `getGroups(getRoots())` → un tableau de cases par question.
3. Pour chaque groupe non répondu : `answerGroup()` → pont, sinon correction,
   sinon hasard.
4. Sortie tant qu'il reste une question sans réponse.
5. `findNextButton()` → clic si actif, puis `waitForChange()` sur la signature.

**Page de fin** — `/training/activity/{id}/result`

1. Lecture du score, de la durée et du nom de la série.
2. Ajout au journal, **dédoublonné par l'id d'activité** : recharger la page ne
   compte pas l'exercice deux fois.
3. Mémorisation de l'URL de la série, lue sur « Retour à la liste ».
4. Pause, puis clic sur « Activité suivante ». Bouton absent → retour à la liste.

**Liste d'activités** — `/library/trainings/exercises/{id}/activities`

1. Première ligne dont le pourcentage de réussite est inférieur à 100 %, et dont
   le bouton n'a pas déjà été essayé dans cette session.
2. Pause, puis clic sur « Lancer ».

**Bibliothèque** — `/library/trainings` et ses sous-pages

Le panneau flottant affiche la recommandation — Reading › Partie 7(B) — et un
bouton qui l'ouvre. Aucun clic automatique : le choix de la série reste manuel.

**Toute autre page** — accueil, `/stats`, `/user-plannings`…

Tant que le runner tourne, il n'a rien à y faire : redirection vers
`/library/trainings`. `REDIRECT_GUARD` empêche la navigation de boucler si la
bibliothèque ne se charge pas.

Le minuteur de session n'est vérifié **qu'aux frontières d'exercice**. La
consigne est de tenir *au moins* la durée demandée : couper au milieu d'une page
laisserait un exercice abandonné dans le relevé du site.

L'état vit dans `chrome.storage.local` : le popup écrit, `content.js` réagit via
`onChanged`. C'est ce qui permet à la boucle de reprendre après un rechargement
de page sans mémoire partagée.

## Ancrages DOM relevés

Trois `data-testid` existent sur le site. Ce sont les seuls ancrages réellement
stables ; tout le reste repose sur des libellés français.

| Cible | Ancrage |
|---|---|
| Bouton « Lancer » d'une activité | `button[data-testid^="activity-button-"]` |
| Score de fin d'exercice | `p[data-testid="your-grade"]` → `13 /25` |
| Durée de fin d'exercice | texte `Durée : 00:02:41` |
| Bouton d'enchaînement | libellé `Activité suivante` (deux exemplaires : mobile et bureau) |
| URL de la série | `a[href*="/library/trainings/exercises/"][href*="/activities"]`, « Retour à la liste » |
| Réussite d'une ligne | `NN%` dans le texte de la ligne |
| Pagination | `n / total` dans un `<nav>` |

`Rejouer l'entraînement` (`a[href="/training/activity/start"]`) est couvert par
la liste d'exclusion `nextNever` : il ne doit jamais être cliqué.

### Catalogue des séries

| Type | Section | Exercice |
|---|---|---|
| Audio | Listening | Partie 1 (`1085`), 2 (`1136`), 3 (`1201`), 4 (`1297`) |
| Texte | Reading | Partie 5 (`492`), 6 (`669`), 7A (`817`), **7B (`977`)** |

URL : `/library/trainings/exercises/{id}/activities`. Partie 7(B) est la plus
rentable : textes longs, 5 pages, durée annoncée 00:25:00. Une pause de 30 s par
page y reste crédible.

## Sélecteurs modifiables

`ge-selectors.js` décrit chaque cible par trois écritures, essayées dans cet
ordre :

1. `xp` — XPath relatif, saisi par l'utilisateur, prioritaire ;
2. `css` — sélecteur CSS ;
3. `rx` — expression régulière sur le libellé du bouton ou du lien.

Un champ vide est ignoré : le repli suivant prend la main. Une expression
invalide est ignorée de la même façon, sans faire tomber le script. L'onglet
« Sélecteurs » du tableau de bord édite les trois champs de chaque cible, avec
un bouton « Tester » qui interroge l'onglet global-exam.com ouvert.

Les surcharges sont enregistrées dans `chrome.storage.local` sous la clé `sel`.

## Réglages

| Réglage | Défaut | Effet |
|---|---|---|
| `pageDelay` | 30 s | attente moyenne par page |
| `pageJitter` | ± 20 s | amplitude du tirage autour de la moyenne |
| `correctRate` | 100 % | proportion de bonnes réponses visée |
| `runFor` | 0 | durée de session, `0` = illimité |
| `chain` | activé | enchaîner les exercices |
| `showHud` | activé | panneau flottant en bas à droite |

Le panneau flottant affiche la progression dans l'exercice, le temps restant
estimé et le compte à rebours de session.

**Attention au relevé du site.** GlobalExam publie un suivi à
`https://exam.global-exam.com/stats` : temps total, nombre d'activités, moyenne
par jour. Au-delà de 5 h par jour, le profil devient un point aberrant sur ce
graphique. Le popup et le tableau de bord l'annoncent.

### Constantes internes

En tête de `content.js`, non exposées dans l'interface :

```js
ANSWER_DELAY   = 300    // pause entre deux cases d'une même page
SCAN_DELAY     = 600    // cadence de réessai quand la page n'est pas prête
CLICK_GUARD    = 700    // écart minimal entre deux clics « suivant »
REDIRECT_GUARD = 5000   // écart minimal entre deux redirections automatiques
```

`CLICK_GUARD` ne doit **pas** être indexé sur `pageDelay`, sinon la pause est
comptée deux fois et « 30 s » en vaut 60.

## Contraintes du site

Trois particularités expliquent des choix de code qui paraîtraient sinon tordus.

**`id` dupliqués.** Le site rend chaque question dans son propre bloc et donne à
tous ces blocs le même `id="question-wrapper"`. `querySelector` n'en renvoie
qu'un ; `getRoots()` utilise donc `querySelectorAll('[id="question-wrapper"]')`.
Se fier au premier ne fait voir qu'une question sur cinq.

**Bouton de progression mouvant.** Son libellé dépend de l'état (`Passer`,
`Suivant`, `Terminer`) et sa position du gabarit de page. `scoreButton()` note
chaque bouton visible — libellé, présence dans un `<nav>`, position — avec
`nextNever` en liste d'exclusion. Le bonus de position est **borné** : non borné,
un bouton hors zone visible obtient un score très négatif qui écrase le libellé
et le rend « introuvable ».

**Signature de page.** Toutes les cases ont `value="on"` et l'URL ne change pas
entre deux questions d'un même texte. `signature()` s'appuie donc sur les `id`
(`radio-{question}-{réponse}`) et le compteur de pagination.

## Développement

```bash
# charger : chrome://extensions → Mode développeur → Charger non empaquetée
# après chaque modification : bouton ↻ sur la carte de l'extension, puis F5 sur l'onglet

node selftest.js                         # motifs et ordre de résolution
node --check extension/content.js        # vérification statique
node --check extension/ge-selectors.js

cd extension && zip -r ../paquet.zip . -x '.*' -x '*/.DS_Store'
```

Incrémenter `version` dans `manifest.json` à chaque envoi au Chrome Web Store,
sinon le paquet est rejeté.

## Tests

`selftest.js` couvre la logique pure : les motifs, appliqués aux chaînes réelles
relevées sur le site, et l'ordre de résolution XPath → CSS → libellé. Il tourne
sans navigateur.

Le reste se vérifie à la main :

- une **maquette DOM** reproduisant la structure du site (cases masquées,
  labels, bouton temporairement désactivé), pour la boucle et les cas limites ;
- des **passes réelles**, la barre de score de GlobalExam servant d'oracle.

Attention au piège rencontré : évaluer du code depuis la console du navigateur ne
teste **pas** le monde isolé. La lecture de l'état Vue y fonctionne toujours,
même quand elle est impossible depuis un script de contenu.

## Limites connues

- Dépend de la structure du DOM et de l'état interne du site, susceptibles de
  changer sans préavis. L'éditeur de sélecteurs est la réponse prévue.
- Sans correction accessible (examen blanc), aucune réponse n'est identifiable :
  tirage au hasard.
- Le drapeau marche/arrêt est global à `chrome.storage` : plusieurs onglets
  démarrent ensemble.
- `runFor` est figé au démarrage de la session. Le modifier en cours de route ne
  déplace pas l'échéance.
- L'ordre des activités dans une liste n'est pas garanti par le site. Le choix
  « première ligne pas à 100 % » reste correct, mais l'ordre peut surprendre.
- `"world": "MAIN"` requiert Chrome 111 ou plus récent ; en deçà, seul le repli
  par ouverture de la correction fonctionne.

## Licence

MIT — voir [LICENSE](LICENSE).
