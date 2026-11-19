'use strict';
// Engine, user interface, overworld and battles.
(() => {
  const VW = 480, VH = 320;            // logical screen size in pixels
  const STEP = 0.19;                   // seconds to walk one tile
  // "?test" in the address keeps test runs in a save slot of their own
  const SAVE_KEY = 'sprout_village_save_v1' + (location.search.includes('test') ? '_test' : '');
  const FONT = '"Leelawadee UI","Noto Sans Thai",Tahoma,sans-serif';
  const DIRS = { down: [0, 1, 0], left: [-1, 0, 1], right: [1, 0, 2], up: [0, -1, 3] }; // dx, dy, sheet row
  const OPPOSITE = { down: 'up', up: 'down', left: 'right', right: 'left' };

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const buf = document.createElement('canvas');   // low-resolution picture, scaled up with hard pixels
  buf.width = VW; buf.height = VH;
  const b = buf.getContext('2d');
  let S = 2;                                      // screen pixels per logical pixel

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const hint = document.getElementById('hint');
    const availH = window.innerHeight - (hint ? hint.offsetHeight + 12 : 0);
    S = Math.max(1, Math.floor(Math.min(window.innerWidth * dpr / VW, availH * dpr / VH)));
    canvas.width = VW * S; canvas.height = VH * S;
    canvas.style.width = (VW * S / dpr) + 'px';
    canvas.style.height = (VH * S / dpr) + 'px';
  }
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------------ images
  const IMG = {};
  function loadImage(name) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => { IMG[name] = im; resolve(); };
      im.onerror = () => reject(new Error('โหลดภาพไม่ได้: ' + name));
      im.src = 'assets/' + name + '.png';
    });
  }
  function allImages() {
    const names = ['terrain', 'battle_bg', 'chars/hero', 'chars/npc_researcher', 'chars/npc_rival',
      'chars/npc_shopkeeper', 'chars/npc_healer', 'chars/rival_large'];
    for (const n of Object.keys(SPRITE_META.objects)) names.push('objects/' + n);
    for (const n of Object.keys(SPRITE_META.buildings)) names.push('buildings/' + n);
    for (const n of Object.keys(SPRITE_META.furniture)) names.push('furniture/' + n);
    for (const sp of Object.values(SPECIES)) names.push('monsters/' + sp.img, 'monsters/' + sp.img + '_back');
    return names;
  }

  // ------------------------------------------------------------------- state
  let mode = 'loading';        // loading | title | world | battle
  let MAPS = null, MAP = null; // every map, and the one the player is on
  const groundCache = {};      // map id -> pre-drawn ground picture
  let groundCanvas = null;
  let G = null;                // saved game: player position, party, bag, flags
  let pl = null;               // player on the map
  let npcs = [];
  let busy = false;            // a scripted scene (dialogue, battle) is running
  let bt = null;               // current battle
  const ui = { msg: null, menu: null, fade: 0, flash: 0, portrait: null, prompt: null };
  const held = [];             // directions currently held, most recent last
  const tweens = [];
  let clock = 0;

  // ----------------------------------------------------------------- helpers
  const rand = (n) => Math.floor(Math.random() * n);
  const nm = (m) => SPECIES[m.sp].name;
  const expAt = (level) => level * level * level;

  function stats(m) {
    const s = SPECIES[m.sp], L = m.level;
    const st = (base) => Math.floor(base * 2 * L / 100) + 5;
    return { hp: Math.floor(s.hp * 2 * L / 100) + L + 10, atk: st(s.atk), def: st(s.def), spd: st(s.spd) };
  }
  function makeMon(sp, level) {
    const m = { sp, level, exp: expAt(level), hp: 0, moves: [] };
    for (const [lv, mv] of SPECIES[sp].moves) if (lv <= level) m.moves.push(mv);
    m.moves = m.moves.slice(-4);
    m.hp = stats(m).hp;
    return m;
  }
  function healParty() { for (const m of G.party) m.hp = stats(m).hp; }
  function noteCaught(sp) { if (!G.caught.includes(sp)) G.caught.push(sp); }

  function newGame() {
    G = { player: { ...START_SPOT }, party: [], lab: [], bag: { capsule: 0, potion: 0 },
          caught: [], flags: {}, steps: 0 };
  }
  function save() {
    if (!G || !pl) return;
    G.player = { map: MAP.id, c: pl.c, r: pl.r, dir: pl.dir };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(G)); } catch (e) { /* storage unavailable */ }
  }
  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function tween(ms, fn) {
    return new Promise((resolve) => { tweens.push({ ms, fn, t: 0, resolve }); if (fn) fn(0); });
  }
  const wait = (ms) => tween(ms, null);
  const fadeTo = (v, ms) => { const from = ui.fade; return tween(ms, (t) => { ui.fade = from + (v - from) * t; }); };

  async function run(scene) {          // run a scripted scene; the player cannot walk meanwhile
    if (busy) return;
    busy = true;
    try { await scene(); } catch (e) { console.error(e); ui.msg = null; ui.menu = null; }
    busy = false;
  }

  // -------------------------------------------------------------------- text
  const wordSeg = window.Intl && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
  const graphSeg = window.Intl && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'grapheme' }) : null;
  const graphemes = (s) => graphSeg ? Array.from(graphSeg.segment(s), (x) => x.segment) : Array.from(s);
  const words = (s) => wordSeg ? Array.from(wordSeg.segment(s), (x) => x.segment) : graphemes(s);
  const setFont = (px, bold) => { ctx.font = (bold ? 'bold ' : '') + px + 'px ' + FONT; };

  function wrap(text, maxW, px) {
    setFont(px || 13);
    const lines = [];
    for (const para of String(text).split('\n')) {
      let cur = '';
      for (const w of words(para)) {
        if (cur && ctx.measureText(cur + w).width > maxW) {
          lines.push(cur.replace(/\s+$/, ''));
          cur = w.replace(/^\s+/, '');
        } else cur += w;
      }
      lines.push(cur);
    }
    return lines;
  }

  // A message in the text box. Resolves when the player presses the confirm key.
  function say(text) {
    return new Promise((resolve) => {
      const lines = wrap(text, 436, 13).map(graphemes);
      const pages = [];
      for (let i = 0; i < lines.length; i += 3) pages.push(lines.slice(i, i + 3));
      ui.msg = { pages, page: 0, shown: 0, resolve };
    });
  }
  const pageLength = (p) => p.reduce((n, l) => n + l.length, 0);

  // A menu. Resolves with the chosen index, or -1 when cancelled.
  function choose(options, o = {}) {
    return new Promise((resolve) => {
      const opts = options.map((x) => typeof x === 'string' ? { label: x } : x);
      const cols = o.cols || 1, rowH = o.rowH || 22;
      const rows = Math.ceil(opts.length / cols);
      const titleH = o.title ? 22 : 0, footH = o.footer ? 20 : 0;
      const h = Math.max(o.minH || 0, rows * rowH + 14 + titleH + footH);
      const w = o.w || 150;
      ui.menu = {
        opts, cols, rowH, w, h, titleH, title: o.title, footer: o.footer,
        x: o.x !== undefined ? o.x : VW - w - 8, y: o.y !== undefined ? o.y : 228 - h,
        index: Math.min(o.start || 0, opts.length - 1), cancellable: !!o.cancellable, onMove: o.onMove, resolve,
      };
      if (o.onMove) o.onMove(ui.menu.index);
    });
  }

  // ------------------------------------------------------------------- input
  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
    z: 'ok', Z: 'ok', Enter: 'ok', ' ': 'ok', x: 'back', X: 'back', Escape: 'back', Backspace: 'back',
  };
  window.addEventListener('keydown', (ev) => {
    const k = KEYMAP[ev.key];
    if (!k) return;
    ev.preventDefault();
    if (DIRS[k] && !held.includes(k)) held.push(k);
    if (ev.repeat && !DIRS[k]) return;
    press(k, ev.repeat);
  });
  window.addEventListener('keyup', (ev) => {
    const k = KEYMAP[ev.key];
    const i = held.indexOf(k);
    if (i >= 0) held.splice(i, 1);
  });
  window.addEventListener('blur', () => { held.length = 0; });

  function press(k, repeat) {
    if (ui.menu) {
      const m = ui.menu, n = m.opts.length;
      let i = m.index;
      if (k === 'up') i -= m.cols; else if (k === 'down') i += m.cols;
      else if (k === 'left' && m.cols > 1) i -= 1; else if (k === 'right' && m.cols > 1) i += 1;
      else if (k === 'ok' && !repeat) {
        if (m.opts[m.index].disabled) return;
        ui.menu = null; m.resolve(m.index); return;
      } else if (k === 'back' && !repeat && m.cancellable) { ui.menu = null; m.resolve(-1); return; }
      if (i !== m.index && i >= 0 && i < n) { m.index = i; if (m.onMove) m.onMove(i); }
      return;
    }
    if (ui.msg) {
      if (repeat || (k !== 'ok' && k !== 'back')) return;
      const m = ui.msg, len = pageLength(m.pages[m.page]);
      if (m.shown < len) m.shown = len;
      else if (m.page < m.pages.length - 1) { m.page++; m.shown = 0; }
      else { ui.msg = null; m.resolve(); }
      return;
    }
    if (mode === 'world' && !busy && !pl.moving && !repeat) {
      if (k === 'ok') examine();
      else if (k === 'back') run(teamScreen);
    }
  }

  // --------------------------------------------------------------- overworld
  function setMap(id) {
    MAP = MAPS[id] || MAPS.village;
    if (!groundCache[MAP.id]) {
      const cv = document.createElement('canvas');
      cv.width = MAP.w * TS; cv.height = MAP.h * TS;
      const g = cv.getContext('2d');
      for (let r = 0; r < MAP.h; r++) for (let c = 0; c < MAP.w; c++) {
        const name = MAP.ground[r][c];
        if (!name) continue;                       // nothing there: stays black
        const t = TILE_INDEX[name] || TILE_INDEX.grass;
        g.drawImage(IMG.terrain, t[0] * TS, t[1] * TS, TS, TS, c * TS, r * TS, TS, TS);
      }
      if (MAP.indoor) {                            // dark frame around the room, open at the doorway
        const w = MAP.w * TS, h = (MAP.h - 1) * TS;
        let exitCol = 0;
        for (const k of MAP.warps.keys()) exitCol = Number(k.split(',')[0]);
        g.fillStyle = '#3a2f2a';
        g.fillRect(0, 0, w, 3); g.fillRect(0, 0, 3, h); g.fillRect(w - 3, 0, 3, h);
        g.fillRect(0, h - 3, exitCol * TS, 3); g.fillRect((exitCol + 1) * TS, h - 3, w - (exitCol + 1) * TS, 3);
      }
      groundCache[MAP.id] = cv;
    }
    groundCanvas = groundCache[MAP.id];
    npcs = MAP.npcs.map((n) => ({ ...n }));
  }
  function placePlayer(spot) {
    pl.c = spot.c; pl.r = spot.r; pl.dir = spot.dir; pl.moving = false; pl.t = 0;
  }
  function startWorld() {
    setMap(G.player.map || 'village');
    pl = { c: G.player.c, r: G.player.r, dir: G.player.dir, moving: false, t: 0, tc: 0, tr: 0, walk: 0, turn: 0 };
    mode = 'world';
  }
  // Go through a door: fade out, change map, fade in.
  async function travel(spot) {
    await fadeTo(1, 180);
    setMap(spot.map);
    placePlayer(spot);
    await fadeTo(0, 180);
    save();
  }

  const npcAt = (c, r) => npcs.find((n) => n.c === c && n.r === r);
  function isBlocked(c, r) {
    if (c < 0 || r < 0 || c >= MAP.w || r >= MAP.h) return true;
    return MAP.blocked[r * MAP.w + c] === 1 || !!npcAt(c, r);
  }

  function tryMove(d) {
    const [dx, dy] = DIRS[d];
    const c = pl.c + dx, r = pl.r + dy;
    const door = MAP.warps.get(cellKey(c, r));
    if (door) { run(() => travel(door)); return; }
    if (r >= MAP.h && MAP.id === 'village') {
      run(async () => { await say('เส้นทางข้างหน้ายังไม่เปิดให้ผ่านในเวอร์ชันนี้'); });
      return;
    }
    if (isBlocked(c, r)) return;
    if (MAP.tall.has(cellKey(c, r)) && G.party.length === 0) {
      run(async () => { await say('ในพงหญ้าสูงมีมอนสเตอร์ป่าอาศัยอยู่!\nไปหาศาสตราจารย์ที่ลานกลางหมู่บ้านก่อนดีกว่า'); });
      return;
    }
    pl.tc = c; pl.tr = r; pl.t = 0; pl.moving = true;
  }

  function updateWorld(dt) {
    let arrived = false;
    if (pl.moving) {
      pl.t += dt / STEP; pl.walk += dt;
      if (pl.t >= 1) {
        pl.c = pl.tc; pl.r = pl.tr; pl.moving = false; pl.t = 0; arrived = true;
        onStep();
      }
    }
    if (pl.moving || busy) return;
    const d = held[held.length - 1];
    if (!d) { pl.walk = 0; pl.turn = 0; return; }
    if (pl.dir !== d) { pl.dir = d; pl.turn = arrived ? 0 : 0.09; }
    if (pl.turn > 0) { pl.turn -= dt; return; }
    tryMove(d);
  }

  function onStep() {
    G.steps++;
    if (G.steps % 25 === 0) save();
    const area = MAP.tall.get(cellKey(pl.c, pl.r));
    if (area && G.party.length && Math.random() < ENCOUNTER_CHANCE) run(() => wildEncounter(area));
  }

  function examine() {
    const [dx, dy] = DIRS[pl.dir];
    const c = pl.c + dx, r = pl.r + dy;
    const n = npcAt(c, r);
    if (n) { n.dir = OPPOSITE[pl.dir]; run(SCENES[n.id]); return; }
    const id = MAP.interact.get(cellKey(c, r));
    if (id && SCENES[id]) run(SCENES[id]);
  }

  function playerPixel() {
    const fx = pl.moving ? pl.c + (pl.tc - pl.c) * pl.t : pl.c;
    const fy = pl.moving ? pl.r + (pl.tr - pl.r) * pl.t : pl.r;
    return [fx * TS, fy * TS];
  }

  function drawWorld() {
    const [px, py] = playerPixel();
    // follow the player, stopping at the map's edges; a map smaller than the screen is centred
    const mw = MAP.w * TS, mh = MAP.h * TS;
    const camX = mw <= VW ? Math.round((mw - VW) / 2) : Math.round(Math.max(0, Math.min(mw - VW, px + TS / 2 - VW / 2)));
    const camY = mh <= VH ? Math.round((mh - VH) / 2) : Math.round(Math.max(0, Math.min(mh - VH, py + TS / 2 - VH / 2)));
    b.drawImage(groundCanvas, -camX, -camY);
    const list = [];
    for (const t of MAP.things) {
      if (t.x + t.w < camX || t.x > camX + VW || t.y + t.h < camY || t.y > camY + VH) continue;
      list.push({ sortY: t.sortY, draw: () => b.drawImage(IMG[t.img], t.x - camX, t.y - camY) });
    }
    for (const n of npcs) {
      list.push({ sortY: (n.r + 1) * TS - 1, draw: () => b.drawImage(IMG[n.sheet], 0, DIRS[n.dir][2] * 48, 32, 48,
        n.c * TS - camX, (n.r + 1) * TS - 48 - camY, 32, 48) });
    }
    const frame = pl.moving ? Math.floor(pl.walk / (STEP / 2)) % 4 : 0;
    list.push({ sortY: py + TS - 1, draw: () => b.drawImage(IMG['chars/hero'], frame * 32, DIRS[pl.dir][2] * 48, 32, 48,
      Math.round(px) - camX, Math.round(py) + TS - 48 - camY, 32, 48) });
    list.sort((a, c) => a.sortY - c.sortY);
    for (const e of list) e.draw();
  }

  // ------------------------------------------------------------------ scenes
  async function yesNo(question) {
    ui.prompt = null;
    const p = say(question);
    ui.msg.shown = 9999;
    const pick = await choose(['ใช่', 'ไม่'], { w: 90 });
    ui.msg = null; void p;
    return pick === 0;
  }

  const SCENES = {
    async researcher() {
      if (!G.flags.starter) {
        await say('ยินดีต้อนรับสู่หมู่บ้านต้นกล้า!\nฉันคือศาสตราจารย์สน ศึกษามอนสเตอร์อยู่ที่ศูนย์วิจัยโดมกระจกหลังนี้');
        await say('ออกไปนอกหมู่บ้านโดยไม่มีคู่หูนั้นอันตราย\nเลือกมอนสเตอร์ไปเป็นคู่หูหนึ่งตัวสิ');
        let pick = -1;
        while (pick < 0) {
          const p = say('จะเลือกตัวไหนดี?');
          ui.msg.shown = 9999;
          const i = await choose(STARTERS.map((sp) => ({
            label: SPECIES[sp].name, badge: SPECIES[sp].type })), {
            w: 170, onMove: (k) => { ui.portrait = 'monsters/' + SPECIES[STARTERS[k]].img; } });
          ui.msg = null; void p;
          if (await yesNo('เลือก' + SPECIES[STARTERS[i]].name + ' ธาตุ' + TYPES[SPECIES[STARTERS[i]].type].name + ' ใช่ไหม?')) pick = i;
        }
        ui.portrait = null;
        const sp = STARTERS[pick];
        G.party.push(makeMon(sp, 5));
        noteCaught(sp);
        G.flags.starter = sp;
        G.bag.capsule += 5; G.bag.potion += 3;
        await say('ได้รับ' + SPECIES[sp].name + 'มาเป็นคู่หูแล้ว!');
        await say('นี่แคปซูล 5 ลูกกับยา 3 ขวด\nแคปซูลใช้จับมอนสเตอร์ป่าในพงหญ้าสูงทางใต้ของหมู่บ้าน');
        await say('ทำให้มันอ่อนแรงก่อนจะจับง่ายขึ้นมาก\nลองจับให้ครบทั้ง 6 ชนิดดูนะ');
        save();
        return;
      }
      if (G.caught.length >= 6 && !G.flags.finished) {
        G.flags.finished = true;
        await say('สุดยอดไปเลย! เธอจับมอนสเตอร์ครบทั้ง 6 ชนิดแล้ว');
        await say('ข้อมูลของเธอช่วยงานวิจัยได้มาก ขอบคุณจริง ๆ\nนี่คือจุดสิ้นสุดของเวอร์ชันต้นแบบ แต่ยังเดินเล่นต่อได้นะ');
        save();
        return;
      }
      await say('ตอนนี้เธอจับได้ ' + G.caught.length + ' จาก 6 ชนิด\n' +
        (G.caught.length >= 6 ? 'ครบแล้ว เก่งมาก!' : 'พงหญ้าฝั่งตะวันออกมีชนิดหายากกว่าฝั่งตะวันตกนะ'));
      if (G.lab.length) await say('มอนสเตอร์ที่ฝากไว้ที่ศูนย์วิจัยมี ' + G.lab.length + ' ตัว ฉันดูแลให้อย่างดี');
    },

    async healer() {
      await say('ศูนย์รักษายินดีต้อนรับ ให้ฉันดูแลมอนสเตอร์ของเธอนะ');
      if (!G.party.length) { await say('อ้าว เธอยังไม่มีมอนสเตอร์นี่นา ไปหาศาสตราจารย์สนก่อนสิ'); return; }
      await fadeTo(0.6, 250); healParty(); await wait(350); await fadeTo(0, 250);
      await say('เรียบร้อย! ทุกตัวแข็งแรงเต็มที่แล้ว');
      save();
    },

    async shopkeeper() {
      if (!G.flags.starter) { await say('ร้านต้นกล้ายินดีต้อนรับ!\nพอเธอมีมอนสเตอร์แล้วแวะมารับของแถมมือใหม่ได้นะ'); return; }
      const cap = Math.max(0, 5 - G.bag.capsule), pot = Math.max(0, 3 - G.bag.potion);
      if (!cap && !pot) { await say('ของในกระเป๋าเธอยังเต็มอยู่เลย ใช้หมดแล้วค่อยกลับมาใหม่นะ'); return; }
      G.bag.capsule += cap; G.bag.potion += pot;
      await say('ร้านยังไม่เปิดขายจริงจัง แต่มือใหม่รับของแถมไปได้เลย');
      await say('ได้รับ' + (cap ? 'แคปซูล ' + cap + ' ลูก' : '') + (cap && pot ? ' และ' : '') + (pot ? 'ยา ' + pot + ' ขวด' : '') + '!');
      save();
    },

    async rival() {
      if (!G.flags.starter) { await say('นายยังไม่มีมอนสเตอร์เหรอ?\nไปหาศาสตราจารย์สนที่ลานกลางหมู่บ้านก่อนสิ'); return; }
      if (G.flags.rivalBeaten) { await say('ครั้งหน้าฉันไม่แพ้แน่! ฉันจะไปฝึกในพงหญ้าเพิ่ม'); return; }
      if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของนายหมดแรงหมดแล้ว ไปศูนย์รักษาก่อนเถอะ'); return; }
      await say('ฉันชื่อพายุ! ได้มอนสเตอร์มาจากศาสตราจารย์เหมือนกัน\nมาประลองกันหน่อย!');
      const result = await battle([makeMon(RIVAL_PICK[G.flags.starter], 5)], { name: 'พายุ', img: 'chars/rival_large' });
      if (result === 'win') {
        G.flags.rivalBeaten = true;
        G.bag.capsule += 3;
        await say('แพ้แล้ว... ฝีมือไม่เบานี่!\nเอาแคปซูล 3 ลูกนี่ไป ถือเป็นรางวัล');
        save();
      }
    },

    async sign_village() { await say('หมู่บ้านต้นกล้า\nทิศใต้ : เส้นทางที่ 1 และพงหญ้าสูง'); },
    async sign_grass() { await say('ระวัง! พงหญ้าสูงมีมอนสเตอร์ป่า\nฝั่งตะวันตกเหมาะกับมือใหม่ ฝั่งตะวันออกมีตัวที่แข็งแกร่งกว่า'); },
    async sign_route() { await say('เส้นทางที่ 1\nทางไปเมืองถัดไปอยู่ระหว่างก่อสร้าง'); },
    async well() { await say('น้ำในบ่อใสแจ๋ว มองเห็นก้นบ่อเลย'); },
    // ---- inside the buildings
    async home_bed() {
      if (!(await yesNo('เตียงของคุณเอง จะนอนพักสักครู่ไหม?'))) return;
      await fadeTo(1, 350); healParty(); await wait(500); await fadeTo(0, 350);
      await say(G.party.length ? 'ตื่นมาสดชื่น! มอนสเตอร์ทุกตัวฟื้นพลังเต็มที่แล้ว' : 'ตื่นมาสดชื่น!');
      save();
    },
    async home_books() { await say('ชั้นหนังสือของคุณ มีคู่มือนักฝึกมอนสเตอร์อยู่หลายเล่ม\n"ธาตุน้ำชนะไฟ ไฟชนะพืช พืชชนะน้ำ"'); },
    async home_kitchen() { await say('ครัวสะอาดเอี่ยม ยังมีกลิ่นขนมปังอบใหม่จาง ๆ'); },
    async house_books() { await say('ชั้นหนังสือของเพื่อนบ้าน\n"ธาตุไฟฟ้าได้เปรียบน้ำ แต่แพ้ทางหินกับพืช"'); },
    async house_kitchen() { await say('บนเตามีหม้อซุปที่ยังอุ่นอยู่ เจ้าของบ้านคงออกไปไม่นาน'); },
    async house_bed() { await say('เตียงของเพื่อนบ้าน อย่าไปนอนเลยดีกว่า'); },
    async house_plant() {
      if (G.flags.plant) { await say('ต้นไม้ในกระถางใบเขียวสดดี'); return; }
      G.flags.plant = true; G.bag.potion += 1;
      await say('มีอะไรซ่อนอยู่หลังกระถางต้นไม้...\nพบยา 1 ขวด!');
      save();
    },
    async lab_computer() {
      const names = G.caught.map((sp) => SPECIES[sp].name);
      await say('คอมพิวเตอร์บันทึกข้อมูลมอนสเตอร์\nจับได้แล้ว ' + names.length + ' จาก 6 ชนิด' + (names.length ? ' : ' + names.join(' ') : ''));
      if (G.lab.length) await say('มอนสเตอร์ที่ฝากไว้ที่นี่ ' + G.lab.length + ' ตัว : ' + G.lab.map((m) => nm(m) + ' Lv.' + m.level).join(' '));
    },
    async lab_notes() { await say('บนจอมีบันทึกของศาสตราจารย์สน\n"มอนสเตอร์ที่อ่อนแรงจะจับด้วยแคปซูลได้ง่ายกว่ามาก"'); },
    async lab_tank() { await say('ถังแก้วบรรจุของเหลวสีฟ้าใส มีฟองอากาศลอยขึ้นเป็นระยะ'); },
    async lab_books() { await say('ตำราวิจัยเรียงแน่นเต็มชั้น\n"พงหญ้าฝั่งตะวันออกพบมอนสเตอร์ได้ครบทั้ง 6 ชนิด"'); },
    async lab_table() { await say('โต๊ะทำงานมีแก้วชาที่ดื่มค้างไว้กับกองเอกสาร'); },
    async heal_machine() { await say('เครื่องฟื้นพลังมอนสเตอร์ มีช่องวางแคปซูล 6 ช่อง\nคุยกับพยาบาลที่เคาน์เตอร์เพื่อใช้งาน'); },
    async heal_books() { await say('แผ่นพับของศูนย์รักษา\n"ถ้ามอนสเตอร์หมดแรงทั้งทีม เราจะพากลับมาดูแลที่นี่"'); },
    async shop_shelf() { await say('ชั้นวางสินค้ามีโหลแยม ขวดยา และกล่องแคปซูลเรียงเป็นระเบียบ'); },
    async mill_stone() { await say('หินโม่ขนาดใหญ่หมุนช้า ๆ ตามแรงลม บดเมล็ดข้าวเป็นแป้งละเอียด'); },
    async mill_sacks() {
      if (G.flags.sacks) { await say('กระสอบแป้งกองอยู่มุมห้อง'); return; }
      G.flags.sacks = true; G.bag.capsule += 2;
      await say('มีของตกอยู่ระหว่างกระสอบแป้ง...\nพบแคปซูล 2 ลูก!');
      save();
    },
    async item_crate() {
      if (G.flags.crate) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.crate = true; G.bag.capsule += 3; G.bag.potion += 2;
      await say('เปิดลังไม้ดู...\nพบแคปซูล 3 ลูกและยา 2 ขวด!');
      save();
    },
  };

  async function teamScreen() {
    if (!G.party.length) { await say('ยังไม่มีมอนสเตอร์ในทีม'); return; }
    let at = 0;
    for (;;) {
      const opts = G.party.map((m) => ({
        label: nm(m) + '  Lv.' + m.level, badge: SPECIES[m.sp].type, hp: [m.hp, stats(m).hp] }));
      const i = await choose(opts, {
        x: 50, y: 30, w: 380, rowH: 30, cancellable: true, start: at,
        title: 'ทีมมอนสเตอร์',
        footer: 'แคปซูล ' + G.bag.capsule + '   ยา ' + G.bag.potion + '   จับได้ ' + G.caught.length + '/6 ชนิด' });
      if (i < 0) break;
      at = 0;
      if (i > 0) {
        const m = G.party.splice(i, 1)[0];
        G.party.unshift(m);
        await say(nm(m) + 'ขึ้นมาเป็นตัวนำทีมแล้ว');
      } else await say(nm(G.party[0]) + 'เป็นตัวนำทีมอยู่แล้ว\nเลือกตัวอื่นเพื่อสลับขึ้นมานำได้');
    }
    save();
  }

  function pickWild(area) {
    const e = ENCOUNTERS[area];
    let roll = Math.random() * e.table.reduce((n, x) => n + x[1], 0);
    let sp = e.table[0][0];
    for (const [s, w] of e.table) { if (roll < w) { sp = s; break; } roll -= w; }
    return makeMon(sp, e.levels[0] + rand(e.levels[1] - e.levels[0] + 1));
  }
  async function wildEncounter(area) {
    await battle([pickWild(area)], null);
  }

  // ------------------------------------------------------------------ battle
  const SPOT = { me: { x: 153, y: 204 }, foe: { x: 372, y: 146 } };   // where each monster's feet stand

  function typeMult(moveType, defType) {
    const row = TYPE_CHART[moveType];
    return row && row[defType] !== undefined ? row[defType] : 1;
  }
  function damage(att, def, mv) {
    const A = stats(att).atk, D = stats(def).def;
    const base = Math.floor(((2 * att.level / 5 + 2) * mv.power * A / D) / 50) + 2;
    const stab = SPECIES[att.sp].type === mv.type ? 1.25 : 1;
    const eff = typeMult(mv.type, SPECIES[def.sp].type);
    return { dmg: Math.max(1, Math.floor(base * stab * eff * (0.85 + Math.random() * 0.15))), eff };
  }

  async function battle(foes, trainer) {
    const lead = G.party.find((m) => m.hp > 0);
    if (!lead) return 'lose';
    // screen flash, then cut to the battle
    for (let i = 0; i < 2; i++) { await tween(90, (t) => { ui.flash = t; }); await tween(90, (t) => { ui.flash = 1 - t; }); }
    await fadeTo(1, 220);
    bt = {
      me: lead, foe: foes[0], foes, trainer,
      hp: { me: lead.hp, foe: foes[0].hp },
      spr: { me: { dx: -220, dy: 0, alpha: 1, blink: false }, foe: { dx: 220, dy: 0, alpha: 1, blink: false } },
      trainerX: trainer ? 0 : null, capsule: null, showMe: true, showFoe: !trainer,
    };
    mode = 'battle';
    const foeName = () => trainer ? nm(bt.foe) + 'ของ' + trainer.name : nm(bt.foe) + 'ป่า';
    await fadeTo(0, 220);
    let result = null;

    if (trainer) {
      await say(trainer.name + 'ท้าประลอง!');
      await tween(260, (t) => { bt.trainerX = 200 * t; });
      bt.trainerX = null; bt.showFoe = true;
      tween(260, (t) => { bt.spr.foe.dx = 220 * (1 - t); });
      await say(trainer.name + 'ส่ง' + nm(bt.foe) + 'ออกมา!');
    } else {
      await tween(300, (t) => { bt.spr.foe.dx = 220 * (1 - t); });
      await say(nm(bt.foe) + 'ป่าปรากฏตัว!');
      noteSeen();
    }
    tween(260, (t) => { bt.spr.me.dx = -220 * (1 - t); });
    await say('ลุยเลย ' + nm(bt.me) + '!');

    async function useMove(side, mvId) {
      const other = side === 'me' ? 'foe' : 'me';
      const att = bt[side], def = bt[other], mv = MOVES[mvId];
      await say((side === 'me' ? nm(att) : foeName()) + 'ใช้ท่า' + mv.name + '!');
      const dir = side === 'me' ? 1 : -1, s = bt.spr[side];
      await tween(110, (t) => { s.dx = dir * 20 * t; s.dy = -dir * 9 * t; });
      await tween(110, (t) => { s.dx = dir * 20 * (1 - t); s.dy = -dir * 9 * (1 - t); });
      const { dmg, eff } = damage(att, def, mv);
      await tween(360, (t) => { bt.spr[other].blink = Math.floor(t * 6) % 2 === 0; });
      bt.spr[other].blink = false;
      const from = def.hp;
      def.hp = Math.max(0, def.hp - dmg);
      await tween(350, (t) => { bt.hp[other] = from + (def.hp - from) * t; });
      if (eff > 1) await say('ได้ผลดีเยี่ยม!'); else if (eff < 1) await say('ไม่ค่อยได้ผล...');
    }
    async function faint(side) {
      const s = bt.spr[side];
      await tween(420, (t) => { s.dy = 46 * t; s.alpha = 1 - t; });
      await say((side === 'me' ? nm(bt.me) : foeName()) + 'หมดแรง!');
    }
    async function gainExp(m, amount) {
      m.exp += amount;
      await say(nm(m) + 'ได้รับค่าประสบการณ์ ' + amount + ' แต้ม');
      while (m.level < 50 && m.exp >= expAt(m.level + 1)) {
        const before = stats(m).hp;
        m.level++;
        m.hp += stats(m).hp - before;
        bt.hp.me = m.hp;
        await say(nm(m) + 'เลเวลอัปเป็น Lv.' + m.level + '!');
        for (const [lv, mv] of SPECIES[m.sp].moves) {
          if (lv === m.level && !m.moves.includes(mv)) {
            m.moves.push(mv);
            if (m.moves.length > 4) m.moves.shift();
            await say(nm(m) + 'เรียนรู้ท่า' + MOVES[mv].name + '!');
          }
        }
      }
    }
    // After my monster falls: bring in the next one, or lose. Returns false when the battle is lost.
    async function afterMyFaint() {
      await faint('me');
      const next = G.party.find((m) => m.hp > 0);
      if (!next) return false;
      bt.me = next; bt.hp.me = next.hp;
      bt.spr.me = { dx: -220, dy: 0, alpha: 1, blink: false };
      tween(260, (t) => { bt.spr.me.dx = -220 * (1 - t); });
      await say('สู้ต่อนะ ' + nm(next) + '!');
      return true;
    }
    // After the foe falls. Returns true when the battle is won.
    async function afterFoeFaint() {
      await faint('foe');
      await gainExp(bt.me, Math.floor(50 * bt.foe.level / 5 * (trainer ? 1.5 : 1)));
      const next = bt.foes.find((m) => m.hp > 0);
      if (!next) return true;
      bt.foe = next; bt.hp.foe = next.hp;
      bt.spr.foe = { dx: 220, dy: 0, alpha: 1, blink: false };
      tween(260, (t) => { bt.spr.foe.dx = 220 * (1 - t); });
      await say(trainer.name + 'ส่ง' + nm(next) + 'ออกมา!');
      return false;
    }
    async function foeTurn() {
      await useMove('foe', bt.foe.moves[rand(bt.foe.moves.length)]);
      if (bt.me.hp <= 0 && !(await afterMyFaint())) result = 'lose';
    }

    while (!result) {
      ui.prompt = nm(bt.me) + 'จะทำอะไรดี?';
      const act = await choose([
        'ต่อสู้', { label: 'แคปซูล', right: 'x' + G.bag.capsule },
        { label: 'ยา', right: 'x' + G.bag.potion }, 'หนี'], { x: 262, y: 236, w: 214, cols: 2, rowH: 33, start: bt.lastAct || 0 });
      bt.lastAct = act;
      ui.prompt = null;

      if (act === 0) {
        const i = await choose(bt.me.moves.map((id) => ({
          label: MOVES[id].name, badge: MOVES[id].type, right: String(MOVES[id].power) })), {
          x: 4, y: 236, w: 472, cols: 2, rowH: 33, minH: 80, cancellable: true });
        if (i < 0) continue;
        const mine = bt.me.moves[i], theirs = bt.foe.moves[rand(bt.foe.moves.length)];
        const ms = stats(bt.me).spd, fs = stats(bt.foe).spd;
        const first = ms > fs || (ms === fs && Math.random() < 0.5) ? 'me' : 'foe';
        for (const side of first === 'me' ? ['me', 'foe'] : ['foe', 'me']) {
          await useMove(side, side === 'me' ? mine : theirs);
          if (bt.foe.hp <= 0) { if (await afterFoeFaint()) result = 'win'; break; }
          if (bt.me.hp <= 0) { if (!(await afterMyFaint())) result = 'lose'; break; }
        }
      } else if (act === 1) {
        if (trainer) { await say('ใช้แคปซูลกับมอนสเตอร์ที่มีเจ้าของแล้วไม่ได้!'); continue; }
        if (G.bag.capsule <= 0) { await say('แคปซูลหมดแล้ว!'); continue; }
        G.bag.capsule--;
        await say('โยนแคปซูลออกไป!');
        const from = { x: SPOT.me.x + 30, y: SPOT.me.y - 90 }, to = { x: SPOT.foe.x, y: SPOT.foe.y - 70 };
        bt.capsule = { x: from.x, y: from.y };
        await tween(420, (t) => { bt.capsule.x = from.x + (to.x - from.x) * t; bt.capsule.y = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 60; });
        await tween(220, (t) => { bt.spr.foe.alpha = 1 - t; });
        await tween(260, (t) => { bt.capsule.y = to.y + (SPOT.foe.y - 12 - to.y) * t * t; });
        const chance = 0.6 * (1 - 0.66 * bt.foe.hp / stats(bt.foe).hp);
        const caught = Math.random() < chance;
        const shakes = caught ? 3 : rand(3);
        for (let i = 0; i < shakes; i++) {
          await wait(260);
          await tween(260, (t) => { bt.capsule.x = to.x + Math.sin(t * Math.PI * 2) * 5; });
        }
        await wait(260);
        if (caught) {
          await say('จับ' + nm(bt.foe) + 'ได้แล้ว!');
          noteCaught(bt.foe.sp);
          if (G.party.length < PARTY_MAX) G.party.push(bt.foe);
          else { G.lab.push(bt.foe); await say('ทีมเต็มแล้ว ' + nm(bt.foe) + 'ถูกส่งไปฝากไว้ที่ศูนย์วิจัย'); }
          result = 'caught';
        } else {
          bt.capsule = null;
          await tween(200, (t) => { bt.spr.foe.alpha = t; });
          await say('โธ่ มันหลุดออกมาได้!');
          await foeTurn();
        }
      } else if (act === 2) {
        if (G.bag.potion <= 0) { await say('ยาหมดแล้ว!'); continue; }
        const max = stats(bt.me).hp;
        if (bt.me.hp >= max) { await say(nm(bt.me) + 'ยังแข็งแรงเต็มที่อยู่'); continue; }
        G.bag.potion--;
        const from = bt.me.hp;
        bt.me.hp = Math.min(max, bt.me.hp + 20);
        await say('ใช้ยากับ' + nm(bt.me));
        await tween(350, (t) => { bt.hp.me = from + (bt.me.hp - from) * t; });
        await say('พลังชีวิตฟื้นขึ้น ' + (bt.me.hp - from) + ' แต้ม');
        await foeTurn();
      } else {
        if (trainer) { await say('หนีจากการประลองไม่ได้!'); continue; }
        if (Math.random() < (stats(bt.me).spd >= stats(bt.foe).spd ? 0.95 : 0.6)) { await say('หนีออกมาได้อย่างปลอดภัย'); result = 'run'; }
        else { await say('หนีไม่พ้น!'); await foeTurn(); }
      }
    }

    if (result === 'win' && trainer) await say('ชนะ' + trainer.name + 'แล้ว!');
    if (result === 'lose') await say('ไม่มีมอนสเตอร์ที่สู้ไหวแล้ว...\nคุณรีบพามอนสเตอร์กลับไปที่ศูนย์รักษา');
    await fadeTo(1, 240);
    bt = null; mode = 'world';
    if (result === 'lose') {
      healParty();
      setMap(HEAL_SPOT.map);
      placePlayer(HEAL_SPOT);
    }
    save();
    await fadeTo(0, 240);
    if (result === 'lose') await say('พยาบาลช่วยฟื้นพลังให้มอนสเตอร์ทุกตัวแล้ว');
    return result;
  }
  function noteSeen() { /* reserved for a monster journal */ }

  function drawBattle() {
    b.drawImage(IMG.battle_bg, 0, 0);
    const mon = (side, m, back) => {
      const s = bt.spr[side];
      if (s.blink || s.alpha <= 0) return;
      b.globalAlpha = Math.max(0, Math.min(1, s.alpha));
      b.drawImage(IMG['monsters/' + SPECIES[m.sp].img + (back ? '_back' : '')],
        Math.round(SPOT[side].x - 64 + s.dx), Math.round(SPOT[side].y - 128 + s.dy), 128, 128);
      b.globalAlpha = 1;
    };
    if (bt.trainerX !== null) b.drawImage(IMG[bt.trainer.img], Math.round(SPOT.foe.x - 80 + bt.trainerX), SPOT.foe.y - 150, 160, 160);
    if (bt.showFoe) mon('foe', bt.foe, false);
    if (bt.capsule) {
      const x = Math.round(bt.capsule.x), y = Math.round(bt.capsule.y);
      b.fillStyle = '#3a2f2a'; b.fillRect(x - 6, y - 6, 12, 12);
      b.fillStyle = '#f2c14e'; b.fillRect(x - 5, y - 5, 10, 5);
      b.fillStyle = '#fbf7e9'; b.fillRect(x - 5, y + 1, 10, 4);
      b.fillStyle = '#3a2f2a'; b.fillRect(x - 5, y - 1, 10, 2); b.fillRect(x - 2, y - 2, 4, 4);
      b.fillStyle = '#fbf7e9'; b.fillRect(x - 1, y - 1, 2, 2);
    }
    mon('me', bt.me, true);
  }

  // -------------------------------------------------------------- UI drawing
  function box(x, y, w, h) {
    ctx.fillStyle = '#3a2f2a';
    roundRect(x, y, w, h, 6); ctx.fill();
    ctx.fillStyle = '#fbf7e9';
    roundRect(x + 2, y + 2, w - 4, h - 4, 4); ctx.fill();
    ctx.strokeStyle = '#d9cfae'; ctx.lineWidth = 1;
    roundRect(x + 4.5, y + 4.5, w - 9, h - 9, 3); ctx.stroke();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function text(str, x, y, px, color, align, bold) {
    setFont(px || 13, bold);
    ctx.fillStyle = color || '#2b2420';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x, y);
  }
  function hpBar(x, y, w, cur, max) {
    const f = Math.max(0, Math.min(1, cur / max));
    ctx.fillStyle = '#3a2f2a'; roundRect(x, y, w, 7, 3); ctx.fill();
    ctx.fillStyle = '#d6cdb4'; roundRect(x + 1, y + 1, w - 2, 5, 2); ctx.fill();
    if (f > 0) {
      ctx.fillStyle = f > 0.5 ? '#3fa648' : f > 0.2 ? '#d9a514' : '#d8483a';
      roundRect(x + 1, y + 1, Math.max(2, (w - 2) * f), 5, 2); ctx.fill();
    }
  }
  function badge(type, x, y) {
    const t = TYPES[type];
    setFont(10, true);
    const w = Math.ceil(ctx.measureText(t.name).width) + 10;
    ctx.fillStyle = t.color; roundRect(x, y - 10, w, 14, 4); ctx.fill();
    text(t.name, x + 5, y + 1, 10, '#ffffff', 'left', true);
    return w;
  }

  function drawMenu(m) {
    box(m.x, m.y, m.w, m.h);
    if (m.title) text(m.title, m.x + 14, m.y + 22, 13, '#2b2420', 'left', true);
    const cellW = (m.w - 16) / m.cols;
    m.opts.forEach((o, i) => {
      const cx = m.x + 8 + (i % m.cols) * cellW;
      const cy = m.y + 7 + m.titleH + Math.floor(i / m.cols) * m.rowH;
      const mid = cy + m.rowH / 2 + 5;
      if (i === m.index) {
        ctx.fillStyle = '#efe6c8'; roundRect(cx + 1, cy + 1, cellW - 2, m.rowH - 2, 4); ctx.fill();
        text('▶', cx + 5, mid - 1, 9, '#c0442f');
      }
      text(o.label, cx + 18, mid, 13, o.disabled ? '#a39c8c' : '#2b2420');
      let right = cx + cellW - 8;
      if (o.hp) {
        text(Math.ceil(o.hp[0]) + '/' + o.hp[1], right, mid, 11, '#5a5048', 'right');
        hpBar(right - 150, mid - 8, 96, o.hp[0], o.hp[1]);
        right -= 158;
      }
      if (o.right) { text(o.right, right, mid, 11, '#5a5048', 'right'); setFont(11); right -= ctx.measureText(o.right).width + 6; }
      if (o.badge) {
        setFont(13);
        const lx = cx + 18 + ctx.measureText(o.label).width + 8;
        badge(o.badge, lx, mid - 2);
      }
    });
    if (m.footer) text(m.footer, m.x + 14, m.y + m.h - 10, 11, '#5a5048');
  }

  function drawMessage(m) {
    const page = m.pages[m.page];
    let left = Math.floor(m.shown);
    page.forEach((line, i) => {
      if (left <= 0) return;
      text(line.slice(0, left).join(''), 20, 259 + i * 19, 13);
      left -= line.length;
    });
    if (m.shown >= pageLength(page) && !ui.menu && Math.floor(clock * 2.5) % 2 === 0) text('▼', 458, 304, 9, '#c0442f', 'right');
  }

  function drawHud() {
    // foe: top left
    box(12, 12, 198, 42);
    text(nm(bt.foe), 24, 31, 13, '#2b2420', 'left', true);
    text('Lv.' + bt.foe.level, 198, 31, 11, '#5a5048', 'right');
    text('HP', 24, 45, 9, '#c0442f', 'left', true);
    hpBar(42, 38, 156, bt.hp.foe, stats(bt.foe).hp);
    // mine: right, above the text box
    const max = stats(bt.me).hp;
    box(270, 172, 198, 58);
    text(nm(bt.me), 282, 191, 13, '#2b2420', 'left', true);
    text('Lv.' + bt.me.level, 456, 191, 11, '#5a5048', 'right');
    text('HP', 282, 205, 9, '#c0442f', 'left', true);
    hpBar(300, 198, 156, bt.hp.me, max);
    text(Math.ceil(bt.hp.me) + ' / ' + max, 456, 221, 11, '#5a5048', 'right');
    const lo = expAt(bt.me.level), hi = expAt(bt.me.level + 1);
    ctx.fillStyle = '#d6cdb4'; ctx.fillRect(282, 216, 110, 3);
    ctx.fillStyle = '#4a8fd8'; ctx.fillRect(282, 216, 110 * Math.max(0, Math.min(1, (bt.me.exp - lo) / (hi - lo))), 3);
  }

  function drawTitle() {
    b.drawImage(IMG.battle_bg, 0, 0);
    b.fillStyle = 'rgba(20,30,40,0.35)'; b.fillRect(0, 0, VW, VH);
    b.drawImage(IMG['monsters/starter_fire_lamb'], 62, 150, 128, 128);
    b.drawImage(IMG['monsters/starter_water_narwhal'], 176, 134, 128, 128);
    b.drawImage(IMG['monsters/starter_leaf_pangolin'], 292, 150, 128, 128);
  }
  function drawTitleText() {
    ctx.lineJoin = 'round';
    setFont(30, true); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = '#2b2420'; ctx.lineWidth = 6; ctx.strokeText('นักสะสมมอนสเตอร์', 240, 64);
    ctx.fillStyle = '#fff3c4'; ctx.fillText('นักสะสมมอนสเตอร์', 240, 64);
    setFont(16, true);
    ctx.lineWidth = 4; ctx.strokeText('หมู่บ้านต้นกล้า', 240, 92);
    ctx.fillStyle = '#ffffff'; ctx.fillText('หมู่บ้านต้นกล้า', 240, 92);
  }

  function drawUI() {
    if (mode === 'title') drawTitleText();
    if (mode === 'battle' && bt) drawHud();
    if (ui.portrait) {
      box(VW - 8 - 104, 30, 104, 104);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(IMG[ui.portrait], VW - 8 - 100, 34, 96, 96);
    }
    if (ui.msg || ui.prompt || mode === 'battle') box(4, 236, 472, 80);
    if (ui.prompt && !ui.msg) wrap(ui.prompt, 230, 13).forEach((l, i) => text(l, 20, 259 + i * 19, 13));
    if (ui.msg) drawMessage(ui.msg);
    if (ui.menu) drawMenu(ui.menu);
    if (ui.fade > 0) { ctx.fillStyle = 'rgba(0,0,0,' + ui.fade + ')'; ctx.fillRect(0, 0, VW, VH); }
    if (ui.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + ui.flash + ')'; ctx.fillRect(0, 0, VW, VH); }
  }

  // --------------------------------------------------------------- main loop
  let last = 0;
  function tick(dt) {
    clock += dt;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      tw.t = Math.min(1, tw.t + dt * 1000 / tw.ms);
      if (tw.fn) tw.fn(tw.t);
      if (tw.t >= 1) { tweens.splice(i, 1); tw.resolve(); }
    }
    if (ui.msg) ui.msg.shown += dt * 48;
    if (mode === 'world') updateWorld(dt);
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    tick(dt);
    render();
    requestAnimationFrame(frame);
  }
  function render() {
    b.fillStyle = '#000'; b.fillRect(0, 0, VW, VH);
    if (mode === 'world') drawWorld(); else if (mode === 'battle' && bt) drawBattle(); else if (mode === 'title') drawTitle();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    if (mode === 'loading') text('กำลังโหลด...', 240, 164, 14, '#ffffff', 'center');
    else drawUI();
  }

  async function title() {
    mode = 'title';
    const saved = loadSave();
    const i = await choose(saved ? ['เล่นต่อ', 'เริ่มเกมใหม่'] : ['เริ่มเกมใหม่'], { x: 165, y: 258, w: 150, rowH: 22 });
    await fadeTo(1, 250);
    if (saved && i === 0) G = saved; else newGame();
    startWorld();
    await fadeTo(0, 250);
    if (!G.flags.intro) {
      G.flags.intro = true;
      await run(async () => {
        await say('เช้าวันใหม่ที่หมู่บ้านต้นกล้า\nวันนี้ศาสตราจารย์สนนัดให้ไปพบที่ลานกลางหมู่บ้าน');
        await say('เดินตามทางดินไปทางขวา แล้วคุยกับศาสตราจารย์ด้วยปุ่ม Z');
      });
    }
  }

  async function boot() {
    resize();
    requestAnimationFrame(frame);
    MAPS = buildMaps();
    try { await Promise.all(allImages().map(loadImage)); }
    catch (e) { console.error(e); document.getElementById('hint').textContent = e.message; return; }
    await title();
  }
  window.addEventListener('beforeunload', () => { if (mode === 'world' && !busy) save(); });

  // for testing from the browser console
  window.GAME = {
    get state() { return { mode, busy, G, pl, bt, msg: ui.msg ? ui.msg.pages.map((p) => p.map((l) => l.join('')).join('\n')).join('\n') : null,
      menu: ui.menu ? { index: ui.menu.index, opts: ui.menu.opts.map((o) => o.label) } : null, prompt: ui.prompt }; },
    press, map: () => MAP, maps: () => MAPS,
    warp(c, r, mapId) { if (mapId) setMap(mapId); pl.c = c; pl.r = r; pl.moving = false; },
    hold(dir, on) { const i = held.indexOf(dir); if (on && i < 0) held.push(dir); if (!on && i >= 0) held.splice(i, 1); },
    // run the game for a number of seconds without waiting for the screen to refresh
    async advance(seconds) {
      const turn = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
      for (let t = 0; t < seconds; t += 1 / 60) { tick(1 / 60); await turn(); }
      render();
    },
  };

  boot();
})();
