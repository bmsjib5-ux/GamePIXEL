'use strict';
// Engine, user interface, overworld and battles.
(() => {
  // Logical screen size in pixels. Menus, messages and battles are laid out in a 480x320
  // picture (the "band"). Held upright, a phone shows a taller screen: the map fills all of
  // it, and the band sits inside it above the on-screen buttons.
  const VW = 480, BAND = 320;
  let VH = BAND;                       // full height of the logical screen
  let PADH = 0;                        // part of that height lying under the on-screen buttons
  const STEP = 0.19;                   // seconds to walk one tile
  // "?test" in the address keeps test runs in a save slot of their own
  const SAVE_KEY = 'sprout_village_save_v1' + (location.search.includes('test') ? '_test' : '');
  const FONT = '"Leelawadee UI","Noto Sans Thai",Tahoma,sans-serif';
  const DIRS = { down: [0, 1, 0], left: [-1, 0, 1], right: [1, 0, 2], up: [0, -1, 3] }; // dx, dy, sheet row
  const OPPOSITE = { down: 'up', up: 'down', left: 'right', right: 'left' };

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const buf = document.createElement('canvas');   // low-resolution picture, scaled up with hard pixels
  buf.width = VW; buf.height = BAND;
  const b = buf.getContext('2d');
  let S = 2;                                      // screen pixels per logical pixel

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const hint = document.getElementById('hint');
    const touch = document.body.classList.contains('touch');
    const portrait = window.innerHeight > window.innerWidth;
    let availH = window.innerHeight;
    if (touch && portrait) availH -= 210;                    // room for the on-screen buttons below
    else if (hint && hint.offsetHeight) availH -= hint.offsetHeight + 12;
    const full = touch && portrait;      // upright phone: use the whole screen
    document.body.classList.toggle('fullview', full);
    if (full) {
      const cssPerPixel = window.innerWidth / VW;
      VH = Math.max(BAND, Math.round(window.innerHeight / cssPerPixel));
      PADH = Math.min(VH - BAND, Math.round(188 / cssPerPixel));   // the buttons take about 188 css px
      S = window.innerWidth * dpr / VW;
      canvas.width = Math.round(VW * S); canvas.height = Math.round(VH * S);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
    } else {
      VH = BAND; PADH = 0;
      const fit = Math.min(window.innerWidth * dpr / VW, availH * dpr / VH);
      // Whole-number scaling keeps every pixel the same size. On sharp (high-dpi) screens the
      // pixels are too small for that to matter, so fill the space instead.
      S = dpr >= 2 && fit >= 1.5 ? fit : Math.max(1, Math.floor(fit));
      canvas.width = Math.round(VW * S); canvas.height = Math.round(VH * S);
      canvas.style.width = (canvas.width / dpr) + 'px';
      canvas.style.height = (canvas.height / dpr) + 'px';
    }
    if (buf.height !== VH) buf.height = VH;
  }
  // Where the 480x320 band starts on a tall screen: just above the buttons while walking
  // (so messages are near the thumbs), centred in the free space for battles and the title.
  function uiTop() {
    const free = VH - PADH;
    if (free <= BAND) return 0;
    return mode === 'world' ? free - BAND - 4 : Math.round((free - BAND) / 2);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

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
      'chars/npc_shopkeeper', 'chars/npc_healer', 'chars/rival_large',
      'chars/npc_gym_leader', 'chars/npc_gym_hiker', 'chars/npc_gym_kid'];
    for (const n of Object.keys(SPRITE_META.objects)) names.push('objects/' + n);
    for (const n of Object.keys(SPRITE_META.buildings)) names.push('buildings/' + n);
    for (const n of Object.keys(SPRITE_META.furniture)) names.push('furniture/' + n);
    for (const sp of Object.values(SPECIES)) {
      names.push('monsters/' + sp.img);
      if (!sp.frontOnly) names.push('monsters/' + sp.img + '_back');
    }
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
  const held = [];             // directions currently held: {src, dir}, most recent last
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
    m.moves = m.moves.slice(-MAX_MOVES);
    m.hp = stats(m).hp;
    return m;
  }
  function healParty() { for (const m of G.party) m.hp = stats(m).hp; }
  function typeMult(moveType, defType) {
    const row = TYPE_CHART[moveType];
    return row && row[defType] !== undefined ? row[defType] : 1;
  }
  // types this type hits hard / hits weakly / is hit hard by / shrugs off
  const typeLinks = (type) => {
    const all = Object.keys(TYPES).filter((t) => !TYPES[t].hidden);
    return { beats: all.filter((d) => typeMult(type, d) > 1), weakTo: all.filter((a) => typeMult(a, type) > 1),
             resists: all.filter((a) => typeMult(a, type) < 1) };
  };
  // A move as a menu line; against a foe it also says whether the type match-up helps.
  function moveOption(id, foe) {
    const mv = MOVES[id];
    const eff = foe ? typeMult(mv.type, SPECIES[foe.sp].type) : 1;
    return { label: mv.name, badge: mv.type,
             sub: 'พลัง ' + mv.power + (eff > 1 ? '  ▲ ได้เปรียบธาตุ' : eff < 1 ? '  ▼ เสียเปรียบธาตุ' : ''),
             subColor: eff > 1 ? '#2f8a3a' : eff < 1 ? '#c0442f' : '#5a5048' };
  }
  function anyKey() { return new Promise((resolve) => { ui.wait = resolve; }); }
  function noteCaught(sp) { if (!G.caught.includes(sp)) G.caught.push(sp); }
  // the collecting goal counts the six basic species only, not their evolved forms
  const goalCaught = () => GOAL_SPECIES.filter((sp) => G.caught.includes(sp));

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
  // Three ways to play: keyboard, on-screen touch buttons, gamepad. Each one holds
  // directions under its own name so releasing one never cancels another.
  function holdDir(src, dir, on) {
    const i = held.findIndex((h) => h.src === src && h.dir === dir);
    if (on && i < 0) held.push({ src, dir });
    if (!on && i >= 0) held.splice(i, 1);
  }
  const heldDir = () => (held.length ? held[held.length - 1].dir : null);

  const HINTS = {
    keys: '<b>ลูกศร / WASD</b> เดิน &nbsp;·&nbsp; <b>Z / Enter / Space</b> ตกลง คุย สำรวจ &nbsp;·&nbsp; <b>X / Esc</b> เมนูทีม ยกเลิก',
    pad: '<b>ปุ่มทิศทาง / ก้านซ้าย</b> เดิน &nbsp;·&nbsp; <b>A</b> ตกลง คุย สำรวจ &nbsp;·&nbsp; <b>B / X / Y / Start</b> เมนูทีม ยกเลิก',
    touch: '',
  };
  let inputMode = '';
  function setInputMode(m) {           // show the help line and buttons that fit how the player is playing
    if (m === inputMode) return;
    inputMode = m;
    document.body.classList.toggle('touch', m === 'touch');
    const hint = document.getElementById('hint');
    if (hint) hint.innerHTML = HINTS[m];
    resize();
  }

  window.addEventListener('keydown', (ev) => {
    const k = KEYMAP[ev.key];
    if (!k) return;
    ev.preventDefault();
    setInputMode('keys');
    if (DIRS[k]) holdDir('key', k, true);
    if (ev.repeat && !DIRS[k]) return;
    press(k, ev.repeat);
  });
  window.addEventListener('keyup', (ev) => {
    const k = KEYMAP[ev.key];
    if (k) holdDir('key', k, false);
  });
  window.addEventListener('blur', () => { held.length = 0; pad.dir = null; stick.dir = null; });

  // A direction held on the touch pad or a gamepad. Unlike a keyboard these do not
  // repeat by themselves, so menus get their own repeat while the direction is held.
  const pad = { dir: null, t: 0 }, stick = { dir: null, t: 0 };
  function setVirtualDir(src, state, dir) {
    if (state.dir === dir) return;
    if (state.dir) holdDir(src, state.dir, false);
    state.dir = dir; state.t = 0;
    if (dir) { holdDir(src, dir, true); press(dir, false); }
  }
  function updateVirtual(dt) {
    for (const state of [pad, stick]) {
      if (!state.dir) continue;
      state.t += dt;
      if (state.t > 0.36) { state.t -= 0.13; press(state.dir, true); }
    }
  }

  // ---- gamepad (standard layout: Xbox-style pads, handheld PCs such as the Legion Go S)
  let padButtons = { ok: false, back: false };
  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) { setVirtualDir('stick', stick, null); return; }
    const down = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    let dir = null;
    if (down(12)) dir = 'up'; else if (down(13)) dir = 'down';
    else if (down(14)) dir = 'left'; else if (down(15)) dir = 'right';
    else if (Math.abs(ax) > 0.5 || Math.abs(ay) > 0.5) {
      dir = Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? 'left' : 'right') : (ay < 0 ? 'up' : 'down');
    }
    const now = { ok: down(0), back: down(1) || down(2) || down(3) || down(9) };
    if (dir || now.ok || now.back) setInputMode('pad');
    setVirtualDir('stick', stick, dir);
    if (now.ok && !padButtons.ok) press('ok', false);
    if (now.back && !padButtons.back) press('back', false);
    padButtons = now;
  }

  // ---- touch: on-screen direction pad and buttons, and tapping the picture itself
  function setupTouch() {
    const dpad = document.getElementById('dpad');
    const dirAt = (ev) => {
      const r = dpad.getBoundingClientRect();
      const dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < r.width * 0.12) return null;          // dead centre
      return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    };
    const show = (dir) => { dpad.dataset.dir = dir || ''; };
    let finger = null;
    dpad.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      finger = ev.pointerId;
      try { dpad.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
      const d = dirAt(ev); show(d); setVirtualDir('pad', pad, d);
    });
    dpad.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== finger) return;
      const d = dirAt(ev); show(d); setVirtualDir('pad', pad, d);
    });
    const lift = (ev) => { if (ev.pointerId === finger) { finger = null; show(null); setVirtualDir('pad', pad, null); } };
    dpad.addEventListener('pointerup', lift);
    dpad.addEventListener('pointercancel', lift);

    for (const [id, key] of [['btnA', 'ok'], ['btnB', 'back']]) {
      const el = document.getElementById(id);
      el.addEventListener('pointerdown', (ev) => { ev.preventDefault(); el.classList.add('down'); press(key, false); });
      for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, () => el.classList.remove('down'));
    }
    document.getElementById('btnFull').addEventListener('click', () => {
      const d = document;
      if (d.fullscreenElement) { d.exitFullscreen(); return; }
      const go = d.documentElement.requestFullscreen && d.documentElement.requestFullscreen();
      if (go && go.then) go.then(() => { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); }).catch(() => {});
    });

    // Tapping the picture: choose the menu item under the finger, otherwise act as the confirm button.
    canvas.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const r = canvas.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width * VW, y = (ev.clientY - r.top) / r.height * VH - uiTop();
      const m = ui.menu;
      if (!m) { press('ok', false); return; }
      const cellW = (m.w - 16) / m.cols;
      const col = Math.floor((x - m.x - 8) / cellW), row = Math.floor((y - m.y - 7 - m.titleH) / m.rowH);
      const i = row * m.cols + col;
      const inside = x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h;
      if (inside && col >= 0 && col < m.cols && row >= 0 && i < m.opts.length) {
        if (i !== m.index) { m.index = i; if (m.onMove) m.onMove(i); }
        press('ok', false);
      } else if (!inside && m.cancellable) press('back', false);
    });
    // any finger on the screen brings the touch buttons up
    window.addEventListener('pointerdown', (ev) => { if (ev.pointerType === 'touch') setInputMode('touch'); }, true);
    document.addEventListener('contextmenu', (ev) => ev.preventDefault());
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    setInputMode(coarse ? 'touch' : 'keys');
  }

  function press(k, repeat) {
    if (ui.wait && !ui.menu) {            // an information panel is open: confirm or cancel closes it
      if (!repeat && (k === 'ok' || k === 'back')) { const done = ui.wait; ui.wait = null; done(); }
      return;
    }
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
    npcs = MAP.npcs.filter((n) => !(n.hideIf && G.flags[n.hideIf]))
      .map((n) => (n.moved && G.flags[n.moved.flag] ? { ...n, c: n.moved.c, r: n.moved.r, dir: n.moved.dir } : { ...n }));
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
    if (MAP.title) ui.banner = { text: MAP.title, t: 0 };
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
    if (c < 0 || r < 0 || c >= MAP.w || r >= MAP.h) {        // walking off the map: an exit, or nothing
      const exit = MAP.exits.find((e) => e.side === d && pl.c >= e.c0 && pl.c <= e.c1);
      if (!exit) return;
      if (exit.need && !G.flags[exit.need]) run(async () => { await say(exit.lockedText); });
      else if (!exit.to) run(async () => { await say(exit.soonText || exit.lockedText); });
      else run(() => travel({ map: exit.to.map, c: pl.c + exit.to.dc, r: exit.to.r, dir: d }));
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
    const d = heldDir();
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
    const free = VH - PADH;
    const camY = mh <= free ? Math.round((mh - free) / 2) : Math.round(Math.max(0, Math.min(mh - free, py + TS / 2 - free / 2)));
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
      if (G.flags.legendMet && !G.flags.legendTold) {
        G.flags.legendTold = true;
        await say('อะไรนะ! เธอเห็นช้างเผือกลอยลงมาจากฟ้างั้นหรือ?\nนั่นคือคชานภา มอนสเตอร์ในตำนานของดินแดนนี้!');
        await say('ว่ากันว่าเลเวลของมันไม่มีที่สิ้นสุด ไม่มีใครเคยจับได้\nและมันจะปรากฏให้คนคนหนึ่งเห็นเพียงครั้งเดียว');
        await say('ถ้าเธอเติบโตไปเรื่อย ๆ สักวันอาจได้พบมันอีก\nตอนนั้นค่อยมาเล่าให้ฉันฟังนะ');
        save();
        return;
      }
      if (goalCaught().length >= 6 && !G.flags.finished) {
        G.flags.finished = true;
        await say('สุดยอดไปเลย! เธอจับมอนสเตอร์ครบทั้ง 6 ชนิดแล้ว');
        await say('ข้อมูลของเธอช่วยงานวิจัยได้มาก ขอบคุณจริง ๆ\nที่เส้นทางที่ 1 ทางใต้ยังมีชนิดใหม่อีกมาก ลองไปสำรวจดูนะ');
        save();
        return;
      }
      await say('ตอนนี้เธอจับได้ ' + goalCaught().length + ' จาก 6 ชนิด\n' +
        (goalCaught().length >= 6 ? 'ครบแล้ว เก่งมาก! เส้นทางที่ 1 ทางใต้ยังมีชนิดใหม่รออยู่' : 'พงหญ้าฝั่งตะวันออกมีชนิดหายากกว่าฝั่งตะวันตกนะ'));
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
      if (G.flags.rivalBeaten) { await say('ครั้งหน้าฉันไม่แพ้แน่! เจอกันที่เส้นทางที่ 1'); return; }
      if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของนายหมดแรงหมดแล้ว ไปศูนย์รักษาก่อนเถอะ'); return; }
      await say('ฉันชื่อพายุ! ได้มอนสเตอร์มาจากศาสตราจารย์เหมือนกัน\nมาประลองกันหน่อย!');
      const result = await battle([makeMon(RIVAL_PICK[G.flags.starter], 5)], { name: 'พายุ', img: 'chars/rival_large' });
      if (result === 'win') {
        G.flags.rivalBeaten = true;
        G.bag.capsule += 3;
        await say('แพ้แล้ว... ฝีมือไม่เบานี่!\nเอาแคปซูล 3 ลูกนี่ไป ถือเป็นรางวัล');
        await say('ฉันจะไปฝึกต่อที่เส้นทางที่ 1 ทางใต้ ถ้ากล้าก็ตามมาสิ!');
        await fadeTo(1, 200);
        npcs = npcs.filter((n) => n.id !== 'rival');
        await fadeTo(0, 200);
        await say('ทางไปเส้นทางที่ 1 เปิดแล้ว!\nเดินตามถนนลงไปทางใต้ได้เลย');
        save();
      }
    },

    // ---- Route 1 (stage 2)
    async rival2() {
      if (G.flags.stage2) { await say(G.flags.badge1 ? 'ได้เหรียญศิลามาแล้วเหรอ! สมกับที่ชนะฉันได้\nไว้เจอกันที่ด่าน 3 นะ' : 'นายเก่งขึ้นทุกวันเลย... ไปท้ายิมศิลาให้ได้เหรียญมาสิ\nยิมอยู่ทางตะวันตกของถนนนี่เอง'); return; }
      if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของนายหมดแรงหมดแล้ว ไปดื่มน้ำพุฟื้นพลังก่อนเถอะ'); return; }
      await say('มาถึงจนได้! ฉันฝึกที่นี่จนมอนสเตอร์วิวัฒนาการแล้วนะ\nคราวนี้ฉันมีสองตัว รับมือให้ได้ล่ะ!');
      const team = RIVAL_REMATCH.map(([sp, lv]) => makeMon(sp === 'starter2' ? RIVAL_PICK[G.flags.starter] + '2' : sp, lv));
      const result = await battle(team, { name: 'พายุ', img: 'chars/rival_large' });
      if (result === 'win') {
        G.flags.stage2 = true;
        G.bag.capsule += 5; G.bag.potion += 3;
        await say('แพ้อีกแล้ว... ยอมรับเลยว่านายเก่งจริง\nเอาแคปซูล 5 ลูกกับยา 3 ขวดนี่ไป');
        await say('ถ้าจะไปเมืองถัดไป ต้องชนะยิมศิลาแล้วเอาเหรียญมาให้ได้ก่อนนะ\nยิมอยู่ทางตะวันตกของถนนนี่เอง');
        save();
      }
    },
    // ---- the Rock Gym
    async gym_hiker() { await gymTrainer('hiker', 'gym_hiker',
      'โฮ่! ผู้ท้าชิงคนใหม่สินะ จะไปถึงหัวหน้ายิมต้องผ่านฉันไปก่อน!',
      'แรงดีไม่มีตก! ผ่านไปได้เลย แต่คนข้างในเก่งกว่าฉันนะ',
      'ฝึกปีนเขาทุกวันขาจะแข็งแรง มอนสเตอร์ก็เหมือนกัน'); },
    async gym_kid() { await gymTrainer('kid', 'gym_kid',
      'หนูสำรวจถ้ำมาทั่วแล้ว มอนสเตอร์หินของหนูไม่แพ้ใครหรอก!',
      'แพ้จนได้... พี่เก่งจัง หัวหน้ายิมรออยู่ข้างในแล้วค่ะ',
      'ธาตุหินแพ้ทางน้ำกับพืชนะ พี่รู้อยู่แล้วใช่ไหม'); },
    async gym_leader() {
      const g = GYM.leader;
      if (G.flags[g.flag]) { await say('เหรียญศิลาเหมาะกับเธอดีนะ\nด่าน 3 รออยู่ทางใต้ ขอให้โชคดี'); return; }
      if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของเธอหมดแรงหมดแล้ว ไปฟื้นพลังที่ลานน้ำพุก่อนเถอะ'); return; }
      await say('ยินดีต้อนรับสู่ยิมศิลา! ฉันคือศิลา หัวหน้ายิมแห่งนี้');
      await say('มอนสเตอร์ธาตุหินของฉันแข็งแกร่งดั่งภูผา\nมาดูกันว่าเธอคู่ควรกับเหรียญศิลาหรือไม่!');
      const result = await battle(g.team.map(([sp, lv]) => makeMon(sp, lv)), { name: g.name, sheet: 'chars/npc_gym_leader' });
      if (result !== 'win') return;
      G.flags[g.flag] = true;
      G.bag.potion += 3;
      await say('ยอดเยี่ยม! เธอแข็งแกร่งจริง ๆ\nรับเหรียญศิลานี้ไป เป็นหลักฐานว่าเธอชนะยิมแห่งนี้');
      await say('ได้รับเหรียญศิลา และยา 3 ขวด!');
      await say('ยินดีด้วย! คุณผ่านด่าน 2 แล้ว\nด่านตรวจทางใต้ของเส้นทางที่ 1 จะเปิดทางไปด่าน 3 ให้');
      save();
    },
    async gym_books() { await say('ตำรายิมศิลา\n"ธาตุหินชนะทางไฟ ไฟฟ้า และปกติ แต่แพ้ทางน้ำกับพืช"'); },
    async sign_gym() { await say('ยิมศิลา\nชนะหัวหน้ายิมเพื่อรับเหรียญศิลา ใช้ผ่านด่านตรวจไปด่าน 3'); },

    async spring() {
      await say('น้ำพุใสเย็นไหลออกมาจากบ่อหิน\nมอนสเตอร์ทั้งทีมได้ดื่มน้ำจนสดชื่น');
      if (!G.party.length) return;
      await fadeTo(0.6, 250); healParty(); await wait(350); await fadeTo(0, 250);
      await say('ทุกตัวฟื้นพลังเต็มที่แล้ว!');
      save();
    },
    async sign_r1_top() { await say('เส้นทางที่ 1\nทิศเหนือ : หมู่บ้านต้นกล้า   ทิศใต้ : สะพานข้ามแม่น้ำ'); },
    async sign_r1_bridge() { await say('สะพานไม้ข้ามแม่น้ำ\nพงหญ้าฝั่งใต้มีมอนสเตอร์แข็งแกร่งกว่าฝั่งเหนือ'); },
    async sign_r1_spring() { await say('ลานน้ำพุ\nสำรวจบ่อน้ำเพื่อฟื้นพลังมอนสเตอร์ได้ทุกเมื่อ'); },
    async sign_r1_end() { await say('ทิศใต้ : ด่านตรวจ ทางไปด่าน 3\nต้องมีเหรียญศิลาจากยิมจึงจะผ่านได้'); },
    async r1_crate_a() {
      if (G.flags.r1a) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.r1a = true; G.bag.capsule += 3;
      await say('เปิดลังไม้ดู...\nพบแคปซูล 3 ลูก!'); save();
    },
    async r1_crate_b() {
      if (G.flags.r1b) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.r1b = true; G.bag.potion += 3;
      await say('เปิดลังไม้ดู...\nพบยา 3 ขวด!'); save();
    },
    async r1_crate_c() {
      if (G.flags.r1c) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.r1c = true; G.bag.capsule += 4; G.bag.potion += 2;
      await say('เปิดลังไม้ดู...\nพบแคปซูล 4 ลูกและยา 2 ขวด!'); save();
    },

    async sign_village() { await say('หมู่บ้านต้นกล้า\nทิศใต้ : เส้นทางที่ 1 และพงหญ้าสูง'); },
    async sign_grass() { await say('ระวัง! พงหญ้าสูงมีมอนสเตอร์ป่า\nฝั่งตะวันตกเหมาะกับมือใหม่ ฝั่งตะวันออกมีตัวที่แข็งแกร่งกว่า'); },
    async sign_route() { await say('ทิศใต้ : เส้นทางที่ 1\nมีมอนสเตอร์ชนิดใหม่ที่ไม่พบในหมู่บ้าน'); },
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
      const names = goalCaught().map((sp) => SPECIES[sp].name);
      await say('คอมพิวเตอร์บันทึกข้อมูลมอนสเตอร์\nจับได้แล้ว ' + names.length + ' จาก 6 ชนิด' + (names.length ? ' : ' + names.join(' ') : ''));
      if (G.lab.length) await say('มอนสเตอร์ที่ฝากไว้ที่นี่ ' + G.lab.length + ' ตัว : ' + G.lab.map((m) => nm(m) + ' Lv.' + m.level).join(' '));
      if (G.flags.legendMet) await say('บันทึกพิเศษ : พบเห็นมอนสเตอร์ในตำนาน 1 ชนิด\nคชานภา ธาตุตำนาน Lv.∞ (ยังจับไม่ได้)');
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

  // A trainer who blocks the way in the gym: fight once, then they step aside for good.
  async function gymTrainer(key, npcId, hello, beaten, later) {
    const g = GYM[key];
    if (G.flags[g.flag]) { await say(later); return; }
    if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของเธอหมดแรงหมดแล้ว ไปฟื้นพลังที่ลานน้ำพุก่อนเถอะ'); return; }
    await say(hello);
    const npc = npcs.find((n) => n.id === npcId);
    const result = await battle(g.team.map(([sp, lv]) => makeMon(sp, lv)), { name: g.name, sheet: npc.sheet });
    if (result !== 'win') return;
    G.flags[g.flag] = true;
    await say(beaten);
    const spot = MAP.npcs.find((n) => n.id === npcId).moved;
    await fadeTo(1, 160);
    const here = npcs.find((n) => n.id === npcId);
    if (here) { here.c = spot.c; here.r = spot.r; here.dir = spot.dir; }
    await fadeTo(0, 160);
    save();
  }

  async function teamScreen() {
    let at = 0;
    for (;;) {
      const opts = G.party.map((m) => ({
        label: nm(m) + '  Lv.' + m.level, badge: SPECIES[m.sp].type, hp: [m.hp, stats(m).hp] }));
      opts.push({ label: 'ดูตารางแพ้ธาตุ' });
      const i = await choose(opts, {
        x: 50, y: 24, w: 380, rowH: 30, cancellable: true, start: at,
        title: G.party.length ? 'ทีมมอนสเตอร์  (เลือกเพื่อดูข้อมูล)' : 'ยังไม่มีมอนสเตอร์ในทีม',
        footer: 'แคปซูล ' + G.bag.capsule + '   ยา ' + G.bag.potion + '   จับได้ ' + goalCaught().length + '/6 ชนิด'
          + '   เหรียญ ' + (G.flags.badge1 ? 1 : 0) });
      if (i < 0) break;
      at = i;
      if (i === G.party.length) {          // the type table
        ui.chart = true; await anyKey(); ui.chart = false;
        continue;
      }
      const m = G.party[i];
      ui.card = m;                         // the monster's information card
      const pick = await choose(['ตั้งเป็นตัวนำ', 'กลับ'], { x: 212, y: 262, w: 220, cols: 2, rowH: 24, cancellable: true });
      ui.card = null;
      if (pick !== 0) continue;
      if (i > 0) {
        G.party.splice(i, 1);
        G.party.unshift(m);
        at = 0;
        await say(nm(m) + 'ขึ้นมาเป็นตัวนำทีมแล้ว');
      } else await say(nm(m) + 'เป็นตัวนำทีมอยู่แล้ว');
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
    // stage 1 only: the legendary monster comes down once, early on
    if (MAP.id === 'village' && !G.flags.legendMet) {
      G.wilds = (G.wilds || 0) + 1;
      if (G.wilds >= LEGEND_AFTER) { await legendEncounter(); return; }
    }
    await battle([pickWild(area)], null);
  }
  async function legendEncounter() {
    await say('จู่ ๆ ลมก็หยุดพัด... พงหญ้าทั้งผืนเงียบสนิท');
    await say('มีบางอย่างที่ยิ่งใหญ่กำลังลงมาจากท้องฟ้า!');
    const foe = makeMon('legend', 99);
    foe.infinite = true;                     // shown as level infinity
    G.flags.legendMet = true;                // once only, whatever happens next
    await battle([foe], null, { legend: true });
    save();
  }

  // ------------------------------------------------------------------ battle
  const SPOT = { me: { x: 153, y: 204 }, foe: { x: 372, y: 146 } };   // where each monster's feet stand

  function damage(att, def, mv) {
    const A = stats(att).atk, D = stats(def).def;
    const base = Math.floor(((2 * att.level / 5 + 2) * mv.power * A / D) / 50) + 2;
    const stab = SPECIES[att.sp].type === mv.type ? 1.25 : 1;
    const eff = typeMult(mv.type, SPECIES[def.sp].type);
    return { dmg: Math.max(1, Math.floor(base * stab * eff * (0.85 + Math.random() * 0.15))), eff };
  }

  async function battle(foes, trainer, opts = {}) {
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
      fx: null, evo: null, evolving: [], pop: null,
    };
    if (opts.legend) { bt.spr.foe.dx = 0; bt.spr.foe.dy = -240; }      // it descends from the sky
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
    } else if (opts.legend) {
      await tween(1400, (t) => { bt.spr.foe.dy = -240 * (1 - t) * (1 - t); });
      await say('มอนสเตอร์ในตำนาน ' + nm(bt.foe) + ' ปรากฏกาย!');
      await say('เลเวลของมันคือ ∞ ... พลังที่ไม่มีที่สิ้นสุด');
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
      const dir = side === 'me' ? 1 : -1, s = bt.spr[side], hit = bt.spr[other];
      await tween(110, (t) => { s.dx = dir * 20 * t; s.dy = -dir * 9 * t; });
      await tween(110, (t) => { s.dx = dir * 20 * (1 - t); s.dy = -dir * 9 * (1 - t); });
      const { dmg, eff } = damage(att, def, mv);
      // the move's effect plays over the target, which shakes while it is being hit
      bt.fx = { type: mv.type, x: SPOT[other].x, y: SPOT[other].y - 60, t: 0, strong: eff > 1 };
      await tween(eff > 1 ? 520 : 440, (t) => {
        bt.fx.t = t;
        hit.dx = t > 0.25 && t < 0.9 ? Math.round(Math.sin(t * 46) * (eff > 1 ? 5 : 3)) : 0;
        if (eff > 1) ui.flash = t > 0.3 && t < 0.42 ? 0.35 : 0;
      });
      bt.fx = null; hit.dx = 0; ui.flash = 0;
      await tween(240, (t) => { hit.blink = Math.floor(t * 4) % 2 === 0; });
      hit.blink = false;
      const from = def.hp;
      def.hp = Math.max(0, def.hp - dmg);
      bt.pop = { text: '-' + dmg, x: SPOT[other].x + (other === 'foe' ? -58 : 62), y: SPOT[other].y - 96, t: 0,
                 color: eff > 1 ? '#ffd23f' : eff < 1 ? '#c8c8d0' : '#ffffff', big: eff > 1 };
      tween(900, (t) => { if (bt && bt.pop) bt.pop.t = t; }).then(() => { if (bt) bt.pop = null; });
      await tween(350, (t) => { bt.hp[other] = from + (def.hp - from) * t; });
      const versus = 'ธาตุ' + TYPES[mv.type].name + (eff > 1 ? 'ชนะทาง' : 'แพ้ทาง') + 'ธาตุ' + TYPES[SPECIES[def.sp].type].name;
      if (eff > 1) await say('ได้ผลดีเยี่ยม! ' + versus); else if (eff < 1) await say('ไม่ค่อยได้ผล... ' + versus);
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
          if (lv === m.level && !m.moves.includes(mv)) await learnMove(m, mv);
        }
      }
      const evo = SPECIES[m.sp].evolve;
      if (evo && m.level >= evo.level && !bt.evolving.includes(m)) bt.evolving.push(m);
    }
    // A monster keeps at most MAX_MOVES moves. With a full set the player chooses one to
    // forget, or keeps the old set.
    async function learnMove(m, id) {
      const mv = MOVES[id];
      if (m.moves.length < MAX_MOVES) {
        m.moves.push(id);
        await say(nm(m) + 'เรียนรู้ท่า' + mv.name + '!');
        return;
      }
      await say(nm(m) + 'อยากเรียนท่า' + mv.name + ' (ธาตุ' + TYPES[mv.type].name + ' พลัง ' + mv.power + ')\nแต่จำท่าได้สูงสุด ' + MAX_MOVES + ' ท่า');
      const opts = m.moves.map((x) => moveOption(x, null));
      opts.push({ label: 'ไม่เรียนท่าใหม่', sub: 'เก็บท่าเดิมไว้ทั้งหมด' });
      const i = await choose(opts, { x: 4, y: 181, w: 472, cols: 2, rowH: 33,
        title: 'จะให้ลืมท่าไหน เพื่อเรียนท่า' + mv.name + '?' });
      if (i >= m.moves.length) { await say(nm(m) + 'ไม่ได้เรียนท่า' + mv.name); return; }
      const old = MOVES[m.moves[i]].name;
      m.moves[i] = id;
      await say('1... 2... 3... ปิ๊ง!\n' + nm(m) + 'ลืมท่า' + old + ' แล้วเรียนรู้ท่า' + mv.name + '!');
    }
    // Change a monster into its next form, on the battle screen once the fight is over.
    async function evolve(m) {
      const evo = SPECIES[m.sp].evolve;
      if (!evo || m.level < evo.level || m.hp <= 0) return;
      const oldName = nm(m);
      bt.evo = { from: m.sp, to: evo.to, showNew: false, t: 0 };
      await say('เอ๊ะ? ' + oldName + 'มีท่าทางแปลกไป!');
      bt.fx = { type: 'evolve', x: 240, y: 132, t: 0, strong: true };
      // the two forms flicker faster and faster, then a white flash settles on the new one
      await tween(2600, (t) => { bt.evo.t = t; bt.fx.t = (t * 3) % 1; bt.evo.showNew = Math.sin(t * t * 70) > 0; });
      await tween(160, (t) => { ui.flash = t; });
      const before = stats(m).hp;
      m.sp = evo.to;
      m.hp = Math.min(stats(m).hp, m.hp + stats(m).hp - before);
      if (m === bt.me) bt.hp.me = m.hp;
      bt.evo.showNew = true; bt.fx = null;
      noteCaught(m.sp);
      await tween(420, (t) => { ui.flash = 1 - t; });
      await say('ยินดีด้วย! ' + oldName + 'วิวัฒนาการเป็น' + nm(m) + 'แล้ว!');
      bt.evo = null;
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

    // The legendary monster cannot be hurt or caught yet. It watches for three turns (or until
    // the player backs away), restores the whole party, and leaves.
    async function legendLoop() {
      const name = nm(bt.foe), foeSpr = bt.spr.foe;
      const watching = [name + 'มองดูคุณอย่างสงบ', 'ดวงตาสีทองของ' + name + 'เป็นประกายอ่อนโยน'];
      let turns = 0;
      while (turns < 3) {
        ui.prompt = nm(bt.me) + 'จะทำอะไรดี?';
        const act = await choose([
          'ต่อสู้', { label: 'แคปซูล', right: 'x' + G.bag.capsule },
          { label: 'ยา', right: 'x' + G.bag.potion }, 'หนี'], { x: 262, y: 236, w: 214, cols: 2, rowH: 33, start: bt.lastAct || 0 });
        bt.lastAct = act;
        ui.prompt = null;
        if (act === 0) {
          const i = await choose(bt.me.moves.map((id) => moveOption(id, bt.foe)), {
            x: 4, y: 236, w: 472, cols: 2, rowH: 33, minH: 80, cancellable: true });
          if (i < 0) continue;
          const mv = MOVES[bt.me.moves[i]], s = bt.spr.me;
          await say(nm(bt.me) + 'ใช้ท่า' + mv.name + '!');
          await tween(110, (t) => { s.dx = 20 * t; s.dy = -9 * t; });
          await tween(110, (t) => { s.dx = 20 * (1 - t); s.dy = -9 * (1 - t); });
          bt.fx = { type: mv.type, x: SPOT.foe.x, y: SPOT.foe.y - 60, t: 0, strong: false };
          await tween(440, (t) => { bt.fx.t = t; });
          bt.fx = null;
          bt.pop = { text: '-0', x: SPOT.foe.x - 58, y: SPOT.foe.y - 96, t: 0, color: '#c8c8d0', big: false };
          await tween(900, (t) => { bt.pop.t = t; });
          bt.pop = null;
          await say('พลังห่างชั้นเกินไป... การโจมตีไม่ระคายผิว' + name + 'เลย');
        } else if (act === 1) {
          if (G.bag.capsule <= 0) { await say('แคปซูลหมดแล้ว!'); continue; }
          await say('โยนแคปซูลออกไป!');
          const from = { x: SPOT.me.x + 30, y: SPOT.me.y - 90 }, to = { x: SPOT.foe.x, y: SPOT.foe.y - 70 };
          bt.capsule = { x: from.x, y: from.y };
          await tween(420, (t) => { bt.capsule.x = from.x + (to.x - from.x) * t; bt.capsule.y = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 60; });
          await tween(90, (t) => { ui.flash = 0.5 * (1 - t); });
          await tween(520, (t) => { bt.capsule.x = to.x + (from.x - to.x) * t; bt.capsule.y = to.y + (from.y - to.y) * t - Math.sin(t * Math.PI) * 90; });
          bt.capsule = null;
          await say('แคปซูลกระเด็นกลับมาอยู่ในมือ!\n' + name + 'ยังไม่อาจถูกจับได้ในตอนนี้');
        } else if (act === 2) {
          if (G.bag.potion <= 0) { await say('ยาหมดแล้ว!'); continue; }
          const max = stats(bt.me).hp;
          if (bt.me.hp >= max) { await say(nm(bt.me) + 'ยังแข็งแรงเต็มที่อยู่'); continue; }
          G.bag.potion--;
          const before = bt.me.hp;
          bt.me.hp = Math.min(max, bt.me.hp + 20);
          await say('ใช้ยากับ' + nm(bt.me));
          await tween(350, (t) => { bt.hp.me = before + (bt.me.hp - before) * t; });
        } else {
          await say('คุณค่อย ๆ ถอยออกมาอย่างนอบน้อม...');
          break;
        }
        turns++;
        if (turns < 3) await say(watching[turns - 1]);
      }
      await say(name + 'เปล่งแสงเจิดจ้า!');
      await tween(220, (t) => { ui.flash = t; });
      const before = bt.me.hp;
      healParty();
      bt.hp.me = bt.me.hp;
      await tween(520, (t) => { ui.flash = 1 - t; });
      if (bt.me.hp > before || G.party.some((m) => m !== bt.me)) await say('แสงอันอบอุ่นโอบล้อมทั้งทีม\nมอนสเตอร์ทุกตัวฟื้นพลังเต็มที่');
      await tween(1100, (t) => { foeSpr.dy = -260 * t * t; foeSpr.alpha = 1 - t * t; });
      await say(name + 'ทะยานขึ้นสู่ท้องฟ้าและหายลับไป...');
      await say('ตำนานเล่าว่ามันจะปรากฏอีกครั้งเมื่อถึงเวลา\n(รอพบกันใหม่ในอัปเดตถัดไป)');
      return 'legend';
    }
    if (opts.legend) result = await legendLoop();

    while (!result) {
      ui.prompt = nm(bt.me) + 'จะทำอะไรดี?';
      const act = await choose([
        'ต่อสู้', { label: 'แคปซูล', right: 'x' + G.bag.capsule },
        { label: 'ยา', right: 'x' + G.bag.potion }, 'หนี'], { x: 262, y: 236, w: 214, cols: 2, rowH: 33, start: bt.lastAct || 0 });
      bt.lastAct = act;
      ui.prompt = null;

      if (act === 0) {
        const i = await choose(bt.me.moves.map((id) => moveOption(id, bt.foe)), {
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
    if (result !== 'lose') for (const m of bt.evolving) await evolve(m);
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

  // Attack effects: small pixel particles drawn over the target, one look per move type.
  // fx = { type, x, y (centre of the target), t (0..1), strong }
  function drawFx(fx) {
    const t = fx.t, n = fx.strong ? 1.5 : 1;
    const rnd = (i, k) => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
    const dot = (x, y, size, color) => { b.fillStyle = color; b.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size); };
    const pick = (list, i) => list[i % list.length];
    if (fx.type === 'fire') {                       // a burst of flame, then embers rising
      if (t < 0.45) for (let i = 0; i < 5; i++) dot(fx.x + (i - 2) * 13, fx.y + 26 - t * 40 - (i % 2) * 10, 18 - Math.abs(i - 2) * 3, pick(['#ff8a1f', '#ffd23f', '#fff3a0'], i));
      for (let i = 0; i < 24 * n; i++) {
        const start = rnd(i, 1) * 0.45, life = (t - start) / 0.55;
        if (life < 0 || life > 1) continue;
        dot(fx.x + (rnd(i, 2) - 0.5) * 84 + Math.sin(life * 6 + i) * 5, fx.y + 40 - life * 92,
          life < 0.4 ? 10 : life < 0.75 ? 8 : 4, pick(['#fff3a0', '#ffd23f', '#ff8a1f', '#e0431f'], i + (life > 0.5 ? 2 : 0)));
      }
    } else if (fx.type === 'water') {               // a splash, then droplets flying up and falling
      if (t < 0.4) for (let i = 0; i < 5; i++) dot(fx.x + (i - 2) * 14, fx.y + 30 - Math.sin(t * 8) * 14 - (i % 2) * 8, 16 - Math.abs(i - 2) * 2, pick(['#4aa8f0', '#9fd8ff', '#ffffff'], i));
      for (let i = 0; i < 24 * n; i++) {
        const a = Math.PI * (1.1 + rnd(i, 1) * 0.8), sp = 46 + rnd(i, 2) * 50;
        dot(fx.x + Math.cos(a) * sp * t * 1.5, fx.y + 24 + Math.sin(a) * sp * t * 1.9 + 130 * t * t,
          rnd(i, 3) > 0.6 ? 10 : rnd(i, 3) > 0.3 ? 8 : 6, pick(['#ffffff', '#9fd8ff', '#4aa8f0', '#2f86e0'], i));
      }
    } else if (fx.type === 'leaf') {                // two slashes, with leaves cutting across
      for (let k = 0; k < 2; k++) {
        const s0 = 0.12 + k * 0.2, len = Math.min(1, Math.max(0, (t - s0) / 0.22));
        if (len <= 0 || t > s0 + 0.5) continue;
        for (let j = 0; j < 14 * len; j++) dot(fx.x - 46 + j * 7, fx.y - 44 + k * 26 + j * 5.5 * (k ? -1 : 1) + (k ? 50 : 0), j % 3 ? 8 : 6, j % 2 ? '#e8ffd0' : '#b6f078');
      }
      for (let i = 0; i < 16 * n; i++) {
        const start = rnd(i, 1) * 0.4, life = (t - start) / 0.6;
        if (life < 0 || life > 1) continue;
        const x = fx.x - 66 + life * 132, y = fx.y - 56 + rnd(i, 2) * 70 + life * 44 + Math.sin(life * 9 + i) * 6;
        b.fillStyle = '#1f6a2c';
        const flat = Math.floor(life * 8 + i) % 2;
        b.fillRect(Math.round(x - (flat ? 7 : 4)), Math.round(y - (flat ? 4 : 7)), flat ? 14 : 8, flat ? 8 : 14);
        b.fillStyle = pick(['#7ed957', '#3f9d45', '#b6f078'], i);
        b.fillRect(Math.round(x - (flat ? 6 : 3)), Math.round(y - (flat ? 3 : 6)), flat ? 12 : 6, flat ? 6 : 12);
      }
    } else if (fx.type === 'electric') {            // flickering bolts from above
      if (Math.floor(t * 12) % 2 === 0) {
        for (let k = 0; k < Math.round(2 * n); k++) {
          let x = fx.x - 28 + k * 28 + (rnd(k, Math.floor(t * 12)) - 0.5) * 16;
          for (let s = 0; s < 9; s++) {
            const nx = x + (rnd(s + k * 9, Math.floor(t * 12)) - 0.5) * 22;
            const y = fx.y - 78 + s * 14;
            b.fillStyle = '#f7d21c'; b.fillRect(Math.round(Math.min(x, nx)) - 1, y, Math.round(Math.abs(nx - x)) + 6, 6);
            b.fillRect(Math.round(nx) - 1, y, 6, 16);
            b.fillStyle = '#fffbe0'; b.fillRect(Math.round(nx) + 1, y + 2, 2, 12);
            x = nx;
          }
        }
      }
    } else if (fx.type === 'rock') {                // stones dropping, then dust
      for (let i = 0; i < 6 * n; i++) {
        const start = i * 0.09, fall = Math.min(1, Math.max(0, (t - start) / 0.4));
        if (t < start) continue;
        const x = fx.x - 44 + rnd(i, 1) * 88, y = fx.y - 96 + fall * fall * 124;
        if (fall < 1) {
          const sz = 10 + Math.floor(rnd(i, 2) * 3) * 2;
          dot(x, y, sz + 2, '#4a4038'); dot(x, y, sz, pick(['#9a8a78', '#7d6f60', '#b0a090'], i)); dot(x - 2, y - 2, 4, '#cfc3b2');
        } else {
          const puff = (t - start - 0.4) / 0.3;
          if (puff < 1) for (let d = 0; d < 3; d++) dot(x + (d - 1) * 12 * puff, fx.y + 28 - puff * 10, 6, '#d8cdbb');
        }
      }
    } else if (fx.type === 'ghost') {               // a dark core with wisps spiralling inward
      const pulse = 14 + Math.round(Math.sin(t * 16) * 4) + Math.round(t * 16);
      dot(fx.x, fx.y, pulse + 6, '#3a2760'); dot(fx.x, fx.y, pulse, '#5b3f8a'); dot(fx.x, fx.y, Math.max(4, pulse - 10), '#c9a8ff');
      for (let i = 0; i < 18 * n; i++) {
        const a = i * 0.9 + t * 7, r = 62 * (1 - t) + 10 + rnd(i, 1) * 10;
        dot(fx.x + Math.cos(a) * r, fx.y + Math.sin(a) * r * 0.7, i % 3 ? 10 : 6, pick(['#c9a8ff', '#8560b8', '#5b3f8a', '#f0e6ff'], i));
      }
    } else if (fx.type === 'evolve') {              // sparkles rising all around
      for (let i = 0; i < 34; i++) {
        const life = (t + rnd(i, 1)) % 1;
        dot(fx.x + (rnd(i, 2) - 0.5) * 190, fx.y + 80 - life * 170, life < 0.5 ? 8 : 4, pick(['#ffffff', '#fff3a0', '#9fd8ff'], i));
      }
    } else {                                        // normal: a burst of impact lines
      const r0 = 6 + t * 30, r1 = 16 + t * 50;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4 + 0.3;
        for (let s = 0; s < 4; s++) {
          const r = r0 + (r1 - r0) * s / 3;
          if (t < 0.85) dot(fx.x + Math.cos(a) * r, fx.y + Math.sin(a) * r, s < 2 ? 6 : 4, s % 2 ? '#fff3a0' : '#ffffff');
        }
      }
      if (t < 0.3) dot(fx.x, fx.y, 22, '#ffffff');
    }
  }

  function drawBattle() {
    b.drawImage(IMG.battle_bg, 0, 0);
    if (bt.evo) {                                   // evolution: one monster, centre stage
      const sp = SPECIES[bt.evo.showNew ? bt.evo.to : bt.evo.from];
      const im = IMG['monsters/' + sp.img];
      b.drawImage(im, 240 - im.width, 206 - im.height * 2, im.width * 2, im.height * 2);
      if (bt.fx) drawFx(bt.fx);
      return;
    }
    const mon = (side, m, back) => {
      const s = bt.spr[side];
      if (s.blink || s.alpha <= 0) return;
      b.globalAlpha = Math.max(0, Math.min(1, s.alpha));
      // sprites are drawn at twice their size; evolved forms have bigger sprites and stand a little lower
      const im = IMG['monsters/' + SPECIES[m.sp].img + (back ? '_back' : '')];
      const w = im.width * 2, h = im.height * 2, drop = Math.round((h - 128) / 4);
      let top = SPOT[side].y + drop - h;
      if (side === 'foe') top = Math.max(4, top);
      b.drawImage(im, Math.round(SPOT[side].x - w / 2 + s.dx), Math.round(top + s.dy), w, h);
      b.globalAlpha = 1;
    };
    if (bt.trainerX !== null && bt.trainer.img) b.drawImage(IMG[bt.trainer.img], Math.round(SPOT.foe.x - 80 + bt.trainerX), SPOT.foe.y - 150, 160, 160);
    else if (bt.trainerX !== null) b.drawImage(IMG[bt.trainer.sheet], 0, 0, 32, 48, Math.round(SPOT.foe.x - 48 + bt.trainerX), SPOT.foe.y - 138, 96, 144);
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
    if (bt.fx) drawFx(bt.fx);
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
      const mid = o.sub ? cy + 15 : cy + m.rowH / 2 + 5;
      if (i === m.index) {
        ctx.fillStyle = '#efe6c8'; roundRect(cx + 1, cy + 1, cellW - 2, m.rowH - 2, 4); ctx.fill();
        text('▶', cx + 5, mid - 1, 9, '#c0442f');
      }
      text(o.label, cx + 18, mid, 13, o.disabled ? '#a39c8c' : '#2b2420');
      if (o.sub) text(o.sub, cx + 18, cy + 28, 10, o.subColor || '#5a5048');
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
    badge(SPECIES[bt.foe.sp].type, 30 + ctx.measureText(nm(bt.foe)).width, 29);
    text(bt.foe.infinite ? 'Lv.∞' : 'Lv.' + bt.foe.level, 198, 31, bt.foe.infinite ? 13 : 11, bt.foe.infinite ? '#c08a12' : '#5a5048', 'right', !!bt.foe.infinite);
    text('HP', 24, 45, 9, '#c0442f', 'left', true);
    hpBar(42, 38, 156, bt.hp.foe, stats(bt.foe).hp);
    // mine: right, above the text box
    const max = stats(bt.me).hp;
    box(270, 172, 198, 58);
    text(nm(bt.me), 282, 191, 13, '#2b2420', 'left', true);
    badge(SPECIES[bt.me.sp].type, 288 + ctx.measureText(nm(bt.me)).width, 189);
    text('Lv.' + bt.me.level, 456, 191, 11, '#5a5048', 'right');
    text('HP', 282, 205, 9, '#c0442f', 'left', true);
    hpBar(300, 198, 156, bt.hp.me, max);
    text(Math.ceil(bt.hp.me) + ' / ' + max, 456, 221, 11, '#5a5048', 'right');
    const lo = expAt(bt.me.level), hi = expAt(bt.me.level + 1);
    ctx.fillStyle = '#d6cdb4'; ctx.fillRect(282, 216, 110, 3);
    ctx.fillStyle = '#4a8fd8'; ctx.fillRect(282, 216, 110 * Math.max(0, Math.min(1, (bt.me.exp - lo) / (hi - lo))), 3);
  }

  // Row of type badges; returns the x after the last one.
  function badges(types, x, y) {
    if (!types.length) { text('-', x, y + 1, 11, '#a39c8c'); return x + 10; }
    for (const t of types) x += badge(t, x, y) + 4;
    return x;
  }

  // Which type beats which.
  function drawTypeChart() {
    box(24, 10, 432, 300);
    text('ตารางแพ้ธาตุ', 40, 33, 14, '#2b2420', 'left', true);
    text('ท่าที่ได้เปรียบแรงขึ้น 1.5 เท่า  ท่าที่เสียเปรียบเหลือ 2 ใน 3', 444, 33, 10, '#5a5048', 'right');
    Object.keys(TYPES).filter((t) => !TYPES[t].hidden).forEach((type, i) => {
      const y = 62 + i * 34, links = typeLinks(type);
      if (i % 2 === 0) { ctx.fillStyle = '#f1e9cf'; roundRect(32, y - 19, 416, 30, 4); ctx.fill(); }
      badge(type, 42, y);
      text('ชนะทาง', 96, y + 1, 11, '#2f8a3a', 'left', true);
      badges(links.beats, 142, y);
      text('แพ้ทาง', 282, y + 1, 11, '#c0442f', 'left', true);
      badges(links.weakTo, 322, y);
    });
    text('กดปุ่มใดก็ได้เพื่อปิด', 444, 300, 10, '#5a5048', 'right');
  }

  // Everything about one monster: stats, weaknesses, its moves, what comes next.
  function drawCard(m) {
    const sp = SPECIES[m.sp], st = stats(m), links = typeLinks(sp.type);
    box(40, 12, 400, 296);
    ctx.fillStyle = '#e9f0d8'; roundRect(52, 24, 100, 100, 6); ctx.fill();
    const im = IMG['monsters/' + sp.img], k = 96 / Math.max(im.width, im.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(im, 102 - im.width * k / 2, 122 - im.height * k, im.width * k, im.height * k);
    text(sp.name, 164, 42, 15, '#2b2420', 'left', true);
    badge(sp.type, 170 + ctx.measureText(sp.name).width, 40);
    text('Lv.' + m.level, 428, 42, 12, '#5a5048', 'right');
    text('HP', 164, 61, 9, '#c0442f', 'left', true);
    hpBar(182, 54, 170, m.hp, st.hp);
    text(m.hp + ' / ' + st.hp, 428, 62, 11, '#5a5048', 'right');
    text('โจมตี ' + st.atk + '    ป้องกัน ' + st.def + '    ความเร็ว ' + st.spd, 164, 82, 11, '#2b2420');
    text('แพ้ธาตุ', 164, 102, 11, '#c0442f', 'left', true);
    badges(links.weakTo, 206, 101);
    text('ต้านธาตุ', 164, 121, 11, '#2f8a3a', 'left', true);
    badges(links.resists, 212, 120);

    text('ท่าโจมตี  (จำได้สูงสุด ' + MAX_MOVES + ' ท่า)', 56, 146, 12, '#2b2420', 'left', true);
    for (let i = 0; i < MAX_MOVES; i++) {
      const x = 56 + (i % 2) * 190, y = 168 + Math.floor(i / 2) * 26;
      ctx.fillStyle = '#f1e9cf'; roundRect(x - 4, y - 15, 184, 22, 4); ctx.fill();
      const id = m.moves[i];
      if (!id) { text('-', x + 4, y, 12, '#a39c8c'); continue; }
      text(MOVES[id].name, x + 2, y, 12, '#2b2420');
      setFont(12);
      badge(MOVES[id].type, x + 8 + ctx.measureText(MOVES[id].name).width, y - 1);
      text(String(MOVES[id].power), x + 174, y, 11, '#5a5048', 'right');
    }
    const next = sp.moves.find(([lv, id]) => lv > m.level && !m.moves.includes(id));
    text(next ? 'ท่าถัดไป : ' + MOVES[next[1]].name + ' ที่ Lv.' + next[0] : 'ท่าถัดไป : เรียนครบทุกท่าแล้ว', 56, 226, 11, '#5a5048');
    text(sp.evolve ? 'วิวัฒนาการ : เป็น' + SPECIES[sp.evolve.to].name + ' ที่ Lv.' + sp.evolve.level : 'วิวัฒนาการ : ร่างสุดท้ายแล้ว', 56, 244, 11, '#5a5048');
  }

  function drawTitle() {
    b.drawImage(IMG.battle_bg, 0, 0);
    b.fillStyle = 'rgba(20,30,40,0.35)'; b.fillRect(0, -2000, VW, 4000 + VH);
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
    if (mode === 'battle' && bt && !bt.evo) drawHud();
    if (mode === 'battle' && bt && bt.pop) {                // damage number: pops up, rises, fades
      const p = bt.pop, rise = 1 - Math.pow(1 - p.t, 3);
      const size = (p.big ? 24 : 20) * (p.t < 0.12 ? 0.6 + p.t / 0.12 * 0.4 : 1);
      ctx.globalAlpha = p.t > 0.75 ? Math.max(0, (1 - p.t) / 0.25) : 1;
      setFont(size, true);
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#2b2420'; ctx.lineWidth = 5;
      ctx.strokeText(p.text, p.x, p.y - rise * 30);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y - rise * 30);
      ctx.globalAlpha = 1;
    }
    if (ui.portrait) {
      box(VW - 8 - 104, 30, 104, 104);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(IMG[ui.portrait], VW - 8 - 100, 34, 96, 96);
    }
    if (ui.msg || ui.prompt || mode === 'battle') box(4, 236, 472, 80);
    if (ui.prompt && !ui.msg) wrap(ui.prompt, 230, 13).forEach((l, i) => text(l, 20, 259 + i * 19, 13));
    if (ui.msg) drawMessage(ui.msg);
    if (ui.banner && mode === 'world') {                    // place name, sliding in and out at the top
      const t = ui.banner.t, k = Math.min(1, t / 0.25, (2.6 - t) / 0.25);
      setFont(13, true);
      const w = ctx.measureText(ui.banner.text).width + 40;
      const by = -30 + 38 * k - uiTop();
      box(240 - w / 2, by, w, 28);
      text(ui.banner.text, 240, by + 19, 13, '#2b2420', 'center', true);
    }
    if (ui.chart) drawTypeChart();
    if (ui.card) drawCard(ui.card);
    if (ui.menu) drawMenu(ui.menu);
    if (ui.fade > 0) { ctx.fillStyle = 'rgba(0,0,0,' + ui.fade + ')'; ctx.fillRect(0, -uiTop(), VW, VH); }
    if (ui.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + ui.flash + ')'; ctx.fillRect(0, -uiTop(), VW, VH); }
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
    if (ui.banner && (ui.banner.t += dt) > 2.6) ui.banner = null;
    updateVirtual(dt);
    if (mode === 'world') updateWorld(dt);
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    pollGamepad();
    tick(dt);
    render();
    requestAnimationFrame(frame);
  }
  function render() {
    const top = uiTop();
    // beyond the edge of an outdoor map there is just more grass; indoors it stays black
    b.fillStyle = mode === 'world' && MAP && !MAP.indoor ? '#72ce37' : '#000';
    b.fillRect(0, 0, VW, VH);
    if (mode === 'world') drawWorld();
    else if ((mode === 'battle' && bt) || mode === 'title') {
      if (VH > BAND) {                 // tall screen: carry the scene's sky up and its grass down
        b.drawImage(IMG.battle_bg, 470, 0, 1, 1, 0, 0, VW, top);
        b.drawImage(IMG.battle_bg, 240, BAND - 1, 1, 1, 0, top + BAND, VW, VH - top - BAND);
      }
      b.save(); b.translate(0, top);
      if (mode === 'title') drawTitle(); else drawBattle();
      b.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(S, 0, 0, S, 0, top * S);        // everything below is laid out inside the band
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
    setupTouch();
    resize();
    requestAnimationFrame(frame);
    MAPS = buildMaps();
    try { await Promise.all(allImages().map(loadImage)); }
    catch (e) { console.error(e); document.getElementById('hint').textContent = e.message; return; }
    await title();
  }
  window.addEventListener('beforeunload', () => { if (mode === 'world' && !busy) save(); });
  // phones often close a page without "beforeunload", so also save when it goes to the background
  document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'world' && !busy) save(); });

  // for testing from the browser console
  window.GAME = {
    get state() { return { mode, busy, G, pl, bt, msg: ui.msg ? ui.msg.pages.map((p) => p.map((l) => l.join('')).join('\n')).join('\n') : null,
      menu: ui.menu ? { index: ui.menu.index, opts: ui.menu.opts.map((o) => o.label) } : null, prompt: ui.prompt }; },
    press, map: () => MAP, maps: () => MAPS,
    warp(c, r, mapId) { if (mapId) setMap(mapId); pl.c = c; pl.r = r; pl.moving = false; },
    hold(dir, on) { holdDir('test', dir, on); },
    pollPad: pollGamepad, inputMode: () => inputMode,
    // run the game for a number of seconds without waiting for the screen to refresh
    async advance(seconds) {
      const turn = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
      for (let t = 0; t < seconds; t += 1 / 60) { tick(1 / 60); await turn(); }
      render();
    },
  };

  boot();
})();
