'use strict';
// Game data: types, moves, monster species, wild encounter tables.

const TYPES = {
  normal:   { name: 'ปกติ',   color: '#8a8a7a' },
  fire:     { name: 'ไฟ',     color: '#e0562f' },
  water:    { name: 'น้ำ',    color: '#2f86e0' },
  leaf:     { name: 'พืช',    color: '#3f9d45' },
  electric: { name: 'ไฟฟ้า', color: '#c99a10' },
  rock:     { name: 'หิน',    color: '#8a745f' },
  ghost:    { name: 'ผี',     color: '#8560b8' },
  // the legendary monster's own type: outside the match-up table, so it is left out of it
  legend:   { name: 'ตำนาน', color: '#c08a12', hidden: true },
};

// TYPE_CHART[attacking type][defending type] = damage multiplier (1 when missing)
const STRONG = 1.5, WEAK = 0.67;
// Every type is weak to at least one other:
//   fire <- water, rock      water <- leaf, electric    leaf <- fire
//   electric <- rock         rock <- water, leaf        ghost <- ghost, fire
//   normal <- rock
const TYPE_CHART = {
  fire:     { leaf: STRONG, ghost: STRONG, water: WEAK, rock: WEAK, fire: WEAK },
  water:    { fire: STRONG, rock: STRONG, leaf: WEAK, water: WEAK },
  leaf:     { water: STRONG, rock: STRONG, fire: WEAK, leaf: WEAK },
  electric: { water: STRONG, leaf: WEAK, rock: WEAK, electric: WEAK },
  rock:     { fire: STRONG, electric: STRONG, normal: STRONG, leaf: WEAK, rock: WEAK },
  ghost:    { ghost: STRONG, normal: WEAK },
  normal:   { rock: WEAK, ghost: WEAK },
};

const MAX_MOVES = 4;      // a monster remembers at most this many moves

const MOVES = {
  tackle:       { name: 'พุ่งชน',          type: 'normal',   power: 40 },
  shell_bash:   { name: 'กระดองกระแทก',    type: 'normal',   power: 55 },
  wing_slap:    { name: 'ปีกตบ',           type: 'normal',   power: 55 },
  // moves of another type, learned at level 11, that answer the monster's own weakness
  static_wool:  { name: 'ขนไฟฟ้าสถิต',     type: 'electric', power: 60 },
  coral_slam:   { name: 'ปะการังกระแทก',   type: 'rock',     power: 60 },
  rock_roll:    { name: 'กลิ้งบดหิน',       type: 'rock',     power: 60 },
  leaf_cutter:  { name: 'กรามตัดใบ',       type: 'leaf',     power: 60 },
  sun_prism:    { name: 'ผลึกรวมแสง',      type: 'fire',     power: 60 },
  dew_dust:     { name: 'ละอองน้ำค้าง',     type: 'water',    power: 60 },
  ember:        { name: 'ประกายถ่าน',      type: 'fire',     power: 45 },
  flame_wool:   { name: 'ขนเพลิง',         type: 'fire',     power: 65 },
  bubble:       { name: 'ฟองสบู่',          type: 'water',    power: 45 },
  horn_jet:     { name: 'เขาพ่นน้ำ',        type: 'water',    power: 65 },
  leaf_toss:    { name: 'ปาใบไม้',          type: 'leaf',     power: 45 },
  bud_bloom:    { name: 'ดอกตูมบาน',       type: 'leaf',     power: 65 },
  spark:        { name: 'ประกายไฟฟ้า',     type: 'electric', power: 45 },
  fork_bolt:    { name: 'สายฟ้าส้อมเสียง',  type: 'electric', power: 65 },
  pebble:       { name: 'ปากรวด',          type: 'rock',     power: 45 },
  crystal_slam: { name: 'ผลึกกระแทก',      type: 'rock',     power: 65 },
  lantern_glow: { name: 'แสงโคม',          type: 'ghost',    power: 45 },
  wing_haunt:   { name: 'ปีกหลอน',         type: 'ghost',    power: 65 },
  // moves of the second set of monsters
  lantern_flare: { name: 'โคมเพลิง',       type: 'fire',     power: 65 },
  teapot_steam:  { name: 'ไอน้ำกาเดือด',   type: 'water',    power: 65 },
  lotus_spray:   { name: 'ฝักบัวพ่นน้ำ',   type: 'water',    power: 45 },
  pond_splash:   { name: 'ตีน้ำกระจาย',    type: 'water',    power: 65 },
  thorn_roll:    { name: 'กลิ้งหนาม',      type: 'leaf',     power: 45 },
  durian_drop:   { name: 'ทุเรียนหล่น',    type: 'leaf',     power: 65 },
  leaf_gust:     { name: 'ลมใบตอง',        type: 'leaf',     power: 65 },
  plug_shock:    { name: 'ช็อตปลั๊ก',      type: 'electric', power: 65 },
  cairn_fall:    { name: 'หินซ้อนถล่ม',    type: 'rock',     power: 65 },
  string_snare:  { name: 'สายป่านพัน',     type: 'ghost',    power: 45 },
  night_dive:    { name: 'โฉบกลางคืน',     type: 'ghost',    power: 65 },
  peck:          { name: 'จิก',            type: 'normal',   power: 40 },
  dawn_crow:     { name: 'ขันรับอรุณ',     type: 'normal',   power: 55 },
  spur_kick:     { name: 'เตะเดือย',       type: 'normal',   power: 70 },
  horn_charge:   { name: 'ขวิด',           type: 'normal',   power: 55 },
  mud_stomp:     { name: 'ย่ำโคลน',        type: 'normal',   power: 70 },
  // strongest move of each evolved monster of the second set, learned at level 12
  lantern_blaze:  { name: 'โคมประทีปลุก', type: 'fire', power: 80 },
  kettle_burst:   { name: 'กาเดือดระเบิด', type: 'water', power: 80 },
  lotus_storm:    { name: 'พายุบัวหลวง', type: 'water', power: 80 },
  king_thorn:     { name: 'หนามราชา', type: 'leaf', power: 80 },
  leaf_blade:     { name: 'ใบตองคมกริบ', type: 'leaf', power: 80 },
  kilo_volt:      { name: 'พันโวลต์', type: 'electric', power: 80 },
  tower_crash:    { name: 'หอคอยถล่ม', type: 'rock', power: 80 },
  shadow_swoop:   { name: 'โฉบเงาราตรี', type: 'ghost', power: 80 },
  sunrise_peck:   { name: 'จิกรับอรุณ', type: 'normal', power: 80 },
  quake_stomp:    { name: 'กระทืบโคลนสะเทือน', type: 'normal', power: 80 },
  // strongest move of each final evolution
  inferno_horn:   { name: 'เขาเพลิงผลาญ',    type: 'fire',     power: 85 },
  tidal_spiral:   { name: 'เกลียวคลื่นยักษ์', type: 'water',    power: 85 },
  forest_bloom:   { name: 'พฤกษาผลิบาน',     type: 'leaf',     power: 85 },
  thunder_crown:  { name: 'มงกุฎอัสนี',       type: 'electric', power: 85 },
  mountain_crash: { name: 'ภูผาถล่ม',         type: 'rock',     power: 85 },
  moon_lantern:   { name: 'โคมจันทรา',        type: 'ghost',    power: 85 },
};

// levels at which a monster reaches its first and its final evolution
const EVO_LEVEL_1 = 7, EVO_LEVEL_2 = 13;
// the monsters of stage 2 (Route 1) evolve once, at this level
const EVO_LEVEL_ROUTE = 10;

// moves: [level learned, move id]. A monster learns each move on reaching that level;
// past MAX_MOVES the player picks one to forget.
const SPECIES = {
  lamb:     { name: 'ถ่านปุย',     type: 'fire',     img: 'starter_fire_lamb',
              hp: 45, atk: 52, def: 43, spd: 55,
              moves: [[1, 'tackle'], [1, 'ember'], [4, 'horn_charge'], [8, 'flame_wool'], [11, 'static_wool']],
              evolve: { level: EVO_LEVEL_1, to: 'lamb2' } },
  narwhal:  { name: 'ฟองวาฬ',     type: 'water',    img: 'starter_water_narwhal',
              hp: 50, atk: 48, def: 55, spd: 43,
              moves: [[1, 'tackle'], [1, 'bubble'], [4, 'horn_charge'], [8, 'horn_jet'], [11, 'coral_slam']],
              evolve: { level: EVO_LEVEL_1, to: 'narwhal2' } },
  pangolin: { name: 'ใบนิ่ม',      type: 'leaf',     img: 'starter_leaf_pangolin',
              hp: 48, atk: 49, def: 58, spd: 40,
              moves: [[1, 'tackle'], [1, 'leaf_toss'], [4, 'shell_bash'], [8, 'bud_bloom'], [11, 'rock_roll']],
              evolve: { level: EVO_LEVEL_1, to: 'pangolin2' } },
  beetle:   { name: 'ด้วงสายฟ้า',  type: 'electric', img: 'wild_electric_beetle',
              hp: 40, atk: 55, def: 40, spd: 60,
              moves: [[1, 'tackle'], [1, 'spark'], [4, 'horn_charge'], [8, 'fork_bolt'], [11, 'leaf_cutter']],
              evolve: { level: EVO_LEVEL_1, to: 'beetle2' } },
  tortoise: { name: 'เต่าผลึก',    type: 'rock',     img: 'wild_rock_tortoise',
              hp: 55, atk: 45, def: 65, spd: 25,
              moves: [[1, 'tackle'], [1, 'pebble'], [4, 'shell_bash'], [8, 'crystal_slam'], [11, 'sun_prism']],
              evolve: { level: EVO_LEVEL_1, to: 'tortoise2' } },
  moth:     { name: 'โคมราตรี',    type: 'ghost',    img: 'wild_ghost_moth',
              hp: 42, atk: 50, def: 42, spd: 58,
              moves: [[1, 'tackle'], [1, 'lantern_glow'], [4, 'wing_slap'], [8, 'wing_haunt'], [11, 'dew_dust']],
              evolve: { level: EVO_LEVEL_1, to: 'moth2' } },

  // Second set of monsters: they live on Route 1 (stage 2).
  frog:     { name: 'กบโคม',        type: 'fire',     img: 'wild_fire_frog',
              hp: 48, atk: 50, def: 45, spd: 50,
              moves: [[1, 'tackle'], [1, 'ember'], [8, 'lantern_flare']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'frog2' } },
  crab:     { name: 'ปูกาน้ำ',      type: 'water',    img: 'wild_water_crab',
              hp: 45, atk: 46, def: 66, spd: 30,
              moves: [[1, 'tackle'], [1, 'bubble'], [8, 'teapot_steam']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'crab2' } },
  duck:     { name: 'เป็ดฝักบัว',   type: 'water',    img: 'wild_water_duck',
              hp: 44, atk: 47, def: 42, spd: 57,
              moves: [[1, 'tackle'], [1, 'lotus_spray'], [8, 'pond_splash']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'duck2' } },
  durian:   { name: 'ทุเรียนกลิ้ง', type: 'leaf',     img: 'wild_leaf_durian',
              hp: 52, atk: 54, def: 62, spd: 28,
              moves: [[1, 'tackle'], [1, 'thorn_roll'], [8, 'durian_drop']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'durian2' } },
  bat:      { name: 'ค้างคาวใบตอง', type: 'leaf',     img: 'wild_leaf_bat',
              hp: 40, atk: 48, def: 38, spd: 64,
              moves: [[1, 'tackle'], [1, 'leaf_toss'], [8, 'leaf_gust']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'bat2' } },
  gecko:    { name: 'ตุ๊กแกปลั๊ก',  type: 'electric', img: 'wild_electric_gecko',
              hp: 46, atk: 53, def: 44, spd: 52,
              moves: [[1, 'tackle'], [1, 'spark'], [8, 'plug_shock']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'gecko2' } },
  snail:    { name: 'ทากหินซ้อน',   type: 'rock',     img: 'wild_rock_snail',
              hp: 58, atk: 42, def: 68, spd: 20,
              moves: [[1, 'tackle'], [1, 'pebble'], [8, 'cairn_fall']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'snail2' } },
  kite:     { name: 'ว่าวหลอน',     type: 'ghost',    img: 'wild_ghost_kite',
              hp: 38, atk: 54, def: 36, spd: 66,
              moves: [[1, 'tackle'], [1, 'string_snare'], [8, 'night_dive']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'kite2' } },
  rooster:  { name: 'ไก่แจ้จอมโวย', type: 'normal',   img: 'wild_normal_rooster',
              hp: 42, atk: 56, def: 40, spd: 60,
              moves: [[1, 'peck'], [1, 'dawn_crow'], [8, 'spur_kick']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'rooster2' } },
  buffalo:  { name: 'ควายโคลน',     type: 'normal',   img: 'wild_normal_buffalo',
              hp: 62, atk: 55, def: 54, spd: 30,
              moves: [[1, 'tackle'], [1, 'horn_charge'], [8, 'mud_stomp']],
              evolve: { level: EVO_LEVEL_ROUTE, to: 'buffalo2' } },
  // Evolved forms of the second set (stage 2). Each of them evolves once, at EVO_LEVEL_ROUTE.
  // Stats are the base form's x1.35.
  frog2: { name: 'คางคกประทีป', type: 'fire', img: 'wild_fire_frog_evo1',
              hp: 65, atk: 68, def: 61, spd: 68,
              moves: [[1, 'tackle'], [1, 'ember'], [8, 'lantern_flare'], [12, 'lantern_blaze']] },
  crab2: { name: 'ปูกาหลวง', type: 'water', img: 'wild_water_crab_evo1',
              hp: 61, atk: 62, def: 89, spd: 40,
              moves: [[1, 'tackle'], [1, 'bubble'], [8, 'teapot_steam'], [12, 'kettle_burst']] },
  duck2: { name: 'หงส์บัวหลวง', type: 'water', img: 'wild_water_duck_evo1',
              hp: 59, atk: 63, def: 57, spd: 77,
              moves: [[1, 'tackle'], [1, 'lotus_spray'], [8, 'pond_splash'], [12, 'lotus_storm']] },
  durian2: { name: 'ทุเรียนราชา', type: 'leaf', img: 'wild_leaf_durian_evo1',
              hp: 70, atk: 73, def: 84, spd: 38,
              moves: [[1, 'tackle'], [1, 'thorn_roll'], [8, 'durian_drop'], [12, 'king_thorn']] },
  bat2: { name: 'ค้างคาวปลีทอง', type: 'leaf', img: 'wild_leaf_bat_evo1',
              hp: 54, atk: 65, def: 51, spd: 86,
              moves: [[1, 'tackle'], [1, 'leaf_toss'], [8, 'leaf_gust'], [12, 'leaf_blade']] },
  gecko2: { name: 'ตุ๊กแกพันโวลต์', type: 'electric', img: 'wild_electric_gecko_evo1',
              hp: 62, atk: 72, def: 59, spd: 70,
              moves: [[1, 'tackle'], [1, 'spark'], [8, 'plug_shock'], [12, 'kilo_volt']] },
  snail2: { name: 'ทากหอคอยหิน', type: 'rock', img: 'wild_rock_snail_evo1',
              hp: 78, atk: 57, def: 92, spd: 27,
              moves: [[1, 'tackle'], [1, 'pebble'], [8, 'cairn_fall'], [12, 'tower_crash']] },
  kite2: { name: 'ว่าวจุฬาเงา', type: 'ghost', img: 'wild_ghost_kite_evo1',
              hp: 51, atk: 73, def: 49, spd: 89,
              moves: [[1, 'tackle'], [1, 'string_snare'], [8, 'night_dive'], [12, 'shadow_swoop']] },
  rooster2: { name: 'พญาไก่แจ้', type: 'normal', img: 'wild_normal_rooster_evo1',
              hp: 57, atk: 76, def: 54, spd: 81,
              moves: [[1, 'peck'], [1, 'dawn_crow'], [8, 'spur_kick'], [12, 'sunrise_peck']] },
  buffalo2: { name: 'พญาควายโคลน', type: 'normal', img: 'wild_normal_buffalo_evo1',
              hp: 84, atk: 74, def: 73, spd: 40,
              moves: [[1, 'tackle'], [1, 'horn_charge'], [8, 'mud_stomp'], [12, 'quake_stomp']] },
  // Evolved forms. A monster changes into the next form after a battle once it reaches
  // the level in its "evolve" entry. Stats are the base form's x1.25, then x1.55.
  lamb2: { name: 'เพลิงปุย', type: 'fire', img: 'starter_fire_lamb_evo1',
              hp: 56, atk: 65, def: 54, spd: 69,
              moves: [[1, 'tackle'], [1, 'ember'], [4, 'horn_charge'], [8, 'flame_wool'], [11, 'static_wool']],
              evolve: { level: EVO_LEVEL_2, to: 'lamb3' } },
  lamb3: { name: 'ราชาแกะเพลิง', type: 'fire', img: 'starter_fire_lamb_evo2',
              hp: 70, atk: 81, def: 67, spd: 85,
              moves: [[1, 'tackle'], [1, 'ember'], [4, 'horn_charge'], [8, 'flame_wool'], [11, 'static_wool'], [14, 'inferno_horn']] },
  narwhal2: { name: 'คลื่นวาฬ', type: 'water', img: 'starter_water_narwhal_evo1',
              hp: 62, atk: 60, def: 69, spd: 54,
              moves: [[1, 'tackle'], [1, 'bubble'], [4, 'horn_charge'], [8, 'horn_jet'], [11, 'coral_slam']],
              evolve: { level: EVO_LEVEL_2, to: 'narwhal3' } },
  narwhal3: { name: 'สมุทรวาฬ', type: 'water', img: 'starter_water_narwhal_evo2',
              hp: 78, atk: 74, def: 85, spd: 67,
              moves: [[1, 'tackle'], [1, 'bubble'], [4, 'horn_charge'], [8, 'horn_jet'], [11, 'coral_slam'], [14, 'tidal_spiral']] },
  pangolin2: { name: 'พุ่มนิ่ม', type: 'leaf', img: 'starter_leaf_pangolin_evo1',
              hp: 60, atk: 61, def: 72, spd: 50,
              moves: [[1, 'tackle'], [1, 'leaf_toss'], [4, 'shell_bash'], [8, 'bud_bloom'], [11, 'rock_roll']],
              evolve: { level: EVO_LEVEL_2, to: 'pangolin3' } },
  pangolin3: { name: 'พฤกษานิ่ม', type: 'leaf', img: 'starter_leaf_pangolin_evo2',
              hp: 74, atk: 76, def: 90, spd: 62,
              moves: [[1, 'tackle'], [1, 'leaf_toss'], [4, 'shell_bash'], [8, 'bud_bloom'], [11, 'rock_roll'], [14, 'forest_bloom']] },
  beetle2: { name: 'ด้วงอัสนี', type: 'electric', img: 'wild_electric_beetle_evo1',
              hp: 50, atk: 69, def: 50, spd: 75,
              moves: [[1, 'tackle'], [1, 'spark'], [4, 'horn_charge'], [8, 'fork_bolt'], [11, 'leaf_cutter']],
              evolve: { level: EVO_LEVEL_2, to: 'beetle3' } },
  beetle3: { name: 'จอมด้วงวัชระ', type: 'electric', img: 'wild_electric_beetle_evo2',
              hp: 62, atk: 85, def: 62, spd: 93,
              moves: [[1, 'tackle'], [1, 'spark'], [4, 'horn_charge'], [8, 'fork_bolt'], [11, 'leaf_cutter'], [14, 'thunder_crown']] },
  tortoise2: { name: 'เต่าศิลาแก้ว', type: 'rock', img: 'wild_rock_tortoise_evo1',
              hp: 69, atk: 56, def: 81, spd: 31,
              moves: [[1, 'tackle'], [1, 'pebble'], [4, 'shell_bash'], [8, 'crystal_slam'], [11, 'sun_prism']],
              evolve: { level: EVO_LEVEL_2, to: 'tortoise3' } },
  tortoise3: { name: 'เต่าภูผาผลึก', type: 'rock', img: 'wild_rock_tortoise_evo2',
              hp: 85, atk: 70, def: 101, spd: 39,
              moves: [[1, 'tackle'], [1, 'pebble'], [4, 'shell_bash'], [8, 'crystal_slam'], [11, 'sun_prism'], [14, 'mountain_crash']] },
  moth2: { name: 'โคมวิญญาณ', type: 'ghost', img: 'wild_ghost_moth_evo1',
              hp: 52, atk: 62, def: 52, spd: 72,
              moves: [[1, 'tackle'], [1, 'lantern_glow'], [4, 'wing_slap'], [8, 'wing_haunt'], [11, 'dew_dust']],
              evolve: { level: EVO_LEVEL_2, to: 'moth3' } },
  moth3: { name: 'จันทร์ราตรี', type: 'ghost', img: 'wild_ghost_moth_evo2',
              hp: 65, atk: 78, def: 65, spd: 90,
              moves: [[1, 'tackle'], [1, 'lantern_glow'], [4, 'wing_slap'], [8, 'wing_haunt'], [11, 'dew_dust'], [14, 'moon_lantern']] },
};
// The legendary monster. It is met exactly once, in the village's tall grass (stage 1),
// as the LEGEND_AFTER-th wild encounter there. Its level is shown as infinite: it cannot be
// hurt or caught, and it leaves by itself. Meeting it again is left for a later update.
SPECIES.legend = { name: 'คชานภา', type: 'legend', img: 'legend_sky_elephant', frontOnly: true,
                   hp: 255, atk: 255, def: 255, spd: 255, moves: [[1, 'tackle']] };
const LEGEND_AFTER = 3;

const STARTERS = ['lamb', 'narwhal', 'pangolin'];
// the species the professor asks you to collect (evolved forms do not count separately)
const GOAL_SPECIES = ['lamb', 'narwhal', 'pangolin', 'beetle', 'tortoise', 'moth'];
// the rival takes the starter that is weak to yours, so the first duel is winnable
const RIVAL_PICK = { lamb: 'pangolin', narwhal: 'lamb', pangolin: 'narwhal' };

// [species, weight]; levels are inclusive
const ENCOUNTERS = {
  west: { levels: [2, 4], table: [['beetle', 50], ['tortoise', 35], ['moth', 15]] },
  east: { levels: [3, 5], table: [['moth', 38], ['beetle', 20], ['tortoise', 15],
                                  ['lamb', 9], ['narwhal', 9], ['pangolin', 9]] },
  // Route 1 (stage 2): the second set of monsters lives here
  route_a: { levels: [5, 7],  table: [['rooster', 26], ['frog', 22], ['duck', 20], ['bat', 18], ['gecko', 14]] },
  route_b: { levels: [6, 8],  table: [['crab', 26], ['duck', 22], ['snail', 20], ['buffalo', 20], ['kite', 12]] },
  route_c: { levels: [8, 10], table: [['durian', 22], ['kite', 18], ['gecko', 16], ['buffalo', 14], ['snail', 10],
                                      ['beetle2', 8], ['tortoise2', 6], ['moth2', 6]] },
  // Route 2 (stage 3): stronger monsters, and some of them have already evolved
  route_d: { levels: [10, 12], table: [['rooster', 20], ['bat', 18], ['gecko', 18], ['kite', 14],
                                       ['beetle2', 16], ['moth2', 14]] },
  route_e: { levels: [11, 13], table: [['duck', 22], ['crab', 20], ['frog', 18], ['tortoise2', 14],
                                       ['duck2', 9], ['crab2', 9], ['narwhal2', 8]] },
  route_f: { levels: [12, 14], table: [['buffalo', 16], ['snail', 14], ['durian', 16], ['kite2', 10], ['gecko2', 10],
                                       ['rooster2', 10], ['bat2', 8], ['lamb2', 8], ['pangolin2', 8]] },
};
// the rival's team for the rematch at the end of Route 1: [species, level]; "starter2" is
// the first evolution of the starter he took
const RIVAL_REMATCH = [['rooster', 9], ['starter2', 10]];

// The Rock Gym on Route 1. Two trainers stand in the way of the leader; beating the leader
// gives the badge that opens the road to stage 3. team: [species, level]
const GYM = {
  hiker:  { name: 'นักปีนเขาภูผา',   flag: 'gym1',   team: [['snail', 8], ['buffalo', 9]] },
  kid:    { name: 'นักสำรวจน้องแก้ว', flag: 'gym2',   team: [['tortoise', 10], ['crab', 10]] },
  leader: { name: 'หัวหน้ายิมศิลา',   flag: 'badge1', team: [['snail', 11], ['buffalo', 12], ['tortoise2', 13]] },
};
// Trainers along Route 2 (stage 3): each fights once, when spoken to.
const ROUTE2_TRAINERS = {
  hiker: { name: 'นักเดินป่าผาหิน', flag: 'r2t1', team: [['snail2', 12], ['buffalo', 13]] },
  kid:   { name: 'เด็กตกปลาริมบึง', flag: 'r2t2', team: [['duck', 12], ['crab2', 13], ['frog2', 13]] },
};
// The rival's final team at the end of Route 2; "starter3" is the last form of his starter.
// Beating it clears stage 3.
const RIVAL_FINAL = [['kite2', 14], ['rooster2', 15], ['starter3', 16]];
const ENCOUNTER_CHANCE = 0.13;
const PARTY_MAX = 6;
