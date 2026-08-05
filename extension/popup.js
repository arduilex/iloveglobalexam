/* GlobalExam Auto-Answer — popup */

const DEFAULTS = {
  running: false,
  nextDelay: 1000, // stocké en millisecondes, saisi en secondes
  correctRate: 100,
  showHud: true,
};

const $ = (id) => document.getElementById(id);
let cfg = { ...DEFAULTS };

function render() {
  const on = cfg.running;
  $('dot').classList.toggle('on', on);
  $('toggle').textContent = on ? '■ Arrêter' : '▶ Démarrer';
  $('toggle').classList.toggle('stop', on);
  $('nextDelay').value = Math.round(cfg.nextDelay) / 1000;
  $('correctRate').value = cfg.correctRate;
  $('showHud').checked = !!cfg.showHud;
}

function save(patch) {
  cfg = { ...cfg, ...patch };
  chrome.storage.local.set(patch);
  render();
}

function afficheStats(s) {
  $('answers').textContent = s.answers ?? 0;
  $('correct').textContent = s.correct ?? 0;
  $('pages').textContent = s.pages ?? 0;
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
    afficheStats(res.stats);
    $('hint').textContent =
      !res.nextFound && res.groups === 0 ? 'Aucune question ni bouton détecté sur cette page.' : '';
  });
}

// --- écouteurs --------------------------------------------------------------
// Pas de remise à zéro optimiste à l'écran : seul content.js sait si l'exercice
// a changé, donc si les compteurs doivent repartir de zéro ou continuer.
$('toggle').addEventListener('click', () => save({ running: !cfg.running }));

$('nextDelay').addEventListener('change', (e) => {
  const secondes = parseFloat(e.target.value);
  save({ nextDelay: Number.isFinite(secondes) ? Math.max(0, Math.round(secondes * 1000)) : DEFAULTS.nextDelay });
});

$('correctRate').addEventListener('change', (e) => {
  const pct = parseInt(e.target.value, 10);
  save({ correctRate: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : DEFAULTS.correctRate });
});

$('showHud').addEventListener('change', (e) => save({ showHud: e.target.checked }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('running' in changes) {
    cfg.running = changes.running.newValue;
    render();
  }
  if ('status' in changes) $('status').textContent = changes.status.newValue;
  if ('stats' in changes) afficheStats(changes.stats.newValue);
});

chrome.storage.local.get(null, (data) => {
  cfg = { ...DEFAULTS, ...data };
  render();
  refresh();
});

setInterval(refresh, 1000);
