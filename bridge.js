/* LetsGetPaid bridge. Copyright (c) 2026 LetsGetPaid. */
(() => {
  let lastState = null;
  let lastLicense = null;
  const NS = 'vb';

  function pushLicense(license) {
    if (!license) return;
    lastLicense = license;
    try {
      window.postMessage({ vb: 1, dir: 'toPage', type: 'license', license }, location.origin);
    } catch {}
  }

  function pullLicense(force) {
    if (!alive()) return;
    chrome.runtime.sendMessage({ type: 'getLicense', force: !!force }, (license) => {
      if (chrome.runtime.lastError) return;
      pushLicense(license);
    });
  }

  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[NS] !== 1 || d.dir !== 'toExt' || !alive()) return;
    if (d.type === 'state') {
      lastState = d.state;
      chrome.runtime.sendMessage({ type: 'state', state: d.state }).catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'getState') {
      sendResponse({ state: lastState });
      return;
    }
    if (msg.type === 'cmd' && msg.cmd) {
      window.postMessage({ vb: 1, dir: 'toPage', cmd: msg.cmd, ...msg.args }, location.origin);
      setTimeout(() => sendResponse({ ok: true, state: lastState }), 120);
      return true;
    }
  });

  setTimeout(() => {
    try {
      window.postMessage({ vb: 1, dir: 'toPage', cmd: 'ping' }, location.origin);
    } catch {}
    pullLicense(false);
  }, 1500);
  setInterval(() => pullLicense(false), 120000);
})();
