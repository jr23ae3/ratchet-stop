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
  } else if (st.accountId && !st.ticketSynced) {
    $('#status-text').textContent = 'On Vest — sync ticket in panel';
  } else {
    $('#status-text').textContent = 'Sign in on Vest';
  }
}

$('#open-vest').onclick = () => chrome.tabs.create({ url: VEST });

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
