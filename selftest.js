/* Vérification hors navigateur : `node selftest.js`
 *
 * Elle porte sur la seule logique pure de l'extension — la table des sélecteurs
 * et son ordre de résolution. Les chaînes testées sont celles relevées sur
 * exam.global-exam.com le 2026-08-28, pas des exemples inventés.
 */
const assert = require('node:assert');

// --- environnement minimal ---------------------------------------------------
const noeud = (texte, attrs = {}, tags = []) => ({
  innerText: texte,
  isConnected: true,
  tags,
  getAttribute: (k) => attrs[k] ?? null,
  checkVisibility: () => true,
});

let ARBRE = [];
global.window = {};
global.document = {
  querySelectorAll: (sel) => ARBRE.filter((n) => n.tags.includes(sel)),
  evaluate: (expr) => {
    const trouve = ARBRE.filter((n) => n.tags.includes(expr));
    return { snapshotLength: trouve.length, snapshotItem: (i) => trouve[i] };
  },
};

require('./extension/ge-selectors.js');
const S = global.window.GE_SEL;

const test = (nom, fn) => {
  try {
    fn();
    console.log('  ok  ' + nom);
  } catch (e) {
    console.error('FAIL  ' + nom + '\n      ' + e.message);
    process.exitCode = 1;
  }
};

// --- 1. les motifs, sur les chaînes réelles du site --------------------------
test('durée de la page de fin', () => {
  const m = 'Votre score 13 /25 Durée : 00:02:41'.match(S.rx('duration'));
  assert.ok(m, 'aucune correspondance');
  assert.strictEqual(+(m[1] || 0) * 3600 + +m[2] * 60 + +m[3], 161);
});

test('durée au-delà d’une heure', () => {
  const m = 'Durée : 01:07:09'.match(S.rx('duration'));
  assert.strictEqual(+(m[1] || 0) * 3600 + +m[2] * 60 + +m[3], 4029);
});

test('score de la page de fin', () => {
  const m = '13 /25'.match(S.rx('grade'));
  assert.deepStrictEqual([+m[1], +m[2]], [13, 25]);
});

test('pourcentage d’une ligne de la liste', () => {
  assert.strictEqual(+'Entraînement 209 Facile 0% Lancer'.match(S.rx('rowPercent'))[1], 0);
  assert.strictEqual(+'Entraînement 202 Facile 52% Lancer'.match(S.rx('rowPercent'))[1], 52);
});

test('pagination du pied de page', () => {
  const m = '‹ 1 / 5 Passer ›'.match(S.rx('pager'));
  assert.deepStrictEqual([+m[1], +m[2]], [1, 5]);
});

test('bouton « Activité suivante »', () => {
  assert.ok(S.rx('nextActivity').test('Activité suivante'));
  assert.ok(!S.rx('nextActivity').test("Rejouer l'entraînement"));
});

test('liste d’exclusion : ne jamais rejouer ni revenir', () => {
  const never = S.rx('nextNever');
  assert.ok(never.test("Rejouer l'entraînement"));
  assert.ok(never.test('Retour à la liste'));
  assert.ok(never.test('Voir la correction'));
  assert.ok(!never.test('Suivant'));
});

test('libellés de progression', () => {
  assert.ok(S.rx('nextStrong').test('Suivant'));
  assert.ok(S.rx('nextStrong').test('Terminer'));
  assert.ok(!S.rx('nextStrong').test('Passer'));
  assert.ok(S.rx('nextWeak').test('Passer'));
});

test('confirmation de fin d’exercice', () => {
  assert.ok(S.rx('nextStrong').test('Oui'));
  assert.ok(S.rx('nextStrong').test('Confirmer'));
  // « oui » borné : il ne doit pas être trouvé au milieu d'un autre mot.
  assert.ok(!S.rx('nextStrong').test('Ouistiti'));
});

// --- 2. reconnaissance des URL, sans recouvrement ----------------------------
test('les types de page ne se recouvrent pas', () => {
  const cas = {
    '/training/activity/6755399455090507/result': 'result',
    '/library/trainings/exercises/977/activities': 'list',
    '/training/activity/6755399455090507/content/10339': 'content',
    // La bibliothèque et ses sous-pages : conseil affiché, aucun clic.
    '/library/trainings': 'library',
    '/library/trainings/sections/487/exercises': 'library',
    // Tout le reste déclenche la redirection vers la bibliothèque.
    '/stats': 'other',
    '/user-plannings': 'other',
    '/library/exams': 'other',
  };
  // Même ordre que pageKind() dans content.js : listUrl AVANT libraryUrl.
  const kind = (p) =>
    S.rx('resultUrl').test(p)
      ? 'result'
      : S.rx('listUrl').test(p)
        ? 'list'
        : S.rx('contentUrl').test(p)
          ? 'content'
          : S.rx('libraryUrl').test(p)
            ? 'library'
            : 'other';
  for (const [p, attendu] of Object.entries(cas)) assert.strictEqual(kind(p), attendu, p);
});

// --- 3. ordre de résolution : XPath, puis CSS, puis libellé ------------------
const parXpath = noeud('par-xpath', {}, ['//le-xpath']);
const parCss = noeud('par-css', {}, ['.le-css', 'button, a, [role="button"]']);
const parLibelle = noeud('Activité suivante', {}, ['button, a, [role="button"]']);

test('le XPath saisi l’emporte sur tout', () => {
  ARBRE = [parXpath, parCss, parLibelle];
  S.setOverrides({ nextActivity: { xp: '//le-xpath', css: '.le-css', rx: 'activit[ée] suivante' } });
  assert.strictEqual(S.pick('nextActivity').innerText, 'par-xpath');
});

test('sans XPath, le CSS l’emporte sur le libellé', () => {
  S.setOverrides({ nextActivity: { xp: '', css: '.le-css', rx: 'activit[ée] suivante' } });
  assert.strictEqual(S.pick('nextActivity').innerText, 'par-css');
});

test('sans XPath ni CSS, le libellé sert de repli', () => {
  S.setOverrides({ nextActivity: { xp: '', css: '', rx: 'activit[ée] suivante' } });
  assert.strictEqual(S.pick('nextActivity').innerText, 'Activité suivante');
});

test('un XPath sans correspondance retombe sur le repli suivant', () => {
  S.setOverrides({ nextActivity: { xp: '//introuvable', css: '.le-css', rx: '' } });
  assert.strictEqual(S.pick('nextActivity').innerText, 'par-css');
});

test('un XPath invalide ne fait pas tomber le script', () => {
  S.setOverrides({ nextActivity: { xp: '((((', css: '.le-css', rx: '' } });
  assert.strictEqual(S.pick('nextActivity').innerText, 'par-css');
});

test('une regex invalide est ignorée', () => {
  S.setOverrides({ nextActivity: { xp: '', css: '', rx: '(((' } });
  assert.strictEqual(S.rx('nextActivity'), null);
  assert.deepStrictEqual(S.all('nextActivity'), []);
});

test('sans surcharge, les valeurs par défaut reviennent', () => {
  S.setOverrides({});
  assert.strictEqual(S.conf('grade').css, '[data-testid="your-grade"]');
});

console.log(process.exitCode ? '\néchec' : '\ntout passe');
