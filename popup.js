/* Ratchet Stop popup. Copyright (c) 2026 Ratchet Stop. */
const VEST = 'https://next.vestmarkets.com/trade/NQ-PERP';
const $ = (s) => document.querySelector(s);
let tabId = null;

document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

function render(st) {
  if (!st) return;
  $('#dot').className = 'dot ' + (st.ready ? 'live' : 'bad');
  if (st.ready) {
    $('#status-text').textContent = `Ready on ${st.symbol || '—'} · ${st.accountName || st.accountId || '—'}`;
  } else if (st.licenseEnforced && st.licenseOk === false) {
    $('#status-text').textContent = 'Enter license key below';
  } else if (st.accountId && !st.ticketSynced) {
    $('#status-text').textContent = 'On Vest — sync ticket in panel';
  } else {
    $('#status-text').textContent = 'Sign in on Vest';
  }
}

function paintLicense(lic) {
  const msg = $('#license-msg');
  const hint = $('#license-hint');
  if (!lic) return;
  if (lic.enforce) {
    hint.textContent = 'A valid key is required to trade.';
  } else {
    hint.textContent = 'Optional now — required when the author enables license enforcement.';
  }
  if (lic.ok) {
    msg.textContent = lic.enforce ? `Licensed (${lic.reason || 'ok'})` : 'Open mode (no enforcement)';
    msg.style.color = '#6ee7b7';
  } else if (lic.enforce) {
    msg.textContent = `Not active: ${lic.reason || 'unknown'}`;
    msg.style.color = '#fca5a5';
  } else {
    msg.textContent = '';
  }
}

$('#open-vest').onclick = () => chrome.tabs.create({ url: VEST });

$('#license-save').onclick = async () => {
  const key = $('#license-key').value.trim();
  const lic = await chrome.runtime.sendMessage({ type: 'setLicenseKey', key }).catch(() => null);
  paintLicense(lic);
  if (tabId) await chrome.tabs.sendMessage(tabId, { type: 'cmd', cmd: 'ping' }).catch(() => null);
};

chrome.runtime.sendMessage({ type: 'getLicense' }).then(paintLicense).catch(() => {});

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  const onVest = tab?.url?.includes('next.vestmarkets.com');
  if (!onVest) return;
  tabId = tab.id;
  $('#off').hidden = true;
  $('#on').hidden = false;
  const r = await chrome.tabs.sendMessage(tabId, { type: 'getState' }).catch(() => null);
  if (r?.state) render(r.state);
  setInterval(async () => {
    const p = await chrome.tabs.sendMessage(tabId, { type: 'cmd', cmd: 'ping' }).catch(() => null);
    if (p?.state) render(p.state);
  }, 2000);
});
