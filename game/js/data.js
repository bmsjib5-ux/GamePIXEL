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
};

// TYPE_CHART[attacking type][defending type] = damage multiplier (1 when missing)
const STRONG = 1.5, WEAK = 0.67;
const TYPE_CHART = {
  fire:     { leaf: STRONG, water: WEAK, rock: WEAK, fire: WEAK },
  water:    { fire: STRONG, rock: STRONG, leaf: WEAK, water: WEAK },
  leaf:     { water: STRONG, rock: STRONG, fire: WEAK, leaf: WEAK },
  electric: { water: STRONG, leaf: WEAK, rock: WEAK, electric: WEAK },
  rock:     { fire: STRONG, electric: STRONG, leaf: WEAK, rock: WEAK },
  ghost:    { ghost: STRONG },
  normal:   { rock: WEAK, ghost: WEAK },
};

const MOVES = {
  tackle:       { name: 'พุ่งชน',          type: 'normal',   power: 40 },
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
};

// moves: [level learned, move id]
const SPECIES = {
  lamb:     { name: 'ถ่านปุย',     type: 'fire',     img: 'starter_fire_lamb',
              hp: 45, atk: 52, def: 43, spd: 55,
              moves: [[1, 'tackle'], [1, 'ember'], [8, 'flame_wool']] },
  narwhal:  { name: 'ฟองวาฬ',     type: 'water',    img: 'starter_water_narwhal',
              hp: 50, atk: 48, def: 55, spd: 43,
              moves: [[1, 'tackle'], [1, 'bubble'], [8, 'horn_jet']] },
  pangolin: { name: 'ใบนิ่ม',      type: 'leaf',     img: 'starter_leaf_pangolin',
              hp: 48, atk: 49, def: 58, spd: 40,
              moves: [[1, 'tackle'], [1, 'leaf_toss'], [8, 'bud_bloom']] },
  beetle:   { name: 'ด้วงสายฟ้า',  type: 'electric', img: 'wild_electric_beetle',
              hp: 40, atk: 55, def: 40, spd: 60,
              moves: [[1, 'tackle'], [1, 'spark'], [8, 'fork_bolt']] },
  tortoise: { name: 'เต่าผลึก',    type: 'rock',     img: 'wild_rock_tortoise',
              hp: 55, atk: 45, def: 65, spd: 25,
              moves: [[1, 'tackle'], [1, 'pebble'], [8, 'crystal_slam']] },
  moth:     { name: 'โคมราตรี',    type: 'ghost',    img: 'wild_ghost_moth',
              hp: 42, atk: 50, def: 42, spd: 58,
              moves: [[1, 'tackle'], [1, 'lantern_glow'], [8, 'wing_haunt']] },

  // Second set of monsters. They are ready to use but are not in any encounter table yet.
  frog:     { name: 'กบโคม',        type: 'fire',     img: 'wild_fire_frog',
              hp: 48, atk: 50, def: 45, spd: 50,
              moves: [[1, 'tackle'], [1, 'ember'], [8, 'lantern_flare']] },
  crab:     { name: 'ปูกาน้ำ',      type: 'water',    img: 'wild_water_crab',
              hp: 45, atk: 46, def: 66, spd: 30,
              moves: [[1, 'tackle'], [1, 'bubble'], [8, 'teapot_steam']] },
  duck:     { name: 'เป็ดฝักบัว',   type: 'water',    img: 'wild_water_duck',
              hp: 44, atk: 47, def: 42, spd: 57,
              moves: [[1, 'tackle'], [1, 'lotus_spray'], [8, 'pond_splash']] },
  durian:   { name: 'ทุเรียนกลิ้ง', type: 'leaf',     img: 'wild_leaf_durian',
              hp: 52, atk: 54, def: 62, spd: 28,
              moves: [[1, 'tackle'], [1, 'thorn_roll'], [8, 'durian_drop']] },
  bat:      { name: 'ค้างคาวใบตอง', type: 'leaf',     img: 'wild_leaf_bat',
              hp: 40, atk: 48, def: 38, spd: 64,
              moves: [[1, 'tackle'], [1, 'leaf_toss'], [8, 'leaf_gust']] },
  gecko:    { name: 'ตุ๊กแกปลั๊ก',  type: 'electric', img: 'wild_electric_gecko',
              hp: 46, atk: 53, def: 44, spd: 52,
              moves: [[1, 'tackle'], [1, 'spark'], [8, 'plug_shock']] },
  snail:    { name: 'ทากหินซ้อน',   type: 'rock',     img: 'wild_rock_snail',
              hp: 58, atk: 42, def: 68, spd: 20,
              moves: [[1, 'tackle'], [1, 'pebble'], [8, 'cairn_fall']] },
  kite:     { name: 'ว่าวหลอน',     type: 'ghost',    img: 'wild_ghost_kite',
              hp: 38, atk: 54, def: 36, spd: 66,
              moves: [[1, 'tackle'], [1, 'string_snare'], [8, 'night_dive']] },
  rooster:  { name: 'ไก่แจ้จอมโวย', type: 'normal',   img: 'wild_normal_rooster',
              hp: 42, atk: 56, def: 40, spd: 60,
              moves: [[1, 'peck'], [1, 'dawn_crow'], [8, 'spur_kick']] },
  buffalo:  { name: 'ควายโคลน',     type: 'normal',   img: 'wild_normal_buffalo',
              hp: 62, atk: 55, def: 54, spd: 30,
              moves: [[1, 'tackle'], [1, 'horn_charge'], [8, 'mud_stomp']] },
};
const STARTERS = ['lamb', 'narwhal', 'pangolin'];
// the rival takes the starter that is weak to yours, so the first duel is winnable
const RIVAL_PICK = { lamb: 'pangolin', narwhal: 'lamb', pangolin: 'narwhal' };

// [species, weight]; levels are inclusive
const ENCOUNTERS = {
  west: { levels: [2, 4], table: [['beetle', 50], ['tortoise', 35], ['moth', 15]] },
  east: { levels: [3, 5], table: [['moth', 38], ['beetle', 20], ['tortoise', 15],
                                  ['lamb', 9], ['narwhal', 9], ['pangolin', 9]] },
};
const ENCOUNTER_CHANCE = 0.13;
const PARTY_MAX = 6;
