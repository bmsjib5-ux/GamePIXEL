'use strict';
// Talks to the online server (server/index.js): accounts, cloud saves, the leaderboard.
// The game works fully without it; online features just report when the server cannot be
// reached. The free Render plan puts the server to sleep when idle, so the first request
// after a while can take most of a minute.
const ONLINE = (() => {
  // Address of the server. On this computer: the local test server; on the web: the Render
  // service from render.yaml. "?api=https://..." in the page address overrides it.
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API_URL = new URLSearchParams(location.search).get('api')
    || (LOCAL ? 'http://localhost:3000' : 'https://pro-monter-api.onrender.com');
  const KEY = 'sprout_online' + (location.search.includes('test') ? '_test' : '');

  // { token, username, linked }  linked = this device's save is the account's save, so it may
  // be uploaded automatically (not yet true right after logging in on a new device, so an
  // empty new game never overwrites the progress kept online).
  let auth = null;
  try { auth = JSON.parse(localStorage.getItem(KEY)); } catch (e) { auth = null; }
  const keep = () => { try { if (auth) localStorage.setItem(KEY, JSON.stringify(auth)); else localStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ } };

  async function call(method, path, body, timeoutMs = 70000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(API_URL + path, {
        method, signal: ctrl.signal, keepalive: method === 'PUT' && JSON.stringify(body || {}).length < 60000,
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401 && auth && path !== '/api/login') { auth = null; keep(); }   // the login ran out
      if (!r.ok) throw new Error(data.error || ('เซิร์ฟเวอร์ตอบกลับผิดพลาด (' + r.status + ')'));
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('เซิร์ฟเวอร์ไม่ตอบสนอง ลองใหม่อีกครั้ง');
      if (e instanceof TypeError) throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
      throw e;
    } finally { clearTimeout(timer); }
  }

  // ---- automatic upload of the save, at most every 15 seconds
  let pending = null, lastUpload = 0, timer = null;
  async function flush() {
    clearTimeout(timer); timer = null;
    if (!pending || !auth || !auth.linked) return;
    const save = pending; pending = null; lastUpload = Date.now();
    try { await call('PUT', '/api/save', { save }); } catch (e) { pending = pending || save; }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // ---- the login form (HTML over the game, so phone keyboards work)
  function form() {
    const box = document.getElementById('authBox');
    const user = document.getElementById('authUser'), pass = document.getElementById('authPass');
    const note = document.getElementById('authNote');
    const btnLogin = document.getElementById('authLogin'), btnReg = document.getElementById('authRegister');
    const btnCancel = document.getElementById('authCancel');
    return new Promise((resolve) => {
      box.hidden = false; api.formOpen = true; note.textContent = ''; pass.value = '';
      setTimeout(() => user.focus(), 30);
      const finish = (ok) => {
        box.hidden = true; api.formOpen = false;
        btnLogin.onclick = btnReg.onclick = btnCancel.onclick = null; box.onkeydown = null;
        resolve(ok);
      };
      const go = async (path) => {
        note.style.color = '#5a5048';
        note.textContent = 'กำลังเชื่อมต่อเซิร์ฟเวอร์... (ถ้าเซิร์ฟเวอร์หลับอยู่ อาจใช้เวลาเกือบนาที)';
        btnLogin.disabled = btnReg.disabled = true;
        try {
          const r = await call('POST', path, { username: user.value.trim(), password: pass.value });
          auth = { token: r.token, username: r.username, linked: false }; keep();
          finish(true);
        } catch (e) {
          note.style.color = '#c0442f'; note.textContent = e.message;
        } finally { btnLogin.disabled = btnReg.disabled = false; }
      };
      btnLogin.onclick = () => go('/api/login');
      btnReg.onclick = () => go('/api/register');
      btnCancel.onclick = () => finish(false);
      box.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') go('/api/login');
        if (ev.key === 'Escape') finish(false);
      };
    });
  }

  const api = {
    url: API_URL,
    formOpen: false,
    get loggedIn() { return !!auth; },
    get username() { return auth ? auth.username : ''; },
    get linked() { return !!(auth && auth.linked); },
    form,
    async logout() {
      await flush();
      try { await call('POST', '/api/logout'); } catch (e) { /* signed out here anyway */ }
      auth = null; keep();
    },
    link(on) { if (auth) { auth.linked = !!on; keep(); } },
    async download() { return call('GET', '/api/save'); },
    async uploadNow(save) {
      pending = null;
      const r = await call('PUT', '/api/save', { save });
      if (auth) { auth.linked = true; keep(); }
      lastUpload = Date.now();
      return r;
    },
    queueUpload(save) {                   // called on every local save
      if (!auth || !auth.linked) return;
      pending = JSON.parse(JSON.stringify(save));
      const wait = Math.max(0, 15000 - (Date.now() - lastUpload));
      if (!timer) timer = setTimeout(flush, wait);
    },
    flush,
    async leaderboard(by) { return call('GET', '/api/leaderboard?by=' + by); },
    // trading
    tradeCreate: (mon) => call('POST', '/api/trades', { mon }),
    tradeList: () => call('GET', '/api/trades'),
    tradePeek: (code) => call('GET', '/api/trades/' + encodeURIComponent(code)),
    tradeAccept: (code, mon) => call('POST', '/api/trades/' + encodeURIComponent(code) + '/accept', { mon }),
    tradeCancel: (code) => call('POST', '/api/trades/' + encodeURIComponent(code) + '/cancel'),
    tradeClaim: (code) => call('POST', '/api/trades/' + encodeURIComponent(code) + '/claim'),
    // trading
    tradeCreate: (mon) => call('POST', '/api/trades', { mon }),
    tradeList: () => call('GET', '/api/trades'),
    tradePeek: (code) => call('GET', '/api/trades/' + encodeURIComponent(code)),
    tradeAccept: (code, mon) => call('POST', '/api/trades/' + encodeURIComponent(code) + '/accept', { mon }),
    tradeCancel: (code) => call('POST', '/api/trades/' + encodeURIComponent(code) + '/cancel'),
    tradeClaim: (code) => call('POST', '/api/trades/' + encodeURIComponent(code) + '/claim'),
  };
  return api;
})();
