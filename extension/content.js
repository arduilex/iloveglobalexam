/* GlobalExam Auto — script de contenu
 *
 * Runner de série. Trois types de page, un comportement chacun :
 *   — liste d'activités : lance la première activité pas encore réussie ;
 *   — page de contenu   : attend, coche la bonne réponse, attend, clique ;
 *   — page de fin       : journalise le score et la durée, puis enchaîne.
 *
 * L'état vit dans chrome.storage.local. C'est ce qui fait survivre la boucle
 * aux navigations : le script est rechargé, il relit l'état, il repart.
 */
(() => {
  if (window.__geAutoAnswerLoaded) return;
  window.__geAutoAnswerLoaded = true;

  const TAG = '[GE-Auto]';
  const S = window.GE_SEL;

  // ---------------------------------------------------------------- config --
  const DEFAULTS = {
    running: false,
    pageDelay: 30000, // ms, attente moyenne par page
    pageJitter: 20000, // ms, amplitude du tirage autour de la moyenne
    correctRate: 100, // % de bonnes réponses quand la correction est lisible
    runFor: 0, // ms de session voulue, 0 = illimité
    chain: true, // enchaîner les exercices
    showHud: true, // panneau flottant sur la page
    sel: {}, // surcharges de sélecteurs
  };

  // Constantes internes, non réglables : leur valeur exacte n'a aucun effet
  // perceptible, et Chrome bride de toute façon les minuteurs à 1 Hz dès que
  // l'onglet passe en arrière-plan.
  const ANSWER_DELAY = 300; // pause entre deux cases cochées d'une même page
  const SCAN_DELAY = 600; // cadence de réessai quand la page n'est pas prête
  const CLICK_GUARD = 700; // écart minimal entre deux clics sur « suivant »

  // Au-delà, la page /stats de GlobalExam montre un point manifestement
  // aberrant. Simple avertissement, aucune limite imposée.
  const SUSPECT_DAY = 5 * 3600 * 1000;

  // Page d'accueil des séries, et la série la plus rentable.
  const URL_BIBLIO = 'https://exam.global-exam.com/library/trainings';
  const URL_RECO = 'https://exam.global-exam.com/library/trainings/exercises/977/activities';
  const NOM_RECO = 'Reading › Partie 7(B) — Textes multiples';

  // Écart minimal entre deux redirections automatiques. Sans lui, une
  // bibliothèque qui ne se charge pas ferait boucler la navigation.
  const REDIRECT_GUARD = 5000;

  // Replis si aucun bloc « question-wrapper » n'est trouvé.
  const ROOT_SELECTORS = ['section', 'main'];

  let cfg = { ...DEFAULTS };
  let running = false;
  let loopToken = 0;
  let lastNextClick = 0;
  let lastRedirect = 0;
  let lastOutcome = null; // 'juste' | 'fausse' | 'hasard'
  let stats = { answers: 0, correct: 0, pages: 0, activity: null };
  let status = 'Arrêté';

  // État de la session, persisté : il doit survivre à un rechargement de page.
  let run = { startedAt: 0, endsAt: 0, listUrl: '', tried: [], exercises: 0, actId: null, actFrom: 0 };

  // Attente en cours, pour la barre du panneau flottant.
  let hold = { from: 0, until: 0 };
  // Progression dans l'exercice, lue sur la pagination.
  let pager = { page: 0, total: 0 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log(`%c${TAG}`, 'color:#a855f7;font-weight:bold', ...a);
  const alive = (token) => running && token === loopToken;

  const sset = (o) => {
    try {
      chrome.storage.local.set(o);
    } catch {
      /* contexte d'extension invalidé (rechargement) */
    }
  };
  const sget = (k) =>
    new Promise((res) => {
      try {
        chrome.storage.local.get(k, res);
      } catch {
        res({});
      }
    });

  // ------------------------------------------------------------- utilitaires --
  function visible(el) {
    return !!el && el.isConnected && el.checkVisibility({ checkVisibilityCSS: true });
  }

  /** Simule un vrai clic (pointer + souris) : plus fidèle qu'un simple .click()
   *  pour les composants Vue qui écoutent pointerdown/mousedown. */
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
   *  ce qui contourne le « value tracker » de Vue et déclenche onChange. */
  function forceCheck(input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    setter?.call(input, true);
    input.dispatchEvent(new Event('click', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isEnabled(el) {
    if (!el || !visible(el)) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.hasAttribute('data-disabled')) return false;
    return getComputedStyle(el).pointerEvents !== 'none';
  }

  const labelOf = (el) => S.labelOf(el);

  function fmtMS(ms) {
    const t = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }
  function fmtHM(ms) {
    const t = Math.max(0, Math.round(ms / 60000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------- temporisation --
  /** Tirage uniforme autour de la moyenne. Plancher à 1 s : en dessous,
   *  GlobalExam enregistre des temps de réponse impossibles. */
  function draw() {
    return Math.max(1000, cfg.pageDelay + (Math.random() * 2 - 1) * cfg.pageJitter);
  }

  // Un seul tirage par page, réparti entre l'avant-réponse et l'avant-clic.
  let budget = { sig: null, total: 0, preDone: false };
  function pageBudget(sig) {
    if (budget.sig !== sig) budget = { sig, total: draw(), preDone: false };
    return budget.total;
  }

  /** Attente interruptible. Alimente la barre du panneau flottant. */
  async function wait(ms, token) {
    hold = { from: Date.now(), until: Date.now() + ms };
    while (Date.now() < hold.until) {
      if (!alive(token)) {
        hold = { from: 0, until: 0 };
        return false;
      }
      await sleep(Math.min(200, hold.until - Date.now()));
    }
    hold = { from: 0, until: 0 };
    return true;
  }

  const timeLeft = () => (run.endsAt ? Math.max(0, run.endsAt - Date.now()) : Infinity);
  const expired = () => run.endsAt > 0 && Date.now() >= run.endsAt;

  // --------------------------------------------------- détection des réponses --
  /** Sur les pages « listening », GlobalExam rend UNE question par bloc mais
   *  donne à tous ces blocs le même id="question-wrapper" (id dupliqué, ce que
   *  querySelector ne sait pas voir : il n'en renvoie qu'un). On récupère donc
   *  tous les conteneurs, pas le premier. */
  function getRoots() {
    const wrappers = S.all('questionRoot').filter((el) => el.querySelector('input[type="radio"]'));
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

  // ------------------------------------- chemin rapide : le pont vers la page --
  /** Le script de contenu vit dans un monde isolé : il voit le DOM mais aucun
   *  objet JavaScript de la page, donc pas l'état des composants Vue où se
   *  trouve la bonne réponse. On la demande à `page-bridge.js`, injecté lui
   *  dans le monde de la page. Sans réponse, on retombe sur l'ouverture de la
   *  correction — le comportement d'origine, qui reste fonctionnel. */
  let pontSeq = 0;

  function demanderAuPont(timeout = 600) {
    return new Promise((resolve) => {
      const id = ++pontSeq;
      let repondu = false;
      const surMessage = (e) => {
        const m = e.data;
        if (e.source !== window || !m || m.__geAuto !== 'answers' || m.id !== id) return;
        repondu = true;
        window.removeEventListener('message', surMessage);
        resolve(new Map(m.pairs));
      };
      window.addEventListener('message', surMessage);
      window.postMessage({ __geAuto: 'ask', id }, '*');
      setTimeout(() => {
        if (repondu) return;
        window.removeEventListener('message', surMessage);
        resolve(new Map());
      }, timeout);
    });
  }

  let pontCache = { sig: null, map: new Map() };

  async function tableDesReponses() {
    const sig = signature();
    if (pontCache.sig === sig) return pontCache.map;
    const map = await demanderAuPont();
    pontCache = { sig, map };
    return map;
  }

  /** L'option juste du groupe d'après le pont, ou null s'il n'a rien à dire.
   *  Les cases suivent le schéma `radio-{question}-{réponse}`. */
  async function bonneReponseViaPont(group) {
    const question = group[0].name;
    const idReponse = (await tableDesReponses()).get(String(question));
    if (idReponse == null) return null;
    return (
      group.find((r) => r.id === `radio-${question}-${idReponse}` || r.id.endsWith('-' + idReponse)) ||
      null
    );
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
    const wrapper = S.all('questionRoot').find((w) => w.contains(group[0]));
    if (wrapper) return wrapper;
    let el = group[0].parentElement;
    while (el && el !== document.body && !group.every((r) => el.contains(r))) el = el.parentElement;
    return el || document.body;
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
    const open = S.pick('correctionOpen', root);
    if (!open || !isEnabled(open)) return null;

    realClick(open);
    const affichee = await waitFor(() => S.pick('correctMark', root), 3000);

    let id = null;
    if (affichee) {
      const marque = S.all('correctMark', root).find((s) => s.querySelector('input[type="radio"]'));
      if (marque) id = marque.querySelector('input[type="radio"]').id;
    }

    const close = S.pick('correctionClose', root);
    if (close) realClick(close);
    await waitFor(() => !S.pick('correctMark', root), 2000);
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
    let options = group;

    // 1) Chemin rapide : la page connaît déjà la bonne réponse, le pont nous la
    //    donne sans le moindre clic.
    let bonne = await bonneReponseViaPont(group);

    // 2) Repli : ouvrir puis refermer la correction. Le bloc étant re-rendu au
    //    passage, les éléments doivent être repris par id.
    if (!bonne) {
      const correctId = await readCorrection(group);
      if (ids.every(Boolean)) {
        const frais = ids.map((id) => document.getElementById(id)).filter(Boolean);
        if (frais.length) options = frais;
      }
      bonne = correctId ? options.find((r) => r.id === correctId) : null;
    }

    let choice;
    if (bonne) {
      const viser = Math.random() * 100 < cfg.correctRate;
      const autres = options.filter((r) => r !== bonne);
      choice =
        viser || autres.length === 0 ? bonne : autres[Math.floor(Math.random() * autres.length)];
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
  /** Le bouton « suivant » change de place ET de libellé selon le type de page
   *  (barre de pagination <nav>, pied de page simple, fenêtre modale…).
   *  On note donc chaque bouton visible au lieu de se fier à un chemin figé. */
  function scoreButton(b) {
    const txt = labelOf(b);
    if (S.rx('nextNever')?.test(txt)) return -1;
    let s = 0;
    if (S.rx('nextStrong')?.test(txt)) s += 100;
    else if (S.rx('nextWeak')?.test(txt)) s += 60;
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
        (b) => visible(b) && !S.rx('nextNever')?.test(labelOf(b)),
      );
      if (btns.length) return btns[btns.length - 1];
    }
    return null;
  }

  // ------------------------------------------------------------- signature --
  /** Empreinte de la question affichée. Attention : sur GlobalExam tous les
   *  radios ont value="on" et l'URL ne change pas entre deux questions d'un
   *  même texte — seuls les id (radio-{question}-{réponse}) et le compteur de
   *  pagination (« 2/3 ») distinguent réellement une question de la suivante. */
  function signature() {
    const radios = radiosIn(getRoots());
    const p = Array.from(document.querySelectorAll('nav'))
      .map((n) => (n.innerText || '').replace(/[^\d/]/g, ''))
      .join('~');
    return `${location.pathname}|${radios.map((r) => r.id || r.name || r.value).join(',')}|${radios.length}|${p}`;
  }

  async function waitForChange(sig, timeout, token) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (!alive(token)) return false;
      await sleep(200);
      if (signature() !== sig) return true;
    }
    return false;
  }

  // -------------------------------------------------------- type de page ----
  /** L'ordre est significatif : `listUrl` est un cas particulier de
   *  `libraryUrl` et doit passer avant lui. */
  function pageKind() {
    const p = location.pathname;
    if (S.rx('resultUrl')?.test(p)) return 'result';
    if (S.rx('listUrl')?.test(p)) return 'list';
    if (S.rx('contentUrl')?.test(p)) return 'content';
    if (S.rx('libraryUrl')?.test(p)) return 'library';
    return 'other';
  }

  const activityId = () => (location.pathname.match(/\/activity\/([^/]+)/) || [])[1] || location.pathname;

  // ---------------------------------------------------- page de contenu -----
  function readPager() {
    const re = S.rx('pager');
    if (!re) return { page: 0, total: 0 };
    for (const nav of S.all('pager')) {
      const m = (nav.innerText || '').match(re);
      if (m) return { page: +m[1], total: +m[2] };
    }
    return { page: 0, total: 0 };
  }

  async function handleContent(token) {
    pager = readPager();

    // Chronomètre de secours : sert de durée si la page de fin n'en donne pas.
    const id = activityId();
    if (run.actId !== id) {
      run = { ...run, actId: id, actFrom: Date.now() };
      saveRun();
    }

    const total = pageBudget(signature());
    const groups = getGroups(getRoots());

    // 1) Toute l'attente de la page a lieu ICI, avant de cocher quoi que ce
    //    soit. Une fois les réponses cochées, la validation est immédiate :
    //    hésiter après avoir répondu ne correspond à rien.
    if (!budget.preDone) {
      const vierges = groups.filter((g) => !g.some((r) => r.checked)).length;
      setStatus(vierges ? `Lecture… (${vierges} question(s))` : 'Lecture…');
      if (!(await wait(total, token))) return;
      budget.preDone = true;
    }

    // 2) Répondre à toutes les questions visibles encore vierges.
    let answered = 0;
    for (const g of getGroups(getRoots())) {
      if (!alive(token)) return;
      if (g.some((r) => r.checked)) continue;
      if (await answerGroup(g)) {
        answered++;
        stats.answers++;
        setStatus(
          {
            juste: 'Bonne réponse',
            fausse: 'Fausse réponse volontaire',
            hasard: 'Réponse au hasard (pas de correction)',
          }[lastOutcome],
        );
        await sleep(ANSWER_DELAY);
      }
    }

    // 3) Vérifier qu'il ne reste rien de non répondu avant de continuer.
    const restant = getGroups(getRoots()).filter((g) => !g.some((r) => r.checked));
    if (restant.length > 0) {
      setStatus(`${restant.length} question(s) en attente…`);
      return;
    }
    if (groups.length === 0 && answered === 0) setStatus('Aucune question ici');

    // 4) Passer à la suite.
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
    // doit PAS être calé sur pageDelay, sinon la pause serait comptée deux fois.
    if (Date.now() - lastNextClick < CLICK_GUARD) return;

    // Validation immédiate : l'attente de la page a déjà été passée à l'étape 1.
    const sig = signature();
    realClick(btn);
    lastNextClick = Date.now();
    stats.pages++;
    setStatus('→ ' + (labelOf(btn) || 'suivant'));
    push();
    await waitForChange(sig, 5000, token);
  }

  // ------------------------------------------------------ page de fin -------
  function readGrade() {
    const el = S.pick('grade');
    const re = S.rx('grade');
    const m = el && re ? (el.innerText || '').match(re) : null;
    if (m) return { ok: +m[1], total: +m[2] };
    // Repli : les compteurs tenus en mémoire pendant l'exercice.
    return { ok: stats.correct, total: stats.answers };
  }

  function readDuration() {
    const re = S.rx('duration');
    const m = re ? (document.body.innerText || '').match(re) : null;
    if (m) return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3];
    // Repli : le chronomètre local démarré à l'entrée dans l'activité.
    return run.actFrom ? Math.round((Date.now() - run.actFrom) / 1000) : 0;
  }

  /** Nom de la série, tel qu'affiché en tête de la page de fin : « Reading -
   *  Partie 7(B) - Textes multiples ». Le sélecteur ramène plusieurs
   *  paragraphes blancs ; celui qui nomme une partie l'emporte. */
  function readTitle() {
    const els = S.all('activityTitle')
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 3);
    return (
      els.find((t) => /partie|part\s|reading|listening|writing|speaking/i.test(t)) ||
      els.sort((a, b) => b.length - a.length)[0] ||
      'Exercice'
    );
  }

  /** Une entrée par exercice terminé, dédoublonnée par l'id d'activité :
   *  recharger la page de résultat ne doit pas compter l'exercice deux fois. */
  async function logResult(id) {
    const { log: journal = [] } = await sget(['log']);
    if (journal.some((e) => e.id === id)) return false;
    const g = readGrade();
    journal.push({
      id,
      at: Date.now(),
      type: readTitle(),
      ok: g.ok,
      ko: Math.max(0, g.total - g.ok),
      sec: readDuration(),
    });
    run.exercises++;
    sset({ log: journal, run });
    return true;
  }

  async function handleResult(token) {
    const id = activityId();
    if (await logResult(id)) log('exercice journalisé', id);

    // « Retour à la liste » donne l'URL de la série sans avoir à la deviner.
    const back = S.pick('backToList');
    const href = back?.getAttribute('href');
    if (href && href !== run.listUrl) {
      run.listUrl = href;
      saveRun();
    }

    if (!cfg.chain) {
      setStatus('Exercice terminé — enchaînement désactivé');
      stopAll();
      return;
    }
    if (expired()) {
      setStatus(`Session terminée — ${run.exercises} exercice(s)`);
      stopAll();
      return;
    }
    if (Date.now() - lastNextClick < CLICK_GUARD) return;

    setStatus('Exercice terminé — pause avant le suivant');
    if (!(await wait(draw(), token))) return;

    const suivant = S.pick('nextActivity');
    if (suivant && isEnabled(suivant)) {
      realClick(suivant);
      lastNextClick = Date.now();
      setStatus('→ activité suivante');
      return;
    }
    if (run.listUrl) {
      setStatus('→ retour à la liste');
      location.href = run.listUrl;
      return;
    }
    setStatus('Aucune suite trouvée — arrêt');
    stopAll();
  }

  // --------------------------------------------------- liste d'activités ----
  /** Ligne de la liste contenant ce bouton : le premier ancêtre qui parle
   *  d'un entraînement. Le pourcentage de réussite y est écrit en clair. */
  function rowOf(b) {
    let el = b;
    for (let i = 0; i < 6 && el.parentElement; i++) {
      el = el.parentElement;
      if (/entra[îi]nement|training/i.test(el.innerText || '')) return el;
    }
    return b.parentElement || b;
  }

  function rowPercent(b) {
    const re = S.rx('rowPercent');
    const m = re ? (rowOf(b).innerText || '').match(re) : null;
    return m ? +m[1] : 0;
  }

  const keyOf = (b) => b.getAttribute('data-testid') || labelOf(b) + '@' + rowOf(b).innerText.slice(0, 40);

  async function handleList(token) {
    if (!cfg.chain) {
      setStatus('Liste — enchaînement désactivé');
      return;
    }
    if (expired()) {
      setStatus(`Session terminée — ${run.exercises} exercice(s)`);
      stopAll();
      return;
    }
    if (Date.now() - lastNextClick < CLICK_GUARD) return;

    const btns = S.all('launchButton').filter(isEnabled);
    if (!btns.length) {
      setStatus('Aucun bouton « Lancer » sur cette page');
      return;
    }
    // run.tried évite de boucler indéfiniment sur une activité qui refuse
    // de démarrer.
    const libre = btns.find((b) => !run.tried.includes(keyOf(b)) && rowPercent(b) < 100);
    if (!libre) {
      setStatus('Série terminée — plus d’activité à lancer');
      stopAll();
      return;
    }

    run.listUrl = location.pathname;
    run.tried = [...run.tried, keyOf(libre)].slice(-200);
    saveRun();

    setStatus('Lancement : ' + rowOf(libre).innerText.replace(/\s+/g, ' ').trim().slice(0, 40));
    if (!(await wait(draw(), token))) return;
    realClick(libre);
    lastNextClick = Date.now();
  }

  // ------------------------------------------------------------------ boucle --
  /** Le minuteur de session n'est vérifié qu'aux frontières d'exercice —
   *  page de fin et liste. La consigne est « tenir AU MOINS cette durée » :
   *  couper au milieu d'une page laisserait un exercice abandonné dans le
   *  relevé du site. */
  async function step(token) {
    switch (pageKind()) {
      case 'content':
        return handleContent(token);
      case 'result':
        return handleResult(token);
      case 'list':
        return handleList(token);
      case 'library':
        // Le choix de la série reste manuel : le panneau flottant affiche la
        // recommandation et un bouton, l'extension ne décide pas à la place.
        return setStatus('Choisissez une série — ' + NOM_RECO + ' recommandée');
      default:
        return handleOther();
    }
  }

  /** Page sans exercice — accueil, statistiques, parcours. Tant que le runner
   *  tourne, il n'a rien à y faire : retour à la bibliothèque. */
  function handleOther() {
    if (!running) return setStatus('Page hors exercice');
    if (Date.now() - lastRedirect < REDIRECT_GUARD) return;
    lastRedirect = Date.now();
    setStatus('Page hors exercice — retour à la bibliothèque');
    location.href = URL_BIBLIO;
  }

  async function loop(token) {
    while (alive(token)) {
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

  function saveRun() {
    sset({ run });
  }

  /** Nouvelle session : minuteur remis à zéro, liste des activités tentées
   *  vidée. Appelé au démarrage volontaire, pas à la reprise après navigation. */
  function newRun() {
    run = {
      startedAt: Date.now(),
      endsAt: cfg.runFor > 0 ? Date.now() + cfg.runFor : 0,
      listUrl: '',
      tried: [],
      exercises: 0,
      actId: null,
      actFrom: 0,
    };
    saveRun();
  }

  /** Les compteurs de page ne repartent de zéro qu'en arrivant sur un NOUVEL
   *  exercice. Un arrêt suivi d'un redémarrage au milieu du même exercice les
   *  conserve, tout comme la reprise après un rechargement de page. */
  function start() {
    if (running) return;
    const exercice = activityKey();
    if (stats.activity !== exercice) stats = { answers: 0, correct: 0, pages: 0, activity: exercice };
    running = true;
    setStatus('Démarré');
    log('démarré', cfg, run);
    loop(++loopToken);
    tick(true);
  }

  function stop(msg) {
    if (!running) return;
    running = false;
    loopToken++;
    hold = { from: 0, until: 0 };
    tick(false);
    if (msg) setStatus(msg);
    else renderHud();
    log('arrêté', stats);
  }

  /** Arrêt global : coupe aussi le drapeau partagé, sinon un autre onglet — ou
   *  la page suivante — relancerait la boucle aussitôt.
   *  L'ordre compte : `running` est déjà faux localement quand l'événement
   *  `onChanged` revient, donc le message d'arrêt affiché n'est pas écrasé. */
  function stopAll() {
    stop();
    sset({ running: false });
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
      sset({ stats, status });
    }, 400);
  }

  // -------------------------------------------------------------------- HUD --
  let hud = null;
  let hudTimer = null;

  function tick(on) {
    if (hudTimer) clearInterval(hudTimer);
    hudTimer = on ? setInterval(renderHud, 500) : null;
  }

  function ensureHud() {
    if (hud || !document.body) return;
    const host = document.createElement('div');
    host.id = 'ge-auto-hud';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .box{font:500 12px/1.4 system-ui,-apple-system,sans-serif;background:#2a1b38;color:#f4f0f8;
             border:1px solid #5b3d78;border-radius:12px;padding:10px 12px;width:230px;
             box-shadow:0 8px 24px rgba(0,0,0,.35);}
        .row{display:flex;align-items:center;gap:8px;}
        .dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:none;}
        .on .dot{background:#4ade80;box-shadow:0 0 8px #4ade80;animation:p 1.4s ease-in-out infinite;}
        @keyframes p{50%{opacity:.35}}
        .t{font-weight:700;letter-spacing:.2px;}
        .s{margin:6px 0 8px;color:#c9bcd8;min-height:16px;}
        .n{color:#c9bcd8;font-variant-numeric:tabular-nums;}
        b{color:#fff;}
        .bar{height:5px;border-radius:3px;background:#432c59;overflow:hidden;margin:5px 0;}
        .bar i{display:block;height:100%;background:#a855f7;width:0;transition:width .25s linear;}
        .bar.w i{background:#38bdf8;}
        .meta{display:flex;justify-content:space-between;color:#a794b8;font-size:11px;
              font-variant-numeric:tabular-nums;}
        .warn{color:#fbbf24;font-size:11px;margin-top:5px;}
        .tip{display:none;margin:8px 0 0;padding:8px 9px;border-radius:8px;
             background:#3b2350;border:1px solid #7c3aed;font-size:11px;line-height:1.45;}
        .tip.show{display:block;}
        .tip b{display:block;margin-bottom:3px;font-size:12px;}
        .tip em{color:#c9bcd8;font-style:normal;}
        .tip button{width:100%;margin-top:7px;}
        button{all:unset;cursor:pointer;padding:5px 10px;border-radius:8px;background:#7c3aed;
               color:#fff;font-weight:700;font-size:11px;text-align:center;}
        button:hover{background:#8b5cf6;}
        button.stop{background:#dc2626;} button.stop:hover{background:#ef4444;}
        button.ghost{background:#432c59;} button.ghost:hover{background:#54376f;}
        .f{display:flex;gap:6px;align-items:center;margin-top:8px;}
        .f button{flex:1;}
        /* ponytail: pas de bouton « tableau de bord » ici — un script de contenu
           ne peut pas ouvrir d'onglet sans service worker. Le popup le fait. */
        .x{all:unset;cursor:pointer;color:#8f7ea3;padding:0 4px;font-size:14px;line-height:1;}
      </style>
      <div class="box">
        <div class="row"><span class="dot"></span><span class="t">GlobalExam Auto</span>
          <span style="flex:1"></span><button class="x" id="hide" title="Masquer">×</button></div>
        <div class="s" id="st"></div>
        <div class="bar w"><i id="wb"></i></div>
        <div class="bar"><i id="pb"></i></div>
        <div class="meta"><span id="pg"></span><span id="rest"></span></div>
        <div class="meta"><span id="ses"></span><span id="exo"></span></div>
        <div class="n" style="margin-top:6px"><b id="a">0</b> rép. · <b id="c">0</b> justes · <b id="p">0</b> pages</div>
        <div class="warn" id="warn"></div>
        <div class="tip" id="tip">
          <b>Choisissez une série d'entraînement.</b>
          <em>Recommandé : ${NOM_RECO}. Textes longs, 5 pages : une pause de 30 s par page y reste crédible.</em>
          <button id="reco">Ouvrir la Partie 7(B)</button>
        </div>
        <div class="f"><button id="tg"></button></div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    sh.getElementById('tg').addEventListener('click', () => sset({ running: !running }));
    sh.getElementById('reco').addEventListener('click', () => {
      location.href = URL_RECO;
    });
    sh.getElementById('hide').addEventListener('click', () => sset({ showHud: false }));
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
    const $ = (id) => sh.getElementById(id);

    sh.querySelector('.box').classList.toggle('on', running);
    $('st').textContent = status;
    $('a').textContent = stats.answers;
    $('c').textContent = stats.correct;
    $('p').textContent = stats.pages;

    // Barre d'attente : progression de la pause en cours.
    const span = hold.until - hold.from;
    $('wb').style.width = span > 0 ? `${Math.min(100, ((Date.now() - hold.from) / span) * 100)}%` : '0%';

    // Barre d'exercice : page courante sur le total de la pagination.
    const pct = pager.total ? (pager.page / pager.total) * 100 : 0;
    $('pb').style.width = `${pct}%`;
    $('pg').textContent = pager.total ? `page ${pager.page}/${pager.total}` : '';
    $('rest').textContent = pager.total
      ? `reste ${fmtMS(Math.max(0, pager.total - pager.page) * cfg.pageDelay)}`
      : '';

    const left = timeLeft();
    $('ses').textContent = Number.isFinite(left) ? `session ${fmtHM(left)}` : 'session illimitée';
    $('exo').textContent = run.exercises ? `${run.exercises} exo` : '';
    $('warn').textContent =
      cfg.runFor > SUSPECT_DAY ? 'Plus de 5 h par jour se voit sur votre page Statistiques.' : '';

    // Le conseil de série ne s'affiche que là où il sert : sur la bibliothèque.
    $('tip').classList.toggle('show', pageKind() === 'library');

    const tg = $('tg');
    tg.textContent = running ? '■ Stop' : '▶ Démarrer';
    tg.className = running ? 'stop' : '';
  }

  // -------------------------------------------------------- synchro storage --
  function applyCfg(data) {
    cfg = { ...DEFAULTS, ...data };
    // Migration depuis la version 2.x : une pause fixe, en millisecondes.
    if (data.pageDelay == null && data.nextDelay != null) cfg.pageDelay = data.nextDelay;
    S.setOverrides(cfg.sel);
  }

  chrome.storage.local.get(null, (data) => {
    applyCfg(data);
    if (data.stats) stats = { ...stats, ...data.stats };
    if (data.run) run = { ...run, ...data.run };
    renderHud();
    if (cfg.running) start(); // reprise automatique après un rechargement de page
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) {
      if (k in DEFAULTS) cfg[k] = v.newValue;
    }
    if ('sel' in changes) S.setOverrides(cfg.sel);
    if ('run' in changes && !running) run = { ...run, ...(changes.run.newValue || {}) };
    if ('running' in changes) {
      if (changes.running.newValue) {
        newRun(); // démarrage volontaire : nouvelle session, minuteur remis à zéro
        start();
      } else {
        stop('Arrêté');
      }
    }
    renderHud();
  });

  // Le popup et le tableau de bord peuvent interroger l'onglet.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'ge-status') {
      respond({
        running,
        status,
        stats,
        run,
        kind: pageKind(),
        pager,
        groups: getGroups(getRoots()).length,
        nextFound: !!findNextButton(),
      });
    }
    if (msg?.type === 'ge-test-selector') {
      // Test à la volée depuis l'éditeur de sélecteurs, sans rien enregistrer.
      const sauvegarde = cfg.sel;
      S.setOverrides({ ...sauvegarde, [msg.name]: msg.value });
      let found = [];
      try {
        found = S.all(msg.name);
      } catch {
        found = [];
      }
      S.setOverrides(sauvegarde);
      respond({
        count: found.length,
        first: found[0] ? (found[0].innerText || found[0].outerHTML).replace(/\s+/g, ' ').trim().slice(0, 90) : '',
      });
    }
    return true;
  });

  log('script chargé sur', location.href);
})();
