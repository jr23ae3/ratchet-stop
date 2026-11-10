/* LetsGetPaid — license validation (service worker). Copyright (c) 2026 LetsGetPaid. */
(function () {
  const CFG = () => self.LGP_LICENSE || { enforce: false, apiUrl: '', graceHours: 72, recheckHours: 6, product: 'letsgetpaid' };
  const STORAGE_KEY = 'lgp_license_cache';

  async function readCache() {
    try {
      const bag = await chrome.storage.local.get([STORAGE_KEY, 'licenseKey']);
      return { cache: bag[STORAGE_KEY] || null, key: bag.licenseKey || '' };
    } catch {
      return { cache: null, key: '' };
    }
  }

  async function writeCache(data) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
    } catch {}
  }

  function devOk() {
    const c = CFG();
    if (!c.enforce) return { ok: true, reason: 'dev', enforce: false };
    if (!c.apiUrl) return { ok: true, reason: 'no_api', enforce: false };
    return null;
  }

  function fromCache(cache, key) {
    if (!cache || !cache.ok) return null;
    const c = CFG();
    const graceMs = Math.max(1, Number(c.graceHours) || 72) * 3600000;
    if (Date.now() - (cache.checkedAt || 0) > graceMs) return null;
    if (key && cache.keyHash && cache.keyHash !== hashKey(key)) return null;
    return { ok: true, reason: 'cached', exp: cache.exp, enforce: true };
  }

  function hashKey(key) {
    const s = String(key || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  async function validateRemote(key) {
    const c = CFG();
    const url = String(c.apiUrl || '').trim();
    if (!url) return { ok: false, reason: 'no_api' };
    const body = JSON.stringify({
      key: String(key || ''),
      product: c.product || 'letsgetpaid',
      extensionId: chrome.runtime.id,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      return { ok: false, reason: json?.reason || json?.message || `http_${res.status}` };
    }
    const ok = json?.ok === true || json?.valid === true;
    const exp = json?.exp || json?.expiresAt || null;
    return { ok, reason: ok ? 'valid' : (json?.reason || 'invalid'), exp };
  }

  async function validateLicense(opts = {}) {
    const bypass = devOk();
    if (bypass) return { ...bypass, keySet: false };

    const { cache, key } = await readCache();
    const keySet = !!String(key).trim();
    if (!keySet) return { ok: false, reason: 'no_key', enforce: true, keySet: false };

    const recheckMs = Math.max(1, Number(CFG().recheckHours) || 6) * 3600000;
    if (!opts.force && cache && Date.now() - (cache.checkedAt || 0) < recheckMs) {
      const hit = fromCache(cache, key);
      if (hit) return { ...hit, keySet: true };
    }

    let remote;
    try {
      remote = await validateRemote(key);
    } catch (e) {
      const fallback = fromCache(cache, key);
      if (fallback) return { ...fallback, reason: 'offline_grace', keySet: true };
      return { ok: false, reason: 'network', enforce: true, keySet: true };
    }

    const checkedAt = Date.now();
    await writeCache({
      ok: remote.ok,
      checkedAt,
      exp: remote.exp || null,
      keyHash: hashKey(key),
      reason: remote.reason,
    });

    return {
      ok: remote.ok,
      reason: remote.reason,
      exp: remote.exp,
      enforce: true,
      keySet: true,
    };
  }

  async function setLicenseKey(key) {
    const trimmed = String(key || '').trim();
    await chrome.storage.local.set({ licenseKey: trimmed });
    await writeCache(null);
    return validateLicense({ force: true });
  }

  self.LGP_validateLicense = validateLicense;
  self.LGP_setLicenseKey = setLicenseKey;
})();
