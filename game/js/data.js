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
