"""Collect the game's images into game/assets and write js/tiles.js (tile index + sprite sizes)."""
import json
import os
import re
import shutil
import sys

import numpy as np
from PIL import Image

SRC = sys.argv[1]            # ...\pixel_game
GAME = sys.argv[2]           # ...\pixel_game\game
A = os.path.join(GAME, "assets")
for sub in ("", "objects", "buildings", "furniture", "chars", "monsters"):
    os.makedirs(os.path.join(A, sub), exist_ok=True)
os.makedirs(os.path.join(GAME, "js"), exist_ok=True)


def copy(rel_src, rel_dst):
    shutil.copyfile(os.path.join(SRC, rel_src), os.path.join(A, rel_dst))


copy(r"tileset\tileset_terrain_32x32.png", "terrain.png")
meta = {"objects": {}, "buildings": {}, "furniture": {}}
for kind in ("objects", "buildings", "furniture"):
    folder = os.path.join(SRC, "tileset", kind)
    if not os.path.isdir(folder):
        continue
    for f in sorted(os.listdir(folder)):
        copy(os.path.join("tileset", kind, f), os.path.join(kind, f))
        a = np.array(Image.open(os.path.join(folder, f)).convert("RGBA"))
        solid = a[..., 3] == 255
        ys, xs = np.flatnonzero(solid.any(axis=1)), np.flatnonzero(solid.any(axis=0))
        info = {"w": a.shape[1], "h": a.shape[0], "x0": int(xs[0]), "x1": int(xs[-1]) + 1,
                "y0": int(ys[0]), "y1": int(ys[-1]) + 1}
        if kind == "buildings":   # the doorstep is the only thing in the lowest rows
            step = np.flatnonzero(solid[ys[-1] - 2:ys[-1] + 1].all(axis=0))
            info["door"] = int(round((step[0] + step[-1] + 1) / 2))
        meta[kind][f[:-4]] = info

for who in ("hero", "npc_researcher", "npc_rival", "npc_shopkeeper", "npc_healer",
            "npc_gym_leader", "npc_gym_hiker", "npc_gym_kid"):
    if not os.path.isdir(os.path.join(SRC, "sprites", who)):
        continue
    copy(os.path.join("sprites", who, f"{who}_walk_32x48.png"), os.path.join("chars", f"{who}.png"))
copy(r"sprites\npc_large\npc_rival.png", r"chars\rival_large.png")
for f in sorted(os.listdir(os.path.join(SRC, "sprites", "monsters"))):
    if not re.search(r"_\d+x\d+\.png$", f):        # skip the combined sheets
        copy(os.path.join("sprites", "monsters", f), os.path.join("monsters", f))



def shrink(img, W, H):
    """Hard-edged downscale: every output pixel takes the commonest colour of its block."""
    sx, sy = img.shape[1] / W, img.shape[0] / H
    out = np.zeros((H, W, 3), np.uint8)
    for i in range(H):
        y0, y1 = int(i * sy + 0.2 * sy), max(int((i + 1) * sy - 0.2 * sy), int(i * sy + 0.2 * sy) + 1)
        for j in range(W):
            x0, x1 = int(j * sx + 0.2 * sx), max(int((j + 1) * sx - 0.2 * sx), int(j * sx + 0.2 * sx) + 1)
            px = img[y0:y1, x0:x1].reshape(-1, 3)
            q = px.astype(np.int32) >> 3
            key = (q[:, 0] << 10) | (q[:, 1] << 5) | q[:, 2]
            vals, counts = np.unique(key, return_counts=True)
            out[i, j] = px[key == vals[counts.argmax()]].mean(axis=0).round()
    return out


# battle background at the game's 480x320 resolution
bg = np.array(Image.open(os.path.join(SRC, "scene_battle.png")).convert("RGB"))
Image.fromarray(shrink(bg, 480, 320), "RGB").save(os.path.join(A, "battle_bg.png"))

# App icons (home screen, installed app, browser tab) from the square icon artwork.
icon_src = os.path.join(SRC, "icon_source.png")
if os.path.exists(icon_src):
    icons = os.path.join(GAME, "icons")
    os.makedirs(icons, exist_ok=True)
    art = Image.open(icon_src).convert("RGB")
    side = min(art.size)
    left, top = (art.width - side) // 2, (art.height - side) // 2
    art = art.crop((left, top, left + side, top + side))
    small = Image.fromarray(shrink(np.array(art), 128, 128), "RGB")      # true pixel art
    big = small.resize((512, 512), Image.NEAREST)                         # enlarged with hard pixels
    big.save(os.path.join(icons, "icon-512.png"))
    big.resize((192, 192), Image.LANCZOS).save(os.path.join(icons, "icon-192.png"))
    big.resize((180, 180), Image.LANCZOS).save(os.path.join(icons, "apple-touch-icon.png"))
    # Android cuts "maskable" icons to a circle or rounded shape and may hide the outer 10%,
    # so that version gets a mirrored margin to keep the whole mascot inside the safe area.
    # The mascot comes close to the top, right and bottom sides, so those margins repeat the
    # edge (plain sky and grass); mirroring them would show stray bits of wool, flame and feet.
    padded = np.pad(np.array(small), ((0, 0), (16, 0), (0, 0)), mode="reflect")
    padded = np.pad(padded, ((16, 16), (0, 16), (0, 0)), mode="edge")
    Image.fromarray(padded, "RGB").resize((640, 640), Image.NEAREST).save(
        os.path.join(icons, "icon-maskable-640.png"))
    # browser-tab icon: the mascot only, so it stays readable at 16 pixels
    face = small.crop((16, 16, 112, 112))
    face.resize((32, 32), Image.BOX).save(os.path.join(icons, "favicon-32.png"))
    face.resize((48, 48), Image.BOX).save(os.path.join(GAME, "favicon.ico"),
                                          sizes=[(16, 16), (32, 32), (48, 48)])
    print("icons: written")

index = {}
with open(os.path.join(SRC, "tileset", "tileset_terrain_32x32.txt"), encoding="utf-8") as f:
    for line in f:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 3 and parts[1].isdigit():
            index[parts[0]] = [int(parts[1]), int(parts[2])]
with open(os.path.join(GAME, "js", "tiles.js"), "w", encoding="utf-8") as f:
    f.write("// Generated from the tileset: tile name -> [column, row] in assets/terrain.png,\n")
    f.write("// and the pixel size / solid area / door position of every object and building.\n")
    f.write("const TILE_INDEX = " + json.dumps(index, indent=0).replace("\n", " ") + ";\n")
    f.write("const SPRITE_META = " + json.dumps(meta, indent=1) + ";\n")

print("tiles:", len(index))
for kind in meta:
    for name, m in meta[kind].items():
        print(f"{kind[:-1]:9s}{name:16s}{m}")
