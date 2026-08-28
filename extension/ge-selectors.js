/* GlobalExam Auto — table des sélecteurs
 *
 * Chargé dans deux contextes : le script de contenu (monde isolé) et la page
 * du tableau de bord. Il n'agit pas de lui-même, il ne fait que résoudre des
 * cibles.
 *
 * Chaque cible accepte trois écritures, essayées dans cet ordre :
 *   1. `xp`  — XPath relatif, saisi par l'utilisateur, prioritaire ;
 *   2. `css` — sélecteur CSS ;
 *   3. `rx`  — expression régulière sur le libellé du bouton ou du lien.
 * Un champ vide est ignoré : le repli suivant prend la main. C'est ce qui
 * permet de survivre à un changement d'interface sans toucher au code.
 */
(() => {
  // Valeurs relevées sur exam.global-exam.com le 2026-08-28.
  const DEF = {
    // --- pages de contenu -------------------------------------------------
    nextStrong: {
      xp: '',
      css: '',
      // « confirmer » et « oui » couvrent la fenêtre modale qui demande parfois
      // de valider la fin de l'exercice. Bornés par \b : sans cela, « oui »
      // se retrouve au milieu de mots comme « oui-dire ».
      rx: '(suivant|next|continuer|continue|valider|validate|terminer|finish|submit|commencer|démarrer|start|\\bconfirmer\\b|\\bconfirm\\b|\\boui\\b)',
    },
    nextWeak: { xp: '', css: '', rx: '(passer|skip|ignorer)' },
    nextNever: {
      xp: '',
      css: '',
      rx: '(précédent|precedent|previous|retour|back|annuler|cancel|fermer|close|quitter|exit|signaler|formulaire|feedback|correction|transcription|transcript|aide|help|indice|hint|pause|lecture|play|rejouer|replay|volume|son|paramètre|settings|menu|sommaire|déconnexion|logout)',
    },
    correctionOpen: { xp: '', css: '', rx: '(voir|afficher|view|show).{0,14}correction|^correction$' },
    correctionClose: { xp: '', css: '', rx: '(fermer|masquer|close|hide).{0,14}correction' },
    correctMark: { xp: '', css: '[class*="bg-success"]', rx: '' },
    questionRoot: { xp: '', css: '[id="question-wrapper"]', rx: '' },
    pager: { xp: '', css: 'nav', rx: '(\\d+)\\s*/\\s*(\\d+)' },

    // --- page de fin d'exercice ------------------------------------------
    grade: { xp: '', css: '[data-testid="your-grade"]', rx: '(\\d+)\\s*/\\s*(\\d+)' },
    duration: { xp: '', css: '', rx: 'dur[ée]e\\s*:?\\s*(?:(\\d+):)?(\\d+):(\\d+)' },
    activityTitle: { xp: '', css: 'p[class*="text-white"]', rx: '' },
    nextActivity: { xp: '', css: '', rx: 'activit[ée]\\s+suivante|next\\s+activity' },
    backToList: {
      xp: '',
      css: 'a[href*="/library/trainings/exercises/"][href*="/activities"]',
      rx: '',
    },

    // --- liste des activités d'une série ----------------------------------
    launchButton: {
      xp: '',
      css: 'button[data-testid^="activity-button-"]',
      rx: '^(lancer|reprendre|start|resume)$',
    },
    rowPercent: { xp: '', css: '', rx: '(\\d+)\\s*%' },

    // --- reconnaissance des URL -------------------------------------------
    // L'ordre de test compte, voir pageKind() : `listUrl` est plus précis que
    // `libraryUrl` et doit être essayé avant lui.
    resultUrl: { xp: '', css: '', rx: '/training/activity/[^/]+/result' },
    listUrl: { xp: '', css: '', rx: '/library/trainings/exercises/[^/]+/activities' },
    contentUrl: { xp: '', css: '', rx: '/training/activity/[^/]+/content' },
    libraryUrl: { xp: '', css: '', rx: '/library/trainings' },
  };

  // Éléments passés en revue quand la cible est décrite par un libellé.
  const CANDIDATS = 'button, a, [role="button"]';

  let over = {};
  const cacheRx = new Map();

  function conf(nom) {
    return { ...(DEF[nom] || {}), ...(over[nom] || {}) };
  }

  /** RegExp compilée d'une cible, ou null si le champ est vide ou invalide. */
  function rx(nom) {
    const src = conf(nom).rx;
    if (!src) return null;
    if (cacheRx.has(src)) return cacheRx.get(src);
    let re = null;
    try {
      re = new RegExp(src, 'i');
    } catch {
      /* motif invalide saisi dans les réglages : on l'ignore */
    }
    cacheRx.set(src, re);
    return re;
  }

  function xpath(expr, scope) {
    const doc = scope.ownerDocument || scope;
    const out = [];
    try {
      const r = doc.evaluate(expr, scope, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    } catch {
      /* XPath invalide saisi dans les réglages : on retombe sur le CSS */
    }
    return out;
  }

  function labelOf(el) {
    return ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
  }

  /** Tous les éléments d'une cible, XPath puis CSS puis libellé. */
  function all(nom, scope) {
    const root = scope || document;
    const c = conf(nom);
    if (c.xp) {
      const n = xpath(c.xp, root);
      if (n.length) return n;
    }
    if (c.css) {
      try {
        const n = Array.from(root.querySelectorAll(c.css));
        if (n.length) return n;
      } catch {
        /* sélecteur CSS invalide : on retombe sur le libellé */
      }
    }
    const re = rx(nom);
    if (!re) return [];
    return Array.from(root.querySelectorAll(CANDIDATS)).filter((el) => re.test(labelOf(el)));
  }

  /** Premier élément visible d'une cible, ou le premier tout court. */
  function pick(nom, scope) {
    const n = all(nom, scope);
    return n.find((el) => el.isConnected && el.checkVisibility?.({ checkVisibilityCSS: true })) || n[0] || null;
  }

  window.GE_SEL = {
    defaults: DEF,
    names: Object.keys(DEF),
    setOverrides(o) {
      over = o || {};
      cacheRx.clear();
    },
    conf,
    rx,
    all,
    pick,
    labelOf,
  };
})();
