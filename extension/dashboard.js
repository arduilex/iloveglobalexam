/* GlobalExam Auto — tableau de bord
 *
 * Trois onglets : statistiques du journal, réglages du rythme, éditeur de
 * sélecteurs. La page ne pilote rien : elle lit et écrit chrome.storage.local,
 * le script de contenu réagit.
 */

const S = window.GE_SEL;
const $ = (id) => document.getElementById(id);

// Relevé sur exam.global-exam.com. Les identifiants d'exercice sont stables :
// ce sont ceux des URL de la bibliothèque.
const SERIES = [
  { id: 1085, type: 'Audio', nom: 'Partie 1 — Photographies', sec: 'Listening' },
  { id: 1136, type: 'Audio', nom: 'Partie 2 — Question-Réponse', sec: 'Listening' },
  { id: 1201, type: 'Audio', nom: 'Partie 3 — Conversations', sec: 'Listening' },
  { id: 1297, type: 'Audio', nom: 'Partie 4 — Monologues', sec: 'Listening' },
  { id: 492, type: 'Texte', nom: 'Partie 5 — Phrases à trous', sec: 'Reading' },
  { id: 669, type: 'Texte', nom: 'Partie 6 — Textes à compléter', sec: 'Reading' },
  { id: 817, type: 'Texte', nom: 'Partie 7(A) — Textes simples', sec: 'Reading' },
  { id: 977, type: 'Texte', nom: 'Partie 7(B) — Textes multiples', sec: 'Reading', reco: true },
];
const URL_SERIE = (id) => `https://exam.global-exam.com/library/trainings/exercises/${id}/activities`;

// Au-delà, la page /stats de GlobalExam montre un point manifestement aberrant.
const SUSPECT_DAY = 5 * 3600;

let cfg = {};
let journal = [];
let run = {};
let range = 'session';

const sset = (o) => chrome.storage.local.set(o);

// ------------------------------------------------------------- formatage ---
function fmtHM(sec) {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
const jour = (ms) => new Date(ms).toLocaleDateString('fr-FR');
const cleJour = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ------------------------------------------------------------- périodes ----
function bornes() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  switch (range) {
    case 'session':
      return [run.startedAt || 0, Infinity];
    case 'today':
      return [d.getTime(), Infinity];
    case 'week': {
      // Semaine française : lundi comme premier jour.
      const delta = (d.getDay() + 6) % 7;
      return [d.getTime() - delta * 86400000, Infinity];
    }
    case 'month':
      return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), Infinity];
    case 'custom': {
      const a = $('from').value ? new Date($('from').value + 'T00:00:00').getTime() : 0;
      const b = $('to').value ? new Date($('to').value + 'T23:59:59').getTime() : Infinity;
      return [a, b];
    }
    default:
      return [0, Infinity];
  }
}

const cumul = (list) =>
  list.reduce((a, e) => ({ exos: a.exos + 1, ok: a.ok + e.ok, ko: a.ko + e.ko, sec: a.sec + e.sec }), {
    exos: 0,
    ok: 0,
    ko: 0,
    sec: 0,
  });

// ---------------------------------------------------------------- rendu ----
function renderStats() {
  const [a, b] = bornes();
  const sel = journal.filter((e) => e.at >= a && e.at <= b).sort((x, y) => x.at - y.at);
  const t = cumul(sel);

  $('tExos').textContent = t.exos;
  $('tOk').textContent = t.ok;
  $('tKo').textContent = t.ko;
  $('tRate').textContent = t.ok + t.ko ? `${Math.round((t.ok / (t.ok + t.ko)) * 100)} %` : '—';
  $('tTime').textContent = fmtHM(t.sec);

  // --- par jour ---
  const parJour = new Map();
  for (const e of sel) parJour.set(cleJour(e.at), (parJour.get(cleJour(e.at)) || 0) + e.sec);
  const jours = [...parJour.entries()].slice(-60);
  const max = Math.max(1, ...jours.map(([, s]) => s));
  const chart = $('chart');
  chart.innerHTML = '';
  if (!jours.length) {
    chart.innerHTML = '<span class="empty">Aucun exercice sur cette période.</span>';
  } else {
    for (const [k, s] of jours) {
      const bar = document.createElement('div');
      bar.className = 'bar' + (s > SUSPECT_DAY ? ' over' : '');
      bar.style.height = `${Math.max(3, (s / max) * 100)}%`;
      bar.title = `${k} — ${fmtHM(s)}`;
      chart.appendChild(bar);
    }
  }

  const charges = jours.filter(([, s]) => s > SUSPECT_DAY);
  $('warnDay').hidden = charges.length === 0;
  $('warnDay').textContent = charges.length
    ? `Plus de 5 h sur ${charges.length} jour(s) : ${charges
        .map(([k, s]) => `${k} (${fmtHM(s)})`)
        .join(', ')}. Ces pics se voient sur votre page Statistiques GlobalExam.`
    : '';

  // --- par série ---
  const parType = new Map();
  for (const e of sel) {
    if (!parType.has(e.type)) parType.set(e.type, []);
    parType.get(e.type).push(e);
  }
  $('byType').tBodies[0].innerHTML =
    [...parType.entries()]
      .map(([nom, list]) => {
        const c = cumul(list);
        const r = c.ok + c.ko ? `${Math.round((c.ok / (c.ok + c.ko)) * 100)} %` : '—';
        return `<tr><td>${esc(nom)}</td><td>${c.exos}</td><td>${c.ok}</td><td>${c.ko}</td><td>${r}</td><td>${fmtHM(c.sec)}</td></tr>`;
      })
      .join('') || '<tr><td colspan="6">—</td></tr>';

  // --- derniers exercices ---
  $('recent').tBodies[0].innerHTML =
    sel
      .slice(-25)
      .reverse()
      .map(
        (e) =>
          `<tr><td>${jour(e.at)} ${new Date(e.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</td>` +
          `<td>${esc(e.type)}</td><td>${e.ok}/${e.ok + e.ko}</td><td>${fmtHM(e.sec)}</td></tr>`,
      )
      .join('') || '<tr><td colspan="4">—</td></tr>';
}

// Les guillemets doubles comptent : les sélecteurs CSS par défaut en
// contiennent ([data-testid="your-grade"]) et sont réinjectés dans value="…".
const ESC = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ESC[c]);

function renderReglages() {
  $('pageDelay').value = Math.round((cfg.pageDelay ?? 30000) / 1000);
  $('pageJitter').value = Math.round((cfg.pageJitter ?? 20000) / 1000);
  $('correctRate').value = cfg.correctRate ?? 100;
  const min = Math.round((cfg.runFor ?? 0) / 60000);
  $('runFor').value = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  $('chain').checked = cfg.chain !== false;
  $('showHud').checked = cfg.showHud !== false;
  $('warnRun').hidden = (cfg.runFor ?? 0) <= SUSPECT_DAY * 1000;

  const d = (cfg.pageDelay ?? 30000) / 1000;
  const j = (cfg.pageJitter ?? 20000) / 1000;
  $('rangeHint').textContent = `Chaque page attend entre ${Math.max(1, d - j).toFixed(0)} s et ${(d + j).toFixed(0)} s. Environ 40 % avant de cocher, le reste avant « suivant ».`;
}

function renderSeries() {
  $('series').innerHTML = SERIES.map(
    (s) => `
      <button class="${s.reco ? 'reco' : ''}" data-url="${URL_SERIE(s.id)}">
        <span class="tag">${s.type}</span>
        <b>${esc(s.nom)}</b>
        <small>${s.sec}${s.reco ? ' · recommandé' : ''}</small>
      </button>`,
  ).join('');
}

function renderSelecteurs() {
  $('selEditor').innerHTML = S.names
    .map((nom) => {
      const c = S.conf(nom);
      return `
        <div class="sel" data-name="${nom}">
          <h3>${nom}</h3>
          <div class="grid">
            <label>XPath</label><input data-k="xp" value="${esc(c.xp || '')}" placeholder="relatif, ex. //button[contains(.,'Suivant')]" />
            <label>CSS</label><input data-k="css" value="${esc(c.css || '')}" placeholder="${esc(S.defaults[nom].css || '—')}" />
            <label>Regex</label><input data-k="rx" value="${esc(c.rx || '')}" placeholder="${esc(S.defaults[nom].rx || '—')}" />
          </div>
          <div class="acts">
            <button class="ghost test">Tester</button>
            <button class="ghost reset">Défaut</button>
            <span class="res"></span>
          </div>
        </div>`;
    })
    .join('');
}

function lireSelecteurs() {
  const out = {};
  for (const bloc of document.querySelectorAll('.sel')) {
    const v = {};
    for (const inp of bloc.querySelectorAll('input')) v[inp.dataset.k] = inp.value.trim();
    out[bloc.dataset.name] = v;
  }
  return out;
}

// ------------------------------------------------------------- écouteurs ---
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === b);
  for (const id of ['stats', 'reglages', 'selecteurs']) $(id).hidden = id !== b.dataset.tab;
});

document.querySelector('.ranges').addEventListener('click', (e) => {
  const b = e.target.closest('.range');
  if (!b) return;
  range = b.dataset.range;
  for (const t of document.querySelectorAll('.range')) t.classList.toggle('on', t === b);
  renderStats();
});

for (const id of ['from', 'to']) {
  $(id).addEventListener('change', () => {
    range = 'custom';
    for (const t of document.querySelectorAll('.range')) t.classList.remove('on');
    renderStats();
  });
}

const num = (id, mult, cle, mini) =>
  $(id).addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    cfg[cle] = Number.isFinite(v) ? Math.max(mini, Math.round(v * mult)) : cfg[cle];
    sset({ [cle]: cfg[cle] });
    renderReglages();
  });

num('pageDelay', 1000, 'pageDelay', 1000);
num('pageJitter', 1000, 'pageJitter', 0);
num('correctRate', 1, 'correctRate', 0);

$('runFor').addEventListener('change', (e) => {
  const [h, m] = (e.target.value || '00:00').split(':').map(Number);
  cfg.runFor = ((h || 0) * 60 + (m || 0)) * 60000;
  sset({ runFor: cfg.runFor });
  renderReglages();
});

$('chain').addEventListener('change', (e) => sset({ chain: e.target.checked }));
$('showHud').addEventListener('change', (e) => sset({ showHud: e.target.checked }));

$('series').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-url]');
  if (b) chrome.tabs.create({ url: b.dataset.url });
});

$('export').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(journal, null, 1)], { type: 'application/json' }));
  a.download = `globalexam-journal-${cleJour(Date.now())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('wipe').addEventListener('click', () => {
  if (!confirm('Vider tout le journal ? Les statistiques seront perdues.')) return;
  journal = [];
  sset({ log: [] });
  renderStats();
});

$('selSave').addEventListener('click', () => {
  const sel = lireSelecteurs();
  cfg.sel = sel;
  S.setOverrides(sel);
  sset({ sel });
  $('selMsg').textContent = 'Enregistré. Rechargez la page de l’exercice (F5).';
});

$('selReset').addEventListener('click', () => {
  cfg.sel = {};
  S.setOverrides({});
  sset({ sel: {} });
  renderSelecteurs();
  $('selMsg').textContent = 'Valeurs par défaut restaurées.';
});

/** L'onglet global-exam.com le plus récent. Le tableau de bord n'est pas sur
 *  le site : il faut viser explicitement l'onglet à interroger. */
async function ongletGE() {
  const tabs = await chrome.tabs.query({ url: 'https://*.global-exam.com/*' });
  return tabs[tabs.length - 1] || null;
}

$('selEditor').addEventListener('click', async (e) => {
  const bloc = e.target.closest('.sel');
  if (!bloc) return;
  const nom = bloc.dataset.name;
  const res = bloc.querySelector('.res');

  if (e.target.closest('.reset')) {
    const d = S.defaults[nom];
    for (const inp of bloc.querySelectorAll('input')) inp.value = d[inp.dataset.k] || '';
    res.textContent = '';
    return;
  }

  if (!e.target.closest('.test')) return;
  const tab = await ongletGE();
  if (!tab) {
    res.textContent = 'Aucun onglet global-exam.com ouvert.';
    return;
  }
  const value = {};
  for (const inp of bloc.querySelectorAll('input')) value[inp.dataset.k] = inp.value.trim();
  chrome.tabs.sendMessage(tab.id, { type: 'ge-test-selector', name: nom, value }, (r) => {
    if (chrome.runtime.lastError || !r) {
      res.textContent = 'Script non chargé sur cet onglet — rechargez-le (F5).';
      return;
    }
    res.textContent = r.count ? `${r.count} trouvé(s) · ${r.first}` : 'Aucune correspondance.';
  });
});

// ------------------------------------------------------------- démarrage ---
chrome.storage.local.get(null, (data) => {
  cfg = data || {};
  journal = data.log || [];
  run = data.run || {};
  S.setOverrides(cfg.sel || {});
  renderReglages();
  renderSeries();
  renderSelecteurs();
  renderStats();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('log' in changes) {
    journal = changes.log.newValue || [];
    renderStats();
  }
  if ('run' in changes) {
    run = changes.run.newValue || {};
    if (range === 'session') renderStats();
  }
});
