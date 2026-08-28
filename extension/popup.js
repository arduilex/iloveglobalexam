/* GlobalExam Auto — popup */

const DEFAULTS = {
  running: false,
  pageDelay: 30000, // stocké en millisecondes, saisi en secondes
  pageJitter: 20000,
  correctRate: 100,
  runFor: 0, // ms, 0 = illimité
  chain: true,
  showHud: true,
};

// Au-delà, la page /stats de GlobalExam montre un point manifestement aberrant.
const SUSPECT_DAY = 5 * 3600 * 1000;

const $ = (id) => document.getElementById(id);
let cfg = { ...DEFAULTS };

function render() {
  const on = cfg.running;
  $('dot').classList.toggle('on', on);
  $('toggle').textContent = on ? '■ Arrêter' : '▶ Démarrer';
  $('toggle').classList.toggle('stop', on);
  $('pageDelay').value = Math.round(cfg.pageDelay / 1000);
  $('pageJitter').value = Math.round(cfg.pageJitter / 1000);
  $('correctRate').value = cfg.correctRate;
  const min = Math.round(cfg.runFor / 60000);
  $('runFor').value = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  $('chain').checked = !!cfg.chain;
  $('showHud').checked = !!cfg.showHud;
  $('warnRun').hidden = cfg.runFor <= SUSPECT_DAY;
}

function save(patch) {
  cfg = { ...cfg, ...patch };
  chrome.storage.local.set(patch);
  render();
}

// --- état de l'onglet actif -------------------------------------------------
async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const surLeSite = /^https:\/\/([a-z0-9-]+\.)?global-exam\.com\//i.test(tab?.url || '');
  $('toggle').disabled = !surLeSite;
  if (!surLeSite) {
    $('hint').textContent = "Ouvre d'abord un exercice sur global-exam.com.";
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'ge-status' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      $('hint').textContent = 'Recharge la page de l’exercice (F5) pour activer l’extension.';
      $('status').textContent = 'Script non chargé';
      return;
    }
    $('status').textContent = res.status;
    $('answers').textContent = res.stats?.answers ?? 0;
    $('correct').textContent = res.stats?.correct ?? 0;
    $('exos').textContent = res.run?.exercises ?? 0;
    $('hint').textContent =
      {
        library: 'Choisis une série. Reading › Partie 7(B) — Textes multiples est la plus rentable.',
        other: 'Page hors exercice : le runner renvoie vers la bibliothèque.',
      }[res.kind] || '';
  });
}

// --- écouteurs --------------------------------------------------------------
// Pas de remise à zéro optimiste à l'écran : seul content.js sait si l'exercice
// a changé, donc si les compteurs doivent repartir de zéro ou continuer.
$('toggle').addEventListener('click', () => save({ running: !cfg.running }));

const num = (id, cle, mult, mini) =>
  $(id).addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    save({ [cle]: Number.isFinite(v) ? Math.max(mini, Math.round(v * mult)) : DEFAULTS[cle] });
  });

num('pageDelay', 'pageDelay', 1000, 1000);
num('pageJitter', 'pageJitter', 1000, 0);
num('correctRate', 'correctRate', 1, 0);

$('runFor').addEventListener('change', (e) => {
  const [h, m] = (e.target.value || '00:00').split(':').map(Number);
  save({ runFor: ((h || 0) * 60 + (m || 0)) * 60000 });
});

$('chain').addEventListener('change', (e) => save({ chain: e.target.checked }));
$('showHud').addEventListener('change', (e) => save({ showHud: e.target.checked }));
$('dash').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('running' in changes) {
    cfg.running = changes.running.newValue;
    render();
  }
  if ('status' in changes) $('status').textContent = changes.status.newValue;
  if ('stats' in changes) {
    $('answers').textContent = changes.stats.newValue?.answers ?? 0;
    $('correct').textContent = changes.stats.newValue?.correct ?? 0;
  }
  if ('run' in changes) $('exos').textContent = changes.run.newValue?.exercises ?? 0;
});

chrome.storage.local.get(null, (data) => {
  cfg = { ...DEFAULTS, ...data };
  // Migration depuis la version 2.x : une pause fixe, en millisecondes.
  if (data.pageDelay == null && data.nextDelay != null) cfg.pageDelay = data.nextDelay;
  render();
  refresh();
});

setInterval(refresh, 1000);
