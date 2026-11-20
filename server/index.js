'use strict';
// Online server for the monster game: accounts, cloud saves and the leaderboard.
//
//   POST /api/register   {username, password}  -> {token, username}
//   POST /api/login      {username, password}  -> {token, username}
//   POST /api/logout     (auth)
//   GET  /api/me         (auth)                -> {username}
//   GET  /api/save       (auth)                -> {save, savedAt}   (save is null when none)
//   PUT  /api/save       (auth) {save}         -> {ok, savedAt}
//   GET  /api/leaderboard?by=progress|caught   -> {rows, me}   (me only when logged in)
//   GET  /health                               -> ok
//
// "auth" means the header  Authorization: Bearer <token>.
// With DATABASE_URL set the data lives in Postgres; without it (for trying it out on your own
// computer) it lives in server/local-data.json.
// Settings (environment): PORT (default 3000), DATABASE_URL, ALLOWED_ORIGINS (comma-separated,
// default *), DATABASE_SSL=false to connect to a database without SSL.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 512 * 1024;          // a save is a few kilobytes; this leaves plenty of room

// ------------------------------------------------------------------ passwords and tokens
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(password, salt, 32).toString('hex');
  return salt + ':' + key;
}
function checkPassword(password, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const test = crypto.scryptSync(password, salt, 32);
  const want = Buffer.from(key, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}
const newToken = () => crypto.randomBytes(24).toString('hex');
const tokenId = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');   // only this is stored

// ------------------------------------------------------------------ what the leaderboard counts
// worked out from the save itself: stages cleared, species caught, highest level
const STAGE_FLAGS = ['rivalBeaten', 'badge1', 'stage3', 'badge2', 'stage5'];
function scoreOf(save) {
  const flags = (save && save.flags) || {};
  const mons = [].concat((save && save.party) || [], (save && save.lab) || []);
  return {
    stage: STAGE_FLAGS.filter((f) => flags[f]).length,
    caught: new Set(Array.isArray(save && save.caught) ? save.caught : []).size,
    level: mons.reduce((n, m) => Math.max(n, Number(m && m.level) || 0), 0),
    badges: (flags.badge1 ? 1 : 0) + (flags.badge2 ? 1 : 0),
  };
}

// ------------------------------------------------------------------ storage
// Both stores offer the same calls.
function fileStore(file) {
  let db = { users: [], sessions: [], saves: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  const write = () => fs.writeFileSync(file, JSON.stringify(db, null, 1));
  return {
    kind: 'file ' + path.basename(file),
    async init() {},
    async userByName(name) { return db.users.find((u) => u.username.toLowerCase() === name.toLowerCase()) || null; },
    async createUser(name, passHash) {
      const u = { id: db.users.length + 1, username: name, pass_hash: passHash, created_at: new Date().toISOString() };
      db.users.push(u); write(); return u;
    },
    async addSession(id, userId) { db.sessions.push({ id, user_id: userId, created_at: Date.now() }); write(); },
    async userBySession(id) {
      const s = db.sessions.find((x) => x.id === id);
      return s ? db.users.find((u) => u.id === s.user_id) || null : null;
    },
    async dropSession(id) { db.sessions = db.sessions.filter((x) => x.id !== id); write(); },
    async getSave(userId) { return db.saves[userId] || null; },
    async putSave(userId, data, score) {
      db.saves[userId] = { data, updated_at: new Date().toISOString(), ...score }; write();
      return db.saves[userId].updated_at;
    },
    async leaderboard(by, limit) {
      const rows = Object.entries(db.saves).map(([uid, s]) => ({
        username: (db.users.find((u) => u.id === Number(uid)) || {}).username, stage: s.stage, caught: s.caught,
        level: s.level, badges: s.badges, updated_at: s.updated_at, user_id: Number(uid) }));
      rows.sort(rankOrder(by));
      return rows.slice(0, limit);
    },
    async allRanked(by) { return this.leaderboard(by, 1e9); },
  };
}
function rankOrder(by) {
  const keys = by === 'caught' ? ['caught', 'stage', 'level'] : ['stage', 'caught', 'level'];
  return (a, b) => {
    for (const k of keys) if (b[k] !== a[k]) return b[k] - a[k];
    return String(a.updated_at).localeCompare(String(b.updated_at));   // earlier gets there first
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  const q = (text, args) => pool.query(text, args);
  const order = (by) => by === 'caught' ? 'caught DESC, stage DESC, level DESC, updated_at ASC'
                                        : 'stage DESC, caught DESC, level DESC, updated_at ASC';
  return {
    kind: 'postgres',
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS users (
                 id SERIAL PRIMARY KEY, username TEXT NOT NULL, pass_hash TEXT NOT NULL,
                 created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS users_name ON users (lower(username))');
      await q(`CREATE TABLE IF NOT EXISTS sessions (
                 id TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS saves (
                 user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data JSONB NOT NULL,
                 stage INT NOT NULL DEFAULT 0, caught INT NOT NULL DEFAULT 0, level INT NOT NULL DEFAULT 0,
                 badges INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    },
    async userByName(name) {
      const r = await q('SELECT * FROM users WHERE lower(username) = lower($1)', [name]); return r.rows[0] || null;
    },
    async createUser(name, passHash) {
      const r = await q('INSERT INTO users (username, pass_hash) VALUES ($1, $2) RETURNING *', [name, passHash]);
      return r.rows[0];
    },
    async addSession(id, userId) { await q('INSERT INTO sessions (id, user_id) VALUES ($1, $2)', [id, userId]); },
    async userBySession(id) {
      const r = await q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1', [id]);
      return r.rows[0] || null;
    },
    async dropSession(id) { await q('DELETE FROM sessions WHERE id = $1', [id]); },
    async getSave(userId) {
      const r = await q('SELECT data, updated_at FROM saves WHERE user_id = $1', [userId]); return r.rows[0] || null;
    },
    async putSave(userId, data, s) {
      const r = await q(`INSERT INTO saves (user_id, data, stage, caught, level, badges, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, now())
                         ON CONFLICT (user_id) DO UPDATE SET data = $2, stage = $3, caught = $4, level = $5,
                           badges = $6, updated_at = now()
                         RETURNING updated_at`, [userId, data, s.stage, s.caught, s.level, s.badges]);
      return r.rows[0].updated_at;
    },
    async leaderboard(by, limit) {
      const r = await q(`SELECT u.username, s.stage, s.caught, s.level, s.badges, s.updated_at, s.user_id
                         FROM saves s JOIN users u ON u.id = s.user_id ORDER BY ${order(by)} LIMIT $1`, [limit]);
      return r.rows;
    },
    async allRanked(by) {
      const r = await q(`SELECT s.user_id, s.stage, s.caught, s.level, s.badges, s.updated_at FROM saves s
                         ORDER BY ${order(by)}`);
      return r.rows;
    },
  };
}

const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL)
                                       : fileStore(path.join(__dirname, 'local-data.json'));

// ------------------------------------------------------------------ http helpers
function cors(req, res) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes('*') ? '*' : (ORIGINS.includes(origin) ? origin : '');
  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const fail = (res, status, error) => send(res, status, { error });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      if (!parts.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
async function currentUser(req) {
  const m = /^Bearer\s+([0-9a-f]{20,})$/i.exec(req.headers.authorization || '');
  return m ? store.userBySession(tokenId(m[1])) : null;
}

// a few wrong passwords per minute per address, so guessing is slow
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now(), list = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  attempts.set(ip, list);
  return list.length >= 10;
}
const noteAttempt = (ip) => attempts.get(ip).push(Date.now());

// usernames: 3-16 letters (Thai or English), digits or _
const NAME_OK = /^[A-Za-z0-9_฀-๿]{3,16}$/;

// ------------------------------------------------------------------ routes
async function handle(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://x');
  const route = req.method + ' ' + url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (route === 'GET /health' || route === 'GET /') return send(res, 200, { ok: true, store: store.kind });

  if (route === 'POST /api/register' || route === 'POST /api/login') {
    if (tooManyAttempts(ip)) return fail(res, 429, 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่');
    const { username, password } = await readBody(req);
    const name = String(username || '').trim(), pass = String(password || '');
    if (route === 'POST /api/register') {
      if (!NAME_OK.test(name)) return fail(res, 400, 'ชื่อผู้ใช้ต้องยาว 3-16 ตัว ใช้ตัวอักษร ตัวเลข หรือ _');
      if (pass.length < 6) return fail(res, 400, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัว');
      if (pass.length > 100) return fail(res, 400, 'รหัสผ่านยาวเกินไป');
      if (await store.userByName(name)) { noteAttempt(ip); return fail(res, 409, 'ชื่อนี้มีคนใช้แล้ว'); }
      const user = await store.createUser(name, hashPassword(pass));
      const token = newToken(); await store.addSession(tokenId(token), user.id);
      return send(res, 200, { token, username: user.username });
    }
    const user = await store.userByName(name);
    if (!user || !checkPassword(pass, user.pass_hash)) { noteAttempt(ip); return fail(res, 401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'); }
    const token = newToken(); await store.addSession(tokenId(token), user.id);
    return send(res, 200, { token, username: user.username });
  }

  if (route === 'GET /api/leaderboard') {
    const by = url.searchParams.get('by') === 'caught' ? 'caught' : 'progress';
    const rows = (await store.leaderboard(by, 20)).map((r, i) => ({
      rank: i + 1, username: r.username, stage: r.stage, caught: r.caught, level: r.level, badges: r.badges }));
    const user = await currentUser(req);
    let me = null;
    if (user) {
      const all = await store.allRanked(by);
      const at = all.findIndex((r) => Number(r.user_id) === Number(user.id));
      if (at >= 0) me = { rank: at + 1, username: user.username, stage: all[at].stage, caught: all[at].caught,
                          level: all[at].level, badges: all[at].badges };
    }
    return send(res, 200, { by, rows, me });
  }

  // everything below needs a login
  const user = await currentUser(req);
  if (!user) return fail(res, 401, 'กรุณาเข้าสู่ระบบก่อน');
  if (route === 'GET /api/me') return send(res, 200, { username: user.username });
  if (route === 'POST /api/logout') {
    await store.dropSession(tokenId((req.headers.authorization || '').split(/\s+/)[1]));
    return send(res, 200, { ok: true });
  }
  if (route === 'GET /api/save') {
    const s = await store.getSave(user.id);
    return send(res, 200, s ? { save: s.data, savedAt: s.updated_at } : { save: null, savedAt: null });
  }
  if (route === 'PUT /api/save') {
    const { save } = await readBody(req);
    if (!save || typeof save !== 'object' || !Array.isArray(save.party) || !save.flags) {
      return fail(res, 400, 'ข้อมูลเซฟไม่ถูกต้อง');
    }
    const savedAt = await store.putSave(user.id, save, scoreOf(save));
    return send(res, 200, { ok: true, savedAt });
  }
  return fail(res, 404, 'ไม่พบ');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.status === 413 ? 'ข้อมูลใหญ่เกินไป' : 'เซิร์ฟเวอร์ขัดข้อง ลองใหม่อีกครั้ง');
  });
});

store.init().then(() => {
  server.listen(PORT, () => console.log('monster game server on port ' + PORT + ' (' + store.kind + ')'));
}).catch((e) => { console.error('could not start:', e); process.exit(1); });
