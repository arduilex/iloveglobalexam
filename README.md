# GlobalExam Auto-Answer

Extension Chrome (Manifest V3) qui répond automatiquement aux QCM de
global-exam.com. JavaScript nu, aucune dépendance, aucune étape de build : le
dossier `extension/` se charge tel quel.

> Projet personnel, sans lien avec l'éditeur de global-exam.com.

## Architecture

Le point structurant est la frontière entre les deux mondes d'exécution. Un
script de contenu ordinaire voit le DOM mais **aucun objet JavaScript de la
page** — or la bonne réponse vit dans l'état des composants Vue du site. D'où le
second script, déclaré `"world": "MAIN"`.

```
  popup.html / popup.js          ← réglages, compteurs
          │  chrome.storage.local
          ▼
┌─────────────────────────────────────────────────────────────┐
│  onglet global-exam.com                                     │
│                                                             │
│   content.js            world: ISOLATED                     │
│     │  ▲                                                    │
│     │  │  postMessage  { __geAuto: 'ask' | 'answers' }      │
│     ▼  │                                                    │
│   page-bridge.js        world: MAIN                         │
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
ouverture puis fermeture réelles du panneau de correction. Le statut affiche la
source retenue, `[pont]` ou `[correction]`.

## Carte du code

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV3, deux entrées `content_scripts` (ISOLATED + MAIN), permission `storage`, hôte restreint à `*.global-exam.com` |
| `content.js` | Boucle principale, détection des questions, sélection, clics, bouton suivant, panneau flottant |
| `page-bridge.js` | Répond aux requêtes du script de contenu en lisant l'arbre de composants Vue |
| `popup.{html,css,js}` | Réglages et compteurs, via `chrome.storage.local` |

### Boucle — `step()` dans `content.js`

1. Arrêt immédiat si l'URL correspond à `END_PAGE` (résultats, correction)
2. `getGroups(getRoots())` → un tableau de cases par question
3. Pour chaque groupe non répondu : `answerGroup()` → pont, sinon correction, sinon hasard
4. Sortie tant qu'il reste une question sans réponse
5. `findNextButton()` → clic si actif, puis `waitForChange()` sur la signature de page

L'état vit dans `chrome.storage.local` : le popup écrit, `content.js` réagit via
`onChanged`. C'est ce qui permet à la boucle de reprendre après un rechargement
de page sans mémoire partagée.

## Contraintes du site

Trois particularités expliquent des choix de code qui paraîtraient sinon tordus.

**`id` dupliqués.** Le site rend chaque question dans son propre bloc et donne à
tous ces blocs le même `id="question-wrapper"`. `querySelector` n'en renvoie
qu'un ; `getRoots()` utilise donc `querySelectorAll('[id="question-wrapper"]')`.
Se fier au premier ne fait voir qu'une question sur cinq.

**Bouton de progression mouvant.** Son libellé dépend de l'état (`Passer`,
`Suivant`, `Valider`) et sa position du gabarit de page (barre `<nav>` ou pied de
page). `scoreButton()` note chaque bouton visible — libellé, présence dans un
`<nav>`, position — avec `NEXT_NEVER` en liste d'exclusion. Le bonus de position
est **borné** : non borné, un bouton hors zone visible obtient un score très
négatif qui écrase le libellé et le rend « introuvable ».

**Signature de page.** Toutes les cases ont `value="on"` et l'URL ne change pas
entre deux questions d'un même texte. `signature()` s'appuie donc sur les `id`
(`radio-{question}-{réponse}`) et le compteur de pagination.

## Réglages internes

En tête de `content.js`, non exposés dans l'interface :

```js
ANSWER_DELAY = 300   // pause entre deux cases d'une même page
SCAN_DELAY   = 600   // cadence de réessai quand la page n'est pas prête
CLICK_GUARD  = 700   // écart minimal entre deux clics « suivant »
```

Ces valeurs n'ont pas d'effet perceptible : Chrome bride les minuteurs à 1 Hz dès
que l'onglet passe en arrière-plan. `CLICK_GUARD` ne doit **pas** être indexé sur
`nextDelay`, sinon la pause est comptée deux fois.

Les expressions régulières `NEXT_STRONG` / `NEXT_WEAK` / `NEXT_NEVER` et
`CORRECTION_OPEN` / `CORRECTION_CLOSE` sont les points d'adaptation si les
libellés du site changent.

## Développement

```bash
# charger : chrome://extensions → Mode développeur → Charger non empaquetée
# après chaque modification : bouton ↻ sur la carte de l'extension, puis F5 sur l'onglet

node --check extension/content.js        # seule vérification statique
node --check extension/page-bridge.js

cd extension && zip -r ../paquet.zip . -x '.*' -x '*/.DS_Store'
```

Incrémenter `version` dans `manifest.json` à chaque envoi au Chrome Web Store,
sinon le paquet est rejeté. `store-listing.md` contient les textes de la fiche.

## Tests

Pas de suite automatisée. La mise au point s'est faite sur deux terrains :

- une **maquette DOM** reproduisant la structure du site (cases masquées, labels,
  bouton temporairement désactivé), utilisée pour la boucle et les cas limites ;
- des **passes réelles** sur le site, la barre de score de GlobalExam servant
  d'oracle — 10 questions consécutives, score passé de 0/29 à 10/29.

Attention au piège rencontré : évaluer du code depuis la console du navigateur ne
teste **pas** le monde isolé. La lecture de l'état Vue y fonctionne toujours,
même quand elle est impossible depuis un script de contenu.

## Limites connues

- Dépend de la structure du DOM et de l'état interne du site, susceptibles de
  changer sans préavis.
- Sans correction accessible (examen blanc), aucune réponse n'est identifiable :
  tirage au hasard.
- Le drapeau marche/arrêt est global à `chrome.storage` : plusieurs onglets
  démarrent ensemble.
- `"world": "MAIN"` requiert Chrome 111 ou plus récent ; en deçà, seul le repli
  par ouverture de la correction fonctionne.

## Licence

MIT — voir [LICENSE](LICENSE).

```
Copyright (c) 2026 Alex

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
