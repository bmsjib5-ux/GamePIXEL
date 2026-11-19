// Generated from the tileset: tile name -> [column, row] in assets/terrain.png,
// and the pixel size / solid area / door position of every object and building.
const TILE_INDEX = { "grass": [ 0, 0 ], "grass_tufts": [ 1, 0 ], "grass_white_flowers": [ 2, 0 ], "grass_color_flowers": [ 3, 0 ], "tall_grass": [ 0, 1 ], "dirt": [ 1, 1 ], "sand": [ 2, 1 ], "cobble": [ 3, 1 ], "water": [ 0, 2 ], "deep_water": [ 1, 2 ], "bridge_h": [ 2, 2 ], "bridge_v": [ 3, 2 ], "floor_wood": [ 0, 3 ], "wall_indoor": [ 1, 3 ], "cliff_face": [ 2, 3 ], "stone_steps": [ 3, 3 ], "path_nw": [ 4, 0 ], "path_n": [ 5, 0 ], "path_ne": [ 6, 0 ], "path_w": [ 4, 1 ], "path_c": [ 5, 1 ], "path_e": [ 6, 1 ], "path_sw": [ 4, 2 ], "path_s": [ 5, 2 ], "path_se": [ 6, 2 ], "pond_nw": [ 7, 0 ], "pond_n": [ 8, 0 ], "pond_ne": [ 9, 0 ], "pond_w": [ 7, 1 ], "pond_c": [ 8, 1 ], "pond_e": [ 9, 1 ], "pond_sw": [ 7, 2 ], "pond_s": [ 8, 2 ], "pond_se": [ 9, 2 ], "plateau_nw": [ 4, 3 ], "plateau_n": [ 5, 3 ], "plateau_ne": [ 6, 3 ], "plateau_w": [ 4, 4 ], "plateau_c": [ 5, 4 ], "plateau_e": [ 6, 4 ], "plateau_sw": [ 4, 5 ], "plateau_s": [ 5, 5 ], "plateau_se": [ 6, 5 ], "plaza_nw": [ 7, 3 ], "plaza_n": [ 8, 3 ], "plaza_ne": [ 9, 3 ], "plaza_w": [ 7, 4 ], "plaza_c": [ 8, 4 ], "plaza_e": [ 9, 4 ], "plaza_sw": [ 7, 5 ], "plaza_s": [ 8, 5 ], "plaza_se": [ 9, 5 ], "path_inner_nw": [ 0, 6 ], "path_inner_ne": [ 1, 6 ], "path_inner_sw": [ 0, 7 ], "path_inner_se": [ 1, 7 ], "pond_inner_nw": [ 2, 6 ], "pond_inner_ne": [ 3, 6 ], "pond_inner_sw": [ 2, 7 ], "pond_inner_se": [ 3, 7 ], "plateau_inner_nw": [ 4, 6 ], "plateau_inner_ne": [ 5, 6 ], "plateau_inner_sw": [ 4, 7 ], "plateau_inner_se": [ 5, 7 ], "plaza_inner_nw": [ 6, 6 ], "plaza_inner_ne": [ 7, 6 ], "plaza_inner_sw": [ 6, 7 ], "plaza_inner_se": [ 7, 7 ], "path_narrow_dot": [ 0, 8 ], "path_narrow_n": [ 1, 8 ], "path_narrow_e": [ 2, 8 ], "path_narrow_ne": [ 3, 8 ], "path_narrow_s": [ 4, 8 ], "path_narrow_ns": [ 5, 8 ], "path_narrow_es": [ 6, 8 ], "path_narrow_nes": [ 7, 8 ], "path_narrow_w": [ 8, 8 ], "path_narrow_nw": [ 9, 8 ], "path_narrow_ew": [ 0, 9 ], "path_narrow_new": [ 1, 9 ], "path_narrow_sw": [ 2, 9 ], "path_narrow_nsw": [ 3, 9 ], "path_narrow_esw": [ 4, 9 ], "path_narrow_nesw": [ 5, 9 ], "path_join_n": [ 6, 9 ], "path_join_e": [ 7, 9 ], "path_join_s": [ 8, 9 ], "path_join_w": [ 9, 9 ], "river_dot": [ 0, 10 ], "river_n": [ 1, 10 ], "river_e": [ 2, 10 ], "river_ne": [ 3, 10 ], "river_s": [ 4, 10 ], "river_ns": [ 5, 10 ], "river_es": [ 6, 10 ], "river_nes": [ 7, 10 ], "river_w": [ 8, 10 ], "river_nw": [ 9, 10 ], "river_ew": [ 0, 11 ], "river_new": [ 1, 11 ], "river_sw": [ 2, 11 ], "river_nsw": [ 3, 11 ], "river_esw": [ 4, 11 ], "river_nesw": [ 5, 11 ], "river_join_n": [ 6, 11 ], "river_join_e": [ 7, 11 ], "river_join_s": [ 8, 11 ], "river_join_w": [ 9, 11 ], "river_bridge_ew": [ 0, 4 ], "river_bridge_ns": [ 1, 4 ], "wall_upper": [ 2, 4 ] };
const SPRITE_META = {
 "objects": {
  "barrel": {
   "w": 32,
   "h": 32,
   "x0": 2,
   "x1": 29,
   "y0": 0,
   "y1": 32
  },
  "boulder": {
   "w": 32,
   "h": 32,
   "x0": 0,
   "x1": 32,
   "y0": 5,
   "y1": 32
  },
  "bridge_deck_ew": {
   "w": 32,
   "h": 32,
   "x0": 0,
   "x1": 32,
   "y0": 2,
   "y1": 28
  },
  "bridge_deck_ns": {
   "w": 32,
   "h": 32,
   "x0": 2,
   "x1": 28,
   "y0": 0,
   "y1": 32
  },
  "bush": {
   "w": 32,
   "h": 32,
   "x0": 1,
   "x1": 30,
   "y0": 7,
   "y1": 32
  },
  "bush_berry": {
   "w": 32,
   "h": 32,
   "x0": 0,
   "x1": 32,
   "y0": 5,
   "y1": 32
  },
  "crate": {
   "w": 32,
   "h": 32,
   "x0": 2,
   "x1": 30,
   "y0": 0,
   "y1": 32
  },
  "fence_h": {
   "w": 32,
   "h": 32,
   "x0": 0,
   "x1": 32,
   "y0": 19,
   "y1": 32
  },
  "fence_post": {
   "w": 32,
   "h": 32,
   "x0": 12,
   "x1": 20,
   "y0": 16,
   "y1": 32
  },
  "fence_v": {
   "w": 32,
   "h": 32,
   "x0": 12,
   "x1": 19,
   "y0": 0,
   "y1": 32
  },
  "flower_bed": {
   "w": 64,
   "h": 32,
   "x0": 5,
   "x1": 59,
   "y0": 0,
   "y1": 32
  },
  "rocks": {
   "w": 32,
   "h": 32,
   "x0": 0,
   "x1": 32,
   "y0": 8,
   "y1": 32
  },
  "signpost": {
   "w": 32,
   "h": 32,
   "x0": 3,
   "x1": 29,
   "y0": 0,
   "y1": 32
  },
  "tree_apple": {
   "w": 64,
   "h": 96,
   "x0": 0,
   "x1": 64,
   "y0": 24,
   "y1": 96
  },
  "tree_orange": {
   "w": 64,
   "h": 96,
   "x0": 0,
   "x1": 64,
   "y0": 24,
   "y1": 96
  },
  "tree_pine": {
   "w": 64,
   "h": 96,
   "x0": 5,
   "x1": 59,
   "y0": 23,
   "y1": 96
  },
  "tree_round": {
   "w": 64,
   "h": 96,
   "x0": 0,
   "x1": 64,
   "y0": 24,
   "y1": 96
  },
  "well": {
   "w": 64,
   "h": 64,
   "x0": 8,
   "x1": 56,
   "y0": 5,
   "y1": 64
  }
 },
 "buildings": {
  "healing_center": {
   "w": 192,
   "h": 192,
   "x0": 15,
   "x1": 176,
   "y0": 27,
   "y1": 192,
   "door": 95
  },
  "house_red": {
   "w": 160,
   "h": 160,
   "x0": 0,
   "x1": 160,
   "y0": 7,
   "y1": 160,
   "door": 79
  },
  "house_teal": {
   "w": 160,
   "h": 160,
   "x0": 0,
   "x1": 160,
   "y0": 7,
   "y1": 160,
   "door": 80
  },
  "lab_dome": {
   "w": 224,
   "h": 192,
   "x0": 7,
   "x1": 216,
   "y0": 27,
   "y1": 192,
   "door": 119
  },
  "shop": {
   "w": 192,
   "h": 192,
   "x0": 10,
   "x1": 182,
   "y0": 27,
   "y1": 192,
   "door": 119
  },
  "windmill": {
   "w": 160,
   "h": 224,
   "x0": 14,
   "x1": 145,
   "y0": 30,
   "y1": 224,
   "door": 80
  }
 },
 "furniture": {
  "bed": {
   "w": 32,
   "h": 64,
   "x0": 0,
   "x1": 32,
   "y0": 14,
   "y1": 64
  },
  "bookshelf": {
   "w": 64,
   "h": 64,
   "x0": 0,
   "x1": 63,
   "y0": 0,
   "y1": 64
  },
  "computer_desk": {
   "w": 64,
   "h": 64,
   "x0": 0,
   "x1": 64,
   "y0": 6,
   "y1": 64
  },
  "door_mat": {
   "w": 32,
   "h": 32,
   "x0": 0,
   "x1": 32,
   "y0": 10,
   "y1": 32
  },
  "goods_shelf": {
   "w": 64,
   "h": 64,
   "x0": 0,
   "x1": 64,
   "y0": 1,
   "y1": 64
  },
  "healing_machine": {
   "w": 64,
   "h": 64,
   "x0": 0,
   "x1": 64,
   "y0": 5,
   "y1": 64
  },
  "kitchen_counter": {
   "w": 64,
   "h": 64,
   "x0": 0,
   "x1": 64,
   "y0": 13,
   "y1": 64
  },
  "millstone": {
   "w": 64,
   "h": 64,
   "x0": 0,
   "x1": 64,
   "y0": 5,
   "y1": 64
  },
  "plant": {
   "w": 32,
   "h": 64,
   "x0": 0,
   "x1": 32,
   "y0": 24,
   "y1": 64
  },
  "reception_desk": {
   "w": 96,
   "h": 64,
   "x0": 8,
   "x1": 88,
   "y0": 16,
   "y1": 64
  },
  "rug": {
   "w": 96,
   "h": 64,
   "x0": 0,
   "x1": 96,
   "y0": 3,
   "y1": 64
  },
  "sacks": {
   "w": 32,
   "h": 32,
   "x0": 0,
   "x1": 32,
   "y0": 4,
   "y1": 32
  },
  "shop_counter": {
   "w": 96,
   "h": 64,
   "x0": 13,
   "x1": 82,
   "y0": 16,
   "y1": 64
  },
  "stool": {
   "w": 32,
   "h": 32,
   "x0": 4,
   "x1": 27,
   "y0": 6,
   "y1": 32
  },
  "table": {
   "w": 64,
   "h": 64,
   "x0": 4,
   "x1": 60,
   "y0": 16,
   "y1": 64
  },
  "tank": {
   "w": 32,
   "h": 64,
   "x0": 0,
   "x1": 32,
   "y0": 10,
   "y1": 64
  }
 }
};
