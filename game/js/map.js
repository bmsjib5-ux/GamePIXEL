'use strict';
// Builds every map: the village and the inside of each building.
// A map holds its ground tiles, sprites, collision, things to examine, and warps to other maps.

const MAP_W = 32, MAP_H = 32, TS = 32;      // MAP_W / MAP_H are the village's size
const cellKey = (c, r) => c + ',' + r;

function seededRandom(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function rect(c0, r0, c1, r1) {
  const s = new Set();
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) s.add(cellKey(c, r));
  return s;
}
function cells(list) { return new Set(list.map(([c, r]) => cellKey(c, r))); }
function union(...sets) { const s = new Set(); for (const x of sets) for (const k of x) s.add(k); return s; }
const outsideMap = (c, r) => c < 0 || r < 0 || c >= MAP_W || r >= MAP_H;

// Picks the right piece (edge, corner, inner corner, centre) for every cell of a patch.
function autotile(kind, set, runsOffMap) {
  const has = (c, r) => (runsOffMap && outsideMap(c, r)) || set.has(cellKey(c, r));
  const out = new Map();
  for (const k of set) {
    const [c, r] = k.split(',').map(Number);
    const n = has(c, r - 1), s = has(c, r + 1), w = has(c - 1, r), e = has(c + 1, r);
    let part = '';
    if (!(n && s)) part += (n ? '' : 'n') + (s ? '' : 's');
    if (!(w && e)) part += (w ? '' : 'w') + (e ? '' : 'e');
    if (!part) {
      for (const [dc, dr, name] of [[-1, -1, 'inner_nw'], [1, -1, 'inner_ne'], [-1, 1, 'inner_sw'], [1, 1, 'inner_se']]) {
        if (!has(c + dc, r + dr)) { part = name; break; }
      }
    }
    out.set(k, kind + '_' + (part || 'c'));
  }
  return out;
}

// Wide patch plus one-tile-wide strips of the same terrain (narrow path, river).
const STRIP_NAMES = { path: ['path_narrow_', 'path_join_'], pond: ['river_', 'river_join_'] };
function stripLayout(kind, wide, narrow, runsOffMap) {
  const [narrowPrefix, joinPrefix] = STRIP_NAMES[kind];
  const names = autotile(kind, wide, runsOffMap);
  const step = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
  const joins = (c, r) => (runsOffMap && outsideMap(c, r)) || narrow.has(cellKey(c, r)) || wide.has(cellKey(c, r));
  for (const k of narrow) {
    const [c, r] = k.split(',').map(Number);
    let dirs = '';
    for (const d of 'nesw') if (joins(c + step[d][0], r + step[d][1])) dirs += d;
    names.set(k, narrowPrefix + (dirs || 'dot'));
  }
  for (const k of wide) {
    const [c, r] = k.split(',').map(Number);
    for (const d of 'nesw') {
      if (names.get(k) === kind + '_' + d && narrow.has(cellKey(c + step[d][0], r + step[d][1]))) {
        names.set(k, joinPrefix + d);
      }
    }
  }
  return names;
}

function line(c0, r0, c1, r1) {           // straight run of cells, inclusive
  const out = [];
  const dc = Math.sign(c1 - c0), dr = Math.sign(r1 - r0);
  for (let c = c0, r = r0; ; c += dc, r += dr) { out.push([c, r]); if (c === c1 && r === r1) break; }
  return out;
}

// An empty map plus helpers to fill it.
function mapBuilder(id, w, h, fill) {
  const ground = [];
  for (let r = 0; r < h; r++) ground.push(new Array(w).fill(fill));
  const m = { id, w, h, ground, blocked: new Uint8Array(w * h), things: [], interact: new Map(),
              tall: new Map(), npcs: [], warps: new Map(), indoor: false };
  const block = (c, r) => { if (c >= 0 && r >= 0 && c < w && r < h) m.blocked[r * w + c] = 1; };
  // Places a sprite with its bottom-left corner on cell (c, r).
  // opts: id = what happens when examined, walkable, flat = lies on the floor, dx / dy = pixel nudge
  function sprite(folder, name, c, r, opts = {}) {
    const meta = SPRITE_META[folder][name];
    const x = c * TS + (opts.dx || 0), y = (r + 1) * TS - meta.h + (opts.dy || 0);
    m.things.push({ img: folder + '/' + name, x, y, w: meta.w, h: meta.h, sortY: opts.flat ? 0 : (r + 1) * TS });
    for (let i = 0; i < meta.w / TS; i++) {
      if (!opts.walkable) block(c + i, r);
      if (opts.id) m.interact.set(cellKey(c + i, r), opts.id);
    }
  }
  return { m, block, sprite };
}

// Rooms: w x h cells where the top two rows are wall; exit = column of the door mat;
// door = [column, row] of the building's door cell in the village.
const ROOMS = {
  home:  { w: 9,  h: 8, exit: 4, door: [6, 7] },
  lab:   { w: 13, h: 9, exit: 6, door: [15, 7] },
  heal:  { w: 11, h: 8, exit: 5, door: [24, 7] },
  house: { w: 9,  h: 8, exit: 4, door: [6, 17] },
  shop:  { w: 11, h: 8, exit: 5, door: [25, 18] },
  mill:  { w: 9,  h: 8, exit: 4, door: [28, 25] },
};

function buildRoom(id) {
  const spec = ROOMS[id];
  const B = mapBuilder(id, spec.w, spec.h + 1, 'floor_wood');   // one extra row below: the doorway
  const m = B.m;
  m.indoor = true;
  for (let c = 0; c < spec.w; c++) {
    m.ground[0][c] = 'wall_upper'; m.ground[1][c] = 'wall_indoor';
    m.ground[spec.h][c] = null;
    B.block(c, 0); B.block(c, 1); B.block(c, spec.h);
  }
  B.sprite('furniture', 'door_mat', spec.exit, spec.h - 1, { walkable: true, flat: true });
  m.warps.set(cellKey(spec.exit, spec.h), { map: 'village', c: spec.door[0], r: spec.door[1] + 1, dir: 'down' });
  const f = (name, c, r, opts) => B.sprite('furniture', name, c, r, opts);
  const o = (name, c, r, opts) => B.sprite('objects', name, c, r, opts);

  if (id === 'home') {
    f('rug', 3, 6, { walkable: true, flat: true });
    f('bed', 1, 3, { id: 'home_bed' });
    f('kitchen_counter', 3, 2, { id: 'home_kitchen' });
    f('bookshelf', 6, 2, { id: 'home_books' });
    f('table', 3, 5); f('stool', 2, 5); f('stool', 5, 5);
    f('plant', 8, 2); f('plant', 0, 7);
  } else if (id === 'house') {
    f('rug', 1, 6, { walkable: true, flat: true });
    f('bookshelf', 1, 2, { id: 'house_books' });
    f('kitchen_counter', 4, 2, { id: 'house_kitchen' });
    f('bed', 7, 3, { id: 'house_bed' });
    f('table', 5, 5); f('stool', 7, 5);
    f('plant', 8, 7, { id: 'house_plant' }); f('plant', 0, 2);
  } else if (id === 'lab') {
    f('computer_desk', 1, 2, { id: 'lab_computer' });
    f('computer_desk', 4, 2, { id: 'lab_notes' });
    f('tank', 7, 2, { id: 'lab_tank' }); f('tank', 8, 2, { id: 'lab_tank' }); f('tank', 9, 2, { id: 'lab_tank' });
    f('bookshelf', 11, 2, { id: 'lab_books' });
    f('rug', 5, 6, { walkable: true, flat: true });
    f('table', 2, 5, { id: 'lab_table' }); f('stool', 4, 5);
    f('bookshelf', 10, 5, { id: 'lab_books' });
    f('plant', 0, 8); f('plant', 12, 8);
  } else if (id === 'heal') {
    f('rug', 4, 6, { walkable: true, flat: true });
    f('reception_desk', 4, 3, { id: 'healer' });
    f('healing_machine', 8, 2, { id: 'heal_machine' });
    f('bookshelf', 1, 2, { id: 'heal_books' });
    f('plant', 0, 7); f('plant', 10, 7); f('stool', 1, 5); f('stool', 9, 5);
    m.npcs.push({ id: 'healer', sheet: 'chars/npc_healer', c: 5, r: 2, dir: 'down' });
    B.block(4, 2); B.block(6, 2);        // only the nurse goes behind the desk
  } else if (id === 'shop') {
    f('shop_counter', 2, 4, { id: 'shopkeeper' });
    f('goods_shelf', 6, 2, { id: 'shop_shelf' }); f('goods_shelf', 8, 2, { id: 'shop_shelf' });
    f('goods_shelf', 7, 5, { id: 'shop_shelf' });
    o('barrel', 0, 2); o('crate', 10, 2); o('crate', 0, 7); f('sacks', 10, 7);
    f('plant', 1, 2);
    m.npcs.push({ id: 'shopkeeper', sheet: 'chars/npc_shopkeeper', c: 3, r: 3, dir: 'down' });
    B.block(2, 3); B.block(4, 3);        // only the shopkeeper goes behind the counter
  } else if (id === 'mill') {
    f('millstone', 3, 4, { id: 'mill_stone' });
    f('sacks', 0, 2); f('sacks', 1, 2); f('sacks', 7, 6, { id: 'mill_sacks' }); f('sacks', 8, 6);
    o('crate', 7, 2); o('barrel', 8, 2); o('barrel', 0, 7);
  }
  m.things.sort((a, b) => a.sortY - b.sortY);
  return m;
}

function buildVillage() {
  const rng = seededRandom(20261118);
  const B = mapBuilder('village', MAP_W, MAP_H, 'grass');
  const m = B.m, ground = m.ground, block = B.block;
  for (let r = 0; r < MAP_H; r++) for (let c = 0; c < MAP_W; c++) {
    const v = rng();
    ground[r][c] = v < 0.74 ? 'grass' : v < 0.90 ? 'grass_tufts' : v < 0.95 ? 'grass_white_flowers' : 'grass_color_flowers';
  }
  const put = (layout) => { for (const [k, name] of layout) { const [c, r] = k.split(',').map(Number); ground[r][c] = name; } };

  // ---- dirt: village square, the road south, and narrow paths to every door
  const square = rect(11, 9, 19, 13);
  const road = rect(14, 14, 16, 31);
  const narrowPath = cells([
    [15, 8],                                                   // lab door
    ...line(6, 8, 6, 10), ...line(7, 10, 10, 10),              // red house
    ...line(24, 8, 24, 10), ...line(23, 10, 20, 10),           // healing centre
    ...line(6, 18, 13, 18),                                    // teal house
    ...line(25, 19, 17, 19),                                   // shop
    ...line(28, 26, 28, 27), ...line(27, 27, 17, 27),          // windmill
    ...line(13, 28, 2, 28),                                    // across the river
  ]);
  put(stripLayout('path', union(square, road), narrowPath, true));

  // ---- water: pond and the river running south off the map
  const pond = rect(2, 21, 7, 25);
  const river = cells(line(4, 26, 4, 31));
  put(stripLayout('pond', pond, river, true));
  ground[28][4] = 'river_bridge_ew';

  // ---- cobble court and a raised plateau
  put(autotile('plaza', rect(20, 21, 24, 23), false));
  put(autotile('plateau', rect(26, 9, 29, 11), false));

  // ---- tall grass (wild monsters)
  const grass = [[rect(9, 21, 12, 26), 'west'], [rect(6, 29, 12, 30), 'west'], [rect(18, 28, 25, 30), 'east']];
  for (const [set, area] of grass) {
    for (const k of set) { const [c, r] = k.split(',').map(Number); ground[r][c] = 'tall_grass'; m.tall.set(k, area); }
  }

  // ---- ground that cannot be walked on
  for (let r = 0; r < MAP_H; r++) for (let c = 0; c < MAP_W; c++) {
    const g = ground[r][c];
    if (g.startsWith('pond_') || g.startsWith('plateau_') || (g.startsWith('river_') && !g.startsWith('river_bridge'))) block(c, r);
  }

  const object = (name, c, r, opts) => B.sprite('objects', name, c, r, opts);
  // The building's door lines up with its room's door cell; walking into the door enters the room.
  function building(name, room) {
    const meta = SPRITE_META.buildings[name];
    const [doorCol, bottomRow] = ROOMS[room].door;
    const x = doorCol * TS + TS / 2 - meta.door, y = (bottomRow + 1) * TS - meta.h;
    m.things.push({ img: 'buildings/' + name, x, y, w: meta.w, h: meta.h, sortY: (bottomRow + 1) * TS });
    const c0 = Math.floor((x + meta.x0 + 4) / TS), c1 = Math.floor((x + meta.x1 - 5) / TS);
    const r0 = Math.floor((y + meta.y0 + 16) / TS);
    for (let r = r0; r <= bottomRow; r++) for (let c = c0; c <= c1; c++) block(c, r);
    m.warps.set(cellKey(doorCol, bottomRow), { map: room, c: ROOMS[room].exit, r: ROOMS[room].h - 1, dir: 'up' });
  }
  building('lab_dome', 'lab');
  building('house_red', 'home');
  building('healing_center', 'heal');
  building('house_teal', 'house');
  building('shop', 'shop');
  building('windmill', 'mill');

  // forest border: top row and both sides
  const treeKinds = ['tree_round', 'tree_round', 'tree_pine', 'tree_round', 'tree_apple', 'tree_round', 'tree_pine', 'tree_orange'];
  const pick = () => treeKinds[Math.floor(rng() * treeKinds.length)];
  for (let c = 0; c < MAP_W; c += 2) object(pick(), c, 2);
  for (let r = 4; r < MAP_H; r += 2) { object(pick(), 0, r); object(pick(), 30, r); }
  for (let r = 0; r < MAP_H; r++) { block(0, r); block(1, r); block(30, r); block(31, r); }
  for (let c = 0; c < MAP_W; c++) for (let r = 0; r < 3; r++) block(c, r);
  // fence along the bottom, open where the road and the river leave
  for (let c = 2; c < 30; c++) if (c !== 4 && (c < 14 || c > 16)) object('fence_h', c, 31);

  object('tree_apple', 9, 14); object('tree_orange', 19, 16); object('tree_pine', 2, 19);
  object('tree_round', 10, 6); object('tree_round', 19, 6); object('tree_pine', 22, 26);
  object('flower_bed', 7, 8); object('flower_bed', 21, 8); object('flower_bed', 9, 16);
  object('barrel', 21, 18); object('crate', 21, 17);
  object('bush', 10, 15); object('bush', 18, 15); object('bush_berry', 12, 16); object('bush', 3, 9);
  object('bush_berry', 22, 12); object('bush', 9, 19); object('bush', 26, 13);
  object('rocks', 11, 27); object('boulder', 19, 25); object('boulder', 27, 10); object('rocks', 5, 20);
  object('well', 21, 22, { id: 'well' });
  object('signpost', 13, 14, { id: 'sign_village' });
  object('signpost', 17, 30, { id: 'sign_route' });
  object('signpost', 13, 20, { id: 'sign_grass' });
  object('crate', 2, 27, { id: 'item_crate' });

  m.things.sort((a, b) => a.sortY - b.sortY);
  m.npcs.push({ id: 'researcher', sheet: 'chars/npc_researcher', c: 16, r: 10, dir: 'down' });
  m.npcs.push({ id: 'rival', sheet: 'chars/npc_rival', c: 15, r: 23, dir: 'up' });
  return m;
}

function buildMaps() {
  const maps = { village: buildVillage() };
  for (const id of Object.keys(ROOMS)) maps[id] = buildRoom(id);
  return maps;
}
const START_SPOT = { map: 'village', c: 6, r: 9, dir: 'down' };
const HEAL_SPOT = { map: 'heal', c: 5, r: 5, dir: 'up' };      // where you wake up after losing
