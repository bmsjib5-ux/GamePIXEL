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
      'chars/npc_gym_leader', 'chars/npc_gym_hiker', 'chars/npc_gym_kid',
      'chars/npc_gym2_leader', 'chars/npc_gym2_rower', 'chars/npc_gym2_swimmer'];
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
  const nm = (m) => m.nick || SPECIES[m.sp].name;     // the nickname, or the species' name
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
          caught: [], flags: {}, steps: 0, gold: GOLD_START };
  }
  // fills in what older saves did not have yet
  function upgradeSave() {
    if (typeof G.gold !== 'number') G.gold = GOLD_START;
    for (const id of Object.keys(ITEMS)) if (typeof G.bag[id] !== 'number') G.bag[id] = 0;
    if (G.flags.badge1 && !G.flags.stones1) { G.flags.stones1 = true; G.bag.stone_rock += GYM_STONES; }
    if (G.flags.badge2 && !G.flags.stones2) { G.flags.stones2 = true; G.bag.stone_water += GYM_STONES; }
  }
  const rarityOf = (sp) => RARITY[SPECIES[sp].rarity || 'common'];
  // can this monster evolve now? (level reached, and the gym stone in the bag if it needs one)
  function canEvolve(m) {
    const evo = SPECIES[m.sp].evolve;
    return !!evo && m.level >= evo.level && (!evo.item || G.bag[evo.item] > 0);
  }
  const itemCount = (kind) => Object.keys(ITEMS).filter((id) => ITEMS[id].kind === kind)
    .reduce((n, id) => n + G.bag[id], 0);
  function save() {
    if (!G || !pl) return;
    G.player = { map: MAP.id, c: pl.c, r: pl.r, dir: pl.dir };
    G.savedAt = Date.now();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(G)); } catch (e) { /* storage unavailable */ }
    if (typeof ONLINE !== 'undefined') ONLINE.queueUpload(G);
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

  // Fit one line into maxW: try smaller sizes down to minPx, then cut it short with "…".
  // Returns the text and the size to draw it at (the font is left set to that size).
  function fitText(str, maxW, px, bold, minPx = px) {
    str = String(str);
    for (let p = px; p >= minPx; p--) {
      setFont(p, bold);
      if (ctx.measureText(str).width <= maxW) return { s: str, px: p };
    }
    const g = graphemes(str);
    while (g.length > 1 && ctx.measureText(g.join('') + '…').width > maxW) g.pop();
    return { s: g.join('') + '…', px: minPx };
  }
  // the width a menu needs to show all of its text
  function menuNeed(opts, o, cols) {
    let row = 0;
    for (const x of opts) {
      setFont(13); let w = ctx.measureText(x.label).width + 26;
      if (x.badge) { setFont(10, true); w += ctx.measureText(TYPES[x.badge].name).width + 18; }
      if (x.right) { setFont(11); w += ctx.measureText(x.right).width + 6; }
      if (x.hp) w += 158;
      if (x.sub) { setFont(10); w = Math.max(w, ctx.measureText(x.sub).width + 26); }
      row = Math.max(row, w);
    }
    let need = row * cols + 16;
    if (o.title) { setFont(13, true); need = Math.max(need, ctx.measureText(o.title).width + 28); }
    if (o.footer) { setFont(11); need = Math.max(need, ctx.measureText(o.footer).width + 28); }
    return Math.ceil(need);
  }

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
  // ---- typing a line of text (the hero's name): an HTML box over the game, so phone
  // keyboards work. Resolves with the text, or null when cancelled.
  let textOpen = false;
  function askText(title, value, maxLen, hint) {
    const box = document.getElementById('nameBox'), input = document.getElementById('nameInput');
    const ok = document.getElementById('nameOk'), cancel = document.getElementById('nameCancel');
    document.getElementById('nameTitle').textContent = title;
    document.getElementById('nameHint').textContent = hint || '';
    input.maxLength = maxLen; input.value = value || '';
    input.placeholder = 'สูงสุด ' + maxLen + ' ตัวอักษร';
    box.hidden = false; textOpen = true;
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return new Promise((resolve) => {
      const done = (v) => {
        box.hidden = true; textOpen = false; input.blur();
        ok.onclick = cancel.onclick = null; box.onkeydown = null;
        resolve(v);
      };
      ok.onclick = () => done(input.value.replace(/\s+/g, ' ').trim().slice(0, maxLen));
      cancel.onclick = () => done(null);
      box.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') ok.onclick();
        if (ev.key === 'Escape') done(null);
      };
    });
  }
  const DEFAULT_NAME = 'ต้นกล้า';
  async function askNick(m) {
    const v = await askText('ชื่อเล่นของ' + SPECIES[m.sp].name, m.nick || '', 10, 'สูงสุด 10 ตัว · เว้นว่างไว้ = เรียกว่า' + SPECIES[m.sp].name);
    if (v === null) return false;
    if (v && v !== SPECIES[m.sp].name) m.nick = v; else delete m.nick;
    return true;
  }
  async function askHeroName(first) {
    const v = await askText(first ? 'ชื่อของคุณคืออะไร?' : 'เปลี่ยนชื่อตัวละคร', G.name || '', 12, 'เว้นว่างไว้ = ' + DEFAULT_NAME);
    if (v === null && !first) return false;
    G.name = v || G.name || DEFAULT_NAME;
    save();
    return true;
  }

  function say(text) {
    return new Promise((resolve) => {
      text = String(text).split('{ชื่อ}').join((G && G.name) || DEFAULT_NAME);
      const lines = wrap(text, 436, 13).map(graphemes);
      const pages = [];
      for (let i = 0; i < lines.length; i += 3) pages.push(lines.slice(i, i + 3));
      ui.msg = { pages, page: 0, shown: 0, resolve };
    });
  }
  const pageLength = (p) => p.reduce((n, l) => n + l.length, 0);

  // the given index, or the nearest choice after (then before) it that can be taken
  function firstOpen(opts, at) {
    for (let i = at; i < opts.length; i++) if (!opts[i].disabled) return i;
    for (let i = at - 1; i >= 0; i--) if (!opts[i].disabled) return i;
    return at;
  }
  // A menu. Resolves with the chosen index, or -1 when cancelled.
  function choose(options, o = {}) {
    return new Promise((resolve) => {
      const opts = options.map((x) => typeof x === 'string' ? { label: x } : x);
      const cols = o.cols || 1, rowH = o.rowH || 22;
      const rows = Math.ceil(opts.length / cols);
      const titleH = o.title ? 22 : 0, footH = o.footer ? 20 : 0;
      const h = Math.max(o.minH || 0, rows * rowH + 14 + titleH + footH);
      const w0 = o.w || 150, w = Math.max(w0, Math.min(menuNeed(opts, o, cols), o.maxW || VW - 8));
      // a wider menu grows to both sides, but stays on the screen
      const x = o.x === undefined ? VW - w - 8 : Math.max(4, Math.min((o.maxRight || VW - 4) - w, Math.round(o.x - (w - w0) / 2)));
      ui.menu = {
        opts, cols, rowH, w, h, titleH, title: o.title, footer: o.footer,
        x, y: o.y !== undefined ? o.y : 228 - h,
        index: firstOpen(opts, Math.min(o.start || 0, opts.length - 1)), cancellable: !!o.cancellable, onMove: o.onMove, resolve,
        kind: o.kind, data: o.data,
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

  const typing = (ev) => ONLINE.formOpen || textOpen || (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName));
  window.addEventListener('keydown', (ev) => {
    if (typing(ev)) return;
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
    if (!gp || ONLINE.formOpen || textOpen) { setVirtualDir('stick', stick, null); return; }
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
        if (m.opts[i].disabled) { AUDIO.sfx('bump'); return; }
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
      const stepBy = k === 'up' ? -m.cols : k === 'down' ? m.cols : k === 'left' && m.cols > 1 ? -1 : k === 'right' && m.cols > 1 ? 1 : 0;
      if (stepBy) {
        i += stepBy;
        while (i >= 0 && i < n && m.opts[i].disabled) i += stepBy;   // skip what cannot be chosen
        if (i < 0 || i >= n) i = m.index;
      } else if (k === 'ok' && !repeat) {
        if (m.opts[m.index].disabled) { AUDIO.sfx('bump'); return; }
        AUDIO.sfx('confirm');
        ui.menu = null; m.resolve(m.index); return;
      } else if (k === 'back' && !repeat && m.cancellable) { AUDIO.sfx('cancel'); ui.menu = null; m.resolve(-1); return; }
      if (i !== m.index && i >= 0 && i < n) { m.index = i; AUDIO.sfx('cursor'); if (m.onMove) m.onMove(i); }
      return;
    }
    if (ui.msg) {
      if (repeat || (k !== 'ok' && k !== 'back')) return;
      const m = ui.msg, len = pageLength(m.pages[m.page]);
      if (m.shown < len) m.shown = len;
      else if (m.page < m.pages.length - 1) { m.page++; m.shown = 0; }
      else { AUDIO.sfx('blip'); ui.msg = null; m.resolve(); }
      return;
    }
    if (mode === 'world' && !busy && !pl.moving && !repeat) {
      if (k === 'ok') examine();
      else if (k === 'back') run(teamScreen);
    }
  }

  // --------------------------------------------------------------- overworld
  // background tune of each map: the routes and the Rock Gym have their own, the rest share the village's
  const mapMusic = () => AUDIO.music(['route1', 'route2', 'gym', 'ruins'].includes(MAP.id) ? 'route' : 'village');
  function setMap(id) {
    MAP = MAPS[id] || MAPS.village;
    if (mode !== 'battle') mapMusic();
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
    if (door) { AUDIO.sfx('door'); run(() => travel(door)); return; }
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
        await say('ยินดีต้อนรับ {ชื่อ}! มาตรงเวลาเลยนะ\nฉันคือศาสตราจารย์สน ศึกษามอนสเตอร์อยู่ที่ศูนย์วิจัยโดมกระจกหลังนี้');
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
        if (await yesNo('จะตั้งชื่อเล่นให้' + SPECIES[sp].name + 'ไหม?')) {
          if (await askNick(G.party[0])) await say('ต่อไปนี้' + SPECIES[sp].name + 'ชื่อ ' + nm(G.party[0]) + ' แล้ว!');
        }
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
      await say('ศูนย์รักษายินดีต้อนรับค่ะ คุณ{ชื่อ}\nให้ฉันดูแลมอนสเตอร์ของคุณนะคะ');
      if (!G.party.length) { await say('อ้าว เธอยังไม่มีมอนสเตอร์นี่นา ไปหาศาสตราจารย์สนก่อนสิ'); return; }
      await fadeTo(0.6, 250); healParty(); AUDIO.sfx('heal'); await wait(350); await fadeTo(0, 250);
      G.healSpot = { map: MAP.id, c: HEAL_SPOT.c, r: HEAL_SPOT.r, dir: 'up' };   // wake up here after a loss
      await say('เรียบร้อย! ทุกตัวแข็งแรงเต็มที่แล้ว');
      save();
    },

    async shopkeeper() { await shop('ร้านต้นกล้ายินดีต้อนรับ! วันนี้รับอะไรดีจ๊ะ?'); },
    async vendor() { await shop('พ่อค้าเร่มาแล้วจ้า! ของครบเหมือนร้านในหมู่บ้าน ราคาเดียวกันเลย'); },

    async rival() {
      if (!G.flags.starter) { await say('นายยังไม่มีมอนสเตอร์เหรอ?\nไปหาศาสตราจารย์สนที่ลานกลางหมู่บ้านก่อนสิ'); return; }
      if (G.flags.rivalBeaten) { await say('ครั้งหน้าฉันไม่แพ้แน่! เจอกันที่เส้นทางที่ 1'); return; }
      if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของนายหมดแรงหมดแล้ว ไปศูนย์รักษาก่อนเถอะ'); return; }
      await say('นายคือ{ชื่อ}ใช่ไหม? ฉันชื่อพายุ!\nได้มอนสเตอร์มาจากศาสตราจารย์เหมือนกัน มาประลองกันหน่อย!');
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
      await say('มาถึงจนได้นะ {ชื่อ}! ฉันฝึกที่นี่จนเก่งขึ้นเยอะแล้ว\nคราวนี้ฉันมีสองตัว รับมือให้ได้ล่ะ!');
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
    async gym_hiker() { await gymTrainer(GYM.hiker, 'gym_hiker',
      'โฮ่! ผู้ท้าชิงคนใหม่สินะ จะไปถึงหัวหน้ายิมต้องผ่านฉันไปก่อน!',
      'แรงดีไม่มีตก! ผ่านไปได้เลย แต่คนข้างในเก่งกว่าฉันนะ',
      'ฝึกปีนเขาทุกวันขาจะแข็งแรง มอนสเตอร์ก็เหมือนกัน'); },
    async gym_kid() { await gymTrainer(GYM.kid, 'gym_kid',
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
      G.flags.stones1 = true; G.bag.stone_rock += GYM_STONES;
      await say('ยอดเยี่ยม {ชื่อ}! เธอแข็งแกร่งจริง ๆ\nรับเหรียญศิลานี้ไป เป็นหลักฐานว่าเธอชนะยิมแห่งนี้');
      await say('ได้รับเหรียญศิลา ยา 3 ขวด และหินวิวัฒน์ศิลา ' + GYM_STONES + ' ก้อน!');
      await say('หินวิวัฒน์ศิลาช่วยให้มอนสเตอร์หายากวิวัฒนาการได้\nเมื่อถึงเลเวล มันจะวิวัฒนาการหลังชนะการต่อสู้ครั้งถัดไป');
      await say('ยินดีด้วย! คุณผ่านด่าน 2 แล้ว\nด่านตรวจทางใต้ของเส้นทางที่ 1 จะเปิดทางไปด่าน 3 ให้');
      save();
    },
    async gym_books() { await say('ตำรายิมศิลา\n"ธาตุหินชนะทางไฟ ไฟฟ้า และปกติ แต่แพ้ทางน้ำกับพืช"'); },
    async sign_gym() { await say('ยิมศิลา\nชนะหัวหน้ายิมเพื่อรับเหรียญศิลา ใช้ผ่านด่านตรวจไปด่าน 3'); },

    async spring() {
      await say('น้ำพุใสเย็นไหลออกมาจากบ่อหิน\nมอนสเตอร์ทั้งทีมได้ดื่มน้ำจนสดชื่น');
      if (!G.party.length) return;
      await fadeTo(0.6, 250); healParty(); AUDIO.sfx('heal'); await wait(350); await fadeTo(0, 250);
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

    // ---- Bang Bua town and the Water Gym (stage 4)
    async gym2_swimmer() { await gymTrainer(GYM2.swimmer, 'gym2_swimmer',
      'ว่ายน้ำทุกเช้าจนตัวเบาเป็นปลา! มอนสเตอร์น้ำของหนูก็ปราดเปรียวเหมือนกัน',
      'แพ้แล้ว... ขอไปว่ายน้ำคลายเครียดก่อนนะ ผ่านไปได้เลย',
      'ธาตุน้ำแพ้ทางพืชกับไฟฟ้านะ จำไว้ให้ดีล่ะ'); },
    async gym2_rower() { await gymTrainer(GYM2.rower, 'gym2_rower',
      'พายเรือส่งของในคลองมาสามสิบปี แรงแขนลุงยังดีอยู่! มาลองกันหน่อย',
      'ฮ่า ๆ เก่งจริง! หัวหน้ายิมรออยู่ข้างใน เธอเก่งกว่าลุงอีกนะ',
      'หัวหน้ายิมชอบใช้มอนสเตอร์ที่ทนทาน เตรียมยาไปให้พอ'); },
    async gym2_leader() {
      const g = GYM2.leader;
      if (G.flags[g.flag]) { await say('เหรียญวารีเหมาะกับเธอมาก\nทางใต้ของตลาดคือซากเมืองโบราณ (ด่าน 5) ขอให้โชคดีนะ'); return; }
      if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของเธอหมดแรงหมดแล้ว ไปพักที่ศูนย์รักษาข้างตลาดก่อนเถอะ'); return; }
      await say('ยินดีต้อนรับสู่ยิมวารี! ฉันคือบัวน้ำ หัวหน้ายิมแห่งนี้');
      await say('สายน้ำดูอ่อนโยน แต่กัดเซาะได้แม้แต่หินผา\nมาดูกันว่าเธอจะรับมือกระแสน้ำของฉันได้ไหม!');
      const result = await battle(g.team.map(([sp, lv]) => makeMon(sp, lv)), { name: g.name, sheet: 'chars/npc_gym2_leader' });
      if (result !== 'win') return;
      G.flags[g.flag] = true;
      G.bag.potion_plus += 3;
      G.flags.stones2 = true; G.bag.stone_water += GYM_STONES;
      await say('สุดยอดเลย {ชื่อ}! เธอไหลไปกับกระแสได้อย่างงดงาม\nรับเหรียญวารีนี้ไป เป็นหลักฐานว่าเธอชนะยิมแห่งนี้');
      await say('ได้รับเหรียญวารี ยาชั้นดี 3 ขวด และหินวิวัฒน์วารี ' + GYM_STONES + ' ก้อน!');
      await say('ยินดีด้วย! คุณผ่านด่าน 4 แล้ว\nทางใต้ของตลาดคือด่าน 5 ซากเมืองโบราณ');
      save();
    },
    async gym2_books() { await say('ตำรายิมวารี\n"ธาตุน้ำชนะไฟและหิน แต่แพ้ทางพืชกับไฟฟ้า"'); },
    async sign_t4_top() { await say('ตลาดน้ำบางบัว\nทิศเหนือ : เส้นทางที่ 2   ทิศใต้ : ซากเมืองโบราณ (ด่าน 5)'); },
    async sign_t4_market() { await say('ลานตลาดน้ำ\nตะวันตก : ศูนย์รักษา   ตะวันออก : ยิมวารี'); },
    async sign_t4_end() { await say('ทิศใต้ : ซากเมืองโบราณ (ด่าน 5)\nต้องมีเหรียญวารีจากยิมจึงจะผ่านได้'); },
    async t4_crate_a() {
      if (G.flags.t4a) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.t4a = true; G.bag.capsule_gold += 3;
      await say('เปิดลังไม้ดู...\nพบแคปซูลทอง 3 ลูก!'); save();
    },
    async t4_crate_b() {
      if (G.flags.t4b) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.t4b = true; G.bag.potion_plus += 2; G.gold += 500;
      await say('เปิดลังไม้ดู...\nพบยาชั้นดี 2 ขวด และเหรียญทอง 500 ทอง!'); save();
    },

    // ---- the ancient city ruins (stage 5)
    async r5_digger() { await gymTrainer(RUINS_TRAINERS.digger, 'r5_digger',
      'ซากเมืองนี้มีอายุหลายร้อยปี มอนสเตอร์ที่นี่ก็เก่าแก่และแข็งแกร่ง\nขอทดสอบฝีมือเธอหน่อยเถอะ!',
      'ยอดเยี่ยม! เธอแข็งแกร่งพอจะเดินในเมืองเก่านี้ได้แล้ว',
      'ปราสาทหินทางตะวันตกเคยเป็นศูนย์กลางของเมืองนี้ ลองไปดูจารึกที่ป้ายหน้าปราสาทสิ'); },
    async r5_herder() { await gymTrainer(RUINS_TRAINERS.herder, 'r5_herder',
      'ควายของผมแรงเยอะที่สุดในทุ่งนี้! มาประลองกันไหมพี่',
      'แพ้แล้วครับ... เดี๋ยวพาควายไปแช่น้ำในคูเมืองก่อนนะ',
      'พงหญ้าทางใต้มีมอนสเตอร์ร่างสุดท้ายซ่อนอยู่ด้วยนะพี่ ผมเคยเห็นแวบ ๆ'); },
    async rival4() {
      if (G.flags.stage5) { await say('ทางไปด่าน 6 อยู่หลังประตูเมืองเก่านี่แหละ\nแต่ได้ยินว่ายังไปไม่ได้ ไว้รอดูกันนะ!'); return; }
      if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของนายหมดแรงหมดแล้ว ไปดื่มน้ำพุในลานเมืองก่อนเถอะ'); return; }
      await say('มาถึงซากเมืองโบราณจนได้นะ {ชื่อ}! ตั้งแต่แพ้นายครั้งก่อน\nฉันฝึกหนักมาตลอดทางเลยนะ');
      await say('ทีมฉันตอนนี้มีสี่ตัวแล้ว คราวนี้ไม่ยอมแพ้ง่าย ๆ แน่!');
      const team = RIVAL_RUINS.map(([sp, lv]) => makeMon(sp === 'starter3' ? RIVAL_PICK[G.flags.starter] + '3' : sp, lv));
      const result = await battle(team, { name: 'พายุ', img: 'chars/rival_large' });
      if (result !== 'win') return;
      G.flags.stage5 = true;
      G.bag.capsule_gold += 3; G.bag.potion_plus += 3;
      await say('...ยังเป็นนายที่เก่งกว่าอยู่ดี แต่ฉันจะตามให้ทันแน่!');
      await say('ได้รับแคปซูลทอง 3 ลูกและยาชั้นดี 3 ขวด!');
      await say('ยินดีด้วย! คุณผ่านด่าน 5 แล้ว\nทางไปด่าน 6 อยู่หลังประตูเมืองเก่า (จะเปิดในเวอร์ชันถัดไป)');
      save();
    },
    async ruin_prasat() { await say('จารึกบนแผ่นหินเลือนลาง...\n"ณ เมืองนี้ ช้างเผือกแห่งฟ้าเคยลงมาเยือน"'); },
    async sign_t5_top() { await say('ซากเมืองโบราณ\nทิศเหนือ : ตลาดน้ำบางบัว   ทิศใต้ : ประตูเมืองเก่า'); },
    async sign_t5_court() { await say('ลานเมืองเก่า\nน้ำพุยังใช้ฟื้นพลังได้ และมีพ่อค้าเร่แวะมาขายของ'); },
    async sign_t5_end() { await say('ประตูเมืองเก่า ทางไปด่าน 6\nคู่แข่งของคุณรออยู่ตรงนี้'); },
    async t5_crate_a() {
      if (G.flags.t5a) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.t5a = true; G.bag.potion_plus += 3;
      await say('เปิดลังไม้ดู...\nพบยาชั้นดี 3 ขวด!'); save();
    },
    async t5_crate_b() {
      if (G.flags.t5b) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.t5b = true; G.bag.capsule_gold += 3; G.gold += 800;
      await say('เปิดลังไม้ดู...\nพบแคปซูลทอง 3 ลูก และเหรียญทอง 800 ทอง!'); save();
    },

    // ---- Route 2 (stage 3)
    async r2_hiker() { await gymTrainer(ROUTE2_TRAINERS.hiker, 'r2_hiker',
      'ทุ่งผาหินนี้ลมแรงนัก มอนสเตอร์ที่อยู่รอดได้ต้องแกร่งจริง\nมาลองดูว่าทีมเธอแกร่งพอไหม!',
      'โอ้โห แกร่งกว่าหินผาซะอีก! ข้างหน้ายังมีอีกไกล สู้ต่อไปนะ',
      'บึงทางตะวันออกมีมอนสเตอร์น้ำชุกชุม ระวังธาตุไฟของเธอด้วยล่ะ'); },
    async r2_kid() { await gymTrainer(ROUTE2_TRAINERS.kid, 'r2_kid',
      'ตกปลาทั้งวันได้แต่มอนสเตอร์! มาประลองกับหนูหน่อยสิ',
      'แพ้แล้ว... ปลาก็ไม่กินเบ็ด มอนสเตอร์ก็แพ้ วันนี้ซวยจัง',
      'พงหญ้าทางใต้มีมอนสเตอร์ที่วิวัฒนาการแล้วด้วยนะ หนูเคยเห็นแกะเพลิงตัวโตด้วย!'); },
    async rival3() {
      if (G.flags.stage3) { await say('ตลาดน้ำบางบัวอยู่ข้างหน้าแล้ว ที่นั่นมียิมวารีด้วยนะ\nไปท้าประลองให้ได้เหรียญมาอีกเหรียญสิ!'); return; }
      if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของนายหมดแรงหมดแล้ว ไปดื่มน้ำพุฟื้นพลังก่อนเถอะ'); return; }
      await say('ในที่สุดก็มาถึง {ชื่อ}! ฉันรอนายอยู่ตรงนี้นานแล้ว\nคู่หูของฉันวิวัฒนาการจนถึงร่างสุดท้ายแล้วนะ');
      await say('นี่คือการประลองครั้งสุดท้ายของด่านนี้ ทุ่มให้สุดตัวเลย!');
      const team = RIVAL_FINAL.map(([sp, lv]) => makeMon(sp === 'starter3' ? RIVAL_PICK[G.flags.starter] + '3' : sp, lv));
      const result = await battle(team, { name: 'พายุ', img: 'chars/rival_large' });
      if (result !== 'win') return;
      G.flags.stage3 = true;
      G.bag.capsule += 5; G.bag.potion += 5;
      await say('...แพ้อีกจนได้ แต่ครั้งนี้ฉันไม่เสียใจเลย\nนายคือคู่แข่งที่ดีที่สุดของฉัน');
      await say('ได้รับแคปซูล 5 ลูกและยา 5 ขวด!');
      await say('ยินดีด้วย! คุณผ่านด่าน 3 แล้ว\nเดินต่อไปทางใต้คือด่าน 4 ตลาดน้ำบางบัว');
      save();
    },
    async sign_r2_top() { await say('เส้นทางที่ 2  ทุ่งผาหิน\nทิศเหนือ : เส้นทางที่ 1   ทิศใต้ : ตลาดน้ำบางบัว (ด่าน 4)'); },
    async sign_r2_spring() { await say('ลานน้ำพุผาหิน\nสำรวจบ่อน้ำเพื่อฟื้นพลังมอนสเตอร์ได้ทุกเมื่อ'); },
    async sign_r2_end() { await say('ทิศใต้ : ตลาดน้ำบางบัว (ด่าน 4)\nคู่แข่งของคุณรออยู่ตรงทางออก'); },
    async r2_crate_a() {
      if (G.flags.r2a) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.r2a = true; G.bag.capsule += 4;
      await say('เปิดลังไม้ดู...\nพบแคปซูล 4 ลูก!'); save();
    },
    async r2_crate_b() {
      if (G.flags.r2b) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.r2b = true; G.bag.potion += 4;
      await say('เปิดลังไม้ดู...\nพบยา 4 ขวด!'); save();
    },
    async r2_crate_c() {
      if (G.flags.r2c) { await say('ลังไม้ว่างเปล่า'); return; }
      G.flags.r2c = true; G.bag.capsule += 3; G.bag.potion += 3;
      await say('เปิดลังไม้ดู...\nพบแคปซูล 3 ลูกและยา 3 ขวด!'); save();
    },

    async sign_village() { await say('หมู่บ้านต้นกล้า\nทิศใต้ : เส้นทางที่ 1 และพงหญ้าสูง'); },
    async sign_grass() { await say('ระวัง! พงหญ้าสูงมีมอนสเตอร์ป่า\nฝั่งตะวันตกเหมาะกับมือใหม่ ฝั่งตะวันออกมีตัวที่แข็งแกร่งกว่า'); },
    async sign_route() { await say('ทิศใต้ : เส้นทางที่ 1\nมีมอนสเตอร์ชนิดใหม่ที่ไม่พบในหมู่บ้าน'); },
    async well() { await say('น้ำในบ่อใสแจ๋ว มองเห็นก้นบ่อเลย'); },
    async sala() { await say('ศาลาไม้ริมลาน ลมพัดเย็นสบาย\nชาวบ้านมักมานั่งพักคุยกันตอนบ่าย'); },
    async spirit_house() { await say('ศาลพระภูมิประดับพวงมาลัยดาวเรือง\nมีน้ำแดงกับขนมวางไว้อย่างเรียบร้อย'); },
    async food_cart() { await say('รถเข็นขายข้าวเหนียวหมูปิ้งกับลูกชิ้นทอด\nกลิ่นหอมฉุยไปทั้งลาน'); },
    // ---- inside the buildings
    async home_bed() {
      if (!(await yesNo('เตียงของคุณเอง จะนอนพักสักครู่ไหม?'))) return;
      await fadeTo(1, 350); healParty(); AUDIO.sfx('heal'); await wait(500); await fadeTo(0, 350);
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
      const pick = await choose(['กล่องฝากมอนสเตอร์', 'ข้อมูลการวิจัย'], { x: 160, y: 120, w: 200, rowH: 26,
        cancellable: true, title: 'คอมพิวเตอร์ศูนย์วิจัย' });
      if (pick < 0) return;
      if (pick === 0) { await storageBox(); return; }
      const names = goalCaught().map((sp) => SPECIES[sp].name);
      await say('คอมพิวเตอร์บันทึกข้อมูลมอนสเตอร์\nจับได้แล้ว ' + names.length + ' จาก 6 ชนิด' + (names.length ? ' : ' + names.join(' ') : ''));
      if (G.lab.length) await say('มอนสเตอร์ที่ฝากไว้ที่นี่ ' + G.lab.length + ' ตัว : ' + G.lab.map((m) => nm(m) + ' Lv.' + m.level).join(' '));
      if (G.flags.legendMet) await say('บันทึกพิเศษ : พบเห็นมอนสเตอร์ในตำนาน 1 ชนิด\nคชานภา ธาตุตำนาน Lv.∞ (ยังจับไม่ได้)');
    },
    async lab_notes() { await say('บนจอมีบันทึกของศาสตราจารย์สน\n"มอนสเตอร์ที่อ่อนแรงจะจับด้วยแคปซูลได้ง่ายกว่ามาก"'); },
    async lab_tank() { await say('ถังแก้วบรรจุของเหลวสีฟ้าใส มีฟองอากาศลอยขึ้นเป็นระยะ'); },
    async lab_books() { await say('ตำราวิจัยเรียงแน่นเต็มชั้น\n"พงหญ้าฝั่งตะวันออกพบมอนสเตอร์ได้ครบทั้ง 6 ชนิด"'); },
    async lab_table() { await say('โต๊ะทำงานมีแก้วชาที่ดื่มค้างไว้กับกองเอกสาร'); },
    async box_kiosk() { await storageBox(); },
    async heal_machine() {
      await say('เครื่องฟื้นพลังมอนสเตอร์ เชื่อมต่อกับกล่องฝากของศูนย์วิจัย\n(ฟื้นพลังให้ทีม คุยกับพยาบาลที่เคาน์เตอร์)');
      await storageBox();
    },
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

  // Buying: pick an item, then how many. Gold is shown at the bottom of the list.
  async function shop(hello) {
    await say(hello);
    let at = 0;
    for (;;) {
      const stock = SHOP_STOCK.filter((id) => !ITEMS[id].need || G.flags[ITEMS[id].need]);
      const opts = stock.map((id) => ({ label: ITEMS[id].name, right: ITEMS[id].price + ' ทอง',
        sub: ITEMS[id].desc + '  (มีอยู่ ' + G.bag[id] + ')' }));
      const i = await choose(opts, { x: 40, y: 8, w: 400, rowH: 34, cancellable: true, start: at,
        title: 'ร้านค้า  เลือกของที่จะซื้อ', footer: 'เหรียญทองของคุณ : ' + G.gold + ' ทอง' });
      if (i < 0) break;
      at = i;
      const id = stock[i], it = ITEMS[id];
      if (G.gold < it.price) { await say('เหรียญทองไม่พอ... ' + it.name + 'ราคา ' + it.price + ' ทอง\nแต่คุณมี ' + G.gold + ' ทอง'); continue; }
      const amounts = [1, 5, 10];
      const q = await choose(amounts.map((n) => ({ label: n + ' ชิ้น', right: n * it.price + ' ทอง',
        disabled: n * it.price > G.gold })), { x: 150, y: 120, w: 180, rowH: 28, cancellable: true,
        title: 'ซื้อ' + it.name + 'กี่ชิ้น?' });
      if (q < 0 || amounts[q] * it.price > G.gold) continue;
      const n = amounts[q];
      G.gold -= n * it.price;
      G.bag[id] += n;
      AUDIO.sfx('coin');
      await say('ซื้อ' + it.name + ' ' + n + ' ชิ้น จ่ายไป ' + n * it.price + ' ทอง\nเหลือเหรียญทอง ' + G.gold + ' ทอง');
    }
    await say('ขอบคุณที่อุดหนุนนะ แวะมาใหม่ล่ะ!');
    save();
  }

  // A trainer who fights once. Gym trainers block the way and step aside for good once
  // beaten (their map entry has a "moved" spot); trainers on a route just stay where they are.
  async function gymTrainer(g, npcId, hello, beaten, later) {
    if (G.flags[g.flag]) { await say(later); return; }
    if (!G.party.some((m) => m.hp > 0)) { await say('มอนสเตอร์ของเธอหมดแรงหมดแล้ว ไปฟื้นพลังที่ลานน้ำพุก่อนเถอะ'); return; }
    await say(hello);
    const npc = npcs.find((n) => n.id === npcId);
    const result = await battle(g.team.map(([sp, lv]) => makeMon(sp, lv)), { name: g.name, sheet: npc.sheet });
    if (result !== 'win') return;
    G.flags[g.flag] = true;
    await say(beaten);
    const spot = MAP.npcs.find((n) => n.id === npcId).moved;
    if (!spot) { save(); return; }
    await fadeTo(1, 160);
    const here = npcs.find((n) => n.id === npcId);
    if (here) { here.c = spot.c; here.r = spot.r; here.dir = spot.dir; }
    await fadeTo(0, 160);
    save();
  }

  // ---- the storage box: monsters caught while the team was full wait here (G.lab).
  // Open at the research lab's computer or the healing machine of any healing centre.
  const monOption = (m) => ({ label: nm(m) + ' ' + rarityOf(m.sp).stars + '  Lv.' + m.level,
    badge: SPECIES[m.sp].type, hp: [m.hp, stats(m).hp] });
  // Pick one monster from a list, six per page. Returns its index, or -1 when backed out.
  async function pickFromList(list, title) {
    const PER = 6, pages = Math.max(1, Math.ceil(list.length / PER));
    let page = 0;
    for (;;) {
      const part = list.slice(page * PER, page * PER + PER);
      const opts = part.map(monOption);
      if (pages > 1) opts.push({ label: '◀ หน้าก่อน', disabled: page === 0 }, { label: 'หน้าถัดไป ▶', disabled: page === pages - 1 });
      const i = await choose(opts, { x: 50, y: 12, w: 380, rowH: 30, cancellable: true, title,
        footer: pages > 1 ? 'หน้า ' + (page + 1) + ' / ' + pages + '   (ทั้งหมด ' + list.length + ' ตัว)' : 'ทั้งหมด ' + list.length + ' ตัว' });
      if (i < 0) return -1;
      if (i === part.length) { page--; continue; }
      if (i === part.length + 1) { page++; continue; }
      return page * PER + i;
    }
  }
  // show the monster's card and ask to go ahead
  async function confirmWithCard(m, yes) {
    ui.card = m;
    const pick = await choose([yes, 'กลับ'], { x: 212, y: 262, w: 220, maxW: 376, maxRight: 432, cols: 2, rowH: 24, cancellable: true });
    ui.card = null;
    return pick === 0;
  }
  async function storageBox() {
    await say('เปิดกล่องฝากมอนสเตอร์ของศูนย์วิจัย\nมอนสเตอร์ที่ฝากไว้จะได้พักจนพลังชีวิตเต็ม');
    let at = 0;
    for (;;) {
      const i = await choose(['ถอนมอนสเตอร์ออกมา', 'ฝากมอนสเตอร์', 'สลับตัว (ทีม ⇄ กล่อง)', 'ออก'], {
        x: 120, y: 60, w: 240, rowH: 28, cancellable: true, start: at,
        title: 'กล่องฝากมอนสเตอร์', footer: 'ทีม ' + G.party.length + '/' + PARTY_MAX + '   ในกล่อง ' + G.lab.length + ' ตัว' });
      if (i < 0 || i === 3) break;
      at = i;
      if (i === 0) {                                   // withdraw
        if (!G.lab.length) { await say('ในกล่องยังไม่มีมอนสเตอร์'); continue; }
        if (G.party.length >= PARTY_MAX) { await say('ทีมเต็มแล้ว (' + PARTY_MAX + ' ตัว)\nใช้ "สลับตัว" หรือฝากตัวในทีมก่อนนะ'); continue; }
        const k = await pickFromList(G.lab, 'เลือกตัวที่จะถอนออกมา');
        if (k < 0) continue;
        const m = G.lab[k];
        if (!(await confirmWithCard(m, 'ถอนเข้าทีม'))) continue;
        G.lab.splice(k, 1); G.party.push(m);
        AUDIO.sfx('confirm');
        await say(nm(m) + 'เข้าร่วมทีมแล้ว!');
      } else if (i === 1) {                            // deposit
        if (G.party.length <= 1) { await say('ต้องมีมอนสเตอร์ในทีมอย่างน้อย 1 ตัว'); continue; }
        const k = await pickFromList(G.party, 'เลือกตัวที่จะฝากไว้');
        if (k < 0) continue;
        const m = G.party[k];
        if (G.party.length === 2 && G.party.some((x) => x !== m && x.hp <= 0) ) {
          await say('ถ้าฝาก' + nm(m) + ' ทีมจะเหลือแต่ตัวที่หมดแรง\nไปรักษาก่อนแล้วค่อยฝากนะ'); continue;
        }
        if (!(await confirmWithCard(m, 'ฝากไว้'))) continue;
        G.party.splice(k, 1); m.hp = stats(m).hp; G.lab.push(m);
        AUDIO.sfx('confirm');
        await say('ฝาก' + nm(m) + 'ไว้ในกล่องแล้ว');
      } else {                                         // swap
        if (!G.lab.length) { await say('ในกล่องยังไม่มีมอนสเตอร์ให้สลับ'); continue; }
        const a = await pickFromList(G.party, 'เลือกตัวในทีมที่จะส่งเข้ากล่อง');
        if (a < 0) continue;
        const b = await pickFromList(G.lab, 'เลือกตัวในกล่องที่จะนำออกมาแทน' + nm(G.party[a]));
        if (b < 0) continue;
        const out = G.party[a], inn = G.lab[b];
        if (!(await confirmWithCard(inn, 'สลับกับ' + nm(out)))) continue;
        out.hp = stats(out).hp;
        G.party[a] = inn; G.lab[b] = out;
        AUDIO.sfx('confirm');
        await say(nm(inn) + 'เข้าทีมแทน' + nm(out) + 'แล้ว\n' + nm(out) + 'ไปพักในกล่อง');
      }
    }
    save();
  }

  // ------------------------------------------------------------ online: account, cloud save, leaderboard
  const STAGE_NAMES = ['ยังไม่ผ่านด่าน', 'ผ่านด่าน 1', 'ผ่านด่าน 2', 'ผ่านด่าน 3', 'ผ่านด่าน 4', 'ผ่านด่าน 5'];
  const whenText = (iso) => { try { return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return String(iso); } };
  // run a network call with a "connecting" line on screen; returns null after showing the error
  async function online(fn) {
    ui.prompt = 'กำลังเชื่อมต่อเซิร์ฟเวอร์...\n(ถ้าเซิร์ฟเวอร์หลับอยู่ อาจใช้เวลาเกือบนาที)';
    try { return await fn(); }
    catch (e) { ui.prompt = null; await say('ออนไลน์ไม่สำเร็จ: ' + e.message); return null; }
    finally { ui.prompt = null; }
  }

  async function leaderboardScreen(start) {
    let by = start || 'progress';
    const NEXT = { progress: 'caught', caught: 'pvp', pvp: 'progress' };
    const TITLE = { progress: 'ความคืบหน้า', caught: 'สะสมมอนสเตอร์', pvp: 'นักสู้ออนไลน์' };
    for (;;) {
      const data = await online(() => ONLINE.leaderboard(by));
      if (!data) return;
      const rows = data.rows.slice(0, 10);
      const rightOf = (r) => by === 'pvp' ? 'คะแนน ' + r.rating + ' · ชนะ ' + r.wins + ' แพ้ ' + r.losses
        : by === 'caught' ? 'จับได้ ' + r.caught + ' ชนิด' : STAGE_NAMES[r.stage] + ' · จับ ' + r.caught;
      const opts = rows.map((r) => ({ label: r.rank + '.  ' + r.username, right: rightOf(r) }));
      if (!rows.length) opts.push({ label: 'ยังไม่มีใครอยู่ในตาราง', disabled: true });
      opts.push({ label: '⇄ ดูอันดับ' + TITLE[NEXT[by]] }, { label: 'กลับ' });
      const me = data.me ? 'อันดับของคุณ : ' + data.me.rank + '   (' + rightOf(data.me) + ')'
                         : by === 'pvp' ? 'ต่อสู้ออนไลน์เพื่อเข้าตารางนี้'
                         : (ONLINE.loggedIn ? 'บันทึกเซฟขึ้นคลาวด์เพื่อเข้าตารางอันดับ' : 'เข้าสู่ระบบแล้วบันทึกเซฟเพื่อเข้าตารางอันดับ');
      const i = await choose(opts, { x: 40, y: 8, w: 400, rowH: 22, cancellable: true, start: opts.length - 2,
        title: 'ตารางอันดับ : ' + TITLE[by], footer: me });
      if (i < 0 || i === opts.length - 1) return;
      if (i === opts.length - 2) by = NEXT[by];
    }
  }

  // The online menu. On the title screen it can load the cloud save (returns that save to start
  // from); in the game it can upload the current save.
  async function onlineMenu(fromTitle) {
    for (;;) {
      if (!ONLINE.loggedIn) {
        const i = await choose(['เข้าสู่ระบบ / สมัครสมาชิก', 'ตารางอันดับ', 'กลับ'], { x: 130, y: 96, w: 220, rowH: 26,
          cancellable: true, title: 'ออนไลน์', footer: 'เซฟบนคลาวด์ เล่นต่อได้ทุกเครื่อง' });
        if (i < 0 || i === 2) return null;
        if (i === 1) { await leaderboardScreen(); continue; }
        if (!(await ONLINE.form())) continue;
        await say('เข้าสู่ระบบแล้ว สวัสดี ' + ONLINE.username + '!');
        // first time on this device: see whether the account already keeps a save
        const cloud = await online(() => ONLINE.download());
        if (cloud && !cloud.save) {
          if (!fromTitle) { await online(() => ONLINE.uploadNow(G)); await say('บันทึกเซฟนี้ขึ้นคลาวด์แล้ว\nต่อจากนี้เกมจะบันทึกขึ้นคลาวด์ให้อัตโนมัติ'); }
          else await say('บัญชีนี้ยังไม่มีเซฟบนคลาวด์\nเริ่มเล่นแล้วเลือก "บันทึกขึ้นคลาวด์" ในเมนูทีม หรือที่หน้านี้');
        } else if (cloud && cloud.save) {
          await say('บัญชีนี้มีเซฟบนคลาวด์ (บันทึกเมื่อ ' + whenText(cloud.savedAt) + ')' +
            (fromTitle ? '\nเลือก "โหลดเซฟจากคลาวด์" เพื่อเล่นต่อ' : '\nถ้าจะเล่นเซฟนั้น ให้กลับหน้าแรกแล้วเลือกโหลดเซฟจากคลาวด์'));
        }
        continue;
      }
      const opts = fromTitle
        ? ['โหลดเซฟจากคลาวด์', 'อัปโหลดเซฟในเครื่องขึ้นคลาวด์', 'ตารางอันดับ', 'ออกจากระบบ', 'กลับ']
        : ['บันทึกขึ้นคลาวด์ตอนนี้', 'ต่อสู้ออนไลน์', 'แลกเปลี่ยนมอนสเตอร์', 'ตารางอันดับ', 'ออกจากระบบ', 'กลับ'];
      const i = await choose(opts, { x: 120, y: 70, w: 240, rowH: 26, cancellable: true,
        title: 'ออนไลน์ : ' + ONLINE.username,
        footer: ONLINE.linked ? 'บันทึกขึ้นคลาวด์อัตโนมัติ : เปิด' : 'ยังไม่ได้เชื่อมเซฟกับบัญชี' });
      const what = i < 0 ? 'back' : opts[i];
      if (what === 'กลับ' || what === 'back') return null;
      if (what === 'ตารางอันดับ') { await leaderboardScreen(); continue; }
      if (what === 'แลกเปลี่ยนมอนสเตอร์') { await tradeMenu(); continue; }
      if (what === 'ต่อสู้ออนไลน์') { await fightMenu(); continue; }
      if (what === 'ออกจากระบบ') {
        if (!(await yesNo('ออกจากระบบ ' + ONLINE.username + ' ใช่ไหม?'))) continue;
        await online(() => ONLINE.logout());
        await say('ออกจากระบบแล้ว (เซฟในเครื่องยังอยู่ครบ)');
        continue;
      }
      if (what === 'โหลดเซฟจากคลาวด์') {
        const cloud = await online(() => ONLINE.download());
        if (!cloud) continue;
        if (!cloud.save) { await say('บัญชีนี้ยังไม่มีเซฟบนคลาวด์'); continue; }
        const local = loadSave();
        if (!(await yesNo('โหลดเซฟบนคลาวด์ (บันทึกเมื่อ ' + whenText(cloud.savedAt) + ')' +
          (local ? '\nเซฟในเครื่องนี้จะถูกแทนที่ ใช่ไหม?' : ' ใช่ไหม?')))) continue;
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(cloud.save)); } catch (e) { /* storage unavailable */ }
        ONLINE.link(true);
        return cloud.save;
      }
      // upload: the save in this browser (title) or the game being played
      let save = fromTitle ? loadSave() : (save0(), G);
      if (!save) { await say('ยังไม่มีเซฟในเครื่องนี้'); continue; }
      const cloud = await online(() => ONLINE.download());
      if (!cloud) continue;
      if (cloud.save && !ONLINE.linked &&
          !(await yesNo('บัญชีนี้มีเซฟบนคลาวด์อยู่แล้ว (บันทึกเมื่อ ' + whenText(cloud.savedAt) + ')\nจะเขียนทับด้วยเซฟนี้ ใช่ไหม?'))) continue;
      if (await online(() => ONLINE.uploadNow(save))) await say('บันทึกขึ้นคลาวด์แล้ว!\nต่อจากนี้เกมจะบันทึกขึ้นคลาวด์ให้อัตโนมัติ');
    }
  }
  const save0 = () => save();

  // ---- trading monsters online, with a code: put one up (it waits on the server), a friend
  // enters the code and gives one back, then the first player collects it.
  const monText = (m) => m.nick ? m.nick + ' (' + SPECIES[m.sp].name + ')' : SPECIES[m.sp].name;
  // only monsters this version of the game knows can arrive
  const knownMon = (m) => !!(m && SPECIES[m.sp] && Array.isArray(m.moves) && m.moves.every((id) => MOVES[id]));
  function receiveMon(m) {
    const mon = { sp: m.sp, level: m.level, exp: m.exp, hp: 0, moves: m.moves.slice() };
    if (m.nick) mon.nick = m.nick;
    mon.hp = stats(mon).hp;
    noteCaught(mon.sp);
    if (G.party.length < PARTY_MAX) { G.party.push(mon); return 'ทีม'; }
    G.lab.push(mon); return 'กล่องฝากมอนสเตอร์';
  }
  // every monster the player owns: the team first, then the box
  const allMine = () => G.party.map((m) => ({ m, where: 'party' })).concat(G.lab.map((m) => ({ m, where: 'lab' })));
  function takeMine(entry) {
    const list = entry.where === 'party' ? G.party : G.lab;
    list.splice(list.indexOf(entry.m), 1);
  }
  async function pickMineToTrade(title) {
    const all = allMine();
    const k = await pickFromList(all.map((e) => e.m), title);
    if (k < 0) return null;
    const e = all[k];
    if (e.where === 'party' && G.party.length <= 1) { await say('ต้องเหลือมอนสเตอร์ในทีมอย่างน้อย 1 ตัว'); return null; }
    return e;
  }
  async function afterTrade() {
    save();
    if (ONLINE.linked) { try { await ONLINE.uploadNow(G); } catch (e) { /* the regular upload will retry */ } }
  }
  async function collectTrades(list) {
    for (const t of list.filter((x) => x.status === 'accepted')) {
      const got = await online(() => ONLINE.tradeClaim(t.code));
      if (!got) continue;
      if (!knownMon(got.mon)) { await say('ได้รับมอนสเตอร์ที่เกมเวอร์ชันนี้ยังไม่รู้จัก\nรีเฟรชหน้าเกมแล้วลองใหม่'); continue; }
      const where = receiveMon(got.mon);
      AUDIO.sfx('caught');
      await say((t.partner || 'เพื่อน') + ' รับข้อเสนอ ' + t.code + ' แล้ว!\nได้รับ' + monText(got.mon) + ' Lv.' + got.mon.level + ' (ไปอยู่ใน' + where + ')');
      await afterTrade();
    }
  }
  async function tradeMenu() {
    for (;;) {
      const data = await online(() => ONLINE.tradeList());
      if (!data) return;
      if (data.trades.some((t) => t.status === 'accepted')) { await collectTrades(data.trades); continue; }
      const open = data.trades.filter((t) => t.status === 'open');
      const i = await choose(['เสนอแลกมอนสเตอร์ (สร้างรหัส)', 'ใส่รหัสแลกจากเพื่อน', 'ข้อเสนอของฉัน (' + open.length + ')', 'กลับ'],
        { x: 110, y: 70, w: 260, rowH: 28, cancellable: true, title: 'แลกเปลี่ยนมอนสเตอร์',
          footer: 'มอนสเตอร์ที่เสนอจะฝากไว้บนเซิร์ฟเวอร์จนกว่าจะมีคนรับ' });
      if (i < 0 || i === 3) return;

      if (i === 0) {                                   // put one up for trade
        const e = await pickMineToTrade('เลือกตัวที่จะนำไปแลก');
        if (!e) continue;
        if (!(await confirmWithCard(e.m, 'นำไปแลก'))) continue;
        const r = await online(() => ONLINE.tradeCreate(e.m));
        if (!r) continue;
        takeMine(e);
        await afterTrade();
        AUDIO.sfx('confirm');
        await say('สร้างข้อเสนอแล้ว!  รหัสแลกเปลี่ยน : ' + r.code + '\nบอกรหัสนี้ให้เพื่อน แล้วรอให้เพื่อนเลือกตัวมาแลก');
        await say('รหัส ' + r.code + ' ดูซ้ำได้ที่ "ข้อเสนอของฉัน"\nเปลี่ยนใจก่อนมีคนรับ ยกเลิกแล้วรับ' + nm(e.m) + 'คืนได้');
      } else if (i === 1) {                            // take a friend's offer
        const code = await askText('ใส่รหัสแลกเปลี่ยน', '', 8, 'รหัส 6 ตัวที่เพื่อนบอก');
        if (!code) continue;
        const t = await online(() => ONLINE.tradePeek(code.toUpperCase().replace(/\s/g, '')));
        if (!t) continue;
        if (t.mine) { await say('นี่คือข้อเสนอของคุณเอง รับเองไม่ได้นะ'); continue; }
        if (!knownMon(t.mon)) { await say('มอนสเตอร์ตัวนี้มาจากเกมเวอร์ชันใหม่กว่า\nรีเฟรชหน้าเกมแล้วลองใหม่'); continue; }
        await say('ข้อเสนอ ' + t.code + ' : ' + monText(t.mon) + ' Lv.' + t.mon.level);
        if (!(await confirmWithCard(t.mon, 'เลือกตัวที่จะให้แลก'))) continue;
        const e = await pickMineToTrade('เลือกตัวที่จะให้แลกกับ' + monText(t.mon));
        if (!e) continue;
        if (!(await confirmWithCard(e.m, 'ให้ตัวนี้แลก'))) continue;
        const r = await online(() => ONLINE.tradeAccept(t.code, e.m));
        if (!r) continue;
        takeMine(e);
        const where = receiveMon(r.mon);
        await afterTrade();
        AUDIO.sfx('caught');
        await say('แลกสำเร็จ! ส่ง' + nm(e.m) + 'ไปให้เพื่อนแล้ว\nได้รับ' + monText(r.mon) + ' Lv.' + r.mon.level + ' (ไปอยู่ใน' + where + ')');
      } else {                                         // my open offers
        if (!open.length) { await say('ยังไม่มีข้อเสนอที่รอคนรับ'); continue; }
        const k = await choose(open.map((t) => ({ label: 'รหัส ' + t.code, right: knownMon(t.mon) ? monText(t.mon) + ' Lv.' + t.mon.level : '?' }))
          .concat([{ label: 'กลับ' }]), { x: 60, y: 60, w: 360, rowH: 26, cancellable: true, title: 'ข้อเสนอของฉัน (รอคนรับ)' });
        if (k < 0 || k === open.length) continue;
        const t = open[k];
        if (!(await yesNo('ยกเลิกข้อเสนอ ' + t.code + ' แล้วรับ' + (knownMon(t.mon) ? monText(t.mon) : 'มอนสเตอร์') + 'คืน ใช่ไหม?'))) continue;
        const r = await online(() => ONLINE.tradeCancel(t.code));
        if (!r) continue;
        if (!knownMon(r.mon)) { await say('รับคืนไม่ได้ เกมเวอร์ชันนี้ยังไม่รู้จักมอนสเตอร์ตัวนี้'); continue; }
        const where = receiveMon(r.mon);
        await afterTrade();
        await say('ยกเลิกแล้ว ' + monText(r.mon) + 'กลับมาอยู่ใน' + where);
      }
    }
  }

  // ---- fighting other players: challenge the team they saved to the cloud (the game plays
  // their side). Nothing is gained or lost: no exp, gold, items or evolution, and the team's
  // hit points are put back as they were afterwards. Only the fighters' rating changes.
  async function challengeMenu() {
    const data = await online(() => ONLINE.pvpOpponents());
    if (!data) return;
    if (!data.rows.length) { await say('ยังไม่มีผู้เล่นคนอื่นบันทึกทีมขึ้นคลาวด์\nชวนเพื่อนมาเล่นแล้วบันทึกเซฟขึ้นคลาวด์สิ'); return; }
    const rows = data.rows.slice(0, 10);
    const opts = rows.map((r) => ({ label: r.username, right: 'คะแนน ' + r.rating + ' · ทีม ' + r.size + ' ตัว Lv.≤' + r.top }));
    opts.push({ label: 'กลับ' });
    const me = data.me;
    const i = await choose(opts, { x: 30, y: 8, w: 420, rowH: 22, cancellable: true, title: 'เลือกคู่ต่อสู้ (คะแนนใกล้เคียงขึ้นก่อน)',
      footer: 'คะแนนของคุณ ' + me.rating + '   ชนะ ' + me.wins + ' · แพ้ ' + me.losses });
    if (i < 0 || i === rows.length) return;
    const t = await online(() => ONLINE.pvpTeam(rows[i].username));
    if (!t) return;
    const foes = t.team.filter(knownMon).map((m) => {
      const mon = { sp: m.sp, level: m.level, exp: m.exp, hp: 0, moves: m.moves.slice() };
      if (m.nick) mon.nick = m.nick;
      mon.hp = stats(mon).hp;
      return mon;
    });
    if (!foes.length) { await say('ทีมของผู้เล่นนี้มีมอนสเตอร์ที่เกมเวอร์ชันนี้ยังไม่รู้จัก\nรีเฟรชหน้าเกมแล้วลองใหม่'); return; }
    await say('ทีมของ ' + t.username + ' (คะแนน ' + t.rating + ')\n' + foes.map((m) => nm(m) + ' Lv.' + m.level).join(', '));
    if (!(await yesNo('ท้าประลองกับ ' + t.username + ' ไหม?\n(ไม่ได้ exp/ทอง ไม่เสียอะไร มอนสเตอร์ฟื้นเต็มก่อนสู้)'))) return;
    const keep = G.party.map((m) => m.hp);
    healParty();
    const result = await battle(foes, { name: t.username, sheet: 'chars/hero' }, { pvp: true });
    G.party.forEach((m, k) => { m.hp = keep[k]; });
    save();
    const r = await online(() => ONLINE.pvpResult(t.username, result === 'win'));
    if (!r) return;
    if (!r.counted) await say('ผลครั้งนี้ไม่นับคะแนน (สู้กับคนเดิมซ้ำภายใน 5 นาที)\nคะแนนของคุณ ' + r.rating);
    else await say((result === 'win' ? 'ชนะ! ' : 'แพ้... ') + 'คะแนน ' + (r.delta >= 0 ? '+' : '') + r.delta + '  เป็น ' + r.rating);
  }
  async function fightMenu() {
    for (;;) {
      const i = await choose(['ท้าทีมผู้เล่นอื่น', 'สู้สดกับเพื่อน (เรียลไทม์)', 'อันดับนักสู้', 'กลับ'],
        { x: 120, y: 80, w: 240, rowH: 28, cancellable: true, title: 'ต่อสู้ออนไลน์' });
      if (i < 0 || i === 3) return;
      if (i === 0) await challengeMenu();
      else if (i === 1) await liveMenu();
      else await leaderboardScreen('pvp');
    }
  }
  // ---- live battles: both players online, the server runs the battle. Each side picks a move,
  // a switch or forfeits; the server resolves the turn and both play back the same events.
  const liveTeam = () => G.party.map((m) => ({ sp: m.sp, level: m.level, moves: m.moves.slice(), nick: m.nick }));
  async function liveMenu() {
    if (!G.party.length) { await say('ต้องมีมอนสเตอร์ในทีมก่อน'); return; }
    const i = await choose(['สร้างห้อง (ได้รหัสให้เพื่อน)', 'เข้าห้องด้วยรหัส', 'กลับ'],
      { x: 110, y: 80, w: 260, rowH: 28, cancellable: true, title: 'สู้สดกับเพื่อน',
        footer: 'ทั้งสองฝ่ายต้องออนไลน์พร้อมกัน · ตาละ 60 วินาที' });
    if (i < 0 || i === 2) return;
    if (i === 0) {
      const r = await online(() => ONLINE.liveCreate(liveTeam()));
      if (!r) return;
      // wait for the friend, with a "cancel" button; a join closes the menu by itself
      let joined = false, cancelled = false;
      const menu = choose(['ยกเลิกห้อง'], { x: 120, y: 110, w: 240, rowH: 28,
        title: 'รหัสห้อง : ' + r.code, footer: 'บอกรหัสนี้ให้เพื่อน แล้วรอเพื่อนเข้าห้อง...' })
        .then((k) => { if (k !== -2) cancelled = true; });
      let seq = 0;
      const gaveUp = menu.then(() => null);
      while (!joined && !cancelled) {
        let p = null;
        try { p = await Promise.race([ONLINE.livePoll(r.room, seq), gaveUp]); } catch (e) { await wait(2000); continue; }
        if (!p) break;                                   // "cancel" was pressed
        seq = p.seq;
        if (p.view.phase !== 'waiting') joined = true;
      }
      if (cancelled) { try { await ONLINE.liveAct(r.room, { kind: 'forfeit' }); } catch (e) { /* the room expires anyway */ } return; }
      if (ui.menu) { const m = ui.menu; ui.menu = null; m.resolve(-2); }
      await menu;
      await liveBattle(r.room);
    } else {
      const code = await askText('ใส่รหัสห้อง', '', 6, 'รหัส 5 ตัวที่เพื่อนบอก');
      if (!code) return;
      const r = await online(() => ONLINE.liveJoin(code.toUpperCase().replace(/\s/g, ''), liveTeam()));
      if (r) await liveBattle(r.room);
    }
  }

  async function liveBattle(room) {
    const live = { seq: 0, view: null, names: ['', ''], over: false };
    const monOf = (p) => ({ sp: p.sp, level: p.level, nick: p.nick, exp: expAt(p.level), moves: [], hp: p.hp });
    const sideOf = (w) => (w === live.view.you ? 'me' : 'foe');
    // the first state tells which monsters are out, so the battle screen has something to draw
    let first = null;
    for (let i = 0; i < 5 && !first; i++) {
      try { first = await online(() => ONLINE.livePoll(room, 0)); } catch (e) { first = null; }
      if (!first) return;
    }
    live.view = first.view;
    for (let i = 0; i < 2; i++) { await tween(90, (t) => { ui.flash = t; }); await tween(90, (t) => { ui.flash = 1 - t; }); }
    await fadeTo(1, 220);
    const mine0 = first.view.team.find((m) => m.active) || first.view.team[0];
    bt = { me: monOf(mine0), foe: monOf(first.view.foe), foes: [], trainer: { name: '', sheet: 'chars/hero' },
           hp: { me: mine0.hp, foe: first.view.foe.hp },
           spr: { me: { dx: -220, dy: 0, alpha: 1, blink: false }, foe: { dx: 220, dy: 0, alpha: 1, blink: false } },
           trainerX: null, capsule: null, showMe: true, showFoe: true, fx: null, evo: null, evolving: [], pop: null,
           round: 0, ready: new Map(), live: true };
    mode = 'battle';
    AUDIO.music('trainer');
    live.names = first.view.names || ['', ''];
    const foeName = () => live.names[1 - live.view.you] || 'คู่แข่ง';
    bt.trainer.name = foeName();
    await fadeTo(0, 220);
    const pending = first.events;                      // played by the loop below
    async function playEvent(e) {
      if (e.type === 'start') { live.names = e.names; bt.trainer.name = foeName(); return; }
      if (e.type === 'switch') {
        const side = sideOf(e.side), m = monOf(e.mon);
        if (bt[side] && !e.first) await tween(220, (t) => { bt.spr[side].dx = (side === 'me' ? -220 : 220) * t; });
        bt[side] = m; bt.hp[side] = m.hp;
        bt.spr[side] = { dx: side === 'me' ? -220 : 220, dy: 0, alpha: 1, blink: false };
        await tween(260, (t) => { bt.spr[side].dx = (side === 'me' ? -220 : 220) * (1 - t); });
        await say(side === 'me' ? '{ชื่อ} : ลุยเลย ' + nm(m) + '!' : foeName() + ' ส่ง' + nm(m) + 'ออกมา!');
        return;
      }
      if (e.type === 'move') {
        const side = sideOf(e.side), other = side === 'me' ? 'foe' : 'me', mv = MOVES[e.move];
        const s = bt.spr[side], hit = bt.spr[other], dir = side === 'me' ? 1 : -1;
        await say((side === 'me' ? nm(bt.me) : nm(bt.foe) + 'ของ' + foeName()) + 'ใช้ท่า' + mv.name + '!');
        await tween(110, (t) => { s.dx = dir * 20 * t; s.dy = -dir * 9 * t; });
        await tween(110, (t) => { s.dx = dir * 20 * (1 - t); s.dy = -dir * 9 * (1 - t); });
        bt.fx = { type: mv.type, x: SPOT[other].x, y: SPOT[other].y - 60, t: 0, strong: e.eff > 1 };
        AUDIO.sfx('attack');
        await tween(e.eff > 1 ? 520 : 440, (t) => {
          bt.fx.t = t;
          hit.dx = t > 0.25 && t < 0.9 ? Math.round(Math.sin(t * 46) * (e.eff > 1 ? 5 : 3)) : 0;
          if (e.eff > 1) ui.flash = t > 0.3 && t < 0.42 ? 0.35 : 0;
        });
        bt.fx = null; hit.dx = 0; ui.flash = 0;
        AUDIO.sfx(e.eff > 1 ? 'hitStrong' : e.eff < 1 ? 'hitWeak' : 'hit');
        await tween(240, (t) => { hit.blink = Math.floor(t * 4) % 2 === 0; });
        hit.blink = false;
        const from = bt.hp[other];
        bt[other].hp = e.hp;
        bt.pop = { text: '-' + e.dmg, x: SPOT[other].x + (other === 'foe' ? -58 : 62), y: SPOT[other].y - 96, t: 0,
                   color: e.eff > 1 ? '#ffd23f' : e.eff < 1 ? '#c8c8d0' : '#ffffff', big: e.eff > 1 };
        tween(900, (t) => { if (bt && bt.pop) bt.pop.t = t; }).then(() => { if (bt) bt.pop = null; });
        await tween(350, (t) => { bt.hp[other] = from + (e.hp - from) * t; });
        if (e.eff > 1) await say('ได้ผลดีเยี่ยม!'); else if (e.eff < 1) await say('ไม่ค่อยได้ผล...');
        return;
      }
      if (e.type === 'faint') {
        const side = sideOf(e.side), s = bt.spr[side];
        AUDIO.sfx('faint');
        await tween(420, (t) => { s.dy = 46 * t; s.alpha = 1 - t; });
        await say((side === 'me' ? nm(bt.me) : nm(bt.foe) + 'ของ' + foeName()) + 'หมดแรง!');
        return;
      }
      if (e.type === 'end') {
        live.over = true;
        const won = e.winner === live.view.you;
        if (e.winner === null) await say('เสมอกัน!');
        else {
          if (won) { AUDIO.music(null); AUDIO.sfx('victory'); }
          await say(e.how === 'forfeit' ? (won ? foeName() + ' ยอมแพ้ คุณชนะ!' : 'คุณยอมแพ้') : (won ? 'ชนะ ' + foeName() + ' แล้ว!' : 'แพ้ ' + foeName() + '...'));
        }
        return;
      }
      if (e.type === 'rating') {
        const mine = Object.values(e.ratings).find((r) => (live.view.winner === live.view.you ? r.delta > 0 : r.delta < 0));
        if (mine) await say('คะแนนนักสู้ ' + (mine.delta >= 0 ? '+' : '') + mine.delta + '  เป็น ' + mine.rating);
      }
    }
    // the player's turn: fight, switch or give up
    async function chooseAction(v) {
      for (;;) {
        ui.prompt = nm(bt.me) + 'จะทำอะไรดี?  (เหลือ ' + Math.max(0, Math.round((v.deadline - Date.now()) / 1000)) + ' วินาที)';
        const k = await choose(['ต่อสู้', 'เปลี่ยนตัว', 'ยอมแพ้'], { x: 262, y: 236, w: 214, cols: 2, rowH: 33, kind: 'act' });
        ui.prompt = null;
        if (k === 0) {
          const ids = v.moves.map((x) => x.id);
          if (v.allResting) ids.push('tackle');
          const opts = ids.map((id, n) => {
            const o = moveOption(id, bt.foe), x = v.moves[n];
            if (x && x.left) { o.disabled = true; o.sub = 'พร้อมใช้ในอีก ' + x.left + ' เทิร์น'; o.subColor = '#a39c8c'; }
            else if (x && x.cd) o.sub += '  · พัก ' + x.cd;
            if (!x) o.label += ' (ท่าพื้นฐาน)';
            return o;
          });
          const i = await choose(opts, { x: 4, y: 236, w: 472, cols: 2, rowH: 33, minH: 80, cancellable: true, kind: 'move', data: ids });
          if (i < 0) continue;
          return { kind: 'move', move: ids[i] };
        }
        if (k === 1) {
          const opts = v.team.map((m) => ({ label: (m.nick || SPECIES[m.sp].name) + '  Lv.' + m.level, badge: SPECIES[m.sp].type,
            hp: [m.hp, m.max], disabled: m.hp <= 0 || m.active }));
          if (opts.every((o) => o.disabled)) { await say('ไม่มีตัวอื่นที่สู้ไหวแล้ว'); continue; }
          const i = await choose(opts, { x: 50, y: 24, w: 380, rowH: 30, cancellable: true, title: 'จะเปลี่ยนเป็นตัวไหน?', kind: 'mon' });
          if (i < 0) continue;
          return { kind: 'switch', idx: i };
        }
        if (await yesNo('ยอมแพ้การต่อสู้นี้ใช่ไหม?')) return { kind: 'forfeit' };
      }
    }
    async function chooseNext(v) {
      const opts = v.team.map((m) => ({ label: (m.nick || SPECIES[m.sp].name) + '  Lv.' + m.level, badge: SPECIES[m.sp].type,
        hp: [m.hp, m.max], disabled: m.hp <= 0 }));
      const i = await choose(opts, { x: 50, y: 24, w: 380, rowH: 30, title: 'จะส่งตัวไหนออกไปสู้ต่อ?', kind: 'mon' });
      return { kind: 'switch', idx: i };
    }

    let failures = 0, lastActRound = -1, queued = { seq: first.seq, events: pending, view: first.view };
    while (!live.over) {
      let p;
      if (queued) { p = queued; queued = null; }
      else try { p = await ONLINE.livePoll(room, live.seq); failures = 0; }
      catch (e) {
        if (++failures >= 5) { await say('การเชื่อมต่อขาดหาย: ' + e.message); break; }
        ui.prompt = 'กำลังเชื่อมต่อใหม่...'; await wait(1500); ui.prompt = null; continue;
      }
      live.view = p.view;
      for (const e of p.events) { live.seq = e.seq; await playEvent(e); if (live.over) break; }
      if (live.over) break;
      const v = p.view;
      const key = v.phase + ':' + v.round;
      if (v.waitingFor === 'you' && key !== lastActRound) {
        const a = v.phase === 'switch' ? await chooseNext(v) : await chooseAction(v);
        try { await ONLINE.liveAct(room, a); lastActRound = key; } catch (e) { await say(e.message); }
        if (a.kind !== 'forfeit') ui.prompt = 'รอ ' + foeName() + ' เลือก...';
      }
    }
    // the rating arrives a moment after the end
    for (let i = 0; i < 3 && live.over; i++) {
      try {
        const p = await ONLINE.livePoll(room, live.seq);
        const r = p.events.find((e) => e.type === 'rating');
        if (r) { live.view = p.view; await playEvent(r); break; }
      } catch (e) { break; }
      await wait(800);
    }
    ui.prompt = null;
    await fadeTo(1, 240);
    bt = null; mode = 'world';
    mapMusic();
    await fadeTo(0, 240);
  }

  // ---- the objective guide: what to do next in the story, shown at the top while walking.
  // The first step not yet done is the goal; "where" is the map it happens on.
  const QUEST = [
    { done: () => !!G.flags.starter, where: 'village', text: 'ไปพบศาสตราจารย์สนที่ลานกลางหมู่บ้าน เพื่อรับมอนสเตอร์คู่หู' },
    { done: () => !!G.flags.rivalBeaten, where: 'village', text: 'ประลองกับพายุ ที่ยืนขวางถนนทางใต้ของหมู่บ้าน' },
    { done: () => !!G.flags.badge1, where: 'route1', text: 'เดินลงใต้ไปเส้นทางที่ 1 แล้วท้ายิมศิลา ชนะหัวหน้ายิมเพื่อรับเหรียญศิลา' },
    { done: () => !!G.flags.stage3, where: 'route2', text: 'ผ่านด่านตรวจทางใต้ของเส้นทางที่ 1 แล้วชนะพายุที่ปลายเส้นทางที่ 2' },
    { done: () => !!G.flags.badge2, where: 'town', text: 'เดินทางต่อไปตลาดน้ำบางบัว แล้วท้ายิมวารีทางตะวันออกของตลาด' },
    { done: () => !!G.flags.stage5, where: 'ruins', text: 'ลงใต้ไปซากเมืองโบราณ แล้วชนะพายุที่ประตูเมืองเก่า' },
  ];
  // how to get from this map to the goal's map (the stages run north to south)
  const MAP_ORDER = ['village', 'route1', 'route2', 'town', 'ruins'];
  function questNow() {
    if (!G) return null;
    const q = QUEST.find((x) => !x.done());
    if (!q) return { text: 'ผ่านทุกด่านแล้ว! ด่าน 6 จะมาในเวอร์ชันถัดไป · ลองจับมอนสเตอร์ให้ครบ หรือต่อสู้ออนไลน์', hint: '' };
    const here = MAP_ORDER.indexOf(MAP.indoor ? (ROOMS[MAP.id] && ROOMS[MAP.id].from) || 'village' : MAP.id);
    const there = MAP_ORDER.indexOf(q.where);
    const hint = MAP.indoor ? 'ออกจากอาคารก่อน' : here < 0 || there < 0 || here === there ? '' : here < there ? 'ไปทางใต้' : 'ย้อนขึ้นเหนือ';
    return { text: q.text, hint };
  }
  const goalUi = { last: null, glow: 0 };

  async function teamScreen() {
    let at = 0;
    for (;;) {
      const opts = G.party.map((m) => ({
        label: nm(m) + ' ' + rarityOf(m.sp).stars + '  Lv.' + m.level, badge: SPECIES[m.sp].type, hp: [m.hp, stats(m).hp] }));
      opts.push({ label: 'เมนูอื่น ๆ', sub: 'ตารางแพ้ธาตุ · ออนไลน์ / อันดับ · เปลี่ยนชื่อ' });
      const i = await choose(opts, {
        x: 50, y: 24, w: 380, rowH: 30, cancellable: true, start: at,
        title: G.party.length ? 'ทีมของ' + (G.name || DEFAULT_NAME) + '  (เลือกเพื่อดูข้อมูล)' : 'ยังไม่มีมอนสเตอร์ในทีม',
        footer: 'ทอง ' + G.gold + '   แคปซูล ' + itemCount('ball') + '   ยา ' + itemCount('heal')
          + '   จับได้ ' + goalCaught().length + '/6   เหรียญตรา ' + ((G.flags.badge1 ? 1 : 0) + (G.flags.badge2 ? 1 : 0)) });
      if (i < 0) break;
      at = i;
      if (i === G.party.length) {          // more: the type table, online, renaming
        const k = await choose(['ดูตารางแพ้ธาตุ', ONLINE.loggedIn ? 'ออนไลน์ / อันดับ (' + ONLINE.username + ')' : 'ออนไลน์ / อันดับ',
          'เปลี่ยนชื่อตัวละคร', G.flags.hideGoal ? 'แสดงเป้าหมายบนจอ' : 'ซ่อนเป้าหมายบนจอ', 'กลับ'],
          { x: 130, y: 80, w: 220, rowH: 26, cancellable: true, title: 'เมนูอื่น ๆ' });
        if (k === 0) { ui.chart = true; await anyKey(); ui.chart = false; }
        else if (k === 1) await onlineMenu(false);
        else if (k === 2 && (await askHeroName(false))) await say('เปลี่ยนชื่อเป็น {ชื่อ} แล้ว');
        else if (k === 3) {
          G.flags.hideGoal = !G.flags.hideGoal; save();
          const q = questNow();
          await say(G.flags.hideGoal ? 'ซ่อนเป้าหมายแล้ว' : 'เป้าหมายตอนนี้ : ' + (q ? q.text : ''));
        }
        continue;
      }
      const m = G.party[i];
      ui.card = m;                         // the monster's information card
      const pick = await choose(['ตั้งเป็นตัวนำ', 'ชื่อเล่น', 'กลับ'], { x: 150, y: 262, w: 282, cols: 3, rowH: 24, cancellable: true });
      ui.card = null;
      if (pick === 1) {
        const before = nm(m);
        if (await askNick(m)) await say(m.nick ? before + ' มีชื่อเล่นว่า ' + m.nick + ' แล้ว' : 'ลบชื่อเล่นแล้ว กลับไปเรียกว่า ' + nm(m));
        continue;
      }
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
    const table = e.table.map(([s, w]) => [s, w * rarityOf(s).enc]);
    let roll = Math.random() * table.reduce((n, x) => n + x[1], 0);
    let sp = table[0][0];
    for (const [s, w] of table) { if (roll < w) { sp = s; break; } roll -= w; }
    return makeMon(sp, e.levels[0] + rand(e.levels[1] - e.levels[0] + 1));
  }
  async function wildEncounter(area) {
    // stage 1 only: the legendary monster comes down once, early on
    if (MAP.id === 'village' && !G.flags.legendMet) {
      G.wilds = (G.wilds || 0) + 1;
      if (G.wilds >= LEGEND_AFTER) { await legendEncounter(); return; }
    }
    if (Math.random() < ZODIAC_CHANCE) {
      const e = ENCOUNTERS[area];
      await battle([makeMon(ZODIAC[rand(ZODIAC.length)], e.levels[1] + ZODIAC_LEVEL_UP)], null, { zodiac: true });
      return;
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
      round: 0, ready: new Map(),       // turn counter; monster -> { move id: turn it is ready again }
    };
    if (opts.legend) { bt.spr.foe.dx = 0; bt.spr.foe.dy = -240; }      // it descends from the sky
    mode = 'battle';
    AUDIO.music(trainer ? 'trainer' : 'battle');
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
      const tier = SPECIES[bt.foe.sp].rarity;
      if (tier === 'zodiac') {
        AUDIO.sfx('rare');
        for (let i = 0; i < 3; i++) { await tween(80, (t) => { ui.flash = 0.6 * t; }); await tween(80, (t) => { ui.flash = 0.6 * (1 - t); }); }
        AUDIO.sfx('fanfare');
        await say('✦✦ ดวงดาวส่องประกาย... มอนสเตอร์ราศีปรากฏตัว!\n' + nm(bt.foe) + ' ★★★★ ลงมาจากฟากฟ้า');
      } else {
        if (tier === 'rare') AUDIO.sfx('rare');
        await say((tier === 'rare' ? '✦ มอนสเตอร์หายาก! ' : '') + nm(bt.foe) + 'ป่าปรากฏตัว!');
      }
      noteSeen();
    }
    tween(260, (t) => { bt.spr.me.dx = -220 * (1 - t); });
    await say('{ชื่อ} : ลุยเลย ' + nm(bt.me) + '!');

    // ---- cooldowns
    // The first time a monster is looked at in this battle (when it comes out), its moves get
    // their warm-up; its weakest move is ready at once.
    function readyOf(m) {
      if (!bt.ready.has(m)) {
        const r = {};
        const weakest = m.moves.reduce((w, id) => (MOVES[id].power < MOVES[w].power ? id : w), m.moves[0]);
        for (const id of m.moves) if (id !== weakest && moveWarmup(id)) r[id] = bt.round + moveWarmup(id);
        bt.ready.set(m, r);
      }
      return bt.ready.get(m);
    }
    const cdLeft = (m, id) => Math.max(0, (readyOf(m)[id] || 0) - bt.round);
    function startCooldown(m, id) {
      const c = moveCooldown(id);
      if (!c) return;
      readyOf(m)[id] = bt.round + c + 1;
    }
    // the foe picks at random among its moves that are ready
    function foeMove() {
      const ok = bt.foe.moves.filter((id) => cdLeft(bt.foe, id) === 0);
      return ok.length ? ok[rand(ok.length)] : 'tackle';
    }
    // The party list, to send a monster out. Fainted monsters (and, when switching, the one
    // already fighting) cannot be chosen. Returns the monster, or null when backed out.
    async function pickMon(title, cancellable) {
      const can = (m) => m.hp > 0 && !(cancellable && m === bt.me);
      const opts = G.party.map((m) => ({ label: nm(m) + '  Lv.' + m.level, badge: SPECIES[m.sp].type,
        hp: [m.hp, stats(m).hp], disabled: !can(m) }));
      const start = !cancellable && can(bt.me) ? G.party.indexOf(bt.me) : Math.max(0, G.party.findIndex(can));
      const i = await choose(opts, { x: 50, y: 24, w: 380, rowH: 30, title, cancellable, start, kind: 'mon' });
      return i < 0 ? null : G.party[i];
    }

    async function useMove(side, mvId) {
      const other = side === 'me' ? 'foe' : 'me';
      const att = bt[side], def = bt[other], mv = MOVES[mvId];
      startCooldown(att, mvId);
      await say((side === 'me' ? nm(att) : foeName()) + 'ใช้ท่า' + mv.name + '!');
      const dir = side === 'me' ? 1 : -1, s = bt.spr[side], hit = bt.spr[other];
      await tween(110, (t) => { s.dx = dir * 20 * t; s.dy = -dir * 9 * t; });
      await tween(110, (t) => { s.dx = dir * 20 * (1 - t); s.dy = -dir * 9 * (1 - t); });
      const { dmg, eff } = damage(att, def, mv);
      // the move's effect plays over the target, which shakes while it is being hit
      bt.fx = { type: mv.type, x: SPOT[other].x, y: SPOT[other].y - 60, t: 0, strong: eff > 1 };
      AUDIO.sfx('attack');
      await tween(eff > 1 ? 520 : 440, (t) => {
        bt.fx.t = t;
        hit.dx = t > 0.25 && t < 0.9 ? Math.round(Math.sin(t * 46) * (eff > 1 ? 5 : 3)) : 0;
        if (eff > 1) ui.flash = t > 0.3 && t < 0.42 ? 0.35 : 0;
      });
      bt.fx = null; hit.dx = 0; ui.flash = 0;
      AUDIO.sfx(eff > 1 ? 'hitStrong' : eff < 1 ? 'hitWeak' : 'hit');
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
      AUDIO.sfx('faint');
      await tween(420, (t) => { s.dy = 46 * t; s.alpha = 1 - t; });
      await say((side === 'me' ? nm(bt.me) : foeName()) + 'หมดแรง!');
    }
    async function gainExp(m, amount) {
      m.exp += amount;
      await say(nm(m) + 'ได้รับค่าประสบการณ์ ' + amount + ' แต้ม');
      while (m.level < 50 && m.exp >= expAt(m.level + 1)) {
        m.level++;
        m.hp = stats(m).hp;               // a level up restores all hit points
        if (m === bt.me) bt.hp.me = m.hp;
        AUDIO.sfx('levelup');
        await say(nm(m) + 'เลเวลอัปเป็น Lv.' + m.level + '!\nพลังชีวิตฟื้นเต็มแล้ว');
        for (const [lv, mv] of SPECIES[m.sp].moves) {
          if (lv === m.level && !m.moves.includes(mv)) await learnMove(m, mv);
        }
      }
      const evo = SPECIES[m.sp].evolve;
      if (canEvolve(m) && !bt.evolving.includes(m)) bt.evolving.push(m);
      else if (evo && evo.item && m.level === evo.level && !bt.evolving.includes(m)) {
        await say(nm(m) + 'แข็งแกร่งพอจะวิวัฒนาการแล้ว\nแต่ต้องมี' + ITEMS[evo.item].name + 'จากยิมก่อน');
      }
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
      const i = await choose(opts, { x: 4, y: 181, w: 472, cols: 2, rowH: 33, kind: 'learn', data: { mon: m, id },
        title: 'จะให้ลืมท่าไหน เพื่อเรียนท่า' + mv.name + '?' });
      if (i >= m.moves.length) { await say(nm(m) + 'ไม่ได้เรียนท่า' + mv.name); return; }
      const old = MOVES[m.moves[i]].name;
      m.moves[i] = id;
      await say('1... 2... 3... ปิ๊ง!\n' + nm(m) + 'ลืมท่า' + old + ' แล้วเรียนรู้ท่า' + mv.name + '!');
    }
    // Change a monster into its next form, on the battle screen once the fight is over.
    async function evolve(m) {
      const evo = SPECIES[m.sp].evolve;
      if (!canEvolve(m) || m.hp <= 0) return;
      const oldName = nm(m);
      if (evo.item) {
        G.bag[evo.item]--;
        await say('ใช้' + ITEMS[evo.item].name + 'กับ' + oldName);
      }
      bt.evo = { from: m.sp, to: evo.to, showNew: false, t: 0 };
      await say('เอ๊ะ? ' + oldName + 'มีท่าทางแปลกไป!');
      bt.fx = { type: 'evolve', x: 240, y: 132, t: 0, strong: true };
      // the two forms flicker faster and faster, then a white flash settles on the new one
      AUDIO.sfx('evolve');
      await tween(2600, (t) => { bt.evo.t = t; bt.fx.t = (t * 3) % 1; bt.evo.showNew = Math.sin(t * t * 70) > 0; });
      await tween(160, (t) => { ui.flash = t; });
      const before = stats(m).hp, oldSp = m.sp;
      m.sp = evo.to;
      m.hp = Math.min(stats(m).hp, m.hp + stats(m).hp - before);
      if (m === bt.me) bt.hp.me = m.hp;
      bt.evo.showNew = true; bt.fx = null;
      noteCaught(m.sp);
      await tween(420, (t) => { ui.flash = 1 - t; });
      AUDIO.sfx('fanfare');
      await say('ยินดีด้วย! ' + oldName + 'วิวัฒนาการเป็น' + SPECIES[m.sp].name + 'แล้ว!');
      // moves of the new form learned at a level already passed (it evolves late, at Lv.20 / 30)
      const had = SPECIES[oldSp].moves.map((x) => x[1]);
      for (const [lv, mv] of SPECIES[m.sp].moves) {
        if (lv <= m.level && !m.moves.includes(mv) && !had.includes(mv)) await learnMove(m, mv);
      }
      bt.evo = null;
    }
    // After my monster falls: bring in the next one, or lose. Returns false when the battle is lost.
    async function afterMyFaint() {
      await faint('me');
      const alive = G.party.filter((m) => m.hp > 0);
      if (!alive.length) return false;
      const next = alive.length > 1 ? await pickMon('จะส่งตัวไหนออกไปสู้ต่อ?', false) : alive[0];
      bt.me = next; bt.hp.me = next.hp;
      bt.spr.me = { dx: -220, dy: 0, alpha: 1, blink: false };
      tween(260, (t) => { bt.spr.me.dx = -220 * (1 - t); });
      await say('สู้ต่อนะ ' + nm(next) + '!');
      return true;
    }
    // After the foe falls. Returns true when the battle is won.
    async function afterFoeFaint() {
      await faint('foe');
      if (!opts.pvp) await gainExp(bt.me, Math.floor(50 * bt.foe.level / 5 * (trainer ? 1.5 : 1)));
      const next = bt.foes.find((m) => m.hp > 0);
      if (!next) return true;
      bt.foe = next; bt.hp.foe = next.hp;
      bt.spr.foe = { dx: 220, dy: 0, alpha: 1, blink: false };
      tween(260, (t) => { bt.spr.foe.dx = 220 * (1 - t); });
      await say(trainer.name + 'ส่ง' + nm(next) + 'ออกมา!');
      return false;
    }
    async function foeTurn() {
      await useMove('foe', foeMove());
      bt.round++;
      if (bt.me.hp <= 0 && !(await afterMyFaint())) result = 'lose';
    }

    // Which capsule or potion to use. With only one grade in the bag it is used straight
    // away; with two the player picks one (or backs out: null).
    async function pickItem(kind) {
      const have = Object.keys(ITEMS).filter((id) => ITEMS[id].kind === kind && G.bag[id] > 0);
      if (!have.length) { await say(kind === 'ball' ? 'แคปซูลหมดแล้ว!' : 'ยาหมดแล้ว!'); return null; }
      if (have.length === 1) return have[0];
      const i = await choose(have.map((id) => ({ label: ITEMS[id].name, right: 'x' + G.bag[id] })),
        { x: 262, y: 236, w: 214, cols: 1, rowH: 30, cancellable: true, kind: 'item', data: have });
      return i < 0 ? null : have[i];
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
          'ต่อสู้', { label: 'แคปซูล', right: 'x' + itemCount('ball') },
          { label: 'ยา', right: 'x' + itemCount('heal') }, 'หนี'], { x: 262, y: 236, w: 214, cols: 2, rowH: 33, start: bt.lastAct || 0, kind: 'act' });
        bt.lastAct = act;
        ui.prompt = null;
        if (act === 0) {
          const i = await choose(bt.me.moves.map((id) => moveOption(id, bt.foe)), {
            x: 4, y: 236, w: 472, cols: 2, rowH: 33, minH: 80, cancellable: true, kind: 'move' });
          if (i < 0) continue;
          const mv = MOVES[bt.me.moves[i]], s = bt.spr.me;
          await say(nm(bt.me) + 'ใช้ท่า' + mv.name + '!');
          await tween(110, (t) => { s.dx = 20 * t; s.dy = -9 * t; });
          await tween(110, (t) => { s.dx = 20 * (1 - t); s.dy = -9 * (1 - t); });
          bt.fx = { type: mv.type, x: SPOT.foe.x, y: SPOT.foe.y - 60, t: 0, strong: false };
          AUDIO.sfx('attack');
          await tween(440, (t) => { bt.fx.t = t; });
          bt.fx = null;
          bt.pop = { text: '-0', x: SPOT.foe.x - 58, y: SPOT.foe.y - 96, t: 0, color: '#c8c8d0', big: false };
          await tween(900, (t) => { bt.pop.t = t; });
          bt.pop = null;
          await say('พลังห่างชั้นเกินไป... การโจมตีไม่ระคายผิว' + name + 'เลย');
        } else if (act === 1) {
          const ball = await pickItem('ball');
          if (!ball) continue;
          await say('โยน' + ITEMS[ball].name + 'ออกไป!');
        AUDIO.sfx('throw');
          const from = { x: SPOT.me.x + 30, y: SPOT.me.y - 90 }, to = { x: SPOT.foe.x, y: SPOT.foe.y - 70 };
          bt.capsule = { x: from.x, y: from.y };
          await tween(420, (t) => { bt.capsule.x = from.x + (to.x - from.x) * t; bt.capsule.y = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 60; });
          await tween(90, (t) => { ui.flash = 0.5 * (1 - t); });
          await tween(520, (t) => { bt.capsule.x = to.x + (from.x - to.x) * t; bt.capsule.y = to.y + (from.y - to.y) * t - Math.sin(t * Math.PI) * 90; });
          bt.capsule = null;
          await say('แคปซูลกระเด็นกลับมาอยู่ในมือ!\n' + name + 'ยังไม่อาจถูกจับได้ในตอนนี้');
        } else if (act === 2) {
          const max = stats(bt.me).hp;
          if (itemCount('heal') && bt.me.hp >= max) { await say(nm(bt.me) + 'ยังแข็งแรงเต็มที่อยู่'); continue; }
          const med = await pickItem('heal');
          if (!med) continue;
          G.bag[med]--;
          const before = bt.me.hp;
          bt.me.hp = Math.min(max, bt.me.hp + ITEMS[med].heal);
        AUDIO.sfx('heal');
          await say('ใช้' + ITEMS[med].name + 'กับ' + nm(bt.me));
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
      healParty(); AUDIO.sfx('heal');
      bt.hp.me = bt.me.hp;
      await tween(520, (t) => { ui.flash = 1 - t; });
      if (bt.me.hp > before || G.party.some((m) => m !== bt.me)) await say('แสงอันอบอุ่นโอบล้อมทั้งทีม\nมอนสเตอร์ทุกตัวฟื้นพลังเต็มที่');
      await tween(1100, (t) => { foeSpr.dy = -260 * t * t; foeSpr.alpha = 1 - t * t; });
      await say(name + 'ทะยานขึ้นสู่ท้องฟ้าและหายลับไป...');
      await say('ตำนานเล่าว่ามันจะปรากฏอีกครั้งเมื่อถึงเวลา\n(รอพบกันใหม่ในอัปเดตถัดไป)');
      return 'legend';
    }
    bt.legend = !!opts.legend;
    if (opts.legend) result = await legendLoop();

    let fleeCheckedAt = 0;
    while (!result) {
      if (opts.zodiac && bt.foe.hp > 0 && bt.round > fleeCheckedAt) {
        fleeCheckedAt = bt.round;
        if (Math.random() < ZODIAC_FLEE) {
          await tween(900, (t) => { bt.spr.foe.dy = -200 * t * t; bt.spr.foe.alpha = 1 - t; });
          await say(nm(bt.foe) + 'ลอยกลับขึ้นสู่ฟากฟ้าไปแล้ว...\nไว้พบกันใหม่เมื่อดวงดาวเรียงตัวอีกครั้ง');
          result = 'fled';
          break;
        }
      }
      ui.prompt = nm(bt.me) + 'จะทำอะไรดี?';
      const act = await choose([
        'ต่อสู้', { label: 'แคปซูล', right: 'x' + itemCount('ball') },
        { label: 'ยา', right: 'x' + itemCount('heal') }, 'เปลี่ยนตัว', 'หนี'],
        { x: 262, y: 233, w: 214, cols: 2, rowH: 24, start: bt.lastAct || 0, kind: 'act' });
      bt.lastAct = act;
      ui.prompt = null;
      const what = ['fight', 'ball', 'heal', 'switch', 'run'][act];

      if (what === 'fight') {
        // moves still resting are greyed out; if every move is resting, a basic tackle is offered
        const ids = bt.me.moves.slice();
        if (ids.every((id) => cdLeft(bt.me, id) > 0)) ids.push('tackle');
        const opts = ids.map((id, k) => {
          const o = moveOption(id, bt.foe), left = k < bt.me.moves.length ? cdLeft(bt.me, id) : 0, cd = moveCooldown(id);
          if (left) { o.disabled = true; o.sub = 'พร้อมใช้ในอีก ' + left + ' เทิร์น'; o.subColor = '#a39c8c'; }
          else if (cd) o.sub += '  · พัก ' + cd;
          if (k >= bt.me.moves.length) o.label += ' (ท่าพื้นฐาน)';
          return o;
        });
        const i = await choose(opts, {
          x: 4, y: 236, w: 472, cols: 2, rowH: 33, minH: 80, cancellable: true, kind: 'move', data: ids,
          start: Math.max(0, opts.findIndex((o) => !o.disabled)) });
        if (i < 0) continue;
        const mine = ids[i], theirs = foeMove();
        const ms = stats(bt.me).spd, fs = stats(bt.foe).spd;
        const first = ms > fs || (ms === fs && Math.random() < 0.5) ? 'me' : 'foe';
        for (const side of first === 'me' ? ['me', 'foe'] : ['foe', 'me']) {
          await useMove(side, side === 'me' ? mine : theirs);
          if (bt.foe.hp <= 0) { if (await afterFoeFaint()) result = 'win'; break; }
          if (bt.me.hp <= 0) { if (!(await afterMyFaint())) result = 'lose'; break; }
        }
        bt.round++;
      } else if (what === 'switch') {
        if (G.party.filter((m) => m.hp > 0).length < 2) { await say('ไม่มีมอนสเตอร์ตัวอื่นที่สู้ไหวแล้ว'); continue; }
        const next = await pickMon('จะเปลี่ยนเป็นตัวไหน?', true);
        if (!next) continue;
        await say('กลับมาก่อน ' + nm(bt.me) + '!');
        await tween(220, (t) => { bt.spr.me.dx = -220 * t; });
        bt.me = next; bt.hp.me = next.hp;
        bt.spr.me = { dx: -220, dy: 0, alpha: 1, blink: false };
        await tween(260, (t) => { bt.spr.me.dx = -220 * (1 - t); });
        await say('{ชื่อ} : ลุยเลย ' + nm(next) + '!');
        await foeTurn();                  // switching takes the turn: the foe attacks the newcomer
      } else if (what === 'ball') {
        if (trainer) { await say('ใช้แคปซูลกับมอนสเตอร์ที่มีเจ้าของแล้วไม่ได้!'); continue; }
        const ball = await pickItem('ball');
        if (!ball) continue;
        G.bag[ball]--;
        await say('โยน' + ITEMS[ball].name + 'ออกไป!');
        AUDIO.sfx('throw');
        const from = { x: SPOT.me.x + 30, y: SPOT.me.y - 90 }, to = { x: SPOT.foe.x, y: SPOT.foe.y - 70 };
        bt.capsule = { x: from.x, y: from.y };
        await tween(420, (t) => { bt.capsule.x = from.x + (to.x - from.x) * t; bt.capsule.y = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 60; });
        await tween(220, (t) => { bt.spr.foe.alpha = 1 - t; });
        await tween(260, (t) => { bt.capsule.y = to.y + (SPOT.foe.y - 12 - to.y) * t * t; });
        const chance = Math.min(0.95, 0.6 * ITEMS[ball].rate * (rarityOf(bt.foe.sp).catch || 1) * (1 - 0.66 * bt.foe.hp / stats(bt.foe).hp));
        const caught = Math.random() < chance;
        const shakes = caught ? 3 : rand(3);
        for (let i = 0; i < shakes; i++) {
          await wait(260);
          AUDIO.sfx('shake');
          await tween(260, (t) => { bt.capsule.x = to.x + Math.sin(t * Math.PI * 2) * 5; });
        }
        await wait(260);
        if (caught) {
          AUDIO.music(null); AUDIO.sfx('caught');
          await say('จับ' + nm(bt.foe) + 'ได้แล้ว!');
          noteCaught(bt.foe.sp);
          if (await yesNo('จะตั้งชื่อเล่นให้' + nm(bt.foe) + 'ไหม?')) await askNick(bt.foe);
          if (G.party.length < PARTY_MAX) G.party.push(bt.foe);
          else {
            bt.foe.hp = stats(bt.foe).hp; G.lab.push(bt.foe);
            await say('ทีมเต็มแล้ว ' + nm(bt.foe) + 'ถูกส่งไปที่กล่องฝากมอนสเตอร์\n(เปิดกล่องได้ที่คอมพิวเตอร์ศูนย์วิจัย หรือเครื่องในศูนย์รักษา)');
          }
          result = 'caught';
        } else {
          bt.capsule = null;
          await tween(200, (t) => { bt.spr.foe.alpha = t; });
          AUDIO.sfx('breakout');
          await say('โธ่ มันหลุดออกมาได้!');
          await foeTurn();
        }
      } else if (what === 'heal') {
        if (opts.pvp) { await say('ใช้ไอเทมในการประลองออนไลน์ไม่ได้'); continue; }
        const max = stats(bt.me).hp;
        if (itemCount('heal') && bt.me.hp >= max) { await say(nm(bt.me) + 'ยังแข็งแรงเต็มที่อยู่'); continue; }
        const med = await pickItem('heal');
        if (!med) continue;
        G.bag[med]--;
        const from = bt.me.hp;
        bt.me.hp = Math.min(max, bt.me.hp + ITEMS[med].heal);
        AUDIO.sfx('heal');
        await say('ใช้' + ITEMS[med].name + 'กับ' + nm(bt.me));
        await tween(350, (t) => { bt.hp.me = from + (bt.me.hp - from) * t; });
        await say('พลังชีวิตฟื้นขึ้น ' + (bt.me.hp - from) + ' แต้ม');
        await foeTurn();
      } else {                            // run
        if (trainer) { await say('หนีจากการประลองไม่ได้!'); continue; }
        if (Math.random() < (stats(bt.me).spd >= stats(bt.foe).spd ? 0.95 : 0.6)) { await say('หนีออกมาได้อย่างปลอดภัย'); result = 'run'; }
        else { await say('หนีไม่พ้น!'); await foeTurn(); }
      }
    }

    if (result === 'win') { AUDIO.music(null); AUDIO.sfx('victory'); }
    if (result === 'win' && trainer) await say('ชนะ' + trainer.name + 'แล้ว!');
    if (result === 'win' && !opts.pvp) {
      const gold = Math.round(trainer ? foes.reduce((n, m) => n + m.level, 0) * GOLD_TRAINER : foes[0].level * GOLD_WILD);
      G.gold += gold;
      AUDIO.sfx('coin');
      await say('ได้รับเหรียญทอง ' + gold + ' ทอง!');
    }
    if (result !== 'lose' && !opts.pvp) {
      for (const m of G.party) if (m.hp > 0 && canEvolve(m) && !bt.evolving.includes(m)) bt.evolving.push(m);
      for (const m of bt.evolving) await evolve(m);
    }
    if (result === 'lose' && opts.pvp) await say('แพ้' + trainer.name + '... ไว้ฝึกแล้วกลับมาแก้มือใหม่!');
    if (result === 'lose' && !opts.pvp) await say('ไม่มีมอนสเตอร์ที่สู้ไหวแล้ว...\nคุณรีบพามอนสเตอร์กลับไปที่ศูนย์รักษา');
    await fadeTo(1, 240);
    bt = null; mode = 'world';
    mapMusic();
    if (result === 'lose' && !opts.pvp) {
      healParty();
      const spot = G.healSpot || HEAL_SPOT;
      setMap(spot.map);
      placePlayer(spot);
    }
    save();
    await fadeTo(0, 240);
    if (result === 'lose' && !opts.pvp) await say('พยาบาลช่วยฟื้นพลังให้มอนสเตอร์ทุกตัวแล้ว');
    return result;
  }
  function noteSeen() { /* reserved for a monster journal */ }

  // Attack effects: small pixel particles drawn over the target, one look per move type.
  // fx = { type, x, y (centre of the target), t (0..1), strong }
  // ---- The glow around the special monsters: the zodiac spirits (violet and gold) and the
  // legend (gold). Built once per sprite: the sprite's outline grown by a few pixels, in two
  // colours, drawn behind the sprite and gently pulsing, with a few stars twinkling around it.
  const AURA_COLORS = { zodiac: ['#b48cff', '#ffe58a'], legend: ['#ffc94a', '#fff3b8'] };
  const auraCache = new Map();
  function auraOf(im, tier) {
    const key = im.src + '|' + tier;
    if (auraCache.has(key)) return auraCache.get(key);
    const P = 4, W = im.width + 2 * P, H = im.height + 2 * P;
    const sil = document.createElement('canvas'); sil.width = W; sil.height = H;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const sc = sil.getContext('2d'), oc = out.getContext('2d');
    const ring = (color, radius, alpha) => {
      sc.clearRect(0, 0, W, H); sc.globalCompositeOperation = 'source-over';
      sc.drawImage(im, P, P); sc.globalCompositeOperation = 'source-in';
      sc.fillStyle = color; sc.fillRect(0, 0, W, H);
      oc.globalAlpha = alpha;
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++)
          if (dx * dx + dy * dy <= radius * radius + 1) oc.drawImage(sil, dx, dy);
    };
    const [outer, inner] = AURA_COLORS[tier];
    ring(outer, 3, 0.35);
    ring(inner, 1, 0.9);
    oc.globalAlpha = 1;
    const a = { img: out, pad: P };
    auraCache.set(key, a);
    return a;
  }
  function hasAura(sp) { return !!AURA_COLORS[SPECIES[sp].rarity]; }
  // draws the glow for a sprite about to be drawn at (x, y) with size (w, h) on canvas c
  function drawAura(c, sp, im, x, y, w, h, alpha = 1) {
    const tier = SPECIES[sp].rarity, a = auraOf(im, tier), k = w / im.width;
    const pulse = 0.55 + 0.45 * Math.sin(clock * 2.6);
    c.save();
    c.imageSmoothingEnabled = false;
    c.globalAlpha = alpha * (0.5 + 0.4 * pulse);
    c.drawImage(a.img, Math.round(x - a.pad * k), Math.round(y - a.pad * k), a.img.width * k, a.img.height * k);
    // four little stars that twinkle in turn around the monster
    const star = AURA_COLORS[tier][1], s = Math.max(1, Math.round(k));
    for (let i = 0; i < 4; i++) {
      const t = (clock * 0.7 + i / 4) % 1, glow = Math.sin(t * Math.PI);
      if (glow < 0.15) continue;
      const ang = i * 1.9 + Math.floor(clock * 0.7 + i / 4) * 2.3;
      const sx = Math.round(x + w / 2 + Math.cos(ang) * w * 0.46), sy = Math.round(y + h * 0.5 + Math.sin(ang) * h * 0.42);
      c.globalAlpha = alpha * glow;
      c.fillStyle = star;
      c.fillRect(sx - s, sy - 3 * s, 2 * s, 6 * s);
      c.fillRect(sx - 3 * s, sy - s, 6 * s, 2 * s);
      c.fillStyle = '#ffffff';
      c.fillRect(sx - s, sy - s, 2 * s, 2 * s);
    }
    c.restore();
  }

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
      if (hasAura(m.sp)) drawAura(b, m.sp, im, Math.round(SPOT[side].x - w / 2 + s.dx), Math.round(top + s.dy), w, h, b.globalAlpha);
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
    if (m.title) { const t = fitText(m.title, m.w - 28, 13, true, 11); text(t.s, m.x + 14, m.y + 22, t.px, '#2b2420', 'left', true); }
    const cellW = (m.w - 16) / m.cols;
    m.opts.forEach((o, i) => {
      const cx = m.x + 8 + (i % m.cols) * cellW;
      const cy = m.y + 7 + m.titleH + Math.floor(i / m.cols) * m.rowH;
      const mid = o.sub ? cy + 15 : cy + m.rowH / 2 + 5;
      if (i === m.index) {
        ctx.fillStyle = '#efe6c8'; roundRect(cx + 1, cy + 1, cellW - 2, m.rowH - 2, 4); ctx.fill();
        text('▶', cx + 5, mid - 1, 9, '#c0442f');
      }
      let room = cellW - 26;
      if (o.badge) { setFont(10, true); room -= ctx.measureText(TYPES[o.badge].name).width + 18; }
      if (o.right) { setFont(11); room -= ctx.measureText(o.right).width + 6; }
      if (o.hp) room -= 158;
      const lab = fitText(o.label, room, 13, false, 13);
      text(lab.s, cx + 18, mid, 13, o.disabled ? '#a39c8c' : '#2b2420');
      if (o.sub) text(fitText(o.sub, cellW - 26, 10).s, cx + 18, cy + 28, 10, o.subColor || '#5a5048');
      let right = cx + cellW - 8;
      if (o.hp) {
        text(Math.ceil(o.hp[0]) + '/' + o.hp[1], right, mid, 11, '#5a5048', 'right');
        hpBar(right - 150, mid - 8, 96, o.hp[0], o.hp[1]);
        right -= 158;
      }
      if (o.right) { text(o.right, right, mid, 11, '#5a5048', 'right'); setFont(11); right -= ctx.measureText(o.right).width + 6; }
      if (o.badge) {
        setFont(13);
        const lx = cx + 18 + ctx.measureText(lab.s).width + 8;
        badge(o.badge, lx, mid - 2);
      }
    });
    if (m.footer) text(fitText(m.footer, m.w - 28, 11).s, m.x + 14, m.y + m.h - 10, 11, '#5a5048');
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
    hudName(bt.foe, 24, 31, 198, bt.foe.infinite ? 'Lv.∞' : 'Lv.' + bt.foe.level, !!bt.foe.infinite);
    text('HP', 24, 45, 9, '#c0442f', 'left', true);
    hpBar(42, 38, 156, bt.hp.foe, stats(bt.foe).hp);
    // mine: right, above the text box
    const max = stats(bt.me).hp;
    box(270, 172, 198, 58);
    hudName(bt.me, 282, 191, 456, 'Lv.' + bt.me.level, false);
    text('HP', 282, 205, 9, '#c0442f', 'left', true);
    hpBar(300, 198, 156, bt.hp.me, max);
    text(Math.ceil(bt.hp.me) + ' / ' + max, 456, 221, 11, '#5a5048', 'right');
    const lo = expAt(bt.me.level), hi = expAt(bt.me.level + 1);
    ctx.fillStyle = '#d6cdb4'; ctx.fillRect(282, 216, 110, 3);
    ctx.fillStyle = '#4a8fd8'; ctx.fillRect(282, 216, 110 * Math.max(0, Math.min(1, (bt.me.exp - lo) / (hi - lo))), 3);
  }

  // A monster's name, its type badge and its level on one line from x to right.
  function hudName(m, x, y, right, lv, gold) {
    setFont(gold ? 13 : 11, gold);
    const lvW = ctx.measureText(lv).width;
    setFont(10, true);
    const badgeW = ctx.measureText(TYPES[SPECIES[m.sp].type].name).width + 10;
    const t = fitText(nm(m), right - x - lvW - badgeW - 14, 13, true, 10);
    text(t.s, x, y, t.px, '#2b2420', 'left', true);
    badge(SPECIES[m.sp].type, x + 6 + ctx.measureText(t.s).width, y - 2);
    text(lv, right, y, gold ? 13 : 11, gold ? '#c08a12' : '#5a5048', 'right', gold);
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
    if (hasAura(m.sp)) drawAura(ctx, m.sp, im, 102 - im.width * k / 2, 122 - im.height * k, im.width * k, im.height * k);
    ctx.drawImage(im, 102 - im.width * k / 2, 122 - im.height * k, im.width * k, im.height * k);
    setFont(12); const lvW = ctx.measureText('Lv.' + m.level).width;
    setFont(10, true); const badgeW = ctx.measureText(TYPES[sp.type].name).width + 10;
    const cardName = fitText(m.nick ? m.nick + ' (' + sp.name + ')' : sp.name, 428 - 164 - lvW - badgeW - 16, 15, true, 11);
    text(cardName.s, 164, 42, cardName.px, '#2b2420', 'left', true);
    badge(sp.type, 170 + ctx.measureText(cardName.s).width, 40);
    text('Lv.' + m.level, 428, 42, 12, '#5a5048', 'right');
    const tier = rarityOf(m.sp);
    text(tier.name + ' ' + tier.stars, 428, 121, 11, tier.color, 'right', true);
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
    const evo = sp.evolve;
    text(evo ? 'วิวัฒนาการ : เป็น' + SPECIES[evo.to].name + ' ที่ Lv.' + evo.level
      + (evo.item ? ' + ' + ITEMS[evo.item].name + ' (มี ' + G.bag[evo.item] + ')' : '') : 'วิวัฒนาการ : ร่างสุดท้ายแล้ว', 56, 244, 11, '#5a5048');
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
    // the objective guide, at the top while walking (hidden behind the place name, messages and menus)
    if (mode === 'world' && G && !G.flags.hideGoal && !ui.banner && !ui.msg && !ui.menu && !ui.card && !ui.chart) {
      const q = questNow();
      if (q) {
        if (goalUi.last !== null && goalUi.last !== q.text) { goalUi.glow = 3; AUDIO.sfx('levelup'); }
        goalUi.last = q.text;
        const line = '◆ เป้าหมาย : ' + q.text + (q.hint ? '  (' + q.hint + ')' : '');
        const lines = wrap(line, 400, 11);
        setFont(11, true);                // measured bold: the widest it is ever drawn
        const w = Math.min(460, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 30), h = 10 + lines.length * 15;
        const y = 6 - uiTop();
        ctx.globalAlpha = 0.93;
        box(240 - w / 2, y, w, h);
        ctx.globalAlpha = 1;
        if (goalUi.glow > 0) {
          ctx.strokeStyle = 'rgba(255,196,64,' + Math.min(1, goalUi.glow) + ')'; ctx.lineWidth = 2;
          roundRect(240 - w / 2 - 1, y - 1, w + 2, h + 2, 7); ctx.stroke();
        }
        lines.forEach((l, i) => text(l, 240, y + 17 + i * 15, 11, '#2b2420', 'center', i === 0 && goalUi.glow > 0));
      }
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
    if (goalUi.glow > 0) goalUi.glow = Math.max(0, goalUi.glow - dt);
    updateVirtual(dt);
    if (mode === 'world') updateWorld(dt);
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    pollGamepad();
    const n = bot.on ? bot.speed : 1;
    for (let i = 0; i < n; i++) { if (bot.on) botStep(dt); tick(dt); }
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
    AUDIO.music('village');
    let start = null;                    // a save to play, or null for a new game
    for (;;) {
      const saved = loadSave();
      const opts = (saved ? ['เล่นต่อ', 'เริ่มเกมใหม่'] : ['เริ่มเกมใหม่'])
        .concat([ONLINE.loggedIn ? 'ออนไลน์ (' + ONLINE.username + ')' : 'ออนไลน์ / เซฟคลาวด์', 'ตารางอันดับ']);
      const h = opts.length * 22 + 14;
      const i = await choose(opts, { x: 145, y: 312 - h, w: 190, rowH: 22 });
      const what = opts[i];
      if (what === 'ตารางอันดับ') { await leaderboardScreen(); continue; }
      if (what.startsWith('ออนไลน์')) {
        const cloud = await onlineMenu(true);
        if (cloud) { start = cloud; break; }
        continue;
      }
      if (what === 'เล่นต่อ') start = saved;
      else if (saved && !(await yesNo('เริ่มเกมใหม่ เซฟเดิมในเครื่องนี้จะถูกแทนที่ ใช่ไหม?'))) continue;
      if (!start) ONLINE.link(false);     // a new game is not linked to the account until uploaded
      break;
    }
    await fadeTo(1, 250);
    if (start) G = start; else newGame();
    upgradeSave();
    startWorld();
    await fadeTo(0, 250);
    if (!G.flags.intro) {
      G.flags.intro = true;
      await run(async () => {
        await say('เช้าวันใหม่ที่หมู่บ้านต้นกล้า\nก่อนออกเดินทาง ขอทราบชื่อของคุณหน่อย');
        await askHeroName(true);
        await say('ยินดีที่ได้รู้จัก {ชื่อ}!\nวันนี้ศาสตราจารย์สนนัดให้ไปพบที่ลานกลางหมู่บ้าน');
        await say('เดินตามทางดินไปทางขวา แล้วคุยกับศาสตราจารย์ด้วยปุ่ม Z');
      });
    } else if (!G.name) {
      await run(async () => {
        await say('ระบบใหม่! ตอนนี้ตั้งชื่อตัวละครได้แล้ว\nตั้งชื่อให้ตัวละครของคุณหน่อย');
        await askHeroName(true);
        await say('เรียบร้อย! ต่อไปนี้ทุกคนจะเรียกคุณว่า {ชื่อ}');
      });
    }
  }

  // ---- install as an app (Windows): Edge / Chrome announce that the game can be installed;
  // keep that offer and show our own button, which opens the browser's install dialog.
  function setupInstall() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    const btn = document.getElementById('btnInstall');
    const ua = navigator.userAgentData;
    const windows = ua && ua.platform ? ua.platform === 'Windows' : /Windows/i.test(navigator.userAgent);
    const installed = window.matchMedia && window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
    if (!btn || !windows || installed) return;
    let offer = null;
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();               // no browser mini-bar; our button asks instead
      offer = ev;
      btn.hidden = false;
    });
    btn.addEventListener('click', async () => {
      if (!offer) return;
      btn.hidden = true;
      offer.prompt();
      const choice = await offer.userChoice.catch(() => null);
      if (!choice || choice.outcome !== 'accepted') btn.hidden = false;   // still offered later
      else offer = null;
    });
    window.addEventListener('appinstalled', () => { offer = null; btn.hidden = true; });
  }

  function setupSound() {
    const btn = document.getElementById('btnSound');
    const show = () => { if (btn) { btn.textContent = AUDIO.on ? '🔊' : '🔇'; btn.title = AUDIO.on ? 'ปิดเสียง (M)' : 'เปิดเสียง (M)'; } };
    const flip = () => { AUDIO.toggle(); show(); };
    if (btn) btn.addEventListener('click', (ev) => { ev.preventDefault(); flip(); btn.blur(); });
    window.addEventListener('keydown', (ev) => { if ((ev.key === 'm' || ev.key === 'M') && !ev.repeat && !typing(ev)) flip(); });
    show();
  }

  async function boot() {
    setupTouch();
    setupSound();
    setupInstall();
    // The auto-play bot is for testing only: its button and the P key exist only when the
    // page is opened with ?bot in the address (e.g. index.html?bot or index.html?test&bot).
    const botBtn = document.getElementById('btnBot');
    if (/[?&]bot(&|=|$)/.test(location.search)) {
      botBtn.hidden = false;
      botBtn.addEventListener('click', (ev) => { ev.preventDefault(); cycleBot(); botBtn.blur(); });
      window.addEventListener('keydown', (ev) => { if ((ev.key === 'p' || ev.key === 'P') && !ev.repeat && !typing(ev)) cycleBot(); });
    }
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


  // ------------------------------------------------------------ auto-play bot
  // For testing: plays by itself. It answers messages and menus, fights with the strongest
  // move, uses potions when low, catches species not caught yet, heals at the spring or the
  // healing centre, and otherwise walks through tall grass to find wild monsters.
  // It does not take on trainers, the gym or the story by itself (it only collects the
  // starter). Toggle: the robot button or the P key; each press cycles off -> x1 -> x4.
  const bot = { on: false, speed: 1, cool: 0, wander: null, last: '' };
  function setBot(on, speed) {
    bot.on = on; bot.speed = speed; bot.cool = 0;
    holdDir('bot', 'up', false);
    const el = document.getElementById('btnBot');
    if (el) {
      el.textContent = on ? 'บอท ×' + speed : 'บอท';
      el.classList.toggle('on', on);
    }
  }
  function cycleBot() {
    if (!bot.on) setBot(true, 1); else if (bot.speed === 1) setBot(true, 4); else setBot(false, 1);
  }
  const hpRatio = (m) => m.hp / stats(m).hp;
  const teamRatio = () => {
    const alive = G.party.filter((m) => m.hp > 0);
    return alive.length ? alive.reduce((n, m) => n + hpRatio(m), 0) / G.party.length : 0;
  };
  function moveScore(id, me, foe) {
    const mv = MOVES[id];
    return mv.power * typeMult(mv.type, SPECIES[foe.sp].type) * (mv.type === SPECIES[me.sp].type ? 1.5 : 1);
  }
  // which option to take in the open menu (-1 = cancel)
  function botMenuPick(m) {
    const labels = m.opts.map((o) => o.label);
    if (labels[0] === 'ใช่' && labels[1] === 'ไม่') return 0;
    if (m.kind === 'act' && bt) {
      const me = bt.me, foe = bt.foe, wild = bt.trainerX === null, at = (l) => labels.indexOf(l);
      if (bt.legend) return at('หนี');                            // the legend: just back away
      if (hpRatio(me) < 0.3 && itemCount('heal') > 0) return at('ยา');
      if (wild && !G.caught.includes(foe.sp) && itemCount('ball') > 0 && foe.hp / stats(foe).hp < 0.5) return at('แคปซูล');
      if (wild && hpRatio(me) < 0.2) return at('หนี');
      return at('ต่อสู้');
    }
    if (m.kind === 'move' && bt) {                               // strongest move that is ready
      let best = -1;
      m.data.forEach((id, i) => {
        if (m.opts[i].disabled) return;
        if (best < 0 || moveScore(id, bt.me, bt.foe) > moveScore(m.data[best], bt.me, bt.foe)) best = i;
      });
      return Math.max(0, best);
    }
    if (m.kind === 'mon') {                                       // the healthiest monster that can go
      let best = -1;
      G.party.forEach((mon, i) => { if (!m.opts[i].disabled && (best < 0 || hpRatio(mon) > hpRatio(G.party[best]))) best = i; });
      return best < 0 ? (m.cancellable ? -1 : 0) : best;
    }
    if (m.kind === 'item') {
      const have = m.data;
      if (bt && have.includes('potion_plus') && stats(bt.me).hp - bt.me.hp >= 40) return have.indexOf('potion_plus');
      return have.indexOf('potion') >= 0 ? have.indexOf('potion') : have.indexOf('capsule') >= 0 ? have.indexOf('capsule') : 0;
    }
    if (m.kind === 'learn') {                                     // forget the weakest move if the new one is stronger
      const mon = m.data.mon, power = (id) => MOVES[id].power * (MOVES[id].type === SPECIES[mon.sp].type ? 1.5 : 1);
      let weakest = 0;
      mon.moves.forEach((id, i) => { if (power(id) < power(mon.moves[weakest])) weakest = i; });
      return power(m.data.id) > power(mon.moves[weakest]) ? weakest : mon.moves.length;
    }
    return m.cancellable ? -1 : 0;                                // shops, team screen and the like: leave
  }
  // shortest walk to any of the goal cells; returns the first step's direction, '' when already there
  function botPath(goals, avoidGrass) {
    const key = (c, r) => c + ',' + r;
    const start = key(pl.c, pl.r);
    if (goals.has(start)) return '';
    const from = new Map([[start, null]]);
    const q = [[pl.c, pl.r]];
    while (q.length) {
      const [c, r] = q.shift();
      for (const d of ['up', 'down', 'left', 'right']) {
        const nc = c + DIRS[d][0], nr = r + DIRS[d][1], k = key(nc, nr);
        if (from.has(k)) continue;
        const door = MAP.warps.has(k);                            // doors are blocked cells you walk into
        if (door && !goals.has(k)) continue;
        if (!door && isBlocked(nc, nr)) continue;
        if (avoidGrass && MAP.tall.has(k) && !goals.has(k)) continue;
        from.set(k, [key(c, r), d]);
        if (goals.has(k)) {                                       // walk back to the first step
          let cur = k, step = d;
          while (from.get(cur) && from.get(cur)[0] !== start) cur = from.get(cur)[0];
          step = from.get(cur)[1];
          return step;
        }
        q.push([nc, nr]);
      }
    }
    return null;
  }
  // stand next to cell (c, r), face it and press the confirm key
  function botVisit(cells, avoidGrass) {
    const goals = new Set(), faceOf = new Map();
    for (const [c, r] of cells) {
      for (const d of ['up', 'down', 'left', 'right']) {
        const sc = c - DIRS[d][0], sr = r - DIRS[d][1];
        if (!isBlocked(sc, sr)) { goals.add(sc + ',' + sr); faceOf.set(sc + ',' + sr, d); }
      }
    }
    const step = botPath(goals, avoidGrass);
    if (step === '') { pl.dir = faceOf.get(pl.c + ',' + pl.r); press('ok', false); return true; }
    if (step) { pl.dir = step; tryMove(step); return true; }
    return false;
  }
  function botWorld() {
    const npc = (id) => npcs.filter((n) => n.id === id).map((n) => [n.c, n.r]);
    const spots = (id) => [...MAP.interact].filter(([, v]) => v === id).map(([k]) => k.split(',').map(Number));
    // 1. no partner yet: see the professor
    if (!G.party.length) { if (MAP.id === 'village' && botVisit(npc('researcher'), true)) return; }
    // 2. tired: heal at the spring, or at the healing centre in the village
    else if (teamRatio() < 0.45 || G.party.every((m) => m.hp <= 0)) {
      if (spots('spring').length && botVisit(spots('spring'), true)) return;
      if (MAP.indoor && spots('healer').length && botVisit(spots('healer'), true)) return;
      {
        const door = [...MAP.warps].find(([, w]) => (ROOMS[w.map] || {}).kind === 'heal' || w.map === 'heal');
        if (door) { const step = botPath(new Set([door[0]]), true); if (step) { pl.dir = step; tryMove(step); return; } }
      }
    }
    // 3. indoors with nothing to do: go out
    if (MAP.indoor) {
      const out = new Set([...MAP.warps.keys()]);
      const step = botPath(out, false);
      if (step) { pl.dir = step; tryMove(step); return; }
    }
    // 4. otherwise roam the tall grass
    if (MAP.tall.has(pl.c + ',' + pl.r)) {
      const opts = ['up', 'down', 'left', 'right'].filter((d) => {
        const k = (pl.c + DIRS[d][0]) + ',' + (pl.r + DIRS[d][1]);
        return MAP.tall.has(k) && !isBlocked(pl.c + DIRS[d][0], pl.r + DIRS[d][1]);
      });
      if (opts.length) {
        if (!bot.wander || !opts.includes(bot.wander) || Math.random() < 0.25) bot.wander = opts[rand(opts.length)];
        pl.dir = bot.wander; tryMove(bot.wander); return;
      }
    }
    const step = botPath(new Set(MAP.tall.keys()), false);
    if (step) { pl.dir = step; tryMove(step); return; }
    // nothing to do on this map (no grass): head back toward the village
    const exits = MAP.exits.filter((e) => e.to && e.to.map === (MAP.id === 'route2' ? 'route1' : 'village'));
    if (exits.length) {
      const e = exits[0], goals = new Set();
      for (let c = e.c0; c <= e.c1; c++) goals.add(c + ',' + (e.side === 'up' ? 0 : MAP.h - 1));
      const s = botPath(goals, false);
      if (s === '') { pl.dir = e.side; tryMove(e.side); } else if (s) { pl.dir = s; tryMove(s); }
    }
  }
  function botStep(dt) {
    bot.cool -= dt;
    if (bot.cool > 0) return;
    bot.cool = 0.12;
    if (textOpen) { document.getElementById('nameOk').click(); return; }
    if (ui.wait) { press('ok', false); return; }
    if (ui.menu) {
      const m = ui.menu, i = botMenuPick(m);
      if (i < 0) { press('back', false); return; }
      if (m.opts[i] && m.opts[i].disabled) { if (m.cancellable) press('back', false); return; }
      m.index = i; if (m.onMove) m.onMove(i);
      press('ok', false);
      return;
    }
    if (ui.msg) { const len = pageLength(ui.msg.pages[ui.msg.page]); ui.msg.shown = len; press('ok', false); return; }
    if (mode === 'world' && !busy && !pl.moving && G) { bot.cool = 0; botWorld(); }
  }

  // for testing from the browser console
  window.GAME = {
    bot: (on, speed) => setBot(on, speed || 1), botState: () => ({ ...bot }), sound: () => AUDIO.state,
    get state() { return { mode, busy, G, pl, bt, msg: ui.msg ? ui.msg.pages.map((p) => p.map((l) => l.join('')).join('\n')).join('\n') : null,
      menu: ui.menu ? { index: ui.menu.index, opts: ui.menu.opts.map((o) => o.label) } : null, prompt: ui.prompt }; },
    press, map: () => MAP, maps: () => MAPS,
    warp(c, r, mapId) { if (mapId) setMap(mapId); pl.c = c; pl.r = r; pl.moving = false; },
    hold(dir, on) { holdDir('test', dir, on); },
    pollPad: pollGamepad, inputMode: () => inputMode,
    // run the game for a number of seconds without waiting for the screen to refresh
    async advance(seconds) {
      const turn = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
      for (let t = 0; t < seconds; t += 1 / 60) { if (bot.on) botStep(1 / 60); tick(1 / 60); await turn(); }
      render();
    },
  };

  boot();
})();
