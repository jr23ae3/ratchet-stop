/* Ratchet Stop service worker. Copyright (c) 2026 Ratchet Stop. */
importScripts('license/config.js', 'license/validator.js');

let licenseMemo = { at: 0, data: { ok: true, reason: 'init', enforce: false } };

async function getLicenseCached(force) {
  const now = Date.now();
  if (!force && now - licenseMemo.at < 30000) return licenseMemo.data;
  const data = await self.LGP_validateLicense({ force: !!force });
  licenseMemo = { at: now, data };
  return data;
}

chrome.runtime.onInstalled.addListener(() => {
  if (self.LGP_LICENSE?.enabled !== false) getLicenseCached(true).catch(() => {});
});

if (self.LGP_LICENSE?.enabled !== false) {
  chrome.alarms?.create?.('lgp_license_check', { periodInMinutes: 360 });
  chrome.alarms?.onAlarm?.addListener?.((a) => {
    if (a.name === 'lgp_license_check') getLicenseCached(true).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'state' && sender.tab) {
    chrome.storage.session
      .set({ [`tab:${sender.tab.id}`]: { ...(msg.state || {}), seenAt: Date.now() } })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'getLicense') {
    getLicenseCached(!!msg.force).then((license) => sendResponse(license));
    return true;
  }
  if (msg?.type === 'setLicenseKey') {
    if (self.LGP_LICENSE?.enabled === false) {
      sendResponse({ ok: true, reason: 'off', enforce: false, keySet: false });
      return true;
    }
    self.LGP_setLicenseKey(msg.key)
      .then((license) => {
        licenseMemo = { at: Date.now(), data: license };
        sendResponse(license);
      })
      .catch((e) => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  return false;
});
