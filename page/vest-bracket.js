/* Ratchet Stop — proprietary. Copyright (c) 2026 Ratchet Stop. See legal/LICENSE. */
(function () {
  'use strict';
  const win = window;
  if (win.top !== win.self) return;

  const VERSION = '1.7.6';
  const prevVer = win.__vestBracketsVer;
  if (prevVer === VERSION && document.getElementById('vb-panel')?.dataset?.vbMount === VERSION) return;
  if (win.__vestBracketsLoaded) {
    document.getElementById('vb-panel')?.remove();
    document.getElementById('vb-toast')?.remove();
    document.getElementById('vb-styles')?.remove();
  }
  win.__vestBracketsLoaded = true;
  win.__vestBracketsVer = VERSION;
  const API_HOST = 'api-gateway.hz.vestmarkets.com';
  const API_BASE = `https://${API_HOST}`;
  const SYMBOL_MAP = {
    'NQ-PERP': 'NDX-USD-PERP',
    'ES-PERP': 'SPX-USD-PERP',
    'MNQ-PERP': 'NDX-USD-PERP',
    'MES-PERP': 'SPX-USD-PERP',
  };
  const DEFAULT_TICK = { 'NQ-PERP': 0.25, 'ES-PERP': 0.25, 'MNQ-PERP': 0.25, 'MES-PERP': 0.25 };
  const SUPPORT_CODE = 'AEthatsMe';
  const BT_CODE_ROUTES = /^\/(vest-capital(\/|$)|deposit\/get-funded(\/|$)|checkout(\/|$))/;
  const BT_CODE_SKIP = /^\/affiliates(\/|$)/;
  const BT_CODE_INPUT = /discount|promo|coupon|voucher/i;
  const BT_CODE_USE = /^(use|apply)$/i;
  const BT_CODE_STATUS = /(\d+(\.\d+)?\s*%\s*(discount|code applied!?)|no discount applied|invalid promo code)/i;

  const defaultSettings = () => ({
    slTicks: 40,
    tp1Ticks: 40,
    tp2Ticks: 80,
    tp1Pct: 50,
    useTp2: false,
    entryType: 'market',
    limitOffsetTicks: 0,
    tickSize: 0.25,
    showPanel: true,
    showAdvanced: false,
    trailEnabled: true,
    trailDistPts: 8,
    trailStartPts: 10,
    trailStepPts: 1,
    trailLimitOffsetPts: 0,
    autoSupportCode: true,
    panelX: null,
    panelY: null,
  });

  let S = loadSettings();
  let token = null;
  let nativeFetch = null;
  let sessionBc = null;
  let accountId = '';
  let accountName = '—';
  let ticketSynced = false;
  let lastSyncAt = 0;
  let lastSyncDetail = '';
  let lastKnownMid = 0;
  let lastKnownMidAt = 0;
  let vestOpenSample = null;
  const vestPctCalib = new Map();
  const vestUsdCalib = new Map();
  let vestClickSnap = null;
  const accountTokens = new Map();
  const vbTrail = { armed: new Map(), lastOpenId: null, lastOpenSl: null };
  const TRAIL_POLL_MS = 100;
  const TRAIL_POLL_TRIES = 30;
  const TRAIL_TICK_MS = 175;
  const TRAIL_UPDATE_MS = 500;
  const TRAIL_POS_CACHE_MS = 450;
  let vbPosCache = { at: 0, rows: [] };
  let licenseOk = true;
  let licenseEnforced = false;
  let licenseReason = '';

  function applyLicense(license) {
    if (!license || typeof license !== 'object') return;
    licenseEnforced = !!license.enforce;
    licenseReason = String(license.reason || '');
    licenseOk = license.enforce ? !!license.ok : true;
    refreshLicenseUi();
    postState();
  }

  function assertLicensed(action) {
    if (licenseOk) return;
    const msg = licenseEnforced
      ? `Ratchet Stop needs a license — open the extension popup and enter your key. (${licenseReason || action})`
      : 'Ratchet Stop is locked on this install.';
    setAction(msg, 'err');
    toast(msg);
    throw new Error(msg);
  }

  function refreshLicenseUi() {
    const ready = document.getElementById('vb-ready');
    if (!ready) return;
    if (licenseOk) {
      refreshReadyLine();
      return;
    }
    ready.textContent = licenseEnforced
      ? 'License required — open Ratchet Stop popup → enter your key'
      : 'This copy is not licensed for use';
    ready.className = 'vb-ready vb-warn';
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem('vb_settings');
      if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
    } catch {}
    return defaultSettings();
  }

  function persist() {
    try { localStorage.setItem('vb_settings', JSON.stringify(S)); } catch {}
  }

  function postState() {
    const st = {
      version: VERSION,
      ready: licenseOk && !!token && !!accountId && ticketSynced,
      licenseOk,
      licenseEnforced,
      accountId,
      accountName,
      symbol: displaySymbol(activeChartSymbol()),
      ticketSynced,
    };
    win.postMessage({ vb: 1, dir: 'toExt', type: 'state', state: st }, location.origin);
  }

  const ACCT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function jwtExp(t) {
    try {
      const part = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const c = JSON.parse(atob(part));
      const exp = c.exp;
      return typeof exp === 'number' ? (exp > 1e12 ? exp : exp * 1000) : 0;
    } catch {
      return 0;
    }
  }

  function jwtUserId(t) {
    try {
      const part = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const c = JSON.parse(atob(part));
      return c.sub || c.userId || c.uid || c.id || null;
    } catch {
      return null;
    }
  }

  function isAccountUuid(s) {
    return typeof s === 'string' && ACCT_UUID.test(s);
  }

  function captureAccountId(id) {
    const s = String(id || '').trim();
    if (!isAccountUuid(s)) return;
    accountId = s;
    postState();
  }

  function parseStoredAccountId(raw) {
    if (raw == null || raw === '') return '';
    let v = String(raw);
    if (v[0] === '"' || v[0] === '{') {
      try {
        const j = JSON.parse(v);
        v = typeof j === 'string' ? j : (j && (j.id || j.accountId)) || '';
      } catch {}
    }
    v = String(v).trim();
    return isAccountUuid(v) ? v : '';
  }

  function captureAuth(hdrs) {
    if (!hdrs) return;
    const auth = typeof hdrs.get === 'function' ? hdrs.get('authorization') : hdrs.Authorization || hdrs.authorization;
    if (!auth || !/^Bearer\s+/i.test(auth)) return;
    const t = auth.replace(/^Bearer\s+/i, '').trim();
    if (t.length < 20) return;
    token = { value: t, exp: jwtExp(t) || Date.now() + 3600000 };
    postState();
  }

  function sessionPing() {
    try {
      if (!sessionBc && typeof BroadcastChannel === 'function') {
        sessionBc = new BroadcastChannel('vest-session-sync');
        sessionBc.onmessage = (ev) => {
          const m = ev?.data;
          if (!m || m.type === 'logout') {
            token = null;
            accountTokens.clear();
            postState();
            return;
          }
          if (m.type !== 'login' && m.type !== 'session-update' && m.type !== 'session-snapshot') return;
          const at = m.snapshot?.userPair?.accessToken;
          if (typeof at === 'string' && at) {
            const exp = m.snapshot.userPair.accessTokenExpiresAt;
            const n = typeof exp === 'number' ? (exp < 1e11 ? exp * 1000 : exp) : jwtExp(at);
            token = { value: at, exp: n || Date.now() + 3600000 };
            accountTokens.clear();
            postState();
          }
        };
      }
      sessionBc?.postMessage({ type: 'request-session' });
    } catch {}
  }

  async function ensureToken() {
    if (token && token.exp > Date.now() + 3000) return;
    sessionPing();
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (token && token.exp > Date.now() + 3000) return;
    }
    throw new Error('Sign in to Vest first.');
  }

  async function mintAccountToken(id) {
    const acc = String(id);
    const hit = accountTokens.get(acc);
    if (hit && hit.exp > Date.now() + 15000) return hit.value;
    await ensureToken();
    const res = await nativeFetch(`${API_BASE}/v3/auth/account-token`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        authorization: `Bearer ${token.value}`,
        'idempotency-key': crypto.randomUUID?.() || String(Date.now()),
      },
      credentials: 'include',
      body: JSON.stringify({ accountId: acc }),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error(json?.message || json?.msg || text || `HTTP ${res.status}`);
    const at = json?.accessToken || json?.data?.accessToken;
    if (!at) throw new Error('No account token');
    accountTokens.set(acc, { value: at, exp: jwtExp(at) || Date.now() + 600000 });
    return at;
  }

  async function api(path, opts = {}) {
    await ensureToken();
    let url = API_BASE + path;
    if (opts.query && typeof opts.query === 'object') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v != null && v !== '') qs.set(k, String(v));
      }
      const q = qs.toString();
      if (q) url += (url.includes('?') ? '&' : '?') + q;
    }
    const acct = opts.accountId ? String(opts.accountId) : '';
    const bearer = acct ? await mintAccountToken(acct) : token.value;
    const headers = {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${bearer}`,
    };
    if (opts.method && opts.method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = crypto.randomUUID?.() || String(Date.now());
    }
    let body = opts.body;
    if (body && acct && String(path).startsWith('/v3/positions/')) {
      body = { ...body };
      delete body.accountId;
    }
    const res = await nativeFetch(url, {
      method: opts.method || 'GET',
      headers,
      credentials: 'include',
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    const failMsg = vestApiError(json, text);
    if (!res.ok) {
      const brief = failMsg
        || (json && typeof json === 'object' ? JSON.stringify(json).slice(0, 280) : '')
        || (text && text.slice(0, 280))
        || `HTTP ${res.status}`;
      const err = new Error(brief);
      err.httpStatus = res.status;
      throw err;
    }
    if (failMsg) throw new Error(failMsg);
    return json;
  }

  function vestApiError(json, text) {
    const parts = [];
    const push = (m) => { if (m && !parts.includes(m)) parts.push(String(m)); };
    if (json && typeof json === 'object') {
      push(json.message);
      push(json.msg);
      push(json.error);
      push(json.reason);
      if (json.code != null) push(json.code);
      const d = json.data;
      if (d && typeof d === 'object') {
        push(d.message);
        push(d.msg);
        push(d.error);
      }
      if (json.status && /reject|fail|error/i.test(String(json.status))) {
        push(json.status);
      }
      if (json.success === false) push('Order rejected');
    }
    if (text && /insufficient funds|margin_check|invalid.?balance|notional/i.test(text)) {
      push(text.slice(0, 240));
    }
    const msg = parts.join(' — ');
    if (!msg) return '';
    if (/insufficient funds|margin_check|invalid.?balance/i.test(msg)) {
      return `${msg} — size/leverage may not match Vest’s ticket. Use Vest’s Long once at this USD, then retry.`;
    }
    if (/reject|fail|error|invalid/i.test(msg)) return msg;
    return '';
  }

  let vbOwnOpen = false;

  function captureVestOpen(j) {
    if (vbOwnOpen) return;
    if (!j?.symbol || j.quantity == null || j.quantity === '') return;
    const snap = vestClickSnap || snapVestTicket();
    vestClickSnap = null;
    let pct = null;
    const pv = snap.size != null ? pctClean(snap.size) : null;
    if (pv != null && usesPercentSizing(snap.unit, pv)) pct = pv;
    const preset = readPctPresetOnTicket();
    if (pct == null && preset != null) pct = preset;
    let lev = j.leverage != null ? String(j.leverage) : orderLeverage();
    const sl = Number(lev);
    if (!(sl > 1)) {
      const fromSnap = resolveTicketLeverage();
      if (fromSnap > 1) lev = String(Math.round(fromSnap));
    }
    const usd = snap.unit === 'usd' && snap.size > 0 ? Number(snap.size) : null;
    vestOpenSample = {
      at: Date.now(),
      symbol: String(j.symbol),
      quantity: String(j.quantity),
      leverage: lev,
      pct,
      usd,
      unit: snap.unit,
      fromVest: true,
    };
    if (pct != null) {
      vestPctCalib.set(`${j.symbol}:${pct}:${lev}`, { quantity: String(j.quantity), at: Date.now() });
    }
    if (usd != null) {
      const uk = usdKey(usd);
      vestUsdCalib.set(`${j.symbol}:${uk}:${lev}`, { quantity: String(j.quantity), at: Date.now() });
    }
    refreshPlanPreview();
    postState();
  }

  function installNetworkTap() {
    nativeFetch = win.fetch.bind(win);
    const orig = nativeFetch;
    win.fetch = function (input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : input?.url || '';
        if (input instanceof Request) captureAuth(input.headers);
        captureAuth(new Headers(init?.headers || undefined));
        if (url.includes(API_HOST)) {
          const raw = init?.body;
          if (typeof raw === 'string' && raw) {
            try {
              const j = JSON.parse(raw);
              if (j?.accountId) captureAccountId(j.accountId);
              if (url.includes('/v3/positions/open')) captureVestOpen(j);
            } catch {}
          }
        }
      } catch {}
      const chain = orig(input, init);
      if (url.includes(API_HOST) && url.includes('/v3/positions/open')) {
        return chain.then(async (res) => {
          try {
            const clone = res.clone();
            const j = await clone.json();
            const pid = j?.positionId || j?.data?.positionId || j?.id;
            if (pid) vbTrail.lastOpenId = String(pid);
            const sl = j?.stopLosses || j?.data?.stopLosses;
            if (sl) vbTrail.lastOpenSl = sl;
            if (vestOpenSample && pid) vestOpenSample.positionId = String(pid);
          } catch {}
          return res;
        });
      }
      return chain;
    };
    const proto = win.XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    const origSet = proto.setRequestHeader;
    proto.open = function (method, url) {
      try { this._vbUrl = String(url || ''); } catch {}
      return origOpen.apply(this, arguments);
    };
    proto.send = function (body) {
      try {
        const u = this._vbUrl || '';
        if (u.includes('/v3/positions/open') && typeof body === 'string' && body) {
          const j = JSON.parse(body);
          captureVestOpen(j);
        }
      } catch {}
      return origSend.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      if (String(name).toLowerCase() === 'authorization' && /^Bearer /i.test(String(value))) {
        captureAuth({ authorization: value });
      }
      return origSet.apply(this, arguments);
    };
    document.addEventListener('click', (e) => {
      const b = e.target?.closest?.('[data-testid="submit-long"], [data-testid="submit-short"]');
      if (!b || b.closest('#vb-panel')) return;
      vestClickSnap = snapVestTicket();
    }, true);
  }

  function activeChartSymbol() {
    const m = location.pathname.match(/\/trade\/([^/?#]+)/i);
    if (m) return decodeURIComponent(m[1]);
    const el = document.querySelector('[data-testid="market-selector-trigger"], [data-testid^="symbol"]');
    const t = el?.textContent?.trim();
    return t || 'NQ-PERP';
  }

  function apiSymbol(sym) {
    const u = String(sym || '').toUpperCase();
    return SYMBOL_MAP[u] || sym;
  }

  function displaySymbol(sym) {
    const rev = Object.fromEntries(Object.entries(SYMBOL_MAP).map(([k, v]) => [v, k]));
    return rev[sym] || sym;
  }

  function defaultTick(sym) {
    const d = displaySymbol(sym);
    return DEFAULT_TICK[d] || S.tickSize || 0.25;
  }

  function setReactInputValue(input, val) {
    if (!input) return false;
    try {
      input.focus();
      const proto = win.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(input, val);
      else input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }

  function isPanelNode(el) {
    return !!(el && el.closest && el.closest('#vb-panel'));
  }

  function btDiscountStatusIn(row) {
    if (!row) return null;
    for (const c of row.querySelectorAll('p, span, div, small')) {
      const t = (c.textContent || '').trim();
      if (t && t.length < 200 && BT_CODE_STATUS.test(t)) return c;
    }
    return null;
  }

  function btFindDiscountCtx() {
    for (const i of document.querySelectorAll('input')) {
      if (i.type === 'hidden' || i.readOnly || isPanelNode(i)) continue;
      const hint = `${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`;
      let row = i.parentElement;
      let status = null;
      for (let k = 0; k < 5 && row; k++) {
        status = btDiscountStatusIn(row);
        if (status) break;
        row = row.parentElement;
      }
      if (!BT_CODE_INPUT.test(hint) && !status) continue;
      return { field: i, row: i.parentElement, status };
    }
    for (const skip of document.querySelectorAll('[data-testid="discount-skip"]')) {
      if (isPanelNode(skip)) continue;
      const form = skip.closest('form');
      if (!form) continue;
      const field = Array.from(form.querySelectorAll('input')).find((x) => x.type !== 'hidden' && !x.readOnly);
      const submit = form.querySelector('button[type="submit"]');
      if (field && submit) return { field, form, submit, kind: 'form' };
    }
    return null;
  }

  function btCodeApplied(ctx) {
    const want = SUPPORT_CODE.toUpperCase();
    const v = (ctx.field.value || '').trim().toUpperCase();
    if (v === want || v.startsWith(want)) return true;
    if (ctx.field.readOnly && v.includes(want)) return true;
    const st = (ctx.status?.textContent || '').toUpperCase();
    if (st.includes(want) && /APPLIED|DISCOUNT|%/.test(st)) return true;
    return false;
  }

  function btUseButton(row) {
    if (!row) return null;
    return Array.from(row.querySelectorAll('button')).find(
      (b) => BT_CODE_USE.test((b.textContent || '').trim()) && !isPanelNode(b),
    );
  }

  function btCodeSurface() {
    if (BT_CODE_SKIP.test(location.pathname)) return false;
    if (BT_CODE_ROUTES.test(location.pathname)) return true;
    if (document.querySelector('[data-testid="plan-qty"], [data-testid="discount-skip"], [data-testid="tos-accept"]')) return true;
    for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      if (isPanelNode(d)) continue;
      const t = (d.innerText || d.textContent || '').toLowerCase();
      if (/discount code|promo|get funded|evaluation account|vest capital|add funded/i.test(t)) return true;
    }
    return !!btFindDiscountCtx();
  }

  let btCodeBusy = false;
  let btCodeCooldown = 0;

  async function btApplySupportCode(opts = {}) {
    if (S.autoSupportCode === false) return;
    if (btCodeBusy || BT_CODE_SKIP.test(location.pathname)) return;
    const ctx = btFindDiscountCtx();
    if (!ctx || btCodeApplied(ctx)) return;
    if (document.activeElement === ctx.field && !opts.force) return;
    btCodeBusy = true;
    try {
      setReactInputValue(ctx.field, SUPPORT_CODE);
      await new Promise((r) => setTimeout(r, 200));
      const use = btUseButton(ctx.row);
      if (use && !use.disabled) use.click();
      else if (ctx.submit && !ctx.submit.disabled) ctx.submit.click();
      else {
        ctx.field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const again = btFindDiscountCtx();
        if (again && btCodeApplied(again)) {
          if (!opts.quiet) toast(`Support code ${SUPPORT_CODE} applied — thank you!`);
          return true;
        }
      }
    } catch {}
    finally {
      btCodeBusy = false;
    }
    return false;
  }

  function btCodeTick() {
    if (S.autoSupportCode === false) return;
    if (!btCodeSurface()) return;
    if (Date.now() < btCodeCooldown) return;
    const ctx = btFindDiscountCtx();
    if (!ctx || btCodeApplied(ctx)) return;
    btCodeCooldown = Date.now() + 2800;
    void btApplySupportCode({ quiet: true });
  }

  function qVest(sel, root) {
    const scope = root || document;
    let el = scope.querySelector(sel);
    if (el) return el;
    for (const iframe of scope.querySelectorAll('iframe')) {
      try {
        el = iframe.contentDocument?.querySelector(sel);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  function readInputNum(el) {
    if (!el) return NaN;
    const tryParse = (s) => {
      const n = parseFloat(String(s ?? '').replace(/,/g, '').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : NaN;
    };
    let n = tryParse(el.value);
    if (n > 0) return n;
    n = tryParse(el.getAttribute('value'));
    if (n > 0) return n;
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc?.get) n = tryParse(desc.get.call(el));
    return n > 0 ? n : NaN;
  }

  function findOrderPanel() {
    const submit = qVest('[data-testid="submit-long"]') || qVest('[data-testid="submit-short"]');
    if (submit) {
      let p = submit.parentElement;
      for (let i = 0; i < 14 && p; i++, p = p.parentElement) {
        if (p.querySelector('[data-testid="size-input"], [data-testid="leverage-button"], [data-testid="size-unit-toggle"]')) {
          return p;
        }
      }
      return submit.closest('form, section, aside, div') || submit.parentElement;
    }
    return null;
  }

  function readReactPropsValue(el) {
    if (!el || typeof el !== 'object') return NaN;
    const pk = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
    if (!pk) return NaN;
    const p = el[pk];
    if (!p || typeof p !== 'object') return NaN;
    for (const key of ['value', 'defaultValue']) {
      if (p[key] == null || String(p[key]) === '') continue;
      const n = parseFloat(String(p[key]).replace(/,/g, ''));
      if (n > 0) return n;
    }
    return NaN;
  }

  function readTicketAmountFromFiber(input) {
    if (!input) return NaN;
    let n = readReactPropsValue(input);
    if (n > 0) return n;
    const ticketKeys = ['value', 'size', 'amount', 'orderSize', 'inputValue', 'defaultValue'];
    let f = fiberOf(input);
    for (let d = 0; f && d < 45; f = f.return, d++) {
      const p = f.memoizedProps || f.pendingProps;
      if (p && typeof p === 'object') {
        for (const k of ticketKeys) {
          if (p[k] == null || String(p[k]) === '') continue;
          const x = parseFloat(String(p[k]).replace(/,/g, ''));
          if (x > 0 && x < 1e9) return x;
        }
      }
      let s = f.memoizedState;
      for (let i = 0; s && i < 30; s = s.next, i++) {
        const m = s.memoizedState;
        if (typeof m === 'number' && m > 0 && m < 1e9) return m;
        if (typeof m === 'string' && m.trim() !== '') {
          const x = parseFloat(m.replace(/,/g, ''));
          if (x > 0 && x < 1e9) return x;
        }
      }
    }
    return NaN;
  }

  function readReactInputValue(input) {
    if (!input) return NaN;
    let n = readInputNum(input);
    if (n > 0) return n;
    n = readTicketAmountFromFiber(input);
    return n > 0 ? n : NaN;
  }

  function readSizeFromStores() {
    let best = null;
    const seed = qVest('[data-testid="size-input"]') || qVest('[data-testid="submit-long"]');
    const tryNum = (v, scale) => {
      if (v == null) return;
      const n = typeof v === 'bigint' ? Number(v) / (scale || 1e6) : Number(v);
      if (n > 0 && n < 1e9) best = best == null ? n : best;
    };
    const scan = (obj, depth, seen) => {
      if (!obj || depth > 6 || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      for (const k of ['size', 'amount', 'orderSize', 'inputSize', 'sizeUsd']) {
        if (k in obj) tryNum(obj[k], 1);
      }
      for (const k of ['draft', 'order', 'orderForm', 'form', 'values', 'orderDraft', 'ticket']) {
        if (obj[k] && typeof obj[k] === 'object') scan(obj[k], depth + 1, seen);
      }
    };
    walkZustandStores(seed, (st) => {
      if (!st || typeof st !== 'object') return;
      tryNum(st.size, 1);
      tryNum(st.quantity, 1e6);
      tryNum(st.orderSize, 1);
      if (st.draft && typeof st.draft === 'object') {
        tryNum(st.draft.size, 1);
        tryNum(st.draft.quantity, 1e6);
      }
      scan(st, 0, new Set());
    });
    return best;
  }

  function pctButtonSelected(b) {
    if (!b) return false;
    const st = b.getAttribute('data-state');
    if (st === 'on' || st === 'checked' || st === 'active') return true;
    for (const a of ['aria-pressed', 'aria-checked', 'data-checked', 'data-selected']) {
      const v = b.getAttribute(a);
      if (v === 'true' || v === '1') return true;
    }
    const cls = b.className || '';
    if (/\b(active|selected|is-selected|data-state-on)\b/i.test(cls)) return true;
    if (b.getAttribute('role') === 'radio' && b.getAttribute('aria-checked') !== 'false') {
      const grp = b.closest('[role="radiogroup"]');
      if (grp && grp.contains(b) && b.matches?.('[aria-checked="true"]')) return true;
    }
    return false;
  }

  function readPctPresetOnTicket() {
    const panel = findOrderPanel() || document;
    for (const p of [100, 50, 25, 10]) {
      const b = panel.querySelector(`[data-testid="size-pct-${p}"]`)
        || qVest(`[data-testid="size-pct-${p}"]`);
      if (!b) continue;
      if (pctButtonSelected(b)) return p;
    }
    return null;
  }

  function readPercentFromStores() {
    let best = null;
    const seed = qVest('[data-testid="size-input"]') || qVest('[data-testid="size-unit-toggle"]')
      || qVest('[data-testid="submit-long"]');
    const bump = (v) => {
      const c = pctClean(v);
      if (c != null) best = c;
    };
    const scan = (obj, depth, seen) => {
      if (!obj || depth > 7 || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      for (const k of ['percent', 'pct', 'sizePercent', 'positionPercent', 'orderPercent', 'sizePct']) {
        if (k in obj) bump(obj[k]);
      }
      const su = obj.sizeUnit ?? obj.unit ?? obj.quoteUnit;
      if (su != null && /percent|pct|%/i.test(String(su))) {
        bump(obj.size);
        bump(obj.amount);
      }
      for (const k of ['draft', 'order', 'orderForm', 'form', 'values', 'orderDraft', 'ticket']) {
        if (obj[k] && typeof obj[k] === 'object') scan(obj[k], depth + 1, seen);
      }
    };
    walkZustandStores(seed, (st) => {
      if (st && typeof st === 'object') scan(st, 0, new Set());
    });
    return best;
  }

  function resolveTicketSize() {
    const readOnce = () => {
      const panel = findOrderPanel();
      const sizeInp = qVest('[data-testid="size-input"]') || findVestAmountInput();
      const unit = ticketSizeUnit();
      if (unit === 'pct') {
        const p = readPctPresetOnTicket() || readPercentFromStores();
        if (isValidPct(p)) return pctClean(p);
      }
      if (sizeInp) {
        const raw = readReactInputValue(sizeInp);
        const pct = pctClean(raw);
        if (pct != null) return pct;
        if (raw > 0) return raw;
      }
      if (panel) {
        const inputs = panel.querySelectorAll('input');
        for (const inp of inputs) {
          if (inp.closest('#vb-panel')) continue;
          if (inp === qVest('[data-testid="price-input"]')) continue;
          const v = readReactInputValue(inp);
          if (v > 0 && v < 1e9) return v;
        }
      }
      const fromStore = readSizeFromStores();
      if (fromStore > 0) return fromStore;
      const pctPreset = readPctPresetOnTicket();
      if (isValidPct(pctPreset)) return pctPreset;
      const storePct = readPercentFromStores();
      if (isValidPct(storePct)) return storePct;
      return null;
    };
    let v = readOnce();
    if (v != null && v > 0) return v;
    nudgeVestSizeRecalc();
    v = readOnce();
    if (v != null && v > 0) return v;
    const sizeInp = qVest('[data-testid="size-input"]') || findVestAmountInput();
    if (sizeInp) {
      const fromFiber = readTicketAmountFromFiber(sizeInp);
      if (fromFiber > 0) return fromFiber;
      const unit = ticketSizeUnit();
      if (unit === 'token') {
        const q = readQtyFromFiber({ usdHint: NaN });
        if (q > 0 && q < 1e6) return q;
      }
    }
    return null;
  }

  function levFromRaw(v) {
    if (v == null) return 0;
    let n = typeof v === 'bigint' ? Number(v) : Number(v);
    if (!Number.isFinite(n)) return 0;
    if (n >= 1e6) n = n / 1e6;
    else if (n > 1000) n = n / 1e6;
    if (n >= 1 && n <= 1000) return n;
    return 0;
  }

  function readLeverageFromStores() {
    let best = 0;
    const bump = (v) => {
      const l = levFromRaw(v);
      if (l > best) best = l;
    };
    const scanLev = (obj, depth, seen) => {
      if (!obj || depth > 8 || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      for (const [k, v] of Object.entries(obj)) {
        if (/leverage/i.test(k)) bump(v);
        if (v && typeof v === 'object') scanLev(v, depth + 1, seen);
      }
    };
    walkZustandStores(qVest('[data-testid="leverage-button"]') || qVest('[data-testid="submit-long"]') || qVest('[data-testid="size-input"]'), (st) => {
      if (!st || typeof st !== 'object') return;
      bump(st.leverage);
      scanLev(st, 0, new Set());
    });
    return best;
  }

  function nudgeVestSizeRecalc() {
    const inp = qVest('[data-testid="size-input"]') || findVestAmountInput();
    if (!inp) return;
    try {
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    } catch {}
  }

  function scrapeTicketLeverage() {
    const panel = findOrderPanel();
    const blobs = [];
    if (panel) blobs.push(panel.innerText?.slice(0, 4000) || '');
    const btn = qVest('[data-testid="leverage-button"]');
    if (btn) {
      blobs.push(btn.textContent, btn.getAttribute('aria-label'), btn.getAttribute('title'));
      let f = fiberOf(btn);
      for (let d = 0; f && d < 35; f = f.return, d++) {
        const p = f.memoizedProps;
        if (p?.leverage != null) {
          const l = levFromRaw(p.leverage);
          if (l > 1) return l;
        }
        if (p?.children != null) blobs.push(String(p.children));
      }
    }
    for (const s of blobs) {
      const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*[x×]/i);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 1000) return n;
      }
    }
    const levEls = document.querySelectorAll('[data-testid*="leverage"]');
    for (const el of levEls) {
      if (el.closest('#vb-panel')) continue;
      const m = (el.textContent || el.getAttribute('aria-label') || '').match(/(\d+(?:\.\d+)?)\s*[x×]?/i);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 1000) return n;
      }
    }
    return null;
  }

  function resolveTicketLeverage() {
    const scraped = scrapeTicketLeverage();
    if (scraped > 1) return scraped;
    const storeL = readLeverageFromStores();
    if (storeL > 1) return storeL;
    const ctx = readPctContext();
    if (ctx.storeLev > 1) return ctx.storeLev;
    return scraped || storeL || ctx.storeLev || null;
  }

  function findVestAmountInput() {
    const panel = findOrderPanel() || qVest('[data-testid="submit-long"]')?.closest('form, section, aside, div') || document.body;
    const labeled = Array.from(panel.querySelectorAll('div, label, span, p')).find((el) => {
      if (el.closest('#vb-panel')) return false;
      return /^\s*(Amount|Size)\s*$/i.test((el.textContent || '').trim());
    });
    if (labeled) {
      const root = labeled.parentElement || labeled;
      const input = root.querySelector('input') || root.parentElement?.querySelector('input');
      if (input && !input.closest('#vb-panel')) return input;
    }
    return Array.from(panel.querySelectorAll('input')).find((i) => {
      if (i.closest('#vb-panel')) return false;
      const hint = `${i.placeholder || ''} ${i.getAttribute('aria-label') || ''} ${i.name || ''}`;
      return /amount|size|qty/i.test(hint);
    }) || null;
  }

  function parsePriceText(t) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    const m = s.match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+\.[0-9]+|[0-9]+)/);
    if (!m) return NaN;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : NaN;
  }

  function priceFromTestId(testId) {
    const el = qVest(`[data-testid="${testId}"]`);
    if (!el || el.closest('#vb-panel')) return NaN;
    return parsePriceText(el.textContent);
  }

  const VEST_BAR_IDS = {
    'Mid Price': 'market-midPrice',
    'Index Price': 'market-indexPrice',
    'Mark Price': 'market-markPrice',
  };

  function scrapeLabelPrice(label) {
    const barId = VEST_BAR_IDS[label];
    if (barId) {
      const v = priceFromTestId(barId);
      if (v > 0) return v;
    }
    const num = '([0-9,]+(?:\\.\\d+)?)';
    const re = new RegExp(label, 'i');
    const nodes = document.querySelectorAll('span, div, p, label, dt, dd, h3, h4, button, a');
    for (const n of nodes) {
      if (n.closest('#vb-panel')) continue;
      if (n.children.length > 8) continue;
      const txt = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!re.test(txt) || txt.length > 64) continue;
      const direct = txt.match(new RegExp(label + '\\s*:?\\s*\\$?\\s*' + num, 'i'));
      if (direct) {
        const v = parseFloat(direct[1].replace(/,/g, ''));
        if (v > 0) return v;
      }
      const parent = n.parentElement;
      if (parent && !parent.closest('#vb-panel')) {
        const blob = parent.innerText.replace(/\s+/g, ' ');
        const m = blob.match(new RegExp(label + '\\s*:?\\s*\\$?\\s*' + num, 'i'));
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 0) return v;
        }
      }
    }
    const reExact = new RegExp(`^\\s*${label}\\s*$`, 'i');
    for (const el of document.querySelectorAll('a, span, div, p, td, th, label, button, li')) {
      if (el.closest('#vb-panel')) continue;
      const own = (el.textContent || '').trim();
      if (!reExact.test(own) && own !== label) continue;
      const sib = el.nextElementSibling || el.parentElement?.nextElementSibling;
      if (sib) {
        const v = parsePriceText(sib.textContent);
        if (v > 0) return v;
      }
    }
    return null;
  }

  function snapMarketPrice() {
    const mids = [
      priceFromTestId('market-midPrice'),
      scrapeLabelPrice('Mid Price'),
      scrapeLabelPrice('Mark Price'),
      scrapeLabelPrice('Index Price'),
      priceFromTestId('market-markPrice'),
      priceFromTestId('market-indexPrice'),
    ];
    for (const v of mids) {
      if (v > 0) {
        lastKnownMid = v;
        lastKnownMidAt = Date.now();
        return v;
      }
    }
    const ctx = readPctContext();
    const storePx = ctx.mmark > 0 ? ctx.mmark : ctx.mark > 0 ? ctx.mark : 0;
    if (storePx > 0) {
      lastKnownMid = storePx;
      lastKnownMidAt = Date.now();
      return storePx;
    }
    const blob = document.body?.innerText?.slice(0, 12000) || '';
    for (const name of ['Mid Price', 'Mark Price', 'Index Price']) {
      const m = blob.match(new RegExp(name + '\\s*\\$?\\s*([0-9,]+(?:\\.\\d+)?)', 'i'));
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (n > 0) {
          lastKnownMid = n;
          lastKnownMidAt = Date.now();
          return n;
        }
      }
    }
    const testIds = [
      '[data-testid*="mark-price"]',
      '[data-testid*="mid-price"]',
      '[data-testid*="last-price"]',
      '[data-testid="market-price"]',
    ];
    for (const sel of testIds) {
      const el = qVest(sel);
      const n = parsePriceText(el?.textContent);
      if (n > 0) {
        lastKnownMid = n;
        lastKnownMidAt = Date.now();
        return n;
      }
    }
    const priceInp = qVest('[data-testid="price-input"]');
    const pin = readInputNum(priceInp);
    if (pin > 0) {
      lastKnownMid = pin;
      lastKnownMidAt = Date.now();
      return pin;
    }
    if (lastKnownMid > 0 && Date.now() - lastKnownMidAt < 45000) return lastKnownMid;
    return null;
  }

  function snapVestTicket() {
    const sizeInp = qVest('[data-testid="size-input"]') || findVestAmountInput();
    const size = resolveTicketSize();
    const lev = resolveTicketLeverage();
    const ticketVisible = !!(qVest('[data-testid="submit-long"]') || qVest('[data-testid="submit-short"]'));
    return {
      size: size != null && size > 0 ? size : null,
      leverage: lev != null && lev >= 1 ? lev : null,
      ticketVisible,
      sizeEl: !!sizeInp,
      unit: ticketSizeUnit(),
    };
  }

  function ticketSizeUnit() {
    const fromFiber = readSizeUnitFromFiber();
    if (fromFiber) return fromFiber;
    const tog = qVest('[data-testid="size-unit-toggle"]');
    const t = vestUnitToggleText(tog).replace(/\s+/g, ' ').trim().toUpperCase();
    if (t.includes('USD')) return 'usd';
    if (t.includes('%') || t.includes('PCT') || t.includes('PERCENT')) return 'pct';
    const sel = qVest('[data-testid="size-unit-select"]');
    const fromSel = sel?.getAttribute('data-unit');
    if (fromSel) {
      const u = String(fromSel).toLowerCase();
      if (u === 'percent' || u === 'pct' || u === '%') return 'pct';
      return u;
    }
    return 'token';
  }

  function isUsdTicket() {
    const t = snapVestTicket();
    const unit = t.unit || ticketSizeUnit();
    return unit === 'usd' && !usesPercentSizing(unit, t.size);
  }

  function usdSizingTrusted(resolved) {
    if (!resolved?.quantity) return false;
    return /^(vest-fiber|vest-store|ticket-equiv|vest-trade|vest-calib)/.test(resolved.source || '');
  }

  function pctClean(v) {
    if (v == null) return null;
    const t = String(v).trim().replace(/\s*%$/, '').replace(/,/g, '.');
    const n = parseFloat(t);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
    return Math.round(n * 100) / 100;
  }

  function isValidPct(v) {
    return pctClean(v) != null;
  }

  function vestUnitToggleText(tog) {
    if (!tog) return '';
    return [
      tog.textContent,
      tog.getAttribute('aria-label'),
      tog.getAttribute('title'),
      tog.getAttribute('data-unit'),
    ].filter(Boolean).join(' ');
  }

  function readSizeUnitFromFiber() {
    const tog = qVest('[data-testid="size-unit-toggle"]') || qVest('[data-testid="size-input"]');
    if (!tog) return null;
    const norm = (s) => {
      const u = String(s || '').toLowerCase();
      if (!u) return null;
      if (u.includes('usd') || u === 'dollar') return 'usd';
      if (u.includes('percent') || u === 'pct' || u.includes('%')) return 'pct';
      if (u.includes('mini')) return 'mini';
      if (u.includes('micro')) return 'micro';
      if (u.includes('contract') || u === 'token' || u === 'qty' || u === 'quantity') return 'token';
      return null;
    };
    let f = fiberOf(tog);
    for (let d = 0; f && d < 45; f = f.return, d++) {
      const p = f.memoizedProps || f.pendingProps;
      if (!p || typeof p !== 'object') continue;
      for (const k of ['sizeUnit', 'unit', 'quoteUnit', 'activeUnit', 'selectedUnit', 'value']) {
        const hit = norm(p[k]);
        if (hit) return hit;
      }
    }
    return null;
  }

  function usesPercentSizing(unit, sizeVal) {
    if (unit === 'usd' || unit === 'mini' || unit === 'micro') return false;
    if (unit === 'pct') return true;
    if (isValidPct(readPctPresetOnTicket())) return true;
    const tog = qVest('[data-testid="size-unit-toggle"]');
    const togTxt = vestUnitToggleText(tog).toUpperCase();
    if (/%|PCT|PERCENT/.test(togTxt)) return true;
    return false;
  }

  function scrapeAccountBalance() {
    const blob = document.body?.innerText?.slice(0, 12000) || '';
    for (const re of [
      /Buying Power\s*\$?\s*([\d,]+\.?\d*)/i,
      /(?:Account )?Balance\s*\$?\s*([\d,]+\.?\d*)/i,
      /Equity\s*\$?\s*([\d,]+\.?\d*)/i,
    ]) {
      const m = blob.match(re);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (n > 0) return n;
      }
    }
    return 0;
  }

  function walkZustandStores(seedEl, visit) {
    if (!seedEl) return;
    const k = Object.keys(seedEl).find((x) => x.indexOf('__reactFiber$') === 0);
    let f = k ? seedEl[k] : null;
    const seen = new Set();
    for (let d = 0; f && d < 100; f = f.return, d++) {
      let s = f.memoizedState;
      for (let i = 0; s && i < 60; s = s.next, i++) {
        const m = s.memoizedState;
        if (m && typeof m.getState === 'function' && !seen.has(m)) {
          seen.add(m);
          try { visit(m.getState()); } catch {}
        }
      }
    }
  }

  function bigToNum(v, scale) {
    if (v == null) return NaN;
    if (typeof v === 'bigint') return Number(v) / scale;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function readPctContext() {
    const out = { bal: 0, upnl: 0, fee: 0, mark: 0, mmark: 0, storeLev: 0 };
    const seed = qVest('[data-testid="submit-long"]') || qVest('[data-testid="size-input"]') || qVest('[data-testid="account-selector-trigger"]');
    const id = () => accountId;
    walkZustandStores(seed, (st) => {
      if (!st || typeof st !== 'object') return;
      const accId = id() || st.activeAccountId;
      if (accId && st.accounts && st.accounts[accId]) {
        const row = st.accounts[accId];
        if (row.balance != null) {
          const b = bigToNum(row.balance, 1e6);
          if (b > 0) out.bal = b;
        }
        if (row.value != null) {
          const v = bigToNum(row.value, 1e6);
          if (v > 0) out.bal = out.bal || v;
        }
        if (row.unrealizedPnl != null) out.upnl = bigToNum(row.unrealizedPnl, 1e6) || 0;
      }
      if (st.marketSpec && st.marketData) {
        const pd = Number(st.marketSpec.priceDecimals);
        const d = Number.isInteger(pd) && pd >= 0 ? Math.pow(10, pd) : 1e6;
        if (st.leverage != null) {
          const lv = levFromRaw(st.leverage);
          if (lv >= 1) out.storeLev = lv;
        }
        const mp = bigToNum(st.marketData.markPrice, d);
        const mm = bigToNum(st.marketData.marginMarkPrice, d);
        if (mp > 0) out.mark = mp;
        if (mm > 0) out.mmark = mm;
        const tk = bigToNum(st.marketSpec.takerFee, 1e7);
        const mk = bigToNum(st.marketSpec.makerFee, 1e7);
        out.fee = Math.max(0, tk || 0, mk || 0);
      }
    });
    const scraped = scrapeAccountBalance();
    if (scraped > 0 && !out.bal) out.bal = scraped;
    return out;
  }

  function pctPower(bal, upnl, lev, fee) {
    const b = Number(bal);
    const u = Number(upnl) || 0;
    const l = Number(lev);
    const f = Number(fee) || 0;
    if (!(b > 0) || !(l > 0)) return 0;
    let x = Math.max(b + Math.min(u, 0), 0) * l;
    if (f > 0) x /= 1 + l * f;
    return (x * 1e4) / (1e4 + 10);
  }

  function readMarketMeta() {
    const meta = { sizeDec: 6, step: 0.01, storeLev: 0, minQty: 0 };
    walkZustandStores(qVest('[data-testid="submit-long"]') || qVest('[data-testid="size-input"]'), (st) => {
      if (!st?.marketSpec) return;
      const sd = Number(st.marketSpec.sizeDecimals);
      if (Number.isInteger(sd) && sd >= 0) meta.sizeDec = sd;
      const pow = Math.pow(10, meta.sizeDec);
      const raw = st.marketSpec.quantityStep ?? st.marketSpec.qtyStep ?? st.marketSpec.step;
      const s = bigToNum(raw, 1e6);
      if (s > 0) meta.step = s;
      else if (pow > 0) meta.step = 1 / pow;
      const mn = st.marketSpec.minOrderQuantity ?? st.marketSpec.minQuantity ?? st.marketSpec.minQty;
      const mq = bigToNum(mn, pow);
      if (mq > 0) meta.minQty = mq;
      const lv = levFromRaw(st.leverage);
      if (lv >= 1) meta.storeLev = lv;
    });
    return meta;
  }

  function marketQtyStep() {
    return readMarketMeta().step;
  }

  function qtyFromRaw(v, sizeDec) {
    if (v == null) return NaN;
    const pow = Math.pow(10, sizeDec);
    if (typeof v === 'bigint') return Number(v) / pow;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    if (n > 1e7) return n / pow;
    if (Number.isInteger(n) && n > 99 && pow > 1) return n / pow;
    return n;
  }

  function effectiveLeverage(lev) {
    const l = Number(lev);
    if (l > 1 && l <= 1000) return l;
    const scraped = scrapeTicketLeverage();
    if (scraped > 1) return scraped;
    const storeL = readLeverageFromStores();
    if (storeL > 1) return storeL;
    const ctx = readPctContext();
    if (ctx.storeLev > 1) return ctx.storeLev;
    const meta = readMarketMeta();
    if (meta.storeLev > 1) return meta.storeLev;
    const t = snapVestTicket();
    if (t.leverage > 1) return t.leverage;
    return l > 0 ? l : 1;
  }

  function looksLikeUsdInput(qty, usd) {
    if (!(qty > 0) || !(usd > 0)) return false;
    return Math.abs(qty - usd) < 0.02;
  }

  function pickContractQty(candidate, usd, step) {
    const n = Number(candidate);
    if (!(n > 0)) return null;
    if (looksLikeUsdInput(n, usd)) return null;
    if (n > 500 && usd < 500) return null;
    const st = step > 0 ? step : 0.01;
    if (n >= st && n < 1e6) return n;
    return null;
  }

  function numFromUnknown(v) {
    if (v == null) return NaN;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = parseFloat(v.replace(/,/g, ''));
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  function readQtyFromFiber(opts = {}) {
    const meta = readMarketMeta();
    const step = meta.step;
    const usd = opts.usdHint;
    let best = null;
    const roots = [
      qVest('[data-testid="size-input"]'),
      qVest('[data-testid="submit-long"]'),
      qVest('[data-testid="submit-short"]'),
    ];
    const keys = new Set([
      'quantity', 'computedQuantity', 'orderQuantity', 'tokenQuantity',
      'contractQuantity', 'qty', 'size', 'amount',
    ]);
    const tryVal = (v) => {
      const raw = qtyFromRaw(v, meta.sizeDec);
      const n = Number.isFinite(raw) ? raw : numFromUnknown(v);
      const pick = pickContractQty(n, usd, step);
      if (pick != null && (best == null || pick < best)) best = pick;
    };
    const visitObj = (obj, depth, seen) => {
      if (!obj || depth > 5 || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      if (obj.values && typeof obj.values === 'object') visitObj(obj.values, depth + 1, seen);
      for (const k of keys) {
        if (k in obj) tryVal(obj[k]);
      }
      if (typeof obj.quantity === 'bigint') tryVal(obj.quantity);
    };
    for (const el of roots) {
      if (!el) continue;
      let f = fiberOf(el);
      for (let d = 0; f && d < 55; f = f.return, d++) {
        const p = f.memoizedProps;
        if (p && typeof p === 'object') {
          for (const k of keys) tryVal(p[k]);
          if (p.getValues && typeof p.getValues === 'function') {
            try {
              const q = p.getValues('quantity');
              tryVal(q);
            } catch {}
          }
          if (p.watch && typeof p.watch === 'function') {
            try { tryVal(p.watch('quantity')); } catch {}
          }
          visitObj(p.formState || p.formValues, 0, new Set());
        }
        let s = f.memoizedState;
        for (let i = 0; s && i < 40; s = s.next, i++) {
          const m = s.memoizedState;
          if (m && typeof m === 'object') visitObj(m, 0, new Set());
        }
      }
    }
    return best;
  }

  function readSubmitQtyHint() {
    for (const id of ['submit-long', 'submit-short']) {
      const b = qVest(`[data-testid="${id}"]`);
      if (!b || b.closest('#vb-panel')) continue;
      const blob = `${b.textContent || ''} ${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`;
      const m = blob.match(/(\d+(?:\.\d+)?)\s*(?:NQ|MNQ|ES|MES|SPX|NDX)(?:\b|[-_])/i)
        || blob.match(/(\d+(?:\.\d+)?)\s*contract/i);
      if (m) {
        const n = parseFloat(m[1]);
        if (n > 0 && n < 1e4) return n;
      }
    }
    return null;
  }

  function readTicketSizeEquiv() {
    const panel = findOrderPanel();
    const submitQ = readSubmitQtyHint();
    if (submitQ > 0) return submitQ;
    if (!panel) return null;
    const testIds = panel.querySelectorAll(
      '[data-testid*="size-equiv"], [data-testid*="estimated-size"], [data-testid*="order-size"], [data-testid*="quantity-equiv"]'
    );
    for (const el of testIds) {
      const n = parseFloat((el.textContent || '').replace(/,/g, '').replace(/[^\d.]/g, ''));
      if (n > 0 && n < 1e7) return n;
    }
    const globalEquiv = qVest('[data-testid*="size-equiv"]');
    if (globalEquiv && findOrderPanel()?.contains(globalEquiv)) {
      const n = parseFloat((globalEquiv.textContent || '').replace(/,/g, '').replace(/[^\d.]/g, ''));
      if (n > 0 && n < 1e7) return n;
    }
    const sym = displaySymbol(apiSymbol(activeChartSymbol()));
    for (const el of panel.querySelectorAll('span, p, div, small, i')) {
      const t = (el.textContent || '').trim();
      if (t.length > 80 || t.length < 2) continue;
      const symM = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${sym}|NQ|MNQ|ES|MES)(?!\\s*USD)`, 'i').exec(t);
      if (symM) {
        const n = parseFloat(symM[1]);
        if (n > 0 && n < 1e4) return n;
      }
    }
    const txt = panel.innerText || '';
    const patterns = [
      /(?:≈|~|Est\.?|Estimated|Size)\s*[:\s]*\$?\s*(\d+(?:\.\d+)?)\s*(?:NQ|MNQ|ES|MES|contract|CT)\b/i,
      /(\d+(?:\.\d+)?)\s*(?:NQ|MNQ|ES|MES)\b(?!\s*USD)/i,
      /(\d+(?:\.\d+)?)\s*contract/i,
    ];
    for (const re of patterns) {
      const m = txt.match(re);
      if (m) {
        const n = parseFloat(m[1]);
        if (n > 0) return n;
      }
    }
    return null;
  }

  function readOrderQtyFromStores(usdHint) {
    const meta = readMarketMeta();
    const step = meta.step;
    let best = null;
    const tryB = (v) => {
      const n = qtyFromRaw(v, meta.sizeDec);
      const pick = pickContractQty(n, usdHint, step);
      if (pick != null) best = pick;
    };
    const scan = (obj, depth, seen) => {
      if (!obj || depth > 6 || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      tryB(obj.quantity);
      tryB(obj.orderQuantity);
      tryB(obj.tokenQuantity);
      tryB(obj.contractQuantity);
      tryB(obj.qty);
      for (const k of ['draft', 'order', 'orderForm', 'form', 'values', 'orderDraft', 'ticket']) {
        if (obj[k] && typeof obj[k] === 'object') scan(obj[k], depth + 1, seen);
      }
    };
    walkZustandStores(qVest('[data-testid="submit-long"]') || qVest('[data-testid="size-input"]'), (st) => {
      if (!st || typeof st !== 'object') return;
      scan(st, 0, new Set());
    });
    return best;
  }

  function floorToStep(raw, step) {
    const st = step > 0 ? step : 0.01;
    const n = Math.floor(Number((raw / st).toPrecision(12)));
    return n > 0 ? Number((n * st).toPrecision(12)) : 0;
  }

  function knownTicketLeverage() {
    const scraped = scrapeTicketLeverage();
    if (scraped > 1) return scraped;
    const storeL = readLeverageFromStores();
    if (storeL > 1) return storeL;
    const ctx = readPctContext();
    if (ctx.storeLev > 1) return ctx.storeLev;
    return 0;
  }

  function usdToContracts(usdVal, lev, out) {
    const usd = Number(usdVal);
    if (!(usd > 0)) return 0;
    const ctx = readPctContext();
    const price = liveMidPrice() || ctx.mmark || ctx.mark || snapMarketPrice();
    if (!(price > 0)) return 0;
    const meta = readMarketMeta();
    const step = meta.step;
    let lv = effectiveLeverage(lev);
    if (lv <= 1) lv = knownTicketLeverage();
    if (lv <= 1) return 0;
    const raw = (usd * lv) / price;
    const q = floorToStep(raw, step);
    if (q > 0) {
      if (out) out.inferredLev = lv;
      return q;
    }
    if (meta.minQty > 0 && raw > 0) {
      if (out) out.inferredLev = lv;
      return Number(formatQty(meta.minQty));
    }
    return 0;
  }

  function usdKey(usdVal) {
    return Math.round(Number(usdVal) * 100) / 100;
  }

  function mirrorUsdQuantity(sym, usdVal, lev) {
    const u = usdKey(usdVal);
    const key = `${sym}:${u}:${lev}`;
    const hit = vestUsdCalib.get(key);
    if (hit && Date.now() - hit.at < 7 * 86400000) return hit.quantity;
    const s = vestOpenSample;
    if (s?.symbol === sym && s.usd > 0 && s.quantity) {
      if (Math.abs(s.usd - u) < 0.05) return s.quantity;
      const q = parseFloat(s.quantity) * (u / s.usd);
      if (q > 0) return formatQty(q);
    }
    return null;
  }

  function resolveUsdQuantity(sym, usdVal, lev) {
    nudgeVestSizeRecalc();
    const u = usdKey(usdVal);
    const fiberQ = readQtyFromFiber({ usdHint: u });
    if (fiberQ > 0) return { quantity: formatQty(fiberQ), source: 'vest-fiber' };
    const equiv = readTicketSizeEquiv();
    if (equiv > 0 && !looksLikeUsdInput(equiv, u)) {
      return { quantity: formatQty(equiv), source: 'ticket-equiv' };
    }
    const storeQ = readOrderQtyFromStores(u);
    if (storeQ > 0) return { quantity: formatQty(storeQ), source: 'vest-store' };
    const mirrored = mirrorUsdQuantity(sym, u, lev);
    if (mirrored) return { quantity: formatQty(mirrored), source: 'vest-trade' };
    for (const [k, hit] of vestUsdCalib) {
      if (k.startsWith(`${sym}:${u}:`) && hit?.quantity) {
        return { quantity: formatQty(hit.quantity), source: 'vest-calib' };
      }
    }
    const calcMeta = {};
    const calc = usdToContracts(u, lev, calcMeta);
    if (calc > 0 && calcMeta.inferredLev > 1) {
      return {
        quantity: formatQty(calc),
        source: `calc @ ${calcMeta.inferredLev}×`,
        orderLeverage: String(Math.round(calcMeta.inferredLev)),
      };
    }
    return null;
  }

  function mirrorPctQuantity(sym, pctVal, lev) {
    const key = `${sym}:${pctVal}:${lev}`;
    const hit = vestPctCalib.get(key);
    if (hit && Date.now() - hit.at < 7 * 86400000) return hit.quantity;
    if (vestOpenSample?.symbol === sym && vestOpenSample.pct != null
        && Math.abs(vestOpenSample.pct - pctVal) < 0.2 && vestOpenSample.quantity) {
      return vestOpenSample.quantity;
    }
    if (vestOpenSample?.symbol === sym && vestOpenSample.pct > 0 && vestOpenSample.quantity && pctVal > 0) {
      const q = parseFloat(vestOpenSample.quantity) * (pctVal / vestOpenSample.pct);
      if (q > 0) return formatQty(q);
    }
    return null;
  }

  function pctToContracts(pctVal) {
    const pct = Math.min(100, Math.max(0, Number(pctVal)));
    if (!(pct > 0)) return 0;
    const t = snapVestTicket();
    const ctx = readPctContext();
    const lev = t.leverage || ctx.storeLev || 1;
    const mid = liveMidPrice() || ctx.mmark || ctx.mark;
    const price = mid;
    if (!(price > 0)) return 0;
    const room = 0.1;
    const power = pctPower(ctx.bal, ctx.upnl, lev, ctx.fee);
    const step = marketQtyStep();
    if (!(power > 0)) return 0;
    const n = Math.floor(Number((power * Math.min(pct, 100 - room) / 100 / price / step).toPrecision(12)));
    return n > 0 ? Number((n * step).toPrecision(12)) : 0;
  }

  function resolvePctQuantity(sym, pctVal, lev) {
    const equiv = readTicketSizeEquiv();
    if (equiv > 0) return { quantity: formatQty(equiv), source: 'ticket' };
    const storeQ = readOrderQtyFromStores();
    if (storeQ > 0) return { quantity: formatQty(storeQ), source: 'vest-store' };
    const mirrored = mirrorPctQuantity(sym, pctVal, lev);
    if (mirrored) return { quantity: formatQty(mirrored), source: 'vest-trade' };
    const calc = pctToContracts(pctVal);
    if (calc > 0) return { quantity: formatQty(calc), source: 'calc' };
    return null;
  }

  function orderLeverage() {
    const t = snapVestTicket();
    if (t.leverage > 1) return String(Math.max(1, Math.round(t.leverage)));
    const storeL = readLeverageFromStores();
    if (storeL > 1) return String(Math.round(storeL));
    const scraped = scrapeTicketLeverage();
    if (scraped > 1) return String(Math.round(scraped));
    const ctx = readPctContext();
    if (ctx.storeLev > 1) return String(Math.round(ctx.storeLev));
    if (vestOpenSample?.leverage) return String(Math.max(1, Math.round(Number(vestOpenSample.leverage))));
    return '1';
  }

  function openEntrySize() {
    const t = snapVestTicket();
    const unit = t.unit || ticketSizeUnit();
    const lev = orderLeverage();
    let pctVal = null;
    let sizeVal = t.size;
    const preset = readPctPresetOnTicket();
    if (isValidPct(preset)) pctVal = preset;
    if (sizeVal != null) {
      const asPct = pctClean(sizeVal);
      if (asPct != null) pctVal = asPct;
    }
    let pctMode = usesPercentSizing(unit, pctVal || sizeVal);
    if (pctMode) {
      if (!isValidPct(pctVal)) pctVal = pctClean(sizeVal);
      if (!isValidPct(pctVal) && isValidPct(preset)) pctVal = preset;
      if (!isValidPct(pctVal)) {
        const fromStore = readPercentFromStores();
        if (isValidPct(fromStore)) pctVal = fromStore;
      }
      if (!isValidPct(pctVal)) {
        const contractLike = sizeVal > 0 && (sizeVal > 100 || (unit === 'token' && !isValidPct(sizeVal)));
        if (contractLike) {
          pctMode = false;
        } else {
          const hint = t.sizeEl
            ? 'Enter your % (1–100) or tap 10/25/50/100 on Vest’s ticket.'
            : 'Open Vest’s order ticket on the right.';
          throw new Error(`Could not read % size — ${hint}`);
        }
      }
    } else if (!sizeVal && vestOpenSample && Date.now() - vestOpenSample.at < 180000) {
      const q = parseFloat(vestOpenSample.quantity);
      if (q > 0) sizeVal = q;
    }
    if (!pctMode && !sizeVal && t.sizeEl) {
      try {
        const inp = qVest('[data-testid="size-input"]') || findVestAmountInput();
        if (inp) {
          inp.focus({ preventScroll: true });
          nudgeVestSizeRecalc();
          const retry = resolveTicketSize();
          if (retry > 0) sizeVal = retry;
        }
      } catch {}
    }
    if (!pctMode && !sizeVal) {
      const hint = t.sizeEl
        ? 'Enter size on Vest’s ticket, or click the size box once and retry.'
        : 'Open Vest’s order ticket on the right (Long/Short visible).';
      throw new Error(`Could not read size — ${hint}`);
    }
    if (!pctMode && (unit === 'mini' || unit === 'micro')) {
      throw new Error(`Vest size is in ${unit} — switch the ticket to contracts (size unit toggle), then retry`);
    }
    const sym = apiSymbol(activeChartSymbol());
    const usdMode = unit === 'usd' && !pctMode;
    let quantity;
    let sizeSource = '';
    if (pctMode) {
      const resolved = resolvePctQuantity(sym, pctVal, lev);
      if (resolved) {
        quantity = resolved.quantity;
        sizeSource = resolved.source;
      } else if (vestOpenSample?.quantity) {
        quantity = formatQty(vestOpenSample.quantity);
        sizeSource = 'last-vest-order';
      } else if (!isValidPct(pctVal)) {
        throw new Error(
          'Could not read % on Vest’s ticket — tap 10/25/50/100 (or type 1–100), then Sync.'
        );
      } else {
        throw new Error(
          `For ${pctVal}%: place one market order on Vest (right-side Long/Short), then retry.`
        );
      }
      sizeVal = pctVal;
    } else if (usdMode) {
      const usd = Number(sizeVal);
      if (!(usd > 0)) {
        throw new Error('Enter a USD amount on Vest’s ticket, then retry.');
      }
      const resolved = resolveUsdQuantity(sym, usd, lev);
      if (resolved) {
        quantity = resolved.quantity;
        sizeSource = resolved.source;
        if (resolved.orderLeverage) lev = resolved.orderLeverage;
        else if (/^vest-/.test(resolved.source) && vestOpenSample?.leverage) {
          const sl = Number(vestOpenSample.leverage);
          if (sl > 1) lev = String(Math.round(sl));
        }
      } else if (vestOpenSample?.quantity) {
        quantity = formatQty(vestOpenSample.quantity);
        sizeSource = 'last-vest-order';
        const sl = Number(vestOpenSample.leverage);
        if (sl > 1) lev = String(Math.round(sl));
      } else {
        const l = effectiveLeverage(lev);
        const px = liveMidPrice() || snapMarketPrice();
        const hint = !(px > 0)
          ? 'Tap Sync so we can read mid price.'
          : `price ~${formatPrice(px)}, leverage ~${l}× — click in the size box or do one Vest Long at $${usd}.`;
        const err = new Error(`For $${usd} USD could not resolve contracts — ${hint}`);
        err.code = 'USD_UNRESOLVED';
        throw err;
      }
    } else {
      quantity = formatQty(sizeVal);
      sizeSource = 'ticket';
    }
    if (vestOpenSample && vestOpenSample.symbol === sym && Date.now() - vestOpenSample.at < 600000) {
      const sampleQ = parseFloat(vestOpenSample.quantity);
      const ourQ = parseFloat(quantity);
      if (sampleQ > 0 && ourQ > sampleQ * 4) {
        throw new Error(`Size ${quantity} looks too large vs Vest (last order used ${vestOpenSample.quantity}) — check size unit on Vest’s ticket`);
      }
    }
    let label;
    if (pctMode) {
      label = `${quantity} contracts (${sizeVal}%) @ ${lev}×${sizeSource ? ` · ${sizeSource}` : ''}`;
    } else if (usdMode) {
      label = `${quantity} contracts ($${sizeVal} USD @ ${lev}× · ${sizeSource || 'ticket'})`;
    } else {
      label = `${quantity} @ ${lev}× (Vest ticket)`;
    }
    const orderLev = String(Math.max(1, Math.round(Number(lev) || 1)));
    return { quantity, leverage: orderLev, unit: pctMode ? 'pct' : unit, label, pct: pctMode ? sizeVal : null, sizeSource };
  }

  function formatPrice(p, dec) {
    const n = Number(p);
    if (!Number.isFinite(n)) return '';
    const d = Number.isFinite(dec) ? dec : 2;
    return n.toFixed(d).replace(/\.?0+$/, (m) => (m === '.' ? '' : m));
  }

  /** Vest API: trigger/limit prices allow at most 2 decimal places. */
  function formatApiPrice(p, tick, dir) {
    const x = roundToTick(p, tick, dir);
    if (!Number.isFinite(x)) return '';
    return x.toFixed(2);
  }

  function roundToTick(price, tick, dir) {
    const t = Number(tick) || 0.25;
    const x = Number(price);
    if (!Number.isFinite(x) || t <= 0) return x;
    const k = x / t;
    const r = dir === 'up' ? Math.ceil(k) : dir === 'down' ? Math.floor(k) : Math.round(k);
    return Math.round(r * t / t) * t;
  }

  function legRoundDir(side, leg) {
    const isTp = leg === 'tp';
    if (side === 'long') return isTp ? 'up' : 'down';
    return isTp ? 'down' : 'up';
  }

  function legPrice(entry, ticks, tick, side, leg) {
    const off = (Number(ticks) || 0) * tick;
    const raw = side === 'long'
      ? (leg === 'tp' ? entry + off : entry - off)
      : (leg === 'tp' ? entry - off : entry + off);
    return roundToTick(raw, tick, legRoundDir(side, leg));
  }

  function liveMidPrice() {
    const m = snapMarketPrice();
    const refInp = document.getElementById('vb-ref');
    if (m && refInp) refInp.value = m;
    return m;
  }

  function nudgeLegPastMid(side, kind, px, mid, tick) {
    const p = Number(px);
    const m = Number(mid);
    if (!Number.isFinite(p) || !Number.isFinite(m) || !(tick > 0)) return px;
    const minOff = tick;
    if (side === 'long') {
      if (kind === 'tp' && p <= m) return formatPrice(roundToTick(m + minOff, tick, 'up'));
      if (kind === 'sl' && p >= m) return formatPrice(roundToTick(m - minOff, tick, 'down'));
    } else {
      if (kind === 'tp' && p >= m) return formatPrice(roundToTick(m - minOff, tick, 'down'));
      if (kind === 'sl' && p <= m) return formatPrice(roundToTick(m + minOff, tick, 'up'));
    }
    return typeof px === 'string' ? px : formatPrice(px);
  }

  function validateBracketLegs(side, mid, slPx, tpPx) {
    const m = Number(mid);
    const sl = parseFloat(slPx);
    const tp = parseFloat(tpPx);
    const midTxt = formatPrice(m);
    if (side === 'long') {
      if (!(tp > m)) throw new Error(`Target ${tpPx} must be above mid ${midTxt} (refresh Sync, then try more target ticks)`);
      if (!(sl < m)) throw new Error(`Stop ${slPx} must be below mid ${midTxt}`);
    } else {
      if (!(tp < m)) throw new Error(`Target ${tpPx} must be below mid ${midTxt}`);
      if (!(sl > m)) throw new Error(`Stop ${slPx} must be above mid ${midTxt}`);
    }
  }

  function formatQty(q) {
    const n = Number(q);
    if (!Number.isFinite(n) || n <= 0) return '1';
    let s = n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    return s || '1';
  }

  function splitQty(total, pct) {
    const t = parseFloat(formatQty(total));
    const a = Math.max(0, Math.min(100, Number(pct) || 50)) / 100;
    const q1 = formatQty(t * a);
    const q2 = formatQty(Math.max(0, t - parseFloat(q1)));
    return { q1, q2 };
  }

  function snapReferencePrice() {
    const inp = document.getElementById('vb-ref');
    const v = parseFloat(inp?.value);
    if (Number.isFinite(v) && v > 0) return v;
    return snapMarketPrice();
  }

  function refreshSyncBadge(meta = {}) {
    const badge = document.getElementById('vb-sync-badge');
    const text = document.getElementById('vb-sync-text');
    const btn = document.getElementById('vb-sync');
    if (!badge || !text) return;
    badge.classList.remove('vb-on', 'vb-off', 'vb-busy', 'vb-warn');
    if (meta.busy) {
      badge.classList.add('vb-busy');
      text.textContent = 'Syncing from Vest…';
      if (btn) btn.classList.remove('vb-btn-synced');
      return;
    }
    if (ticketSynced) {
      badge.classList.add('vb-on');
      const when = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      text.textContent = lastSyncDetail || `Synced ${when}`;
      if (btn) {
        btn.classList.add('vb-btn-synced');
        btn.textContent = 'Synced — tap to refresh';
      }
      return;
    }
    badge.classList.add(meta.missing?.length ? 'vb-warn' : 'vb-off');
    const parts = meta.missing?.length ? [...meta.missing] : ['mid price or ticket'];
    text.textContent = parts.length
      ? `Not synced — need: ${parts.join(', ')}`
      : 'Not synced — tap Sync (reads Vest ticket + prices)';
    if (btn) {
      btn.classList.remove('vb-btn-synced');
      btn.textContent = 'Sync from Vest';
    }
  }

  let vbSyncing = false;

  function syncFromVestTicket(opts = {}) {
    const quiet = !!opts.quiet;
    const manual = !!opts.manual;
    if (vbSyncing) return { ok: ticketSynced, price: lastKnownMid || null };
    vbSyncing = true;
    try {
      if (manual) refreshSyncBadge({ busy: true });
      const p = snapMarketPrice();
      const t = snapVestTicket();
      syncActiveAccountFromVest();
      const missing = [];
      if (!p) missing.push('mid price');
      if (!t.size && !t.ticketVisible) missing.push('order ticket');
      const haveTicket = t.ticketVisible && (t.size > 0 || t.sizeEl);
      ticketSynced = !!(p || haveTicket);
      if (ticketSynced) {
        lastSyncAt = Date.now();
        const parts = [];
        if (p) parts.push(`mid ${formatPrice(p)}`);
        if (t.size) {
          const u = t.unit || ticketSizeUnit();
          parts.push(`size ${u === 'usd' ? '$' : ''}${t.size}${u === 'pct' || usesPercentSizing(u, t.size) ? '%' : ''}${t.leverage ? ` @ ${t.leverage}×` : ''}`);
        } else if (haveTicket) parts.push('ticket OK');
        lastSyncDetail = parts.length ? `Synced — ${parts.join(' · ')}` : 'Synced';
      } else {
        lastSyncDetail = '';
      }
      persist();
      refreshPlanPreview({ missing, price: p, size: t.size });
      refreshSyncBadge({ missing });
      refreshReadyLine();
      postState();
      if (!quiet || manual) {
        if (ticketSynced) toast(lastSyncDetail);
        else toast(missing.length ? `Not synced: need ${missing.join(' + ')}` : 'Could not read Vest mid');
      }
      return { price: p, size: t.size, leverage: t.leverage, ok: ticketSynced, missing };
    } finally {
      vbSyncing = false;
    }
  }

  function runSyncClick() {
    try {
      syncFromVestTicket({ manual: true });
    } catch (e) {
      ticketSynced = false;
      refreshSyncBadge({});
      toast(e?.message || String(e));
    }
  }

  function refreshPlanPreview(meta = {}) {
    const el = document.getElementById('vb-preview');
    if (!el) return;
    const t = snapVestTicket();
    const ref = snapMarketPrice();
    if (!ticketSynced && !ref && !(t.size > 0)) {
      el.textContent = 'Tap Sync — we read Vest’s ticket and mid/mark prices.';
      return;
    }
    if (!ref) {
      const unit = ticketSizeUnit();
      const sym = apiSymbol(activeChartSymbol());
      if (unit === 'usd' && t.size > 0) {
        const lev = t.leverage ? String(Math.round(t.leverage)) : orderLeverage();
        const r = resolveUsdQuantity(sym, t.size, lev);
        el.innerHTML = r
          ? `No mid on screen — using Vest data · <b>$${t.size}</b> → <b>${r.quantity}</b> contracts (${r.source})`
          : `Ticket <b>$${t.size}</b> — mid not found; click in size box, then Sync or Long/Short.`;
      } else {
        el.textContent = 'Ticket partially synced — mid not visible; Long/Short still tries Vest store + ticket.';
      }
      if (!ref) return;
    }
    const sym = apiSymbol(activeChartSymbol());
    const tick = Number(S.tickSize) || defaultTick(sym);
    const unit = ticketSizeUnit();
    const pctVal = t.size || readPctPresetOnTicket();
    const pctMode = usesPercentSizing(unit, pctVal);
    let vestSize = pctVal
      ? `<b>${pctVal}%</b>${t.leverage ? ` @ ${t.leverage}×` : ''}`
      : '<span class="vb-dim">set % on Vest ticket →</span>';
    if (unit === 'usd' && !pctMode) {
      const lev = t.leverage ? String(Math.round(t.leverage)) : orderLeverage();
      const usd = Number(pctVal || t.size);
      const r = usd > 0 ? resolveUsdQuantity(sym, usd, lev) : null;
      vestSize = usd > 0 ? `<b>$${usd}</b> USD${t.leverage ? ` @ ${t.leverage}×` : ''}` : vestSize;
      if (r) vestSize += ` <span class="vb-dim">→ ${r.quantity} contracts (${r.source})</span>`;
      else if (usd > 0) vestSize += ' <span class="vb-dim">— Long/Short clicks Vest’s native button</span>';
    } else if (pctMode) {
      const sym = apiSymbol(activeChartSymbol());
      const lev = t.leverage ? String(Math.round(t.leverage)) : orderLeverage();
      const r = resolvePctQuantity(sym, pctVal, lev);
      if (r) vestSize += ` <span class="vb-dim">→ ${r.quantity} contracts (${r.source})</span>`;
      else vestSize += ' <span class="vb-dim">— do one Vest trade at this % first</span>';
    } else if (unit !== 'token') vestSize += ` <span class="vb-dim">(${unit})</span>`;
    let trailLine = '<span class="vb-dim">Trail off — check “Trailing stop (limit)” to arm</span>';
    if (S.trailEnabled !== false && ref > 0) {
      const cfg = trailCfg();
      try {
        const sl = initialTrailStopPrices('long', ref);
        trailLine = `Trail SL (limit): start <b>${cfg.start}</b> pt profit · trail <b>${cfg.dist}</b> pt · initial stop ~<b>${sl.trigger}</b> (limit ${sl.limit})`;
      } catch {
        trailLine = '<span class="vb-dim">Trail on — Sync mid for stop preview</span>';
      }
    }
    el.innerHTML = `Mid ~<b>${formatPrice(ref)}</b> · Vest ${vestSize}<br>${trailLine}`;
  }

  function refreshReadyLine() {
    const el = document.getElementById('vb-ready');
    if (!el) return;
    if (!token) {
      el.textContent = 'Sign in to Vest in this tab';
      el.className = 'vb-ready vb-warn';
      return;
    }
    if (!accountId) {
      el.textContent = 'Account not detected — open Vest’s account menu once, then Sync';
      el.className = 'vb-ready vb-warn';
      return;
    }
    el.textContent = S.trailEnabled !== false
      ? 'Ready — market entry + trailing stop-limit on fills'
      : 'Ready — plain market (trail off)';
    el.className = 'vb-ready vb-ok';
  }

  function buildMarketOpen(side) {
    const chartSym = activeChartSymbol();
    const sym = apiSymbol(chartSym);
    const sizing = openEntrySize();
    const ref = snapReferencePrice() || liveMidPrice();
    const stopLosses = [];
    if (S.trailEnabled) {
      if (!(ref > 0)) throw new Error('Sync mid before entry — trail needs a reference price');
      stopLosses.push(buildTrailStopLeg(side, ref));
    }
    const body = {
      accountId,
      orderType: 'market',
      leverage: sizing.leverage,
      side,
      symbol: sym,
      quantity: sizing.quantity,
      timeInForce: 'IOC',
      takeProfits: [],
      stopLosses,
    };
    return { body, sym, side, sizing, ref };
  }

  async function submitViaVestTicket(side) {
    assertLicensed('trade');
    const id = side === 'long' ? 'submit-long' : 'submit-short';
    const btn = qVest(`[data-testid="${id}"]`);
    if (!btn) throw new Error('Vest’s Long/Short button is not on the page.');
    if (btn.disabled) {
      throw new Error('Vest’s button is disabled — check size, leverage, or margin on the ticket.');
    }
    nudgeVestSizeRecalc();
    vestClickSnap = snapVestTicket();
    const snapAt = vestOpenSample?.at || 0;
    btn.click();
    const tag = side === 'long' ? 'LONG' : 'SHORT';
    setAction(`Clicked Vest’s native ${tag} (USD size on ticket)`, 'busy');
    toast(`Native ${tag} — Vest handles USD sizing`);
    const deadline = Date.now() + 4500;
    let filled = false;
    while (Date.now() < deadline) {
      if (vestOpenSample && vestOpenSample.at > snapAt) filled = true;
      if (vbTrail.lastOpenId) filled = true;
      if (filled) break;
      await new Promise((r) => setTimeout(r, TRAIL_POLL_MS));
    }
    if (vestOpenSample && vestOpenSample.at > snapAt) {
      const msg = `${tag} via Vest ticket · qty ${vestOpenSample.quantity} (saved for next API send)`;
      setAction(msg, 'ok');
      toast(msg);
      setStatus('USD mode — every Long/Short uses Vest’s ticket');
      if (S.trailEnabled) {
        await afterFillArmTrail(activeChartSymbol(), vestOpenSample.positionId || vbTrail.lastOpenId, side);
      }
      return { native: true, quantity: vestOpenSample.quantity };
    }
    setAction(`${tag} clicked on Vest — check fill / error on the ticket`, 'ok');
    if (S.trailEnabled) await afterFillArmTrail(activeChartSymbol(), vbTrail.lastOpenId, side);
    return { native: true };
  }

  async function sendMarketOrder(side) {
    assertLicensed('trade');
    if (!token) setAction('Waiting for Vest login token…', 'busy');
    await ensureToken();
    await ensureAccountId();
    syncFromVestTicket({ quiet: true });
    if (isUsdTicket()) {
      return submitViaVestTicket(side);
    }
    let plan;
    try {
      plan = buildMarketOpen(side);
    } catch (e) {
      throw e;
    }
    const body = plan.body;
    vbOwnOpen = true;
    let res;
    try {
      try {
        res = await api('/v3/positions/open', {
          accountId,
          method: 'POST',
          body,
        });
      } catch (e) {
        if (e.httpStatus === 400 && /position|already|exist|duplicate|open/i.test(e.message || '')) {
          throw new Error(`${e.message} — close or reduce on Vest first, or change size.`);
        }
        throw e;
      }
    } finally {
      vbOwnOpen = false;
    }
    const tag = side === 'long' ? 'LONG' : 'SHORT';
    const pid = res?.positionId || res?.data?.positionId || res?.id || vbTrail.lastOpenId;
    const q = body.quantity;
    const lv = body.leverage;
    const src = plan.sizing.sizeSource ? ` · ${plan.sizing.sizeSource}` : '';
    const trailBit = body.stopLosses?.length ? ' · trail stop-limit on open' : '';
    const okMsg = pid
      ? `${tag} ${q} @ ${lv}×${src}${trailBit} · ${String(pid).slice(0, 8)}…`
      : `${tag} ${q} @ ${lv}× — ${plan.sizing.label}`;
    toast(okMsg);
    setStatus(`Sent ${tag} on ${displaySymbol(plan.sym)}`);
    setAction(okMsg, 'ok');
    if (S.trailEnabled && pid) {
      vbPosCache = { at: 0, rows: [] };
      const seedSl = res?.stopLosses || vbTrail.lastOpenSl || body.stopLosses;
      armTrailFromRow({
        positionId: pid,
        symbol: plan.sym,
        side,
        openPrice: plan.ref || lastKnownMid,
        stopLosses: seedSl,
      }, { quiet: true });
      void vbTrailTick();
      void refreshTrailLegFromServer(String(pid));
    }
    return res;
  }

  async function refreshTrailLegFromServer(pid) {
    for (let i = 0; i < TRAIL_POLL_TRIES; i++) {
      if (i) await new Promise((r) => setTimeout(r, TRAIL_POLL_MS));
      vbPosCache = { at: 0, rows: [] };
      const rows = await fetchOpenPositions(accountId);
      const row = rows.find((p) => String(p.positionId) === String(pid));
      const st = vbTrail.armed.get(String(pid));
      if (!st) return;
      if (row) {
        st.entry = positionEntry(row) || st.entry;
        const sl = parseSlLegs(row)[0];
        if (sl?.id) {
          st.legId = sl.id;
          st.lastTrig = sl.trigger;
          st.lastLimit = sl.limit;
          return;
        }
        if (!st.legId && i >= 2) {
          try {
            st.legId = await ensureTrailStopOnPosition(row);
            void vbTrailTick();
            return;
          } catch {}
        }
      }
    }
  }

  function normSym(s) {
    return String(s || '').toUpperCase();
  }

  function isOpenPositionRow(x) {
    if (!x || x.positionId == null) return false;
    if (Number(x.closeDate) > 0) return false;
    const q = parseFloat(x.quantity);
    return Number.isFinite(q) && q > 0;
  }

  function parsePositionRows(r) {
    return Array.isArray(r) ? r : r?.positions || [];
  }

  function rowAccountId(row) {
    return row?.accountId || row?.account_id || null;
  }

  function positionSymbolsMatch(rowSym, chartSym) {
    const a = normSym(rowSym);
    const api = normSym(apiSymbol(chartSym));
    const raw = normSym(chartSym);
    if (a === api || a === raw) return true;
    const dRow = displaySymbol(a);
    const dChart = displaySymbol(apiSymbol(chartSym));
    return normSym(dRow) === normSym(dChart) || normSym(dRow) === normSym(chartSym);
  }

  async function fetchOpenPositions(acct) {
    const acc = String(acct);
    let rows = [];
    try {
      const r = await api('/v3/positions/opened', { accountId: acc, method: 'GET' });
      rows = parsePositionRows(r);
    } catch {}
    if (!rows.length) {
      const r = await api('/v3/positions', {
        accountId: acc,
        method: 'GET',
        query: { account_id: acc, limit: 100, offset: 0 },
      });
      rows = parsePositionRows(r);
    }
    return rows.filter(isOpenPositionRow).filter((p) => {
      const pid = rowAccountId(p);
      return !pid || String(pid) === acc;
    });
  }

  async function fetchOpenOrders(acct) {
    const acc = String(acct);
    try {
      const r = await api('/v3/positions/opened-orders', { accountId: acc, method: 'GET' });
      const rows = Array.isArray(r) ? r : r?.orders || [];
      return rows.filter((o) => o && o.orderId != null).filter((o) => {
        const oid = rowAccountId(o);
        return !oid || String(oid) === acc;
      });
    } catch {
      return [];
    }
  }

  function closePayloadFromRow(row) {
    const body = {
      symbol: apiSymbol(row.symbol),
      positionId: String(row.positionId),
      orderType: 'market',
    };
    const lv = parseFloat(row.leverage);
    if (Number.isFinite(lv) && lv > 0) body.leverage = String(Math.round(lv));
    return body;
  }

  async function apiClosePosition(acct, row) {
    await api('/v3/positions/close', {
      accountId: acct,
      method: 'POST',
      body: closePayloadFromRow(row),
    });
  }

  async function apiCancelOrder(acct, orderId) {
    await api('/v3/positions/cancel-order', {
      accountId: acct,
      method: 'POST',
      body: { orderId: String(orderId) },
    });
  }

  function trailCfg() {
    return {
      dist: Math.max(0.25, Number(S.trailDistPts) || 8),
      start: Math.max(0, Number(S.trailStartPts) || 0),
      step: Math.max(0.25, Number(S.trailStepPts) || 1),
      limitOff: Math.max(0, Number(S.trailLimitOffsetPts) || 0),
    };
  }

  function slLimitFromTrigger(side, trigger, tick) {
    const t = Number(trigger);
    const off = trailCfg().limitOff;
    if (!(off > 0)) return formatApiPrice(t, tick);
    const raw = side === 'long' ? t - off : t + off;
    return formatApiPrice(raw, tick, legRoundDir(side, 'sl'));
  }

  function initialTrailStopPrices(side, refMid) {
    const chart = activeChartSymbol();
    const tick = defaultTick(chart);
    const mid = Number(refMid);
    if (!Number.isFinite(mid) || mid <= 0) throw new Error('No mid price — Sync first');
    const { dist } = trailCfg();
    const raw = side === 'long' ? mid - dist : mid + dist;
    let trigger = roundToTick(raw, tick, legRoundDir(side, 'sl'));
    trigger = parseFloat(nudgeLegPastMid(side, 'sl', trigger, mid, tick));
    const limit = slLimitFromTrigger(side, trigger, tick);
    return { trigger: formatApiPrice(trigger, tick, legRoundDir(side, 'sl')), limit };
  }

  function buildTrailStopLeg(side, refMid) {
    const { trigger, limit } = initialTrailStopPrices(side, refMid);
    return {
      executionType: 'limit',
      triggerPrice: trigger,
      limitPrice: limit,
    };
  }

  function positionSide(row) {
    return /^(long|buy)$/i.test(String(row?.side || '')) ? 'long' : 'short';
  }

  function positionEntry(row) {
    const v = parseFloat(row?.openPrice);
    return Number.isFinite(v) ? v : 0;
  }

  function slLegId(l) {
    if (l?.stopLossId != null) return String(l.stopLossId);
    if (l?.id != null) return String(l.id);
    if (l?.orderId != null) return String(l.orderId);
    return '';
  }

  function parseSlLegs(row) {
    return (Array.isArray(row?.stopLosses) ? row.stopLosses : [])
      .filter((l) => l && (slLegId(l) || l.triggerPrice != null || l.trigger != null))
      .map((l) => ({
        id: slLegId(l),
        trigger: parseFloat(l.triggerPrice != null ? l.triggerPrice : l.trigger),
        limit: parseFloat(l.limitPrice != null ? l.limitPrice : l.limit),
        exec: String(l.executionType || 'market').toLowerCase(),
      }));
  }

  function armTrailFromRow(row, opts = {}) {
    if (!S.trailEnabled) return;
    const id = row?.positionId != null ? String(row.positionId) : '';
    if (!id) return;
    const sl = parseSlLegs(row)[0];
    const { start } = trailCfg();
    const entry = positionEntry(row) || snapMarketPrice() || lastKnownMid || 0;
    vbTrail.armed.set(id, {
      best: null,
      active: start <= 0,
      side: positionSide(row),
      symbol: row.symbol,
      entry,
      legId: sl?.id || null,
      missRows: 0,
      lastTrig: sl?.trigger || null,
      lastLimit: sl?.limit || null,
      busy: false,
      lastAt: 0,
      fails: 0,
      prevMid: null,
      sent: null,
      quiet: !!opts.quiet,
    });
  }

  function disarmAllTrails() {
    vbTrail.armed.clear();
    vbPosCache = { at: 0, rows: [] };
  }

  async function cachedOpenPositions(force) {
    if (!accountId) return [];
    const cacheMs = vbTrail.armed.size ? TRAIL_POS_CACHE_MS : 1500;
    if (!force && Date.now() - vbPosCache.at < cacheMs && vbPosCache.rows.length) return vbPosCache.rows;
    try {
      const rows = await fetchOpenPositions(accountId);
      if (rows.length) vbPosCache = { at: Date.now(), rows };
      else if (force || vbPosCache.rows.length) return vbPosCache.rows;
      vbPosCache = { at: Date.now(), rows: [] };
      return rows;
    } catch {
      return vbPosCache.rows;
    }
  }

  async function waitForOpenPosition(sym) {
    for (let i = 0; i < TRAIL_POLL_TRIES; i++) {
      if (i) await new Promise((r) => setTimeout(r, TRAIL_POLL_MS));
      vbPosCache = { at: 0, rows: [] };
      const rows = await fetchOpenPositions(accountId);
      const hit = rows
        .filter((p) => positionSymbolsMatch(p.symbol, sym))
        .sort((a, b) => (parseFloat(b.openDate) || 0) - (parseFloat(a.openDate) || 0))[0];
      if (hit) return hit;
      if (vbTrail.lastOpenId) {
        const byId = rows.find((p) => String(p.positionId) === String(vbTrail.lastOpenId));
        if (byId) return byId;
      }
    }
    return null;
  }

  function normalizeApiPrice(value, tick, dir) {
    const n = parseFloat(value);
    if (Number.isFinite(n)) return formatApiPrice(n, tick, dir);
    return String(value);
  }

  async function apiAddStopLoss(acct, positionId, trigger, limit, sym) {
    const tick = defaultTick(sym || activeChartSymbol());
    const body = {
      positionId: String(positionId),
      executionType: 'limit',
      triggerPrice: normalizeApiPrice(trigger, tick),
      limitPrice: normalizeApiPrice(limit, tick),
    };
    return api('/v3/positions/stop-loss', { accountId: acct, method: 'POST', body });
  }

  async function apiUpdateStopLoss(acct, positionId, stopLossId, trigger, limit, prevTrig, prevLimit, sym) {
    const tick = defaultTick(sym || activeChartSymbol());
    let lp = limit;
    if (prevTrig != null && prevLimit != null && Number.isFinite(prevTrig) && Number.isFinite(prevLimit)) {
      lp = formatApiPrice(prevLimit + (parseFloat(trigger) - prevTrig), tick);
    }
    const body = {
      positionId: String(positionId),
      stopLossId: String(stopLossId),
      executionType: 'limit',
      triggerPrice: normalizeApiPrice(trigger, tick),
      limitPrice: normalizeApiPrice(lp, tick),
    };
    return api('/v3/positions/stop-loss', { accountId: acct, method: 'PUT', body });
  }

  async function ensureTrailStopOnPosition(row) {
    const legs = parseSlLegs(row);
    if (legs.length) return legs[0].id;
    const side = positionSide(row);
    const entry = positionEntry(row) || snapMarketPrice();
    const { trigger, limit } = initialTrailStopPrices(side, entry);
    const addRes = await apiAddStopLoss(accountId, row.positionId, trigger, limit, row.symbol);
    const fromRes = addRes?.stopLossId || addRes?.id || addRes?.data?.stopLossId || addRes?.data?.id;
    if (fromRes) return String(fromRes);
    for (let i = 0; i < 8; i++) {
      if (i) await new Promise((r) => setTimeout(r, TRAIL_POLL_MS));
      vbPosCache = { at: 0, rows: [] };
      const rows = await fetchOpenPositions(accountId);
      const fresh = rows.find((p) => String(p.positionId) === String(row.positionId));
      const id = parseSlLegs(fresh)[0]?.id;
      if (id) return id;
    }
    return null;
  }

  async function afterFillArmTrail(sym, hintedId, side) {
    if (!S.trailEnabled) return;
    try {
      await ensureAccountId();
      vbPosCache = { at: 0, rows: [] };
      let row = null;
      if (hintedId) {
        row = (await fetchOpenPositions(accountId)).find((p) => String(p.positionId) === String(hintedId));
      }
      if (!row) row = await waitForOpenPosition(sym);
      if (!row && hintedId) {
        const ref = snapMarketPrice() || lastKnownMid;
        row = {
          positionId: hintedId,
          symbol: apiSymbol(sym),
          side: side || 'long',
          openPrice: ref,
          stopLosses: vbTrail.lastOpenSl || [],
        };
      }
      if (!row) {
        toast('Trail: position not found yet — arm manually after refresh');
        return;
      }
      armTrailFromRow(row, { quiet: true });
      const pid = String(row.positionId);
      const st = vbTrail.armed.get(pid);
      if (st && !st.legId) {
        st.legId = await ensureTrailStopOnPosition(row) || null;
      }
      void vbTrailTick();
      void refreshTrailLegFromServer(pid);
      toast(`Trailing stop-limit armed · ${trailCfg().dist} pt trail`);
    } catch (e) {
      toast(`Trail arm failed: ${e?.message || e}`);
    }
  }

  function vbTrailStep(st, mid) {
    const { dist, start, step } = trailCfg();
    const chart = activeChartSymbol();
    const tick = defaultTick(chart);
    const entry = Number(st.entry);
    const m = Number(mid);
    if (!(entry > 0) || !(m > 0) || !(tick > 0)) return { skip: 'no-price' };
    const dir = st.side === 'long' ? 1 : -1;
    const prev = Number(st.prevMid);
    if (prev > 0 && Math.abs(m - prev) > Math.max(80 * tick, prev * 0.001)) return { skip: 'jump' };
    const b = st.best == null ? m : (dir > 0 ? Math.max(st.best, m) : Math.min(st.best, m));
    const active = st.active || start <= 0 || dir * (b - entry) >= start;
    const out = { best: b, active, level: null, s: null, trigger: null, limit: null, move: false, create: false, skip: '' };
    if (!active) {
      st.best = b;
      return out;
    }
    let level = dir > 0 ? b - dist : b + dist;
    level = roundToTick(level, tick, legRoundDir(st.side, 'sl'));
    const maxSl = dir > 0 ? roundToTick(m - tick, tick, 'down') : roundToTick(m + tick, tick, 'up');
    if (dir * level > dir * maxSl) level = maxSl;
    out.level = level;
    out.s = formatApiPrice(level, tick, legRoundDir(st.side, 'sl'));
    out.trigger = out.s;
    out.limit = slLimitFromTrigger(st.side, level, tick);
    if (!st.legId) {
      out.create = true;
      return out;
    }
    const prevTrig = st.lastTrig;
    if (prevTrig == null || !Number.isFinite(prevTrig)) {
      out.move = true;
      return out;
    }
    if (dir * (level - prevTrig) >= step) out.move = true;
    return out;
  }

  async function vbTrailTick() {
    if (!S.trailEnabled || !vbTrail.armed.size || !token) return;
    const mid = snapMarketPrice() || liveMidPrice() || lastKnownMid;
    if (!(mid > 0)) return;
    let rows = [];
    try {
      rows = await cachedOpenPositions();
    } catch {
      return;
    }
    const now = Date.now();
    for (const [id, st] of [...vbTrail.armed.entries()]) {
      let row = rows.find((p) => String(p.positionId) === id);
      if (!row) {
        st.missRows = (st.missRows || 0) + 1;
        if (st.missRows >= 12) {
          vbTrail.armed.delete(id);
        }
        continue;
      }
      st.missRows = 0;
      const ep = positionEntry(row);
      if (ep > 0) st.entry = ep;
      const sl = parseSlLegs(row)[0];
      if (sl && sl.id !== st.legId) {
        st.legId = sl.id;
        st.lastTrig = sl.trigger;
        st.lastLimit = sl.limit;
      }
      const minGap = st.legId ? TRAIL_UPDATE_MS : 180;
      if (st.busy || now - st.lastAt < minGap) continue;
      const r = vbTrailStep(st, mid);
      st.prevMid = mid;
      if (r.skip) continue;
      st.best = r.best;
      if (r.active && !st.active && !st.quiet) toast(`Trail active — following ${trailCfg().dist} pt behind price`);
      st.active = r.active;
      if (!r.active) continue;
      const needLeg = !st.legId && r.create;
      const needMove = !!st.legId && r.move;
      if (!needLeg && !needMove) continue;
      st.busy = true;
      st.lastAt = now;
      try {
        await ensureAccountId();
        if (!st.legId) {
          st.legId = await ensureTrailStopOnPosition(row);
          if (!st.legId) throw new Error('no stop-loss leg');
          vbPosCache = { at: 0, rows: [] };
          const freshRows = await cachedOpenPositions(true);
          const fresh = freshRows.find((p) => String(p.positionId) === id);
          const slFresh = parseSlLegs(fresh || row)[0];
          if (slFresh?.id) st.legId = slFresh.id;
          if (slFresh?.trigger != null) {
            st.lastTrig = slFresh.trigger;
            st.lastLimit = slFresh.limit;
          } else if (r.trigger != null) {
            st.lastTrig = parseFloat(r.trigger);
            st.lastLimit = parseFloat(r.limit);
          }
          st.fails = 0;
          continue;
        }
        await apiUpdateStopLoss(accountId, id, st.legId, r.trigger, r.limit, st.lastTrig, st.lastLimit, st.symbol);
        st.lastTrig = parseFloat(r.trigger);
        st.lastLimit = parseFloat(r.limit);
        st.sent = st.lastTrig;
        st.fails = 0;
      } catch (e) {
        st.fails++;
        if (st.fails >= 3) {
          vbTrail.armed.delete(id);
          toast(`Trail off: ${e?.message || e}`);
        }
      } finally {
        st.busy = false;
      }
    }
  }

  function syncTrailSettingsFromPanel() {
    const on = document.getElementById('vb-trail-on');
    const dist = document.getElementById('vb-trail-dist');
    const start = document.getElementById('vb-trail-start');
    const step = document.getElementById('vb-trail-step');
    const loff = document.getElementById('vb-trail-loff');
    if (on) S.trailEnabled = !!on.checked;
    if (dist && dist.value !== '') S.trailDistPts = Number(dist.value) || S.trailDistPts;
    if (start && start.value !== '') S.trailStartPts = Number(start.value);
    if (step && step.value !== '') S.trailStepPts = Number(step.value) || S.trailStepPts;
    if (loff && loff.value !== '') S.trailLimitOffsetPts = Number(loff.value);
    persist();
    refreshPlanPreview();
  }

  function applyTrailSettingsToPanel() {
    const on = document.getElementById('vb-trail-on');
    const dist = document.getElementById('vb-trail-dist');
    const start = document.getElementById('vb-trail-start');
    const step = document.getElementById('vb-trail-step');
    const loff = document.getElementById('vb-trail-loff');
    if (on) on.checked = S.trailEnabled !== false;
    if (dist) dist.value = String(S.trailDistPts ?? 8);
    if (start) start.value = String(S.trailStartPts ?? 10);
    if (step) step.value = String(S.trailStepPts ?? 1);
    if (loff) loff.value = String(S.trailLimitOffsetPts ?? 0);
  }

  async function runCloseCurrent() {
    assertLicensed('close');
    setAction('Close — working…', 'busy');
    toast('Closing current market…');
    try {
      await ensureAccountId();
      const acct = accountId;
      const chart = activeChartSymbol();
      const positions = await fetchOpenPositions(acct);
      const mine = positions.filter((p) => positionSymbolsMatch(p.symbol, chart));
      const orders = await fetchOpenOrders(acct);
      const myOrders = orders.filter((o) => positionSymbolsMatch(o.symbol || o.market, chart));
      if (!mine.length && !myOrders.length) {
        const label = displaySymbol(apiSymbol(chart));
        setAction(`No open position or resting order on ${label}`, 'err');
        toast(`Nothing to close on ${label}`);
        return;
      }
      let closed = 0;
      let cancelled = 0;
      for (const p of mine) {
        await apiClosePosition(acct, p);
        closed++;
      }
      for (const o of myOrders) {
        await apiCancelOrder(acct, o.orderId);
        cancelled++;
      }
      mine.forEach((p) => vbTrail.armed.delete(String(p.positionId)));
      const msg = `Closed ${closed} position(s)` + (cancelled ? `, cancelled ${cancelled} order(s)` : '');
      setAction(msg, 'ok');
      toast(msg);
      setStatus(msg);
    } catch (e) {
      const m = e?.message || String(e);
      setAction(m, 'err');
      toast(m);
    }
  }

  async function runFlattenAll() {
    assertLicensed('flatten');
    setAction('Flatten all — working…', 'busy');
    toast('Flattening account…');
    try {
      await ensureAccountId();
      const acct = accountId;
      const positions = await fetchOpenPositions(acct);
      const orders = await fetchOpenOrders(acct);
      if (!positions.length && !orders.length) {
        setAction('No open positions or resting orders on this account', 'err');
        toast('Account is already flat');
        return;
      }
      let closed = 0;
      let cancelled = 0;
      for (const p of positions) {
        await apiClosePosition(acct, p);
        closed++;
      }
      for (const o of orders) {
        await apiCancelOrder(acct, o.orderId);
        cancelled++;
      }
      disarmAllTrails();
      const msg = `Flattened ${closed} position(s)` + (cancelled ? `, cancelled ${cancelled} order(s)` : '');
      setAction(msg, 'ok');
      toast(msg);
      setStatus(msg);
    } catch (e) {
      const m = e?.message || String(e);
      setAction(m, 'err');
      toast(m);
    }
  }

  function setStatus(msg) {
    const el = document.getElementById('vb-status');
    if (el) el.textContent = msg;
  }

  function setAction(msg, tone) {
    const el = document.getElementById('vb-action');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    el.className = 'vb-action' + (tone === 'ok' ? ' vb-action-ok' : tone === 'err' ? ' vb-action-err' : ' vb-action-busy');
  }

  function toast(msg) {
    const t = document.getElementById('vb-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    t.hidden = false;
    clearTimeout(t._tm);
    t._tm = setTimeout(() => {
      t.classList.remove('show');
      t.hidden = true;
    }, 9000);
  }

  async function runOrderClick(side) {
    const longBtn = document.getElementById('vb-long');
    const shortBtn = document.getElementById('vb-short');
    setAction(`Clicked ${side} — working…`, 'busy');
    toast(`Clicked ${side}…`);
    try {
      setAction(`Sending ${side} market…`, 'busy');
      if (longBtn) longBtn.disabled = true;
      if (shortBtn) shortBtn.disabled = true;
      await sendMarketOrder(side);
    } catch (e) {
      const msg = e?.message || String(e);
      setAction(msg, 'err');
      toast(msg);
    } finally {
      if (longBtn) longBtn.disabled = false;
      if (shortBtn) shortBtn.disabled = false;
    }
  }

  function fiberOf(el) {
    if (!el || typeof el !== 'object') return null;
    const k = Object.keys(el).find((x) => x.indexOf('__reactFiber$') === 0);
    return k ? el[k] : null;
  }

  function scanFiberForAccountId(f, budget = 90) {
    const stores = new Set();
    for (let d = 0; f && d < budget; d++, f = f.return) {
      const props = f.memoizedProps;
      if (props?.account?.id) return String(props.account.id);
      if (props?.accountId && isAccountUuid(props.accountId)) return String(props.accountId);
      let s = f.memoizedState;
      for (let i = 0; s && i < 50; s = s.next, i++) {
        const m = s.memoizedState;
        if (m && typeof m.getState === 'function' && !stores.has(m)) {
          stores.add(m);
          try {
            const st = m.getState();
            if (st?.activeAccountId && isAccountUuid(st.activeAccountId)) return String(st.activeAccountId);
            if (st?.primaryAccountId && isAccountUuid(st.primaryAccountId)) return String(st.primaryAccountId);
          } catch {}
        }
        if (m && typeof m === 'object' && !Array.isArray(m) && typeof m.id === 'string' && isAccountUuid(m.id)
            && 'rootAccountId' in m && ('stage' in m || 'name' in m)) {
          return m.id;
        }
      }
    }
    return null;
  }

  function readStorageActiveAccount() {
    const keys = new Set();
    const uid = token ? jwtUserId(token.value) : null;
    if (uid) keys.add('vest-active-account:' + uid);
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith('vest-active-account:')) keys.add(k);
      }
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('vest-active-account:')) keys.add(k);
      }
    } catch {}
    for (const k of keys) {
      let v = null;
      try { v = sessionStorage.getItem(k); } catch {}
      if (v == null) try { v = localStorage.getItem(k); } catch {}
      const id = parseStoredAccountId(v);
      if (id) return id;
    }
    return '';
  }

  function discoverActiveAccountId() {
    const trig = qVest('[data-testid="account-selector-trigger"]');
    const fromTrigAttr = trig?.getAttribute('data-account-id');
    if (isAccountUuid(fromTrigAttr)) return String(fromTrigAttr);
    const anchors = [
      trig,
      qVest('[data-testid="submit-long"]'),
      qVest('[data-testid="submit-short"]'),
    ].filter(Boolean);
    for (const el of anchors) {
      const id = scanFiberForAccountId(fiberOf(el));
      if (id) return id;
    }
    for (const el of document.querySelectorAll('[data-testid^="account-item-"]')) {
      const flagged = el.getAttribute('aria-checked') === 'true'
        || el.getAttribute('data-state') === 'checked'
        || el.querySelector('[data-state="checked"]');
      if (!flagged) continue;
      const tid = (el.getAttribute('data-testid') || '').replace(/^account-item-/, '');
      if (isAccountUuid(tid)) return tid;
      const id = scanFiberForAccountId(fiberOf(el));
      if (id) return id;
    }
    return readStorageActiveAccount();
  }

  function syncActiveAccountFromVest() {
    const id = discoverActiveAccountId();
    if (id) accountId = id;
    const trig = qVest('[data-testid="account-selector-trigger"]');
    if (trig) {
      const name = (trig.textContent || '').replace(/\s+/g, ' ').trim();
      if (name) accountName = name.slice(0, 48);
    }
    postState();
  }

  function parseAccountList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    const bag = data.data && typeof data.data === 'object' ? data.data : data;
    for (const k of ['accounts', 'items', 'rows', 'activeAccounts', 'history']) {
      if (Array.isArray(bag[k])) return bag[k];
    }
    return [];
  }

  async function ensureAccountId() {
    syncActiveAccountFromVest();
    if (accountId) return;
    await ensureToken().catch(() => {});
    syncActiveAccountFromVest();
    if (accountId) return;
    try {
      const data = await api('/v3/capital/accounts/active');
      const bag = data?.data && typeof data.data === 'object' ? data.data : data;
      const id = bag?.accountId || bag?.id || data?.accountId || data?.id;
      if (isAccountUuid(id)) accountId = String(id);
    } catch {}
    if (accountId) return;
    try {
      const data = await api('/v3/capital/accounts');
      const list = parseAccountList(data);
      const active = list.find((a) => a && (a.active || a.isActive || a.selected));
      const pick = active || list.find((a) => a && isAccountUuid(a.id || a.accountId));
      const id = pick && (pick.id || pick.accountId);
      if (isAccountUuid(id)) accountId = String(id);
    } catch {}
    if (!accountId) {
      throw new Error('Could not read Vest account — click the account menu at the top of Vest once, then Sync and retry');
    }
    postState();
  }

  function injectStyles() {
    if (document.getElementById('vb-styles')) return;
    const css = document.createElement('style');
    css.id = 'vb-styles';
    css.textContent = `
      #vb-panel {
        position: fixed; left: 12px; bottom: 72px; top: auto; right: auto; z-index: 2147482900;
        width: min(92vw, 360px); padding: 12px 14px;
        background: rgba(8,12,22,.96); border: 1px solid #334155; border-radius: 12px;
        color: #e2e8f0; font: 12px/1.4 system-ui, sans-serif;
        box-shadow: 0 12px 40px rgba(0,0,0,.45); backdrop-filter: blur(10px);
      }
      #vb-panel[hidden] { display: none !important; }
      #vb-panel .vb-panel-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; margin: 0 0 2px; padding: 2px 0 4px;
        cursor: grab; user-select: none; touch-action: none;
      }
      #vb-panel.vb-dragging .vb-panel-head { cursor: grabbing; }
      #vb-panel h2 { margin: 0; font-size: 14px; color: #38bdf8; flex: 1; }
      #vb-panel .vb-drag-hint {
        opacity: 0.5; font-size: 13px; line-height: 1; color: #94a3b8;
        letter-spacing: 1px;
      }
      #vb-panel .vb-support {
        margin: 0 0 8px; font-size: 10px; line-height: 1.35; color: #94a3b8; font-weight: 500;
      }
      #vb-panel .vb-support code {
        font-family: ui-monospace, monospace; font-size: 10px; font-weight: 700;
        color: #a5b4fc; background: rgba(99, 102, 241, 0.15); padding: 1px 5px; border-radius: 4px;
      }
      #vb-panel .vb-help { margin: 0 0 10px; font-size: 11px; opacity: .88; line-height: 1.45; }
      #vb-panel .vb-help b { color: #f8fafc; font-weight: 700; }
      #vb-panel .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
      #vb-panel label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; opacity: .9; }
      #vb-panel input, #vb-panel select {
        background: #0b1220; border: 1px solid #334155; color: #e2e8f0;
        border-radius: 6px; padding: 6px 7px; font-size: 13px;
      }
      #vb-panel .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      #vb-panel button {
        flex: 1; min-width: 88px; padding: 10px 10px; border-radius: 8px; border: 1px solid #334155;
        background: #1e293b; color: #e2e8f0; font-weight: 800; cursor: pointer; font-size: 13px;
      }
      #vb-panel button.vb-primary {
        width: 100%; flex: none; margin-bottom: 0;
        background: linear-gradient(135deg, #0ea5e9, #6366f1); border-color: transparent; color: #0f172a;
      }
      #vb-panel button.vb-primary.vb-btn-synced {
        background: linear-gradient(135deg, #34d399, #10b981); color: #052e1a;
      }
      #vb-sync-badge {
        display: flex; align-items: flex-start; gap: 8px;
        margin: 8px 0 10px; padding: 8px 10px; border-radius: 8px; font-size: 11px; line-height: 1.4;
        border: 1px solid #334155; background: #0b1220;
      }
      #vb-sync-badge.vb-on { border-color: #166534; background: #052e1a; color: #6ee7b7; }
      #vb-sync-badge.vb-off { border-color: #854d0e; background: #1c1910; color: #fcd34d; }
      #vb-sync-badge.vb-warn { border-color: #b45309; background: #2a1d0a; color: #fdba74; }
      #vb-sync-badge.vb-busy { border-color: #0ea5e9; color: #bae6fd; }
      .vb-sync-dot {
        width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 2px;
        background: #64748b; box-shadow: 0 0 0 2px rgba(255,255,255,.08);
      }
      #vb-sync-badge.vb-on .vb-sync-dot { background: #34d399; box-shadow: 0 0 8px #34d399; }
      #vb-sync-badge.vb-off .vb-sync-dot { background: #fbbf24; }
      #vb-sync-badge.vb-warn .vb-sync-dot { background: #fb923c; }
      #vb-sync-badge.vb-busy .vb-sync-dot { background: #38bdf8; animation: vb-pulse 0.8s ease infinite alternate; }
      @keyframes vb-pulse { from { opacity: 0.45; } to { opacity: 1; } }
      #vb-preview .vb-sync-fail { color: #fdba74; }
      #vb-panel button.vb-long { border-color: #34d399; color: #6ee7b7; background: #052e1a; }
      #vb-panel button.vb-short { border-color: #f87171; color: #fca5a5; background: #2a0f0f; }
      #vb-panel button.vb-close { border-color: #fbbf24; color: #fde68a; background: #1c1910; }
      #vb-panel button.vb-flat { border-color: #ef4444; color: #fecaca; background: #3f1212; }
      #vb-panel button.vb-ghost { flex: 0 0 auto; min-width: auto; font-weight: 600; opacity: .9; font-size: 11px; padding: 4px 8px; }
      #vb-panel .vb-presets { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 2px; }
      #vb-panel .vb-presets button { flex: 1; min-width: 64px; padding: 6px; font-size: 11px; font-weight: 700; }
      #vb-preview {
        font-size: 11px; line-height: 1.5; padding: 8px 10px; margin-bottom: 8px;
        background: #0b1220; border: 1px solid #1e293b; border-radius: 8px;
      }
      #vb-preview .vb-dim { opacity: .75; font-weight: 500; }
      #vb-panel .vb-trail-box {
        margin: 8px 0; padding: 8px 10px; border-radius: 8px;
        border: 1px solid #1e3a5f; background: #0b1528;
      }
      #vb-panel .vb-trail-head { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; color: #7dd3fc; margin-bottom: 6px; }
      #vb-panel .vb-trail-head input { width: auto; accent-color: #38bdf8; }
      #vb-panel .vb-trail-arm { margin-top: 8px; width: 100%; flex: none; font-size: 11px; padding: 7px; font-weight: 700; }
      #vb-ready {
        margin-top: 8px; padding: 7px 9px; border-radius: 8px; font-size: 11px; text-align: center; line-height: 1.35;
      }
      #vb-ready.vb-ok { background: #052e1a; color: #6ee7b7; border: 1px solid #166534; }
      #vb-ready.vb-warn { background: #1e1b0b; color: #fcd34d; border: 1px solid #854d0e; }
      #vb-panel details { margin-top: 10px; font-size: 11px; opacity: .95; }
      #vb-panel details summary { cursor: pointer; color: #94a3b8; user-select: none; }
      #vb-panel details[open] summary { margin-bottom: 8px; color: #cbd5e1; }
      #vb-status { margin-top: 6px; font-size: 10px; opacity: .7; text-align: center; }
      #vb-action {
        margin-top: 8px; padding: 8px 10px; border-radius: 8px; font-size: 11px; line-height: 1.4;
        border: 1px solid #334155; background: #0b1220; color: #cbd5e1;
      }
      #vb-action.vb-action-ok { border-color: #166534; color: #6ee7b7; background: #052e1a; }
      #vb-action.vb-action-err { border-color: #b91c1c; color: #fecaca; background: #2a0f0f; }
      #vb-action.vb-action-busy { border-color: #0ea5e9; color: #bae6fd; }
      #vb-panel button:disabled { opacity: 0.55; cursor: wait; }
      #vb-panel button { pointer-events: auto; position: relative; z-index: 1; }
      #vb-action:not([hidden]) { display: block; }
      #vb-toast {
        margin-top: 8px; padding: 10px 12px; border-radius: 8px;
        background: #111827; color: #f9fafb; border: 1px solid #475569;
        font-size: 12px; font-weight: 600; line-height: 1.4;
      }
      #vb-toast:not(.show) { display: none; }
      #vb-toast.show { display: block; }
    `;
    (document.documentElement || document.head).appendChild(css);
  }

  function applyPanelPosition(panel) {
    if (!panel) return;
    if (Number.isFinite(S.panelX) && Number.isFinite(S.panelY)) {
      const { x, y } = clampPanelPos(S.panelX, S.panelY, panel);
      S.panelX = x;
      S.panelY = y;
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
    } else {
      panel.style.left = '12px';
      panel.style.bottom = '72px';
      panel.style.top = 'auto';
      panel.style.right = 'auto';
    }
  }

  function clampPanelPos(x, y, panel) {
    const r = panel.getBoundingClientRect();
    const w = r.width > 0 ? r.width : 320;
    const h = r.height > 0 ? r.height : 320;
    const maxX = Math.max(0, win.innerWidth - w - 8);
    const maxY = Math.max(0, win.innerHeight - h - 8);
    return {
      x: Math.min(maxX, Math.max(8, Math.round(x))),
      y: Math.min(maxY, Math.max(8, Math.round(y))),
    };
  }

  function panelSnapToTopLeft(panel) {
    const rect = panel.getBoundingClientRect();
    S.panelX = Math.round(rect.left);
    S.panelY = Math.round(rect.top);
    panel.style.left = `${S.panelX}px`;
    panel.style.top = `${S.panelY}px`;
    panel.style.bottom = 'auto';
    panel.style.right = 'auto';
  }

  function wirePanelDrag(panel) {
    if (panel.__vbDrag === VERSION) return;
    panel.__vbDrag = VERSION;
    const head = panel.querySelector('.vb-panel-head');
    if (!head) return;
    let drag = null;
    const onMove = (e) => {
      if (!drag) return;
      const { x, y } = clampPanelPos(e.clientX - drag.dx, e.clientY - drag.dy, panel);
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.bottom = 'auto';
    };
    const endDrag = () => {
      if (!drag) return;
      const pid = drag.pid;
      drag = null;
      panel.classList.remove('vb-dragging');
      try { head.releasePointerCapture(pid); } catch {}
      const rect = panel.getBoundingClientRect();
      const { x, y } = clampPanelPos(rect.left, rect.top, panel);
      S.panelX = x;
      S.panelY = y;
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      persist();
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', endDrag);
      win.removeEventListener('pointercancel', endDrag);
    };
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, a, select, textarea')) return;
      e.preventDefault();
      panelSnapToTopLeft(panel);
      const rect = panel.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, pid: e.pointerId };
      panel.classList.add('vb-dragging');
      try { head.setPointerCapture(e.pointerId); } catch {}
      win.addEventListener('pointermove', onMove);
      win.addEventListener('pointerup', endDrag);
      win.addEventListener('pointercancel', endDrag);
    });
    win.addEventListener('resize', () => {
      if (!Number.isFinite(S.panelX) || !Number.isFinite(S.panelY)) return;
      applyPanelPosition(panel);
      persist();
    });
  }

  function wirePanelActions(panel) {
    if (panel.__vbWired === VERSION) return;
    panel.__vbWired = VERSION;
    panel.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button');
      if (!btn || !panel.contains(btn)) return;
      e.stopPropagation();
      const id = btn.id;
      if (id === 'vb-sync') {
        e.preventDefault();
        runSyncClick();
        return;
      }
      if (id === 'vb-long') {
        e.preventDefault();
        void runOrderClick('long');
        return;
      }
      if (id === 'vb-short') {
        e.preventDefault();
        void runOrderClick('short');
        return;
      }
      if (id === 'vb-close') {
        e.preventDefault();
        void runCloseCurrent();
        return;
      }
      if (id === 'vb-flat') {
        e.preventDefault();
        void runFlattenAll();
        return;
      }
      if (id === 'vb-trail-arm') {
        e.preventDefault();
        void runArmTrailChart();
      }
    });
    panel.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !panel.contains(t)) return;
      if (String(t.id || '').startsWith('vb-trail-')) syncTrailSettingsFromPanel();
    });
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || !panel.contains(t)) return;
      if (String(t.id || '').startsWith('vb-trail-')) syncTrailSettingsFromPanel();
    });
  }

  async function runArmTrailChart() {
    assertLicensed('trail');
    setAction('Arming trail…', 'busy');
    try {
      await ensureAccountId();
      if (!S.trailEnabled) throw new Error('Turn on “Trailing stop (limit)” first');
      const rows = await fetchOpenPositions(accountId);
      const chart = activeChartSymbol();
      const mine = rows.filter((p) => positionSymbolsMatch(p.symbol, chart));
      if (!mine.length) throw new Error('No open position on this chart');
      for (const row of mine) {
        await ensureTrailStopOnPosition(row);
        const fresh = (await fetchOpenPositions(accountId)).find((p) => String(p.positionId) === String(row.positionId)) || row;
        armTrailFromRow(fresh);
      }
      const msg = `Trail armed on ${mine.length} position(s) on ${displaySymbol(apiSymbol(chart))}`;
      setAction(msg, 'ok');
      toast(msg);
    } catch (e) {
      const m = e?.message || String(e);
      setAction(m, 'err');
      toast(m);
    }
  }

  function mountUi() {
    injectStyles();
    const stale = document.getElementById('vb-panel');
    if (stale && stale.dataset.vbMount === VERSION) {
      wirePanelActions(stale);
      wirePanelDrag(stale);
      applyPanelPosition(stale);
      return;
    }
    stale?.remove();
    const panel = document.createElement('div');
    panel.id = 'vb-panel';
    panel.dataset.vbMount = VERSION;
    panel.hidden = !S.showPanel;
    panel.innerHTML = `
      <div class="vb-panel-head" title="Drag to move panel">
        <h2>Ratchet Stop</h2>
        <span class="vb-drag-hint" aria-hidden="true">⋮⋮</span>
      </div>
      <p class="vb-support">Support code <code>${SUPPORT_CODE}</code> — auto-applied at Vest checkout</p>
      <p class="vb-help">
        <b>Market entry</b> with optional <b>trailing stop-limit</b>. USD size → Vest’s Long/Short, then we arm the trail. <b>Close</b> = this chart; <b>Flatten all</b> = account.
      </p>
      <button type="button" class="vb-primary" id="vb-sync">Sync from Vest</button>
      <div id="vb-sync-badge" class="vb-off" role="status" aria-live="polite">
        <span class="vb-sync-dot" aria-hidden="true"></span>
        <span id="vb-sync-text">Not synced — tap Sync to read ticket</span>
      </div>
      <div id="vb-preview">Size preview appears after sync.</div>
      <div class="vb-trail-box">
        <label class="vb-trail-head"><input type="checkbox" id="vb-trail-on" checked> Trailing stop (limit)</label>
        <div class="grid">
          <label>Trail distance (pts)<input type="number" id="vb-trail-dist" min="0.25" step="0.25" value="8"></label>
          <label>Start after profit (pts)<input type="number" id="vb-trail-start" min="0" step="0.25" value="10"></label>
          <label>Min step (pts)<input type="number" id="vb-trail-step" min="0.25" step="0.25" value="1"></label>
          <label>Limit offset (pts)<input type="number" id="vb-trail-loff" min="0" step="0.25" value="0"></label>
        </div>
        <button type="button" class="vb-ghost vb-trail-arm" id="vb-trail-arm">Arm trail on open chart position</button>
      </div>
      <div class="row">
        <button type="button" class="vb-long" id="vb-long">Long</button>
        <button type="button" class="vb-short" id="vb-short">Short</button>
      </div>
      <div class="row">
        <button type="button" class="vb-close" id="vb-close">Close</button>
        <button type="button" class="vb-flat" id="vb-flat">Flatten all</button>
      </div>
      <div id="vb-action" class="vb-action" hidden role="alert"></div>
      <div id="vb-toast" class="" hidden aria-live="polite"></div>
      <div id="vb-ready" class="vb-ready vb-warn">Sign in on Vest; size comes from the ticket</div>
      <div id="vb-status"></div>
    `;
    document.documentElement.append(panel);
    wirePanelActions(panel);
    wirePanelDrag(panel);
    applyPanelPosition(panel);
    applyTrailSettingsToPanel();

    setTimeout(() => syncFromVestTicket({ quiet: true }), 800);
    refreshSyncBadge({});
    setInterval(syncActiveAccountFromVest, 3000);
    setInterval(() => {
      const cs = activeChartSymbol();
      const sym = displaySymbol(apiSymbol(cs));
      setStatus(`${sym} · ${accountName || accountId || '—'} · drag title to move · Alt+Shift+B hide`);
      refreshReadyLine();
      if (!ticketSynced) syncFromVestTicket({ quiet: true });
      else refreshPlanPreview();
    }, 6000);
    setInterval(() => { void vbTrailTick(); }, TRAIL_TICK_MS);
    refreshReadyLine();
    refreshPlanPreview();
    postState();
  }

  win.addEventListener('message', (ev) => {
    if (ev.source !== win) return;
    const d = ev.data;
    if (!d || d.vb !== 1 || d.dir !== 'toPage') return;
    if (d.type === 'license') {
      applyLicense(d.license);
      return;
    }
    if (d.cmd === 'ping') postState();
    if (d.cmd === 'togglePanel') {
      S.showPanel = !S.showPanel;
      persist();
      const p = document.getElementById('vb-panel');
      if (p) p.hidden = !S.showPanel;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyB') {
      e.preventDefault();
      S.showPanel = !S.showPanel;
      persist();
      const p = document.getElementById('vb-panel');
      if (p) p.hidden = !S.showPanel;
    }
  }, true);

  function boot() {
    installNetworkTap();
    sessionPing();
    setInterval(sessionPing, 5000);
    setInterval(btCodeTick, 2200);
    const ready = () => {
      mountUi();
      syncActiveAccountFromVest();
      postState();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
    else ready();
  }
  boot();
})();
