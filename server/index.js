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
//   POST /api/trades     (auth) {mon}          -> {code}        put a monster up for trade
//   GET  /api/trades     (auth)                -> {trades}      my offers (open / accepted)
//   GET  /api/trades/:code (auth)              -> {code, mon, from, status}
//   POST /api/trades/:code/accept (auth) {mon} -> {mon}         give mine, get theirs
//   POST /api/trades/:code/cancel (auth)       -> {mon}         my open offer back
//   POST /api/trades/:code/claim  (auth)       -> {mon}         collect what I was given
//   GET  /api/pvp/opponents (auth)             -> {me, rows}    players whose team can be challenged
//   GET  /api/pvp/team/:name (auth)            -> {username, rating, team}
//   POST /api/pvp/result (auth) {opponent, won}-> {rating, delta}
//   GET  /api/leaderboard?by=pvp               -> fighters by rating
//   /api/live/...                              live battles (see live.js)
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

const live = require('./live');
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
  let db = { users: [], sessions: [], saves: {}, trades: [], pvp: {} };
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
    // fighters
    async pvpOf(userId) { db.pvp = db.pvp || {}; return db.pvp[userId] || { rating: 1000, wins: 0, losses: 0 }; },
    async setPvp(userId, p) { db.pvp = db.pvp || {}; db.pvp[userId] = { rating: p.rating, wins: p.wins, losses: p.losses }; write(); },
    async opponents(userId) {
      db.pvp = db.pvp || {};
      return Object.entries(db.saves).filter(([uid]) => Number(uid) !== Number(userId)).map(([uid, s]) => {
        const u = db.users.find((x) => x.id === Number(uid)) || {};
        const p = db.pvp[uid] || { rating: 1000, wins: 0, losses: 0 };
        return { username: u.username, party: (s.data || {}).party, rating: p.rating, wins: p.wins, losses: p.losses, updated_at: s.updated_at };
      });
    },
    async teamOf(name) {
      const u = db.users.find((x) => x.username.toLowerCase() === String(name).toLowerCase());
      const s = u && db.saves[u.id];
      if (!s) return null;
      const p = (db.pvp || {})[u.id] || { rating: 1000 };
      return { user_id: u.id, username: u.username, party: (s.data || {}).party, rating: p.rating };
    },
    async pvpBoard(limit) {
      db.pvp = db.pvp || {};
      return Object.entries(db.pvp).map(([uid, p]) => ({ username: (db.users.find((u) => u.id === Number(uid)) || {}).username,
        rating: p.rating, wins: p.wins, losses: p.losses, user_id: Number(uid) }))
        .sort((a, b) => b.rating - a.rating || b.wins - a.wins).slice(0, limit);
    },
    // trades
    async tradeByCode(code) { return (db.trades || []).find((t) => t.code === code) || null; },
    async openTradesOf(userId) { return (db.trades || []).filter((t) => t.owner_id === userId && t.status === 'open').length; },
    async createTrade(code, userId, mon) {
      db.trades = db.trades || [];
      db.trades.push({ code, owner_id: userId, mon, status: 'open', partner_id: null, partner_mon: null,
                       claimed: false, created_at: new Date().toISOString() });
      write();
    },
    async acceptTrade(code, userId, mon) {          // only if still open and not one's own
      const t = (db.trades || []).find((x) => x.code === code && x.status === 'open' && x.owner_id !== userId);
      if (!t) return null;
      Object.assign(t, { status: 'accepted', partner_id: userId, partner_mon: mon, accepted_at: new Date().toISOString() });
      write(); return t.mon;
    },
    async cancelTrade(code, userId) {
      const t = (db.trades || []).find((x) => x.code === code && x.status === 'open' && x.owner_id === userId);
      if (!t) return null;
      db.trades = db.trades.filter((x) => x !== t); write(); return t.mon;
    },
    async claimTrade(code, userId) {
      const t = (db.trades || []).find((x) => x.code === code && x.status === 'accepted' && x.owner_id === userId && !x.claimed);
      if (!t) return null;
      t.claimed = true; write(); return t.partner_mon;
    },
    async tradesOf(userId) {
      return (db.trades || []).filter((t) => t.owner_id === userId && !t.claimed).map((t) => ({
        code: t.code, mon: t.mon, status: t.status, partner_mon: t.partner_mon,
        partner: t.partner_id ? (db.users.find((u) => u.id === t.partner_id) || {}).username : null }));
    },
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
      await q(`CREATE TABLE IF NOT EXISTS trades (
                 code TEXT PRIMARY KEY, owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 mon JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'open',
                 partner_id INT REFERENCES users(id) ON DELETE SET NULL, partner_mon JSONB,
                 claimed BOOLEAN NOT NULL DEFAULT false,
                 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), accepted_at TIMESTAMPTZ)`);
      await q('CREATE INDEX IF NOT EXISTS trades_owner ON trades (owner_id)');
      await q(`CREATE TABLE IF NOT EXISTS pvp (
                 user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                 rating INT NOT NULL DEFAULT 1000, wins INT NOT NULL DEFAULT 0, losses INT NOT NULL DEFAULT 0,
                 updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
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
    // fighters
    async pvpOf(userId) {
      const r = await q('SELECT rating, wins, losses FROM pvp WHERE user_id = $1', [userId]);
      return r.rows[0] || { rating: 1000, wins: 0, losses: 0 };
    },
    async setPvp(userId, p) {
      await q(`INSERT INTO pvp (user_id, rating, wins, losses, updated_at) VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (user_id) DO UPDATE SET rating = $2, wins = $3, losses = $4, updated_at = now()`,
              [userId, p.rating, p.wins, p.losses]);
    },
    async opponents(userId) {
      const r = await q(`SELECT u.username, s.data->'party' AS party, s.updated_at,
                           COALESCE(p.rating, 1000) AS rating, COALESCE(p.wins, 0) AS wins, COALESCE(p.losses, 0) AS losses
                         FROM saves s JOIN users u ON u.id = s.user_id LEFT JOIN pvp p ON p.user_id = s.user_id
                         WHERE s.user_id <> $1 ORDER BY s.updated_at DESC LIMIT 200`, [userId]);
      return r.rows;
    },
    async teamOf(name) {
      const r = await q(`SELECT u.id AS user_id, u.username, s.data->'party' AS party, COALESCE(p.rating, 1000) AS rating
                         FROM users u JOIN saves s ON s.user_id = u.id LEFT JOIN pvp p ON p.user_id = u.id
                         WHERE lower(u.username) = lower($1)`, [name]);
      return r.rows[0] || null;
    },
    async pvpBoard(limit) {
      const r = await q(`SELECT u.username, p.rating, p.wins, p.losses, p.user_id FROM pvp p JOIN users u ON u.id = p.user_id
                         ORDER BY p.rating DESC, p.wins DESC LIMIT $1`, [limit]);
      return r.rows;
    },
    // trades: each change is one statement, so two players can never take the same offer
    async tradeByCode(code) {
      const r = await q('SELECT * FROM trades WHERE code = $1', [code]); return r.rows[0] || null;
    },
    async openTradesOf(userId) {
      const r = await q("SELECT count(*)::int AS n FROM trades WHERE owner_id = $1 AND status = 'open'", [userId]);
      return r.rows[0].n;
    },
    async createTrade(code, userId, mon) {
      await q('INSERT INTO trades (code, owner_id, mon) VALUES ($1, $2, $3)', [code, userId, mon]);
    },
    async acceptTrade(code, userId, mon) {
      const r = await q(`UPDATE trades SET status = 'accepted', partner_id = $2, partner_mon = $3, accepted_at = now()
                         WHERE code = $1 AND status = 'open' AND owner_id <> $2 RETURNING mon`, [code, userId, mon]);
      return r.rows[0] ? r.rows[0].mon : null;
    },
    async cancelTrade(code, userId) {
      const r = await q("DELETE FROM trades WHERE code = $1 AND status = 'open' AND owner_id = $2 RETURNING mon", [code, userId]);
      return r.rows[0] ? r.rows[0].mon : null;
    },
    async claimTrade(code, userId) {
      const r = await q(`UPDATE trades SET claimed = true
                         WHERE code = $1 AND status = 'accepted' AND owner_id = $2 AND NOT claimed RETURNING partner_mon`, [code, userId]);
      return r.rows[0] ? r.rows[0].partner_mon : null;
    },
    async tradesOf(userId) {
      const r = await q(`SELECT t.code, t.mon, t.status, t.partner_mon, u.username AS partner
                         FROM trades t LEFT JOIN users u ON u.id = t.partner_id
                         WHERE t.owner_id = $1 AND NOT t.claimed ORDER BY t.created_at`, [userId]);
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

// trading: codes people can read out (no 0/O, 1/I), and only the fields a monster has
const MAX_OPEN_TRADES = 3;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
function cleanMon(m) {
  if (!m || typeof m !== 'object' || typeof m.sp !== 'string' || !/^[a-z0-9_]{2,24}$/.test(m.sp)) return null;
  const level = Math.floor(Number(m.level)), exp = Math.floor(Number(m.exp)), hp = Math.floor(Number(m.hp));
  if (!(level >= 1 && level <= 100) || !(exp >= 0) || !(hp >= 0)) return null;
  if (!Array.isArray(m.moves) || m.moves.length < 1 || m.moves.length > 4 ||
      !m.moves.every((x) => typeof x === 'string' && /^[a-z0-9_]{2,24}$/.test(x))) return null;
  const out = { sp: m.sp, level, exp, hp, moves: m.moves.slice() };
  if (typeof m.nick === 'string' && m.nick.trim()) out.nick = m.nick.trim().slice(0, 10);
  return out;
}

// fighting: a saved team, cleaned (at most 6), and Elo ratings
const ELO_K = 32, FIGHT_COOLDOWN_MS = 5 * 60 * 1000;
const recentFights = new Map();
const cleanTeam = (party) => (Array.isArray(party) ? party : []).map(cleanMon).filter(Boolean).slice(0, 6);

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

  if (route === 'GET /api/leaderboard' && url.searchParams.get('by') === 'pvp') {
    const all = await store.pvpBoard(1000);
    const rows = all.slice(0, 20).map((r, i) => ({ rank: i + 1, username: r.username, rating: r.rating, wins: r.wins, losses: r.losses }));
    const user = await currentUser(req);
    let me = null;
    if (user) {
      const at = all.findIndex((r) => Number(r.user_id) === Number(user.id));
      if (at >= 0) me = { rank: at + 1, username: user.username, rating: all[at].rating, wins: all[at].wins, losses: all[at].losses };
    }
    return send(res, 200, { by: 'pvp', rows, me });
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
  if (url.pathname.startsWith('/api/live/')) return live.handle(req, res, { url, user, readBody, send, fail });
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
  // ---- challenging other players' teams
  if (route === 'GET /api/pvp/opponents') {
    const me = await store.pvpOf(user.id);
    const rows = (await store.opponents(user.id)).map((r) => ({ ...r, team: cleanTeam(r.party) }))
      .filter((r) => r.team.length)
      .sort((a, b) => Math.abs(a.rating - me.rating) - Math.abs(b.rating - me.rating))
      .slice(0, 30)
      .map((r) => ({ username: r.username, rating: r.rating, wins: r.wins, losses: r.losses,
                     size: r.team.length, top: r.team.reduce((n, m) => Math.max(n, m.level), 0),
                     species: r.team.map((m) => m.sp) }));
    return send(res, 200, { me: { username: user.username, ...me }, rows });
  }
  const pt = /^\/api\/pvp\/team\/(.+)$/.exec(url.pathname);
  if (pt && req.method === 'GET') {
    const t = await store.teamOf(decodeURIComponent(pt[1]));
    const team = t ? cleanTeam(t.party) : [];
    if (!team.length) return fail(res, 404, 'ไม่พบทีมของผู้เล่นนี้');
    return send(res, 200, { username: t.username, rating: t.rating, team });
  }
  if (route === 'POST /api/pvp/result') {
    const { opponent, won } = await readBody(req);
    const t = await store.teamOf(String(opponent || ''));
    if (!t || Number(t.user_id) === Number(user.id)) return fail(res, 404, 'ไม่พบคู่ต่อสู้');
    const me = await store.pvpOf(user.id), them = await store.pvpOf(t.user_id);
    // the same pair counts for rating once every few minutes, so a win cannot be farmed
    const pairKey = user.id + ':' + t.user_id, now = Date.now();
    const recent = now - (recentFights.get(pairKey) || 0) < FIGHT_COOLDOWN_MS;
    let delta = 0;
    if (!recent) {
      recentFights.set(pairKey, now);
      const expect = 1 / (1 + Math.pow(10, (them.rating - me.rating) / 400));
      delta = Math.round(ELO_K * ((won ? 1 : 0) - expect));
      await store.setPvp(user.id, { rating: me.rating + delta, wins: me.wins + (won ? 1 : 0), losses: me.losses + (won ? 0 : 1) });
      await store.setPvp(t.user_id, { rating: them.rating - delta, wins: them.wins + (won ? 0 : 1), losses: them.losses + (won ? 1 : 0) });
    }
    return send(res, 200, { rating: me.rating + delta, delta, counted: !recent });
  }

  // ---- trading monsters
  if (route === 'POST /api/trades') {
    const { mon } = await readBody(req);
    const clean = cleanMon(mon);
    if (!clean) return fail(res, 400, 'ข้อมูลมอนสเตอร์ไม่ถูกต้อง');
    if (await store.openTradesOf(user.id) >= MAX_OPEN_TRADES) {
      return fail(res, 409, 'มีข้อเสนอที่ยังไม่มีคนรับอยู่ ' + MAX_OPEN_TRADES + ' รายการแล้ว ยกเลิกหรือรอให้มีคนรับก่อน');
    }
    let code = newCode();
    for (let i = 0; i < 5 && (await store.tradeByCode(code)); i++) code = newCode();
    await store.createTrade(code, user.id, clean);
    return send(res, 200, { code });
  }
  if (route === 'GET /api/trades') return send(res, 200, { trades: await store.tradesOf(user.id) });
  const tm = /^\/api\/trades\/([A-Za-z0-9]{4,8})(?:\/(accept|cancel|claim))?$/.exec(url.pathname);
  if (tm) {
    const code = tm[1].toUpperCase(), act = tm[2];
    if (req.method === 'GET' && !act) {
      const t = await store.tradeByCode(code);
      if (!t || t.status !== 'open') return fail(res, 404, 'ไม่พบข้อเสนอนี้ หรือมีคนรับไปแล้ว');
      const owner = Number(t.owner_id) === Number(user.id);
      return send(res, 200, { code, mon: t.mon, mine: owner, status: t.status });
    }
    if (req.method === 'POST' && act === 'accept') {
      const { mon } = await readBody(req);
      const clean = cleanMon(mon);
      if (!clean) return fail(res, 400, 'ข้อมูลมอนสเตอร์ไม่ถูกต้อง');
      const t = await store.tradeByCode(code);
      if (t && Number(t.owner_id) === Number(user.id)) return fail(res, 409, 'รับข้อเสนอของตัวเองไม่ได้');
      const got = await store.acceptTrade(code, user.id, clean);
      if (!got) return fail(res, 404, 'ไม่พบข้อเสนอนี้ หรือมีคนรับไปแล้ว');
      return send(res, 200, { mon: got });
    }
    if (req.method === 'POST' && act === 'cancel') {
      const got = await store.cancelTrade(code, user.id);
      if (!got) return fail(res, 404, 'ยกเลิกไม่ได้ (อาจมีคนรับไปแล้ว)');
      return send(res, 200, { mon: got });
    }
    if (req.method === 'POST' && act === 'claim') {
      const got = await store.claimTrade(code, user.id);
      if (!got) return fail(res, 404, 'ไม่มีมอนสเตอร์ให้รับจากข้อเสนอนี้');
      return send(res, 200, { mon: got });
    }
  }
  return fail(res, 404, 'ไม่พบ');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.status === 413 ? 'ข้อมูลใหญ่เกินไป' : 'เซิร์ฟเวอร์ขัดข้อง ลองใหม่อีกครั้ง');
  });
});

// a finished live battle changes both players' ratings (Elo, like challenges)
live.setOnFinish(async (winnerId, loserId) => {
  const w = await store.pvpOf(winnerId), l = await store.pvpOf(loserId);
  const expect = 1 / (1 + Math.pow(10, (l.rating - w.rating) / 400));
  const delta = Math.max(1, Math.round(ELO_K * (1 - expect)));
  await store.setPvp(winnerId, { rating: w.rating + delta, wins: w.wins + 1, losses: w.losses });
  await store.setPvp(loserId, { rating: l.rating - delta, wins: l.wins, losses: l.losses + 1 });
  return { [winnerId]: { rating: w.rating + delta, delta }, [loserId]: { rating: l.rating - delta, delta: -delta } };
});

store.init().then(() => {
  server.listen(PORT, () => console.log('monster game server on port ' + PORT + ' (' + store.kind + ')'));
}).catch((e) => { console.error('could not start:', e); process.exit(1); });
