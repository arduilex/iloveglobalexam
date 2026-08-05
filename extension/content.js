/* GlobalExam Auto-Answer — script de contenu
 *
 * Boucle : coche une réponse au hasard dans chaque groupe de réponses visible,
 * puis clique sur le bouton « suivant », et recommence — jusqu'à l'arrêt manuel.
 */
(() => {
  if (window.__geAutoAnswerLoaded) return;
  window.__geAutoAnswerLoaded = true;

  const TAG = '[GE-Auto]';

  // ---------------------------------------------------------------- config --
  const DEFAULTS = {
    running: false,
    nextDelay: 3000, // ms d'attente avant de cliquer sur « suivant »
    correctRate: 100, // % de bonnes réponses quand la correction est lisible
    showHud: true, // panneau flottant sur la page
  };

  // Constantes internes, non réglables : leur valeur exacte n'a aucun effet
  // perceptible, et Chrome bride de toute façon les minuteurs à 1 Hz dès que
  // l'onglet passe en arrière-plan.
  const ANSWER_DELAY = 300; // pause entre deux cases cochées d'une même page
  const SCAN_DELAY = 600; // cadence de réessai quand la page n'est pas prête
  const CLICK_GUARD = 700; // écart minimal entre deux clics sur « suivant »

  // Replis si aucun bloc « question-wrapper » n'est trouvé.
  const ROOT_SELECTORS = ['section', 'main'];

  // Le libellé du bouton change selon l'état : « Passer » tant que la question
  // n'est pas répondue, « Suivant » une fois cochée. D'où les deux niveaux.
  const NEXT_STRONG =
    /(suivant|next|continuer|continue|valider|validate|terminer|finish|submit|commencer|démarrer|start)/i;
  const NEXT_WEAK = /(passer|skip|ignorer)/i;
  // Tout ce qu'il ne faut surtout pas cliquer.
  const NEXT_NEVER =
    /(précédent|precedent|previous|retour|back|annuler|cancel|fermer|close|quitter|exit|signaler|formulaire|feedback|correction|transcription|transcript|aide|help|indice|hint|pause|lecture|play|rejouer|replay|volume|son|paramètre|settings|menu|sommaire|déconnexion|logout)/i;

  // Correction intégrée à l'entraînement : le bouton bascule entre les deux
  // libellés, et l'option juste reçoit une classe « bg-success-* ».
  const CORRECTION_OPEN = /(voir|afficher|view|show).{0,14}correction|^correction$/i;
  const CORRECTION_CLOSE = /(fermer|masquer|close|hide).{0,14}correction/i;
  const CORRECT_MARK = '[class*="bg-success"]';

  // Pages de fin de parcours : on s'y arrête au lieu de risquer de cliquer sur
  // « Recommencer » / « Voir la correction » et de relancer une activité.
  const END_PAGE = /\/(result|results|resultat|résultat|stats|statistiques|correction|corrige|corrigé)(\/|$)/i;

  let cfg = { ...DEFAULTS };
  let running = false;
  let loopToken = 0;
  let lastNextClick = 0;
  let lastOutcome = null; // 'juste' | 'fausse' | 'hasard'
  let stats = { answers: 0, correct: 0, pages: 0, activity: null };
  let status = 'Arrêté';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log(`%c${TAG}`, 'color:#a855f7;font-weight:bold', ...a);

  // ------------------------------------------------------------- utilitaires --
  function visible(el) {
    return !!el && el.isConnected && el.checkVisibility({ checkVisibilityCSS: true });
  }

  /** Simule un vrai clic (pointer + souris) : plus fidèle qu'un simple .click()
   *  pour les composants React qui écoutent pointerdown/mousedown. */
  function realClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    const down = { ...base, buttons: 1 };
    const up = { ...base, buttons: 0, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerover', down));
    el.dispatchEvent(new MouseEvent('mouseover', down));
    el.dispatchEvent(new PointerEvent('pointerdown', down));
    el.dispatchEvent(new MouseEvent('mousedown', down));
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* certains éléments ne sont pas focusables */
    }
    el.dispatchEvent(new PointerEvent('pointerup', up));
    el.dispatchEvent(new MouseEvent('mouseup', up));
    el.dispatchEvent(new MouseEvent('click', up));
  }

  /** Dernier recours : force l'état coché en passant par le setter natif,
   *  ce qui contourne le « value tracker » de React et déclenche onChange. */
  function forceCheck(input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    setter?.call(input, true);
    input.dispatchEvent(new Event('click', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // --------------------------------------------------- détection des réponses --
  /** Sur les pages « listening », GlobalExam rend UNE question par bloc mais
   *  donne à tous ces blocs le même id="question-wrapper" (id dupliqué, ce que
   *  querySelector ne sait pas voir : il n'en renvoie qu'un). On récupère donc
   *  tous les conteneurs, pas le premier. */
  function getRoots() {
    const wrappers = Array.from(document.querySelectorAll('[id="question-wrapper"]')).filter((el) =>
      el.querySelector('input[type="radio"]'),
    );
    if (wrappers.length) return wrappers;
    for (const sel of ROOT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.querySelector('input[type="radio"]')) return [el];
    }
    return [document.body];
  }

  function radiosIn(roots) {
    const out = [];
    for (const root of roots) {
      for (const r of root.querySelectorAll('input[type="radio"]')) {
        if (!r.disabled && visible(r) && !out.includes(r)) out.push(r);
      }
    }
    return out;
  }

  function labelFor(input) {
    if (input.id) {
      const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) return l;
    }
    return input.closest('label') || input.parentElement?.querySelector('label') || null;
  }

  /** Découpe les radios en groupes = une question. L'attribut `name` porte l'id
   *  de la question, le regroupement est donc exact. Repli s'il venait à
   *  disparaître : un conteneur de question = un groupe. */
  function getGroups(roots) {
    const radios = radiosIn(roots);
    if (radios.length === 0) return [];

    const cle = radios.every((r) => r.name)
      ? (r) => r.name
      : (r) => roots.findIndex((root) => root.contains(r));

    const map = new Map();
    for (const r of radios) {
      const k = cle(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return [...map.values()];
  }

  // ------------------------------------------------- lecture de la correction --
  async function waitFor(test, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (test()) return true;
      await sleep(120);
    }
    return !!test();
  }

  /** Bloc DOM de la question à laquelle appartient ce groupe d'options. */
  function questionRootOf(group) {
    const wrapper = group[0].closest('[id="question-wrapper"]');
    if (wrapper) return wrapper;
    let el = group[0].parentElement;
    while (el && el !== document.body && !group.every((r) => el.contains(r))) el = el.parentElement;
    return el || document.body;
  }

  function correctionButtons(root) {
    const btns = Array.from(root.querySelectorAll('button, [role="button"]')).filter(visible);
    return {
      open: btns.find((b) => CORRECTION_OPEN.test(labelOf(b))),
      close: btns.find((b) => CORRECTION_CLOSE.test(labelOf(b))),
    };
  }

  /** Ouvre la correction, relève l'option juste, referme. Renvoie son id, ou
   *  null si l'activité n'offre pas de correction (examen blanc par exemple).
   *
   *  Deux points vérifiés en conditions réelles :
   *  — pendant que la correction est ouverte, le conteneur des options porte
   *    « pointer-events-none » : impossible de cocher sans refermer d'abord ;
   *  — la fermeture décoche tout, il faut donc mémoriser l'id AVANT de fermer.
   */
  async function readCorrection(group) {
    const root = questionRootOf(group);
    const { open } = correctionButtons(root);
    if (!open || !isEnabled(open)) return null;

    realClick(open);
    const affichee = await waitFor(() => root.querySelector(CORRECT_MARK), 3000);

    let id = null;
    if (affichee) {
      const marque = Array.from(root.querySelectorAll(CORRECT_MARK)).find((s) =>
        s.querySelector('input[type="radio"]'),
      );
      if (marque) id = marque.querySelector('input[type="radio"]').id;
    }

    const { close } = correctionButtons(root);
    if (close) realClick(close);
    await waitFor(() => !root.querySelector(CORRECT_MARK), 2000);
    return id;
  }

  // ------------------------------------------------------------- répondre ----
  async function clickOption(choice) {
    const label = labelFor(choice);
    // Le vrai clic humain se fait sur la pastille ronde à l'intérieur du label.
    const target = label ? label.querySelector('span') || label : choice;

    // La vérification synchrone couvre le cas normal ; l'attente n'a lieu que
    // si le clic n'a pas pris (Chrome bride les minuteurs en arrière-plan).
    realClick(target);
    if (choice.checked) return true;
    await sleep(80);
    if (choice.checked) return true;

    realClick(choice); // repli : clic direct sur l'input masqué
    if (choice.checked) return true;
    await sleep(80);
    if (choice.checked) return true;

    forceCheck(choice); // dernier recours : setter natif + événements
    return choice.checked;
  }

  async function answerGroup(group) {
    const ids = group.map((r) => r.id);
    const correctId = await readCorrection(group);

    // La correction re-rend le bloc : on récupère les éléments frais par id.
    const frais = ids.every(Boolean)
      ? ids.map((id) => document.getElementById(id)).filter(Boolean)
      : group;
    const options = frais.length ? frais : group;
    const bonne = correctId ? options.find((r) => r.id === correctId) : null;

    let choice;
    if (bonne) {
      const viser = Math.random() * 100 < cfg.correctRate;
      const autres = options.filter((r) => r !== bonne);
      choice = viser || autres.length === 0 ? bonne : autres[Math.floor(Math.random() * autres.length)];
      lastOutcome = choice === bonne ? 'juste' : 'fausse';
    } else {
      choice = options[Math.floor(Math.random() * options.length)];
      lastOutcome = 'hasard';
    }

    const ok = await clickOption(choice);
    if (ok && lastOutcome === 'juste') stats.correct++;
    return ok;
  }

  // ------------------------------------------------------- bouton « suivant » --
  function isEnabled(el) {
    if (!el || !visible(el)) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.hasAttribute('data-disabled')) return false;
    const st = getComputedStyle(el);
    return st.pointerEvents !== 'none';
  }

  function labelOf(el) {
    return ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
  }

  /** Le bouton « suivant » change de place ET de libellé selon le type de page
   *  (barre de pagination <nav>, pied de page simple, fenêtre modale…).
   *  On note donc chaque bouton visible au lieu de se fier à un chemin figé. */
  function scoreButton(b) {
    const txt = labelOf(b);
    if (NEXT_NEVER.test(txt)) return -1;
    let s = 0;
    if (NEXT_STRONG.test(txt)) s += 100;
    else if (NEXT_WEAK.test(txt)) s += 60;
    else return -1; // pas de libellé exploitable : traité par le repli structurel
    if (b.closest('nav')) s += 25;
    // Bonus de position : simple départage, borné à sa plage prévue. Sans les
    // bornes, un bouton hors de la zone visible (top négatif, page défilée)
    // obtient un score de plusieurs milliers en négatif qui écrase le libellé,
    // et l'extension le déclare « introuvable » alors qu'il est bien là.
    const r = b.getBoundingClientRect();
    const ratio = (v, total) => Math.min(1, Math.max(0, v / Math.max(1, total)));
    s += Math.round(20 * ratio(r.top, window.innerHeight)); // plus bas = mieux
    s += Math.round(10 * ratio(r.left, window.innerWidth)); // plus à droite = mieux
    return s;
  }

  function findNextButton() {
    // 1) Si une fenêtre modale est ouverte, le reste de la page est inerte :
    //    on ne cherche que dedans, et uniquement un bouton de confirmation.
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], dialog')).find(visible);
    const scope = dialog || document;

    // Les boutons désactivés restent candidats : c'est ce qui permet d'annoncer
    // « bouton désactivé (audio en cours) » plutôt que « introuvable ». Les
    // boutons actifs passent simplement devant à note égale.
    const scored = Array.from(scope.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((b) => ({ b, s: scoreButton(b), ok: isEnabled(b) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.ok - a.ok || b.s - a.s);
    if (scored.length) return scored[0].b;
    if (dialog) return null;

    // 2) Repli structurel : dans une barre de pagination, le bouton « suivant »
    //    est le dernier, même s'il n'est qu'une flèche sans libellé.
    for (const nav of Array.from(document.querySelectorAll('nav')).reverse()) {
      const btns = Array.from(nav.querySelectorAll('button, [role="button"]')).filter(
        (b) => visible(b) && !NEXT_NEVER.test(labelOf(b)),
      );
      if (btns.length) return btns[btns.length - 1];
    }
    return null;
  }

  // ------------------------------------------------------------------ boucle --
  /** Empreinte de la question affichée. Attention : sur GlobalExam tous les
   *  radios ont value="on" et l'URL ne change pas entre deux questions d'un
   *  même texte — seuls les id (radio-{question}-{réponse}) et le compteur de
   *  pagination (« 2/3 ») distinguent réellement une question de la suivante. */
  function signature() {
    const radios = radiosIn(getRoots());
    const pager = Array.from(document.querySelectorAll('nav'))
      .map((n) => (n.innerText || '').replace(/[^\d/]/g, ''))
      .join('~');
    return (
      location.pathname +
      '|' +
      radios.map((r) => r.id || r.name || r.value).join(',') +
      '|' +
      radios.length +
      '|' +
      pager
    );
  }

  async function waitForChange(sig, timeout, token) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (!running || token !== loopToken) return false;
      await sleep(200);
      if (signature() !== sig) return true;
    }
    return false;
  }

  async function step(token) {
    if (END_PAGE.test(location.pathname)) {
      setStatus('Activité terminée — arrêt');
      stop();
      try {
        chrome.storage.local.set({ running: false });
      } catch {
        /* contexte d'extension invalidé */
      }
      return;
    }

    const groups = getGroups(getRoots());

    // 1) Répondre à toutes les questions visibles encore vierges.
    let answered = 0;
    for (const g of groups) {
      if (!running || token !== loopToken) return;
      if (g.some((r) => r.checked)) continue;
      if (await answerGroup(g)) {
        answered++;
        stats.answers++;
        const libelle = {
          juste: 'Bonne réponse (correction lue)',
          fausse: 'Fausse réponse volontaire',
          hasard: 'Réponse au hasard (pas de correction)',
        }[lastOutcome];
        setStatus(`${libelle}`);
        await sleep(ANSWER_DELAY);
      }
    }

    // 2) Vérifier qu'il ne reste rien de non répondu avant de continuer.
    const remaining = getGroups(getRoots()).filter((g) => !g.some((r) => r.checked));
    if (remaining.length > 0) {
      setStatus(`${remaining.length} question(s) en attente…`);
      return;
    }
    if (groups.length === 0 && answered === 0) setStatus('Aucune question ici');

    // 3) Passer à la suite.
    const btn = findNextButton();
    if (!btn) {
      setStatus('Bouton « suivant » introuvable…');
      return;
    }
    if (!isEnabled(btn)) {
      setStatus('Bouton désactivé (audio en cours ?)');
      return;
    }
    // Garde-fou anti double-clic : empêche seulement deux clics collés. Il ne
    // doit PAS être calé sur nextDelay, sinon la pause serait comptée deux fois
    // (une fois ici, une fois par le sleep ci-dessous) et « 30 s » vaudrait 60 s.
    if (Date.now() - lastNextClick < CLICK_GUARD) return;

    const sig = signature();
    await sleep(cfg.nextDelay);
    if (!running || token !== loopToken) return;

    realClick(btn);
    lastNextClick = Date.now();
    stats.pages++;
    setStatus('→ ' + (labelOf(btn) || 'suivant'));
    push();
    await waitForChange(sig, 5000, token);
  }

  async function loop(token) {
    while (running && token === loopToken) {
      try {
        await step(token);
      } catch (e) {
        console.error(TAG, e);
        setStatus('Erreur : ' + e.message);
      }
      await sleep(SCAN_DELAY);
    }
  }

  /** Identifiant de l'exercice en cours. Il ne bouge pas d'une question à
   *  l'autre — seul le segment /content/ change — et ne change donc qu'en
   *  passant réellement à un autre exercice. */
  function activityKey() {
    const m = location.pathname.match(/\/activity\/([^/]+)/);
    return m ? m[1] : location.pathname.replace(/\/content\/[^/]*$/, '');
  }

  /** Les compteurs ne repartent de zéro qu'en arrivant sur un NOUVEL exercice.
   *  Un arrêt suivi d'un redémarrage au milieu du même exercice les conserve,
   *  tout comme la reprise automatique après un rechargement de page. */
  function start() {
    if (running) return;
    const exercice = activityKey();
    if (stats.activity !== exercice) {
      stats = { answers: 0, correct: 0, pages: 0, activity: exercice };
    }
    running = true;
    setStatus('Démarré');
    log('démarré', cfg);
    loop(++loopToken);
  }

  function stop() {
    if (!running) return;
    running = false;
    loopToken++;
    setStatus('Arrêté');
    log('arrêté', stats);
  }

  // ------------------------------------------------------------------- état --
  let pushTimer = null;
  function setStatus(s) {
    status = s;
    renderHud();
    push();
  }
  function push() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      try {
        chrome.storage.local.set({ stats, status });
      } catch {
        /* contexte d'extension invalidé (rechargement) */
      }
    }, 400);
  }

  // -------------------------------------------------------------------- HUD --
  let hud = null;
  function ensureHud() {
    if (hud || !document.body) return;
    const host = document.createElement('div');
    host.id = 'ge-auto-hud';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .box{font:500 12px/1.4 system-ui,-apple-system,sans-serif;background:#2a1b38;color:#f4f0f8;
             border:1px solid #5b3d78;border-radius:12px;padding:10px 12px;min-width:190px;
             box-shadow:0 8px 24px rgba(0,0,0,.35);}
        .row{display:flex;align-items:center;gap:8px;}
        .dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:none;}
        .on .dot{background:#4ade80;box-shadow:0 0 8px #4ade80;animation:p 1.4s ease-in-out infinite;}
        @keyframes p{50%{opacity:.35}}
        .t{font-weight:700;letter-spacing:.2px;}
        .s{margin:6px 0 8px;color:#c9bcd8;min-height:16px;}
        .n{color:#c9bcd8;font-variant-numeric:tabular-nums;}
        b{color:#fff;}
        button{all:unset;cursor:pointer;padding:5px 10px;border-radius:8px;background:#7c3aed;
               color:#fff;font-weight:700;font-size:11px;text-align:center;}
        button:hover{background:#8b5cf6;}
        button.stop{background:#dc2626;} button.stop:hover{background:#ef4444;}
        .f{display:flex;gap:6px;align-items:center;justify-content:space-between;margin-top:8px;}
        .x{all:unset;cursor:pointer;color:#8f7ea3;padding:0 4px;font-size:14px;line-height:1;}
      </style>
      <div class="box">
        <div class="row"><span class="dot"></span><span class="t">GlobalExam Auto</span>
          <span style="flex:1"></span><button class="x" id="hide" title="Masquer">×</button></div>
        <div class="s" id="st"></div>
        <div class="n"><b id="a">0</b> réponses · <b id="c">0</b> justes · <b id="p">0</b> pages</div>
        <div class="f"><button id="tg"></button></div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    sh.getElementById('tg').addEventListener('click', () => {
      try {
        chrome.storage.local.set({ running: !running });
      } catch {
        running ? stop() : start();
      }
    });
    sh.getElementById('hide').addEventListener('click', () => {
      try {
        chrome.storage.local.set({ showHud: false });
      } catch {
        host.remove();
        hud = null;
      }
    });
    hud = { host, sh };
  }

  function renderHud() {
    if (!cfg.showHud) {
      hud?.host.remove();
      hud = null;
      return;
    }
    ensureHud();
    if (!hud) return;
    const { sh } = hud;
    sh.querySelector('.box').classList.toggle('on', running);
    sh.getElementById('st').textContent = status;
    sh.getElementById('a').textContent = stats.answers;
    sh.getElementById('c').textContent = stats.correct;
    sh.getElementById('p').textContent = stats.pages;
    const tg = sh.getElementById('tg');
    tg.textContent = running ? '■ Stop' : '▶ Démarrer';
    tg.className = running ? 'stop' : '';
  }

  // -------------------------------------------------------- synchro storage --
  chrome.storage.local.get(null, (data) => {
    cfg = { ...DEFAULTS, ...data };
    if (data.stats) stats = { ...stats, ...data.stats };
    renderHud();
    if (cfg.running) start(); // reprise automatique après un rechargement de page
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) {
      if (k in DEFAULTS) cfg[k] = v.newValue;
    }
    if ('running' in changes) {
      changes.running.newValue ? start() : stop();
    }
    renderHud();
  });

  // Le popup peut demander l'état courant.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'ge-status') {
      respond({
        running,
        status,
        stats,
        groups: getGroups(getRoots()).length,
        nextFound: !!findNextButton(),
      });
    }
    return true;
  });

  log('script chargé sur', location.href);
})();
