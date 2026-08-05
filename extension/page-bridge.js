/* GlobalExam Auto-Answer — pont vers le monde de la page
 *
 * Ce fichier est injecté avec "world": "MAIN", c'est-à-dire dans le contexte
 * JavaScript de la page elle-même. C'est indispensable : le script de contenu
 * ordinaire vit dans un « monde isolé » qui partage le DOM mais PAS les objets
 * JavaScript de la page. Or la bonne réponse se trouve dans l'état des
 * composants Vue, accessible seulement via `#app.__vue_app__` — une propriété
 * posée par le code du site, donc invisible depuis le monde isolé.
 *
 * Le pont ne fait rien de lui-même : il répond aux demandes du script de
 * contenu, et uniquement à celles-ci.
 */
(() => {
  if (window.__geAutoBridge) return;
  window.__geAutoBridge = true;

  /** Parcourt l'arbre des composants Vue et relève, pour chaque question,
   *  l'identifiant de la réponse marquée `is_right_answer`.
   *  Renvoie un tableau de paires [idQuestion, idRéponse]. */
  function bonnesReponses() {
    const app = document.getElementById('app');
    const racine = app && app.__vue_app__ ? app._vnode : null;
    const map = new Map();
    if (!racine) return [];

    const vus = new WeakSet();
    let n = 0;

    const noter = (qid, reponses) => {
      if (!qid || !Array.isArray(reponses) || map.has(String(qid))) return;
      const bonne = reponses.find((a) => a && a.is_right_answer === true);
      if (bonne) map.set(String(qid), bonne.id);
    };

    (function parcourir(vnode, prof) {
      if (!vnode || prof > 45 || n > 5000) return;
      if (vnode.component && !vus.has(vnode.component)) {
        vus.add(vnode.component);
        n++;
        const p = vnode.component.props || {};
        const q = p.examQuestion;
        if (q) noter(q.id, q.exam_answers_correction || q.exam_answers);
        if (Array.isArray(p.examQuestions)) {
          p.examQuestions.forEach((x) => noter(x.id, x.exam_answers_correction || x.exam_answers));
        }
        parcourir(vnode.component.subTree, prof + 1);
      }
      const enfants = vnode.children;
      if (Array.isArray(enfants)) enfants.forEach((c) => parcourir(c, prof + 1));
      else if (enfants && typeof enfants === 'object' && enfants.default) {
        try {
          parcourir(enfants.default(), prof + 1);
        } catch {
          /* slot non appelable hors rendu */
        }
      }
    })(racine, 0);

    return [...map.entries()];
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.__geAuto !== 'ask' || typeof msg.id !== 'number') return;

    let pairs = [];
    try {
      pairs = bonnesReponses();
    } catch {
      pairs = []; // l'état Vue a changé de forme : le script de contenu prendra le repli
    }
    window.postMessage({ __geAuto: 'answers', id: msg.id, pairs }, '*');
  });
})();
