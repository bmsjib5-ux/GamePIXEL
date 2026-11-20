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

// Picks the right piece (edge, corner, inner corner, centre) for every cell of a patch.
// w, h = the map's size, so a patch can be told to carry on past the map's edge.
function autotile(kind, set, runsOffMap, w = MAP_W, h = MAP_H) {
  const outsideMap = (c, r) => c < 0 || r < 0 || c >= w || r >= h;
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
function stripLayout(kind, wide, narrow, runsOffMap, w = MAP_W, h = MAP_H) {
  const outsideMap = (c, r) => c < 0 || r < 0 || c >= w || r >= h;
  const [narrowPrefix, joinPrefix] = STRIP_NAMES[kind];
  const names = autotile(kind, wide, runsOffMap, w, h);
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
              tall: new Map(), npcs: [], warps: new Map(), exits: [], indoor: false };
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
// door = [column, row] of the building's door cell on the map it stands on
// (from, the village unless given); floor = ground tile, wooden boards unless given.
const ROOMS = {
  home:  { w: 9,  h: 8, exit: 4, door: [6, 7] },
  lab:   { w: 13, h: 9, exit: 6, door: [15, 7] },
  heal:  { w: 11, h: 8, exit: 5, door: [24, 7] },
  house: { w: 9,  h: 8, exit: 4, door: [6, 17] },
  shop:  { w: 11, h: 8, exit: 5, door: [25, 18] },
  mill:  { w: 9,  h: 8, exit: 4, door: [28, 25] },
  gym:   { w: 13, h: 12, exit: 6, door: [13, 25], from: 'route1', floor: 'cobble' },
  // stage 4 (the town): a second healing centre (laid out like the first) and the Water Gym
  heal2: { w: 11, h: 8, exit: 5, door: [6, 15], from: 'town', kind: 'heal' },
  gym2:  { w: 13, h: 12, exit: 6, door: [24, 15], from: 'town' },
};

function buildRoom(id) {
  const spec = ROOMS[id];
  const B = mapBuilder(id, spec.w, spec.h + 1, spec.floor || 'floor_wood');   // one extra row below: the doorway
  const kind = spec.kind || id;          // rooms of the same kind share one layout
  const m = B.m;
  m.indoor = true;
  for (let c = 0; c < spec.w; c++) {
    m.ground[0][c] = 'wall_upper'; m.ground[1][c] = 'wall_indoor';
    m.ground[spec.h][c] = null;
    B.block(c, 0); B.block(c, 1); B.block(c, spec.h);
  }
  B.sprite('furniture', 'door_mat', spec.exit, spec.h - 1, { walkable: true, flat: true });
  m.warps.set(cellKey(spec.exit, spec.h), { map: spec.from || 'village', c: spec.door[0], r: spec.door[1] + 1, dir: 'down' });
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
  } else if (kind === 'heal') {
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
  } else if (id === 'gym') {
    // Two walls of boulders cross the hall. A trainer stands in the only gap of each and
    // steps aside once beaten; the leader waits on the rug at the far end.
    f('rug', 5, 3, { walkable: true, flat: true });
    for (const row of [5, 8]) {
      for (let c = 0; c < spec.w; c++) if (c !== 6) o((c + row) % 3 ? 'boulder' : 'rocks', c, row);
    }
    f('plant', 0, 2); f('plant', 12, 2); f('plant', 0, 11); f('plant', 12, 11);
    f('bookshelf', 1, 2, { id: 'gym_books' }); f('bookshelf', 10, 2, { id: 'gym_books' });
    m.npcs.push({ id: 'gym_hiker', sheet: 'chars/npc_gym_hiker', c: 6, r: 8, dir: 'down',
                  moved: { flag: 'gym1', c: 7, r: 9, dir: 'left' } });
    m.npcs.push({ id: 'gym_kid', sheet: 'chars/npc_gym_kid', c: 6, r: 5, dir: 'down',
                  moved: { flag: 'gym2', c: 7, r: 6, dir: 'left' } });
    m.npcs.push({ id: 'gym_leader', sheet: 'chars/npc_gym_leader', c: 6, r: 3, dir: 'down' });
  } else if (id === 'gym2') {
    // Two canals cross the hall; a trainer stands on the plank bridge over each and steps
    // aside once beaten. The leader waits on the rug at the far end.
    f('rug', 5, 3, { walkable: true, flat: true });
    for (const row of [5, 8]) {
      for (let c = 0; c < spec.w; c++) {
        m.ground[row][c] = c === 6 ? 'bridge_v' : 'water';
        if (c !== 6) B.block(c, row);
      }
    }
    f('plant', 0, 2); f('plant', 12, 2); f('plant', 0, 11); f('plant', 12, 11);
    f('bookshelf', 1, 2, { id: 'gym2_books' }); f('bookshelf', 10, 2, { id: 'gym2_books' });
    o('water_jar', 1, 10); o('water_jar', 11, 10);
    m.npcs.push({ id: 'gym2_swimmer', sheet: 'chars/npc_gym2_swimmer', c: 6, r: 8, dir: 'down',
                  moved: { flag: 'g2a', c: 7, r: 9, dir: 'left' } });
    m.npcs.push({ id: 'gym2_rower', sheet: 'chars/npc_gym2_rower', c: 6, r: 5, dir: 'down',
                  moved: { flag: 'g2b', c: 7, r: 6, dir: 'left' } });
    m.npcs.push({ id: 'gym2_leader', sheet: 'chars/npc_gym2_leader', c: 6, r: 3, dir: 'down' });
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
  const grass = [[rect(9, 21, 12, 26), 'west'], [rect(6, 29, 12, 30), 'west'],
                 [rect(18, 28, 25, 30), 'east', 'tall_rice_gold']];            // a ripe rice paddy
  for (const [set, area, tile] of grass) {
    for (const k of set) { const [c, r] = k.split(',').map(Number); ground[r][c] = tile || 'tall_grass'; m.tall.set(k, area); }
  }

  blockTerrain(m, block);

  const object = (name, c, r, opts) => B.sprite('objects', name, c, r, opts);
  const building = (name, room) => placeBuilding(B, name, room);
  building('lab_dome', 'lab');
  building('house_red', 'home');
  building('healing_center', 'heal');
  building('house_teal', 'house');
  building('shop', 'shop');
  building('windmill', 'mill');

  // forest border: top row and both sides
  const treeKinds = ['coconut_palm', 'tree_mango', 'banana_tree', 'coconut_palm', 'bamboo', 'tree_round', 'banana_tree', 'tree_mango'];
  const pick = () => treeKinds[Math.floor(rng() * treeKinds.length)];
  for (let c = 0; c < MAP_W; c += 2) object(pick(), c, 2);
  for (let r = 4; r < MAP_H; r += 2) { object(pick(), 0, r); object(pick(), 30, r); }
  for (let r = 0; r < MAP_H; r++) { block(0, r); block(1, r); block(30, r); block(31, r); }
  for (let c = 0; c < MAP_W; c++) for (let r = 0; r < 3; r++) block(c, r);
  // fence along the bottom, open where the road and the river leave
  for (let c = 2; c < 30; c++) if (c !== 4 && (c < 14 || c > 16)) object('fence_h', c, 31);

  object('tree_mango', 9, 14); object('banana_tree', 19, 16); object('coconut_palm', 2, 19);
  object('coconut_palm', 10, 6); object('coconut_palm', 19, 6); object('bamboo', 22, 26);
  object('flower_bed', 7, 8); object('flower_bed', 21, 8); object('flower_bed', 9, 16);
  object('water_jar', 21, 18); object('crate', 21, 17);
  object('bush', 10, 15); object('bush', 18, 15); object('bush_berry', 12, 16);
  object('spirit_house', 3, 9, { id: 'spirit_house' });
  object('water_jar', 9, 7); object('water_jar', 9, 17); object('baskets', 3, 17);
  object('lamp_post', 10, 12); object('lamp_post', 20, 12);
  object('food_cart', 20, 20, { id: 'food_cart' });
  object('haystack', 29, 28); object('haystack', 25, 25); object('ox_cart', 23, 25);
  object('lotus', 3, 22, { flat: true }); object('lotus', 6, 24, { flat: true }); object('lotus', 4, 25, { flat: true });
  object('bush_berry', 22, 12); object('bush', 9, 19); object('bush', 26, 13);
  object('rocks', 11, 27); object('boulder', 19, 25); object('boulder', 27, 10); object('rocks', 5, 20);
  object('sala', 21, 22, { id: 'sala' });          // an open Thai pavilion on the cobbled court
  object('signpost_thai', 13, 14, { id: 'sign_village' });
  object('signpost_thai', 17, 30, { id: 'sign_route' });
  object('signpost_thai', 13, 20, { id: 'sign_grass' });
  object('crate', 2, 27, { id: 'item_crate' });

  m.things.sort((a, b) => a.sortY - b.sortY);
  m.npcs.push({ id: 'researcher', sheet: 'chars/npc_researcher', c: 16, r: 10, dir: 'down' });
  // the rival blocks the way south until he is beaten, then waits on Route 1
  m.npcs.push({ id: 'rival', sheet: 'chars/npc_rival', c: 15, r: 23, dir: 'up', hideIf: 'rivalBeaten' });
  // walking off the bottom of the road leads to Route 1 (stage 2)
  m.exits.push({ side: 'down', c0: 14, c1: 16, to: { map: 'route1', dc: -1, r: 0 }, need: 'rivalBeaten',
                 lockedText: 'ทางไปเส้นทางที่ 1 อยู่ข้างหน้า\nแต่ต้องประลองชนะพายุที่ยืนอยู่บนถนนก่อน' });
  return m;
}

// The building's door lines up with its room's door cell; walking into the door enters the room.
function placeBuilding(B, name, room) {
  const m = B.m, meta = SPRITE_META.buildings[name];
  const [doorCol, bottomRow] = ROOMS[room].door;
  const x = doorCol * TS + TS / 2 - meta.door, y = (bottomRow + 1) * TS - meta.h;
  m.things.push({ img: 'buildings/' + name, x, y, w: meta.w, h: meta.h, sortY: (bottomRow + 1) * TS });
  const c0 = Math.floor((x + meta.x0 + 4) / TS), c1 = Math.floor((x + meta.x1 - 5) / TS);
  const r0 = Math.floor((y + meta.y0 + 16) / TS);
  for (let r = r0; r <= bottomRow; r++) for (let c = c0; c <= c1; c++) B.block(c, r);
  m.warps.set(cellKey(doorCol, bottomRow), { map: room, c: ROOMS[room].exit, r: ROOMS[room].h - 1, dir: 'up' });
}

// Water, river and raised ground cannot be walked on (bridges can).
function blockTerrain(m, block) {
  for (let r = 0; r < m.h; r++) for (let c = 0; c < m.w; c++) {
    const g = m.ground[r][c];
    if (g.startsWith('pond_') || g.startsWith('plateau_') || (g.startsWith('river_') && !g.startsWith('river_bridge'))) block(c, r);
  }
}

// Stage 2: Route 1. The road winds south across a river; the second set of monsters lives
// in its tall grass, and the rival waits near the far end.
const R1_W = 28, R1_H = 36;
function buildRoute1() {
  const rng = seededRandom(20261120);
  const B = mapBuilder('route1', R1_W, R1_H, 'grass');
  const m = B.m, ground = m.ground, block = B.block;
  m.title = 'เส้นทางที่ 1';
  for (let r = 0; r < R1_H; r++) for (let c = 0; c < R1_W; c++) {
    const v = rng();
    ground[r][c] = v < 0.70 ? 'grass' : v < 0.88 ? 'grass_tufts' : v < 0.94 ? 'grass_white_flowers' : 'grass_color_flowers';
  }
  const put = (layout) => { for (const [k, name] of layout) { const [c, r] = k.split(',').map(Number); ground[r][c] = name; } };

  // ---- the road: in at the top, west, down to the river, east, and out at the bottom.
  // It narrows to one tile to cross the river on a plank bridge.
  const road = union(rect(13, 0, 15, 9), rect(5, 7, 15, 9), rect(5, 7, 7, 11),
                     rect(5, 15, 7, 19), rect(5, 17, 21, 19), rect(19, 17, 21, 35));
  // narrow paths: over the bridge, and from the lower road to the gym's door
  put(stripLayout('path', road, cells([...line(6, 12, 6, 14), ...line(13, 26, 18, 26)]), true, R1_W, R1_H));

  // ---- the river runs right across the map and widens into a pond on the east side
  const pond = rect(20, 11, 25, 15);
  const river = cells([...line(0, 13, 19, 13), ...line(26, 13, 27, 13)]);
  put(stripLayout('pond', pond, river, true, R1_W, R1_H));
  ground[13][6] = 'river_bridge_ns';

  put(autotile('plaza', rect(7, 27, 12, 28), false, R1_W, R1_H));        // resting place with a spring
  put(autotile('plateau', rect(23, 28, 25, 30), false, R1_W, R1_H));

  // ---- tall grass: gentler north of the river, tougher in the south
  const grass = [[rect(2, 3, 11, 5), 'route_a', 'tall_rice'], [rect(17, 3, 25, 8), 'route_a', 'tall_rice'],
                 [rect(9, 10, 18, 12), 'route_b'], [rect(9, 14, 17, 16), 'route_b'],
                 [rect(2, 21, 8, 26), 'route_c'], [rect(2, 29, 17, 33), 'route_c', 'tall_rice_gold'],
                 [rect(23, 20, 25, 26), 'route_c']];
  for (const [set, area, tile] of grass) {
    for (const k of set) { const [c, r] = k.split(',').map(Number); ground[r][c] = tile || 'tall_grass'; m.tall.set(k, area); }
  }
  blockTerrain(m, block);
  placeBuilding(B, 'gym', 'gym');

  const object = (name, c, r, opts) => B.sprite('objects', name, c, r, opts);
  // forest on both sides (left open where the river passes), trees along the top, fence along the bottom
  const treeKinds = ['coconut_palm', 'tree_mango', 'banana_tree', 'coconut_palm', 'bamboo', 'tree_round', 'banana_tree', 'tree_mango'];
  const pick = () => treeKinds[Math.floor(rng() * treeKinds.length)];
  for (let c = 0; c < R1_W; c += 2) if (c < 12 || c > 16) object(pick(), c, 2);
  for (let r = 4; r < R1_H; r += 2) if (r < 13 || r > 15) { object(pick(), 0, r); object(pick(), 26, r); }
  for (let r = 0; r < R1_H; r++) { block(0, r); block(1, r); block(26, r); block(27, r); }
  for (let c = 0; c < R1_W; c++) if (c < 12 || c > 16) for (let r = 0; r < 3; r++) block(c, r);
  block(12, 0); block(16, 0);
  for (let c = 2; c < 26; c++) if (c < 19 || c > 21) object('fence_h', c, 35);

  object('tree_mango', 3, 20); object('coconut_palm', 22, 19); object('bamboo', 3, 12);
  object('banana_tree', 17, 24); object('coconut_palm', 15, 31); object('coconut_palm', 4, 31);
  object('boat', 22, 13, { flat: true }); object('lotus', 21, 11, { flat: true }); object('lotus', 24, 14, { flat: true });
  object('haystack', 2, 6); object('haystack', 16, 8); object('bench', 11, 28);
  object('bush', 16, 6); object('bush_berry', 3, 9); object('bush', 19, 9); object('bush', 18, 15);
  object('bush_berry', 22, 27); object('bush', 8, 20); object('bush', 24, 33);
  object('rocks', 12, 6); object('boulder', 24, 29); object('rocks', 3, 16); object('boulder', 17, 21); object('rocks', 22, 22);
  object('well', 9, 28, { id: 'spring' });
  object('signpost_thai', 16, 2, { id: 'sign_r1_top' });
  object('signpost_thai', 8, 11, { id: 'sign_r1_bridge' });
  object('signpost_thai', 13, 27, { id: 'sign_r1_spring' });
  object('signpost_thai', 22, 34, { id: 'sign_r1_end' });
  object('signpost_thai', 12, 26, { id: 'sign_gym' });
  object('crate', 2, 8, { id: 'r1_crate_a' });
  object('crate', 25, 18, { id: 'r1_crate_b' });
  object('crate', 2, 34, { id: 'r1_crate_c' });

  m.things.sort((a, b) => a.sortY - b.sortY);
  m.npcs.push({ id: 'rival2', sheet: 'chars/npc_rival', c: 20, r: 31, dir: 'up' });
  m.npcs.push({ id: 'vendor', sheet: 'chars/npc_shopkeeper', c: 7, r: 27, dir: 'right' });   // travelling merchant
  m.exits.push({ side: 'up', c0: 13, c1: 15, to: { map: 'village', dc: 1, r: MAP_H - 1 } });
  // the road south leads to Route 2 (stage 3) and needs the gym's badge
  m.exits.push({ side: 'down', c0: 19, c1: 21, to: { map: 'route2', dc: R2_ENTRY - 19, r: 0 }, need: 'badge1',
                 lockedText: 'ด่านตรวจขวางทางอยู่: "ผู้ที่จะไปด่าน 3 ต้องมีเหรียญศิลา"\nไปท้าประลองที่ยิมศิลาทางตะวันตกของถนนก่อน' });
  return m;
}

// Stage 3: Route 2, the rocky highland. The road zigzags past cliffs and a lake; wild monsters
// here are stronger and some have already evolved. Two trainers wait by the road and the rival
// has his final duel near the far end; beating him clears stage 3.
const R2_W = 30, R2_H = 38;
const R2_ENTRY = 13;                    // first column of the road where it comes in from Route 1
function buildRoute2() {
  const rng = seededRandom(20261121);
  const B = mapBuilder('route2', R2_W, R2_H, 'grass');
  const m = B.m, ground = m.ground, block = B.block;
  m.title = 'เส้นทางที่ 2  ทุ่งผาหิน';
  for (let r = 0; r < R2_H; r++) for (let c = 0; c < R2_W; c++) {
    const v = rng();
    ground[r][c] = v < 0.66 ? 'grass' : v < 0.88 ? 'grass_tufts' : v < 0.95 ? 'grass_white_flowers' : 'grass_color_flowers';
  }
  const put = (layout) => { for (const [k, name] of layout) { const [c, r] = k.split(',').map(Number); ground[r][c] = name; } };

  // ---- the road: in at the top, west under the cliffs, south past the lake, east, out at the bottom
  const road = union(rect(13, 0, 15, 11), rect(4, 9, 15, 11), rect(4, 9, 6, 26),
                     rect(4, 24, 24, 26), rect(22, 24, 24, 37));
  // a narrow path from the road to the spring
  put(stripLayout('path', road, cells(line(10, 27, 10, 27)), true, R2_W, R2_H));

  // ---- a lake east of the road, cliffs in the north-east and the south
  put(stripLayout('pond', rect(17, 14, 25, 21), new Set(), false, R2_W, R2_H));
  put(autotile('plateau', rect(18, 9, 26, 12), false, R2_W, R2_H));
  put(autotile('plateau', rect(8, 33, 13, 35), false, R2_W, R2_H));
  put(autotile('plaza', rect(8, 28, 13, 30), false, R2_W, R2_H));        // resting place with a spring

  // ---- tall grass: route_d up north, route_e by the lake, route_f (toughest) in the south
  const grass = [[rect(3, 3, 10, 7), 'route_d', 'tall_rice'], [rect(18, 3, 25, 7), 'route_d', 'tall_rice'],
                 [rect(8, 13, 14, 22), 'route_e'], [rect(17, 22, 25, 23), 'route_e'],
                 [rect(2, 28, 6, 35), 'route_f'], [rect(15, 28, 20, 35), 'route_f']];
  for (const [set, area, tile] of grass) {
    for (const k of set) { const [c, r] = k.split(',').map(Number); ground[r][c] = tile || 'tall_grass'; m.tall.set(k, area); }
  }
  blockTerrain(m, block);

  const object = (name, c, r, opts) => B.sprite('objects', name, c, r, opts);
  // forest on both sides, trees along the top, fence along the bottom
  const treeKinds = ['bamboo', 'coconut_palm', 'tree_mango', 'bamboo', 'banana_tree', 'tree_round', 'coconut_palm', 'bamboo'];
  const pick = () => treeKinds[Math.floor(rng() * treeKinds.length)];
  for (let c = 0; c < R2_W; c += 2) if (c < 12 || c > 16) object(pick(), c, 2);
  for (let r = 4; r < R2_H; r += 2) { object(pick(), 0, r); object(pick(), 28, r); }
  for (let r = 0; r < R2_H; r++) { block(0, r); block(1, r); block(28, r); block(29, r); }
  for (let c = 0; c < R2_W; c++) if (c < 12 || c > 16) for (let r = 0; r < 3; r++) block(c, r);
  block(12, 0); block(16, 0);
  for (let c = 2; c < 28; c++) if (c < 22 || c > 24) object('fence_h', c, 37);

  object('tree_mango', 15, 16); object('bamboo', 2, 22); object('coconut_palm', 25, 31);
  object('boat', 20, 17, { flat: true }); object('lotus', 18, 15, { flat: true });
  object('lotus', 23, 19, { flat: true }); object('lotus', 24, 15, { flat: true });
  object('spirit_house', 26, 25, { id: 'spirit_house' }); object('bench', 12, 30);
  object('rocks', 12, 8); object('boulder', 17, 8); object('rocks', 26, 13); object('boulder', 16, 23);
  object('boulder', 7, 23); object('rocks', 14, 32); object('boulder', 21, 29); object('rocks', 26, 23);
  object('bush', 16, 12); object('bush_berry', 7, 16); object('bush', 26, 27); object('bush_berry', 2, 12);
  object('well', 10, 29, { id: 'spring' });
  object('signpost_thai', 16, 2, { id: 'sign_r2_top' });
  object('signpost_thai', 14, 29, { id: 'sign_r2_spring' });
  object('signpost_thai', 21, 35, { id: 'sign_r2_end' });
  object('crate', 26, 8, { id: 'r2_crate_a' });
  object('crate', 2, 26, { id: 'r2_crate_b' });
  object('crate', 26, 35, { id: 'r2_crate_c' });

  m.things.sort((a, b) => a.sortY - b.sortY);
  m.npcs.push({ id: 'r2_hiker', sheet: 'chars/npc_gym_hiker', c: 9, r: 10, dir: 'down' });
  m.npcs.push({ id: 'r2_kid', sheet: 'chars/npc_gym_kid', c: 16, r: 25, dir: 'left' });
  m.npcs.push({ id: 'rival3', sheet: 'chars/npc_rival', c: 23, r: 32, dir: 'up' });
  m.npcs.push({ id: 'vendor', sheet: 'chars/npc_shopkeeper', c: 8, r: 28, dir: 'right' });   // travelling merchant
  m.exits.push({ side: 'up', c0: R2_ENTRY, c1: R2_ENTRY + 2, to: { map: 'route1', dc: 19 - R2_ENTRY, r: R1_H - 1 } });
  // the road on to stage 4 opens after the final duel with the rival; stage 4 is not built yet
  m.exits.push({ side: 'down', c0: 22, c1: 24, to: { map: 'town', dc: T4_ENTRY - 22, r: 0 }, need: 'stage3',
                 lockedText: 'พายุยืนขวางทางอยู่ข้างหน้า\nต้องประลองชนะเขาก่อนจึงจะผ่านไปได้' });
  return m;
}

// Stage 4: Bang Bua, a floating-market town on the canals. A canal crosses the road on the
// way in; the market square has stalls and a merchant; the Water Gym and a second healing
// centre stand on either side. Its badge opens the road to stage 5 (not built yet).
const T4_W = 32, T4_H = 34;
const T4_ENTRY = 14;                    // first column of the road where it comes in from Route 2
function buildTown() {
  const rng = seededRandom(20261122);
  const B = mapBuilder('town', T4_W, T4_H, 'grass');
  const m = B.m, ground = m.ground, block = B.block;
  m.title = 'ด่าน 4  ตลาดน้ำบางบัว';
  for (let r = 0; r < T4_H; r++) for (let c = 0; c < T4_W; c++) {
    const v = rng();
    ground[r][c] = v < 0.70 ? 'grass' : v < 0.88 ? 'grass_tufts' : v < 0.95 ? 'grass_white_flowers' : 'grass_color_flowers';
  }
  const put = (layout) => { for (const [k, name] of layout) { const [c, r] = k.split(',').map(Number); ground[r][c] = name; } };

  // ---- the road: in at the top, over the canal on a narrow bridge, down the main street,
  // out at the bottom; narrow paths lead to the healing centre and the gym
  const road = union(rect(14, 0, 16, 6), rect(14, 10, 16, 33));
  put(stripLayout('path', road, cells([...line(15, 7, 15, 9), ...line(7, 16, 13, 16), ...line(17, 16, 23, 16),
                                       ...line(6, 16, 6, 16), ...line(24, 16, 24, 16)]), true, T4_W, T4_H));
  // ---- water: the canal right across the town, and the market lagoon fed by a side canal
  const lagoon = rect(3, 22, 10, 27);
  const canal = cells(line(0, 8, 31, 8));
  put(stripLayout('pond', lagoon, canal, true, T4_W, T4_H));
  ground[8][15] = 'river_bridge_ns';
  put(autotile('plaza', rect(9, 18, 21, 21), false, T4_W, T4_H));       // the market square

  // ---- tall grass: rice paddies north of the canal, rough grass south of the town
  const grass = [[rect(2, 1, 11, 6), 'route_g', 'tall_rice'], [rect(19, 1, 29, 6), 'route_g', 'tall_rice'],
                 [rect(18, 24, 29, 31), 'route_h'], [rect(2, 29, 12, 31), 'route_h', 'tall_rice_gold']];
  for (const [set, area, tile] of grass) {
    for (const k of set) { const [c, r] = k.split(',').map(Number); ground[r][c] = tile || 'tall_grass'; m.tall.set(k, area); }
  }
  blockTerrain(m, block);
  placeBuilding(B, 'healing_center', 'heal2');
  placeBuilding(B, 'gym2', 'gym2');

  const object = (name, c, r, opts) => B.sprite('objects', name, c, r, opts);
  // palms and bamboo along both sides, fence along the bottom
  const treeKinds = ['coconut_palm', 'banana_tree', 'coconut_palm', 'bamboo', 'tree_mango', 'coconut_palm'];
  const pick = () => treeKinds[Math.floor(rng() * treeKinds.length)];
  for (let r = 2; r < T4_H; r += 2) if (r < 7 || r > 9) { object(pick(), 0, r); object(pick(), 30, r); }
  for (let r = 0; r < T4_H; r++) if (r !== 8) { block(0, r); block(1, r); block(30, r); block(31, r); }
  for (let c = 2; c < 30; c++) if (c < 14 || c > 16) object('fence_h', c, 33);

  // the market: stalls, jars and baskets, lanterns, a sala to rest in
  object('food_cart', 10, 19, { id: 'food_cart' }); object('food_cart', 18, 21, { id: 'food_cart' });
  object('baskets', 12, 18); object('water_jar', 13, 18); object('baskets', 20, 18);
  object('lamp_post', 9, 21); object('lamp_post', 21, 18);
  object('sala', 18, 19, { id: 'sala' });
  object('bench', 11, 21);
  // on the water: long-tail boats and lotus
  object('boat', 4, 23, { flat: true }); object('boat', 7, 25, { flat: true });
  object('boat', 20, 8, { flat: true }); object('boat', 4, 8, { flat: true });
  object('lotus', 9, 23, { flat: true }); object('lotus', 4, 26, { flat: true }); object('lotus', 26, 8, { flat: true });
  object('spirit_house', 2, 18, { id: 'spirit_house' }); object('haystack', 12, 7); object('haystack', 18, 7);
  object('ox_cart', 26, 21); object('tree_mango', 12, 24); object('bamboo', 2, 20);
  object('signpost_thai', 17, 2, { id: 'sign_t4_top' });
  object('signpost_thai', 13, 17, { id: 'sign_t4_market' });
  object('signpost_thai', 13, 31, { id: 'sign_t4_end' });
  object('crate', 28, 23, { id: 't4_crate_a' });
  object('crate', 2, 32, { id: 't4_crate_b' });

  m.things.sort((a, b) => a.sortY - b.sortY);
  m.npcs.push({ id: 'vendor', sheet: 'chars/npc_shopkeeper', c: 11, r: 20, dir: 'down' });
  m.exits.push({ side: 'up', c0: T4_ENTRY, c1: T4_ENTRY + 2, to: { map: 'route2', dc: 22 - T4_ENTRY, r: R2_H - 1 } });
  m.exits.push({ side: 'down', c0: 14, c1: 16, to: { map: 'ruins', dc: 0, r: 0 }, need: 'badge2',
                 lockedText: 'ทางไปด่าน 5 ถูกปิดไว้: "ผู้ที่จะผ่านต้องมีเหรียญวารี"\nไปท้าประลองที่ยิมวารีทางตะวันออกของตลาดก่อน' });
  return m;
}

// A building drawn only as scenery: it blocks like a building but has no door to enter.
function decoBuilding(B, name, doorCol, bottomRow) {
  const m = B.m, meta = SPRITE_META.buildings[name];
  const x = doorCol * TS + TS / 2 - meta.door, y = (bottomRow + 1) * TS - meta.h;
  m.things.push({ img: 'buildings/' + name, x, y, w: meta.w, h: meta.h, sortY: (bottomRow + 1) * TS });
  const c0 = Math.floor((x + meta.x0 + 4) / TS), c1 = Math.floor((x + meta.x1 - 5) / TS);
  const r0 = Math.floor((y + meta.y0 + 16) / TS);
  for (let r = r0; r <= bottomRow; r++) for (let c = c0; c <= c1; c++) B.block(c, r);
}

// Stage 5: the ancient city ruins. Jungle on the way in, broken walls, a ruined stone prasat,
// a courtyard with a spring and a merchant, a lotus moat, thicker jungle in the south, and the
// rival waiting at the far gate. Beating him clears stage 5; stage 6 is not built yet.
const T5_W = 30, T5_H = 40;
function buildRuins() {
  const rng = seededRandom(20261123);
  const B = mapBuilder('ruins', T5_W, T5_H, 'grass');
  const m = B.m, ground = m.ground, block = B.block;
  m.title = 'ด่าน 5  ซากเมืองโบราณ';
  for (let r = 0; r < T5_H; r++) for (let c = 0; c < T5_W; c++) {
    const v = rng();
    ground[r][c] = v < 0.62 ? 'grass' : v < 0.90 ? 'grass_tufts' : v < 0.96 ? 'grass_white_flowers' : 'grass_color_flowers';
  }
  const put = (layout) => { for (const [k, name] of layout) { const [c, r] = k.split(',').map(Number); ground[r][c] = name; } };

  // the old causeway runs straight through; a narrow path leads to the prasat
  put(stripLayout('path', rect(14, 0, 16, 39), cells(line(9, 21, 13, 21)), true, T5_W, T5_H));
  put(autotile('plaza', rect(11, 14, 19, 19), false, T5_W, T5_H));              // the old courtyard
  // broken city walls (raised stone), with a gap for the causeway
  put(autotile('plateau', rect(2, 10, 11, 11), false, T5_W, T5_H));
  put(autotile('plateau', rect(19, 10, 27, 11), false, T5_W, T5_H));
  put(autotile('plateau', rect(22, 33, 27, 35), false, T5_W, T5_H));
  // the lotus moat
  put(stripLayout('pond', rect(21, 14, 27, 20), new Set(), false, T5_W, T5_H));

  // jungle: lighter on the way in, thicker past the courtyard
  const grass = [[rect(2, 2, 11, 8), 'route_i'], [rect(19, 2, 27, 8), 'route_i'],
                 [rect(2, 24, 12, 33), 'route_j'], [rect(18, 23, 27, 31), 'route_j']];
  for (const [set, area] of grass) {
    for (const k of set) { const [c, r] = k.split(',').map(Number); ground[r][c] = 'tall_grass'; m.tall.set(k, area); }
  }
  blockTerrain(m, block);
  decoBuilding(B, 'gym', 6, 20);          // the ruined prasat, west of the courtyard

  const object = (name, c, r, opts) => B.sprite('objects', name, c, r, opts);
  const treeKinds = ['bamboo', 'tree_round', 'banana_tree', 'bamboo', 'tree_mango', 'tree_pine', 'coconut_palm'];
  const pick = () => treeKinds[Math.floor(rng() * treeKinds.length)];
  for (let c = 0; c < T5_W; c += 2) if (c < 12 || c > 16) object(pick(), c, 0);
  for (let r = 2; r < T5_H; r += 2) { object(pick(), 0, r); object(pick(), 28, r); }
  for (let r = 0; r < T5_H; r++) { block(0, r); block(1, r); block(28, r); block(29, r); }
  for (let c = 0; c < T5_W; c++) if (c < 13 || c > 17) block(c, 0);
  for (let c = 2; c < 28; c++) if (c < 14 || c > 16) object('fence_h', c, 39);

  // rubble and old stones everywhere
  for (const [c, r] of [[12, 9], [18, 9], [3, 13], [9, 13], [20, 12], [26, 12], [4, 22], [10, 22],
                        [19, 22], [25, 22], [13, 35], [18, 36], [3, 36], [8, 35], [25, 37]]) {
    object(rng() < 0.5 ? 'boulder' : 'rocks', c, r);
  }
  object('well', 12, 16, { id: 'spring' });
  object('sala', 17, 15, { id: 'sala' });
  object('lamp_post', 11, 19); object('lamp_post', 19, 19);
  object('lotus', 22, 15, { flat: true }); object('lotus', 25, 17, { flat: true }); object('lotus', 23, 19, { flat: true });
  object('boat', 24, 19, { flat: true });
  object('spirit_house', 20, 21, { id: 'spirit_house' });
  object('bamboo', 2, 15); object('tree_mango', 2, 18); object('banana_tree', 10, 34);
  object('signpost_thai', 17, 2, { id: 'sign_t5_top' });
  object('signpost_thai', 13, 13, { id: 'sign_t5_court' });
  object('signpost_thai', 17, 37, { id: 'sign_t5_end' });
  object('signpost_thai', 9, 22, { id: 'ruin_prasat' });
  object('crate', 27, 9, { id: 't5_crate_a' });
  object('crate', 2, 38, { id: 't5_crate_b' });

  m.things.sort((a, b) => a.sortY - b.sortY);
  m.npcs.push({ id: 'vendor', sheet: 'chars/npc_shopkeeper', c: 18, r: 18, dir: 'left' });
  m.npcs.push({ id: 'r5_digger', sheet: 'chars/npc_gym_hiker', c: 13, r: 24, dir: 'right' });
  m.npcs.push({ id: 'r5_herder', sheet: 'chars/npc_gym_kid', c: 17, r: 29, dir: 'left' });
  m.npcs.push({ id: 'rival4', sheet: 'chars/npc_rival', c: 15, r: 36, dir: 'up' });
  m.exits.push({ side: 'up', c0: 14, c1: 16, to: { map: 'town', dc: 0, r: T4_H - 1 } });
  m.exits.push({ side: 'down', c0: 14, c1: 16, to: null, need: 'stage5',
                 lockedText: 'พายุยืนขวางประตูเมืองเก่าอยู่\nต้องประลองชนะเขาก่อนจึงจะผ่านไปได้',
                 soonText: 'ประตูเมืองเก่าเปิดออก ทางไปด่าน 6 อยู่ข้างหน้าแล้ว!\nแต่ด่าน 6 ยังอยู่ระหว่างสร้าง จะตามมาในเวอร์ชันถัดไป' });
  return m;
}

function buildMaps() {
  const maps = { village: buildVillage(), route1: buildRoute1(), route2: buildRoute2(), town: buildTown(),
                 ruins: buildRuins() };
  for (const id of Object.keys(ROOMS)) maps[id] = buildRoom(id);
  return maps;
}
const START_SPOT = { map: 'village', c: 6, r: 9, dir: 'down' };
const HEAL_SPOT = { map: 'heal', c: 5, r: 5, dir: 'up' };      // where you wake up after losing
