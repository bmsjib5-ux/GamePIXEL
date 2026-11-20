'use strict';
// Live battles between two players. The server runs the battle, so neither side can cheat:
// both pick an action each turn, the server resolves the turn and both see the same events.
//
//   POST /api/live/create {team}         -> {room, code}          (code to give a friend)
//   POST /api/live/join   {code, team}   -> {room}
//   GET  /api/live/:room?since=N         -> {seq, events, view}   (waits up to 25 s for news)
//   POST /api/live/:room/act {kind, move | idx}                   kind: move | switch | forfeit
//
// Rooms live in memory: a server restart ends the battles in progress (players can start a new
// one). The rules (stats, damage, warm-up, cooldown, types) mirror game/js/game.js and read the
// game's own data file, so they always match the game.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// ---------------------------------------------------------------- the game's data
const DATA_FILE = process.env.GAME_DATA || path.join(__dirname, '..', 'game', 'js', 'data.js');
const D = {};
(function loadData() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(DATA_FILE, 'utf8') +
    '\n;this.out = { SPECIES, MOVES, TYPE_CHART, MAX_MOVES, moveCooldown, moveWarmup };', ctx);
  Object.assign(D, ctx.out);
})();

const TURN_MS = 60 * 1000;               // time to choose an action
const IDLE_MS = 10 * 60 * 1000;          // a room nobody touches for this long is removed
const WAIT_MS = 25 * 1000;               // longest a poll waits for news

const stats = (m) => {
  const s = D.SPECIES[m.sp], L = m.level, st = (base) => Math.floor(base * 2 * L / 100) + 5;
  return { hp: Math.floor(s.hp * 2 * L / 100) + L + 10, atk: st(s.atk), def: st(s.def), spd: st(s.spd) };
};
const typeMult = (mt, dt) => { const row = D.TYPE_CHART[mt]; return row && row[dt] !== undefined ? row[dt] : 1; };
function damage(att, def, mv) {
  const A = stats(att).atk, Df = stats(def).def;
  const base = Math.floor(((2 * att.level / 5 + 2) * mv.power * A / Df) / 50) + 2;
  const stab = D.SPECIES[att.sp].type === mv.type ? 1.25 : 1;
  const eff = typeMult(mv.type, D.SPECIES[def.sp].type);
  return { dmg: Math.max(1, Math.floor(base * stab * eff * (0.85 + Math.random() * 0.15))), eff };
}

// a team as sent by a player: known species and moves only, at most 6, everyone at full health
function teamFrom(list) {
  if (!Array.isArray(list)) return null;
  const team = [];
  for (const m of list.slice(0, 6)) {
    if (!m || !D.SPECIES[m.sp] || !Array.isArray(m.moves)) continue;
    const level = Math.max(1, Math.min(100, Math.floor(Number(m.level)) || 1));
    const moves = m.moves.filter((id) => D.MOVES[id]).slice(0, D.MAX_MOVES);
    if (!moves.length) continue;
    const mon = { sp: m.sp, level, moves };
    if (typeof m.nick === 'string' && m.nick.trim()) mon.nick = m.nick.trim().slice(0, 10);
    mon.hp = stats(mon).hp;
    team.push(mon);
  }
  return team.length ? team : null;
}
const nameOf = (m) => m.nick || D.SPECIES[m.sp].name;

// ---------------------------------------------------------------- rooms
const rooms = new Map();                 // room id -> room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

function newSide(user, team) {
  return { userId: user.id, name: user.username, team, active: 0, ready: new Map(), choice: null, mustSwitch: false };
}
function emit(room, ev) {
  room.events.push({ ...ev, seq: ++room.seq });
  if (room.events.length > 400) room.events.splice(0, room.events.length - 400);
  room.touched = Date.now();
  for (const w of room.waiters.splice(0)) w();
}

// ---- warm-up and cooldown, as in the game: a monster's moves start their warm-up when it
// comes out; its weakest move is ready at once; a used move rests per its power.
function readyOf(room, side, idx) {
  const key = idx;
  if (!side.ready.has(key)) {
    const m = side.team[idx], r = {};
    const weakest = m.moves.reduce((w, id) => (D.MOVES[id].power < D.MOVES[w].power ? id : w), m.moves[0]);
    for (const id of m.moves) if (id !== weakest && D.moveWarmup(id)) r[id] = room.round + D.moveWarmup(id);
    side.ready.set(key, r);
  }
  return side.ready.get(key);
}
const restLeft = (room, side, idx, id) => Math.max(0, (readyOf(room, side, idx)[id] || 0) - room.round);
function openMoves(room, side) {
  const ids = side.team[side.active].moves;
  const ok = ids.filter((id) => restLeft(room, side, side.active, id) === 0);
  return ok.length ? ok : ['tackle'];
}

// ---- what one player is allowed to see
function viewFor(room, who) {
  const me = room.sides[who], foe = room.sides[1 - who];
  const v = { phase: room.phase, you: who, round: room.round, winner: room.winner, deadline: room.deadline,
              code: room.code, names: [room.sides[0] && room.sides[0].name, room.sides[1] && room.sides[1].name] };
  if (!me || !foe) return v;
  v.team = me.team.map((m, i) => ({ sp: m.sp, level: m.level, nick: m.nick, hp: m.hp, max: stats(m).hp, active: i === me.active }));
  const a = me.team[me.active];
  v.moves = a.moves.map((id) => ({ id, left: restLeft(room, me, me.active, id), cd: D.moveCooldown(id) }));
  v.allResting = v.moves.every((x) => x.left > 0);
  const f = foe.team[foe.active];
  v.foe = { sp: f.sp, level: f.level, nick: f.nick, hp: f.hp, max: stats(f).hp, left: foe.team.filter((m) => m.hp > 0).length };
  v.waitingFor = room.phase === 'choose' ? (me.choice ? 'foe' : 'you')
               : room.phase === 'switch' ? (me.mustSwitch ? 'you' : 'foe') : null;
  return v;
}

// ---------------------------------------------------------------- the battle
function start(room) {
  room.phase = 'choose'; room.round = 0;
  emit(room, { type: 'start', names: [room.sides[0].name, room.sides[1].name] });
  for (const w of [0, 1]) emit(room, { type: 'switch', side: w, mon: pub(room.sides[w].team[0]), first: true });
  room.deadline = Date.now() + TURN_MS;
}
const pub = (m) => ({ sp: m.sp, level: m.level, nick: m.nick, hp: m.hp, max: stats(m).hp });

function act(room, who, a) {
  const side = room.sides[who];
  if (room.phase === 'waiting') { rooms.delete(room.id); return null; }    // the creator gave up waiting
  if (room.phase === 'over') return 'การต่อสู้จบแล้ว';
  if (a.kind === 'forfeit') { finish(room, 1 - who, 'forfeit'); return null; }
  if (room.phase === 'switch') {
    if (!side.mustSwitch) return 'รออีกฝ่ายเลือกตัว';
    const idx = Number(a.idx);
    if (a.kind !== 'switch' || !side.team[idx] || side.team[idx].hp <= 0) return 'เลือกตัวนี้ไม่ได้';
    side.active = idx; side.mustSwitch = false;
    emit(room, { type: 'switch', side: who, mon: pub(side.team[idx]) });
    readyOf(room, side, idx);
    if (!room.sides.some((s) => s.mustSwitch)) { room.phase = 'choose'; room.deadline = Date.now() + TURN_MS; emit(room, { type: 'turn' }); }
    return null;
  }
  if (room.phase !== 'choose') return 'ยังไม่ถึงตาเลือก';
  if (side.choice) return 'เลือกไปแล้ว รออีกฝ่าย';
  if (a.kind === 'move') {
    if (!openMoves(room, side).includes(a.move)) return 'ท่านี้ยังใช้ไม่ได้';
    side.choice = { kind: 'move', move: a.move };
  } else if (a.kind === 'switch') {
    const idx = Number(a.idx);
    if (!side.team[idx] || side.team[idx].hp <= 0 || idx === side.active) return 'เปลี่ยนเป็นตัวนี้ไม่ได้';
    side.choice = { kind: 'switch', idx };
  } else return 'คำสั่งไม่ถูกต้อง';
  emit(room, { type: 'chosen', side: who });
  if (room.sides.every((s) => s.choice)) resolve(room);
  return null;
}

function resolve(room) {
  const S = room.sides;
  // switches go first
  for (const w of [0, 1]) {
    const c = S[w].choice;
    if (c.kind === 'switch') {
      S[w].active = c.idx;
      emit(room, { type: 'switch', side: w, mon: pub(S[w].team[c.idx]) });
      readyOf(room, S[w], c.idx);
    }
  }
  // then moves, faster monster first (a tie is a coin flip)
  const movers = [0, 1].filter((w) => S[w].choice.kind === 'move');
  movers.sort((x, y) => {
    const a = stats(S[x].team[S[x].active]).spd, b = stats(S[y].team[S[y].active]).spd;
    return b - a || (Math.random() < 0.5 ? -1 : 1);
  });
  for (const w of movers) {
    const att = S[w].team[S[w].active], foeSide = S[1 - w], def = foeSide.team[foeSide.active];
    if (att.hp <= 0 || def.hp <= 0) continue;
    const id = S[w].choice.move, mv = D.MOVES[id];
    const c = D.moveCooldown(id);
    if (c) readyOf(room, S[w], S[w].active)[id] = room.round + c + 1;
    const { dmg, eff } = damage(att, def, mv);
    def.hp = Math.max(0, def.hp - dmg);
    emit(room, { type: 'move', side: w, move: id, dmg, eff, hp: def.hp });
    if (def.hp <= 0) emit(room, { type: 'faint', side: 1 - w });
  }
  for (const s of S) s.choice = null;
  room.round++;
  // anyone without a monster left loses; a side whose active monster fell picks the next one
  const out = [0, 1].filter((w) => S[w].team.every((m) => m.hp <= 0));
  if (out.length === 2) return finish(room, null, 'draw');
  if (out.length === 1) return finish(room, 1 - out[0], 'ko');
  for (const s of S) s.mustSwitch = s.team[s.active].hp <= 0;
  room.phase = S.some((s) => s.mustSwitch) ? 'switch' : 'choose';
  room.deadline = Date.now() + TURN_MS;
  emit(room, { type: 'turn' });
}

let onFinish = null;                     // set by index.js: updates the players' ratings
function finish(room, winner, how) {
  room.phase = 'over'; room.winner = winner; room.deadline = null;
  emit(room, { type: 'end', winner, how });
  if (onFinish && winner !== null && !room.rated) {
    room.rated = true;
    onFinish(room.sides[winner].userId, room.sides[1 - winner].userId).then((r) => {
      room.ratings = r;
      emit(room, { type: 'rating', ratings: r });
    }).catch((e) => console.error('rating', e));
  }
}

// when time runs out: whoever has not chosen uses their first ready move (or the first
// monster still standing when they must switch)
function tick() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.touched > IDLE_MS) { rooms.delete(id); continue; }
    if (!room.deadline || now < room.deadline) continue;
    if (room.phase === 'choose') {
      for (const w of [0, 1]) if (!room.sides[w].choice) act(room, w, { kind: 'move', move: openMoves(room, room.sides[w])[0] });
    } else if (room.phase === 'switch') {
      for (const w of [0, 1]) {
        const s = room.sides[w];
        if (s.mustSwitch) act(room, w, { kind: 'switch', idx: s.team.findIndex((m) => m.hp > 0) });
      }
    }
  }
}
setInterval(tick, 1000).unref();

// ---------------------------------------------------------------- http
async function handle(req, res, ctx) {
  const { url, user, readBody, send, fail } = ctx;
  const p = url.pathname;
  if (req.method === 'POST' && p === '/api/live/create') {
    const { team } = await readBody(req);
    const t = teamFrom(team);
    if (!t) return fail(res, 400, 'ทีมไม่ถูกต้อง');
    for (const [k, r] of rooms) if (r.phase === 'waiting' && r.sides[0].userId === user.id) rooms.delete(k);   // one waiting room each
    const id = crypto.randomBytes(8).toString('hex');
    let code = newCode();
    while ([...rooms.values()].some((r) => r.code === code)) code = newCode();
    rooms.set(id, { id, code, phase: 'waiting', sides: [newSide(user, t)], events: [], seq: 0, round: 0,
                    waiters: [], touched: Date.now(), deadline: null, winner: null });
    return send(res, 200, { room: id, code });
  }
  if (req.method === 'POST' && p === '/api/live/join') {
    const { code, team } = await readBody(req);
    const room = [...rooms.values()].find((r) => r.code === String(code || '').toUpperCase().trim());
    if (!room || room.phase !== 'waiting') return fail(res, 404, 'ไม่พบห้องนี้ หรือห้องเต็มแล้ว');
    if (room.sides[0].userId === user.id) return fail(res, 409, 'เข้าห้องของตัวเองไม่ได้');
    const t = teamFrom(team);
    if (!t) return fail(res, 400, 'ทีมไม่ถูกต้อง');
    room.sides.push(newSide(user, t));
    start(room);
    return send(res, 200, { room: room.id });
  }
  const m = /^\/api\/live\/([0-9a-f]{16})(\/act)?$/.exec(p);
  if (!m) return fail(res, 404, 'ไม่พบ');
  const room = rooms.get(m[1]);
  if (!room) return fail(res, 404, 'ห้องนี้ปิดไปแล้ว');
  const who = room.sides.findIndex((s) => s.userId === user.id);
  if (who < 0) return fail(res, 403, 'คุณไม่ได้อยู่ในห้องนี้');
  room.touched = Date.now();
  if (m[2] && req.method === 'POST') {
    const err = act(room, who, await readBody(req));
    if (err) return fail(res, 409, err);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET') {
    const since = Number(url.searchParams.get('since')) || 0;
    if (room.seq <= since && room.phase !== 'over') {        // nothing new yet: wait a little
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, WAIT_MS);
        room.waiters.push(() => { clearTimeout(timer); resolve(); });
        req.on('close', resolve);
      });
    }
    const events = room.events.filter((e) => e.seq > since);
    return send(res, 200, { seq: room.seq, events, view: viewFor(room, who), ratings: room.ratings || null });
  }
  return fail(res, 404, 'ไม่พบ');
}

module.exports = { handle, setOnFinish: (fn) => { onFinish = fn; }, _rooms: rooms };
