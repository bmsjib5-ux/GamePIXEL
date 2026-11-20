"""Cut the generated sheets into real-size game frames.

Each sprite is located by its transparent gaps, then resampled to its target
size by taking the dominant colour of every target pixel's source block (no
blending, so edges stay hard), and finally reduced to a small shared palette.
"""
import math
import os
import sys

import numpy as np
from PIL import Image

SRC = sys.argv[1]
OUT = sys.argv[2]


def spans(mask_1d, min_gap, min_len=12):
    out, start, last = [], None, None
    for i, v in enumerate(mask_1d):
        if v:
            if start is None:
                start = i
            elif i - last > min_gap:
                out.append((start, last + 1))
                start = i
            last = i
    if start is not None:
        out.append((start, last + 1))
    return [s for s in out if s[1] - s[0] >= min_len]


def find_sprites(a, row_gap=None, col_gap=25):
    """Bounding boxes (x0, y0, x1, y1), grouped by row."""
    alpha = a[..., 3] > 0
    rows = spans(alpha.any(axis=1), row_gap) if row_gap else [(0, a.shape[0])]
    out = []
    for r0, r1 in rows:
        row = []
        for c0, c1 in spans(alpha[r0:r1].any(axis=0), col_gap):
            ys = np.flatnonzero(alpha[r0:r1, c0:c1].any(axis=1))
            row.append((c0, r0 + ys[0], c1, r0 + ys[-1] + 1))
        out.append(row)
    return out


def resample(a, box, tw, th):
    """Dominant-colour downsample of a[box] to tw x th RGBA."""
    x0, y0, x1, y1 = box
    out = np.zeros((th, tw, 4), np.uint8)
    sx, sy = (x1 - x0) / tw, (y1 - y0) / th
    for i in range(th):
        fy0, fy1 = y0 + i * sy, y0 + (i + 1) * sy
        for j in range(tw):
            fx0, fx1 = x0 + j * sx, x0 + (j + 1) * sx
            full = a[int(round(fy0)):max(int(round(fy1)), int(round(fy0)) + 1),
                     int(round(fx0)):max(int(round(fx1)), int(round(fx0)) + 1)]
            if (full[..., 3] > 0).mean() < 0.5:
                continue
            # central part of the block only, so neighbours do not bleed in
            cy0, cy1 = int(round(fy0 + 0.2 * sy)), int(round(fy1 - 0.2 * sy))
            cx0, cx1 = int(round(fx0 + 0.2 * sx)), int(round(fx1 - 0.2 * sx))
            core = a[cy0:max(cy1, cy0 + 1), cx0:max(cx1, cx0 + 1)].reshape(-1, 4)
            core = core[core[:, 3] > 0]
            if len(core) == 0:
                core = full.reshape(-1, 4)
                core = core[core[:, 3] > 0]
            q = core[:, :3].astype(np.int32) >> 3
            key = (q[:, 0] << 10) | (q[:, 1] << 5) | q[:, 2]
            vals, counts = np.unique(key, return_counts=True)
            members = core[key == vals[counts.argmax()]]
            out[i, j, :3] = members[:, :3].mean(axis=0).round()
            out[i, j, 3] = 255
    return out


def place(canvas_w, canvas_h, sprite, left, bottom_gap=0):
    th, tw = sprite.shape[:2]
    cell = np.zeros((canvas_h, canvas_w, 4), np.uint8)
    left = max(0, min(canvas_w - tw, left))
    top = max(0, canvas_h - bottom_gap - th)
    cell[top:top + th, left:left + tw] = sprite
    return cell


def reduce_palette(rgba, colors):
    """k-means palette. Farthest-point seeding keeps small accent colours
    (a pink bud, a yellow lantern) that population-based median cut drops."""
    m = rgba[..., 3] > 0
    px = rgba[m][:, :3].astype(np.float64)
    uniq, inv, counts = np.unique(px, axis=0, return_inverse=True, return_counts=True)
    inv = inv.reshape(-1)
    if len(uniq) <= colors:
        return rgba
    first = counts.argmax()
    centers = [uniq[first]]
    d = ((uniq - uniq[first]) ** 2).sum(axis=1)
    for _ in range(colors - 1):
        i = d.argmax()
        centers.append(uniq[i])
        d = np.minimum(d, ((uniq - uniq[i]) ** 2).sum(axis=1))
    c = np.array(centers)
    for _ in range(25):
        lab = ((uniq[:, None, :] - c[None]) ** 2).sum(axis=2).argmin(axis=1)
        for k in range(colors):
            sel = lab == k
            if sel.any():
                c[k] = np.average(uniq[sel], axis=0, weights=counts[sel])
    lab = ((uniq[:, None, :] - c[None]) ** 2).sum(axis=2).argmin(axis=1)
    out = rgba.copy()
    out[m, :3] = c[lab][inv].round().astype(np.uint8)
    return out


def save(arr, *parts):
    path = os.path.join(OUT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(arr, "RGBA").save(path)
    return path


def load(name):
    return np.array(Image.open(os.path.join(SRC, name)).convert("RGBA"))


report = []

# ---------------------------------------------------------------- hero 32x48
W, H = 32, 48


def find_grid(a, n=4):
    """Rows of sprite boxes for an n x n sheet, trying a few gap sizes."""
    alpha = a[..., 3] > 0
    for row_gap in (15, 8, 25, 4, 40):
        rows = spans(alpha.any(axis=1), row_gap, min_len=40)
        if len(rows) != n:
            continue
        for col_gap in (25, 12, 40, 6):
            grid = []
            for r0, r1 in rows:
                row = []
                for c0, c1 in spans(alpha[r0:r1].any(axis=0), col_gap, min_len=40):
                    ys = np.flatnonzero(alpha[r0:r1, c0:c1].any(axis=1))
                    row.append((c0, r0 + ys[0], c1, r0 + ys[-1] + 1))
                grid.append(row)
            if all(len(r) == n for r in grid):
                return grid
    raise SystemExit(f"could not find a {n}x{n} grid")


def walk_sheet(src, prefix, folder, colors=32):
    """4 rows (down, left, right, up) x 4 walk frames -> W x H cells."""
    a = load(src)
    rows = find_grid(a)
    scale = min(W / max(b[2] - b[0] for r in rows for b in r),
                H / max(b[3] - b[1] for r in rows for b in r))
    col_cx = [float(np.median([(r[c][0] + r[c][2]) / 2 for r in rows])) for c in range(4)]
    sheet = np.zeros((H * 4, W * 4, 4), np.uint8)
    for ri, row in enumerate(rows):
        baseline = max(b[3] for b in row)
        for ci, b in enumerate(row):
            tw = max(1, round((b[2] - b[0]) * scale))
            th = max(1, round((b[3] - b[1]) * scale))
            spr = resample(a, b, min(tw, W), min(th, H))
            left = round(W / 2 - (col_cx[ci] - b[0]) * scale)
            gap = round((baseline - b[3]) * scale)
            sheet[ri * H:(ri + 1) * H, ci * W:(ci + 1) * W] = place(W, H, spr, left, gap)
    sheet = reduce_palette(sheet, colors)
    save(sheet, folder, f"{prefix}_walk_{W}x{H}.png")
    for ri, d in enumerate(["down", "left", "right", "up"]):
        for ci in range(4):
            save(sheet[ri * H:(ri + 1) * H, ci * W:(ci + 1) * W], folder, f"{prefix}_{d}_{ci + 1}.png")
    report.append((folder, f"16 frames {W}x{H}, {1 / scale:.2f} source px per pixel"))
    return sheet


sheet = walk_sheet("hero_walk_sheet.png", "hero", "hero")
npc_walks = []
for who in ["researcher", "rival", "shopkeeper", "healer", "gym_leader", "gym_hiker", "gym_kid",
            "gym2_leader", "gym2_rower", "gym2_swimmer"]:
    if os.path.exists(os.path.join(SRC, f"npc_{who}_walk_sheet.png")):
        npc_walks.append(walk_sheet(f"npc_{who}_walk_sheet.png", f"npc_{who}", f"npc_{who}"))

# ------------------------------------------------- lineups (NPCs, monsters)


def split_by_shape(a, n):
    """Separate n sprites that have no clean gap between them.

    Finds every connected blob of opaque pixels, takes the n biggest as the sprites'
    bodies, and gives each loose bit (bubble, spark) to the nearest body. Returns the
    sprites left to right as (boxes, masks); a mask marks the sprite's own pixels in its box.
    """
    alpha = a[..., 3] > 0
    parent = []

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    runs, prev = [], []                     # runs: (row, start, end, id)
    for y in range(alpha.shape[0]):
        d = np.diff(np.concatenate(([0], alpha[y].astype(np.int8), [0])))
        cur = []
        for s0, e0 in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
            rid = len(parent)
            parent.append(rid)
            for ps, pe, pid in prev:        # touches a run in the row above (diagonals count)
                if ps <= e0 and pe >= s0:
                    ra, rb = find(rid), find(pid)
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
            cur.append((int(s0), int(e0), rid))
            runs.append((y, int(s0), int(e0), rid))
        prev = cur
    blobs = {}
    for y, s0, e0, rid in runs:
        blobs.setdefault(find(rid), []).append((y, s0, e0))
    info = []
    for root, rs in blobs.items():
        area = sum(e0 - s0 for _, s0, e0 in rs)
        if area < 40:
            continue                        # stray speck
        x0, x1 = min(r[1] for r in rs), max(r[2] for r in rs)
        info.append({"runs": rs, "area": area, "cx": (x0 + x1) / 2})
    info.sort(key=lambda b: -b["area"])
    bodies = sorted(info[:n], key=lambda b: b["cx"])
    assert len(bodies) == n, ("blobs", len(info))
    for extra in info[n:]:
        min(bodies, key=lambda b: abs(b["cx"] - extra["cx"]))["runs"].extend(extra["runs"])
    boxes, masks = [], []
    for body in bodies:
        rs = body["runs"]
        x0, x1 = min(r[1] for r in rs), max(r[2] for r in rs)
        y0, y1 = min(r[0] for r in rs), max(r[0] for r in rs) + 1
        m = np.zeros((y1 - y0, x1 - x0), bool)
        for y, s0, e0 in rs:
            m[y - y0, s0 - x0:e0 - x0] = True
        boxes.append((x0, y0, x1, y1))
        masks.append(m)
    return boxes, masks


HEIGHTS = {}  # sprite name -> (height in pixels, gap below it)


def lineup(src, names, cell_w, cell_h, folder, sheet_name, colors, match=None, each=False):
    """match: names of already-sliced sprites whose height each sprite should copy.
    each: scale every sprite on its own to fill its cell, instead of one scale for the sheet."""
    a = load(src)
    masks = None
    for col_gap in (25, 16, 10, 6):      # sprites drawn close together need a smaller gap
        boxes = find_sprites(a, col_gap=col_gap)[0]
        if len(boxes) == len(names):
            break
    else:
        # No clean vertical gaps (one sprite reaches over another): separate them by shape.
        boxes, masks = split_by_shape(a, len(names))
    assert len(boxes) == len(names), (src, len(boxes))
    max_w = max(b[2] - b[0] for b in boxes)
    max_h = max(b[3] - b[1] for b in boxes)
    sheet_scale = min(cell_w / max_w, cell_h / max_h)
    sheet = np.zeros((cell_h, cell_w * len(names), 4), np.uint8)
    floor = max(b[3] for b in boxes)
    scales = []
    for i, (b, n) in enumerate(zip(boxes, names)):
        bw, bh = b[2] - b[0], b[3] - b[1]
        if match:
            scale = min(HEIGHTS[match[i]][0] / bh, cell_w / bw)
            gap = HEIGHTS[match[i]][1]
        elif each:
            scale, gap = min(cell_w / bw, cell_h / bh), 0
        else:
            scale = sheet_scale
            gap = round((floor - b[3]) * scale)
        scales.append(scale)
        tw = min(cell_w, max(1, round(bw * scale)))
        th = min(cell_h - gap, max(1, round(bh * scale)))
        HEIGHTS[n] = (th, gap)
        if masks is None:
            spr = resample(a, b, tw, th)
        else:                            # only this sprite's own pixels, even inside its box
            own = a[b[1]:b[3], b[0]:b[2]].copy()
            own[~masks[i]] = 0
            spr = resample(own, (0, 0, bw, bh), tw, th)
        spr = reduce_palette(spr, colors)
        cell = place(cell_w, cell_h, spr, (cell_w - tw) // 2, gap)
        sheet[:, i * cell_w:(i + 1) * cell_w] = cell
        save(cell, folder, f"{n}.png")
    save(sheet, folder, sheet_name)
    per = "/".join(f"{1 / s:.2f}" for s in sorted(set(scales)))
    report.append((folder, f"{len(names)} sprites {cell_w}x{cell_h}, {per} source px per pixel"))
    return sheet


NPCS = ["npc_researcher", "npc_rival", "npc_shopkeeper", "npc_healer"]
npc_large = lineup("npc_lineup.png", NPCS, 80, 80, "npc_large", "npc_large_80x80.png", 32)
starters = lineup("monsters_starters.png",
                  ["starter_fire_lamb", "starter_water_narwhal", "starter_leaf_pangolin"],
                  64, 64, "monsters", "starters_64x64.png", 24)
wild = lineup("monsters_wild.png",
              ["wild_electric_beetle", "wild_rock_tortoise", "wild_ghost_moth"],
              64, 64, "monsters", "wild_64x64.png", 24)
backs = []
for src, names, sheet_name in [
        ("monsters_starters_back.png",
         ["starter_fire_lamb_back", "starter_water_narwhal_back", "starter_leaf_pangolin_back"],
         "starters_back_64x64.png"),
        ("monsters_wild_back.png",
         ["wild_electric_beetle_back", "wild_rock_tortoise_back", "wild_ghost_moth_back"],
         "wild_back_64x64.png")]:
    if os.path.exists(os.path.join(SRC, src)):
        fronts = [n[:-len("_back")] for n in names]
        backs.append(lineup(src, names, 64, 64, "monsters", sheet_name, 24, match=fronts))

# ------------------------------------------------------------------ preview
Z = 6
# each character's 4x4 walk sheet becomes one strip of four directions side by side
# Second set of monsters: two sheets of five, each with an optional back-view sheet.
new_strips = []
for src, names in [
        ("monsters_new_a", ["wild_fire_frog", "wild_water_crab", "wild_water_duck",
                            "wild_leaf_durian", "wild_leaf_bat"]),
        ("monsters_new_b", ["wild_electric_gecko", "wild_rock_snail", "wild_ghost_kite",
                            "wild_normal_rooster", "wild_normal_buffalo"]),
        ("monsters_new_c", ["wild_water_betta", "wild_ghost_krathong", "wild_electric_firefly",
                            "wild_leaf_hyacinth", "wild_fire_kingfisher"])]:
    if not os.path.exists(os.path.join(SRC, src + ".png")):
        continue
    new_strips.append(lineup(src + ".png", names, 64, 64, "monsters", src[9:] + "_64x64.png", 24))
    if os.path.exists(os.path.join(SRC, src + "_back.png")):
        new_strips.append(lineup(src + "_back.png", [n + "_back" for n in names], 64, 64, "monsters",
                                 src[9:] + "_back_64x64.png", 24, match=names))

# Evolved forms, front and back: the first six monsters have stage 1 and stage 2, the ten
# monsters of the second set have one evolved form (stage 1 only).
# They get bigger cells than the 64x64 base forms, so a monster visibly grows when it evolves.
BASE_NAMES = {"starters": ["starter_fire_lamb", "starter_water_narwhal", "starter_leaf_pangolin"],
              "wild": ["wild_electric_beetle", "wild_rock_tortoise", "wild_ghost_moth"],
              "new_a": ["wild_fire_frog", "wild_water_crab", "wild_water_duck",
                        "wild_leaf_durian", "wild_leaf_bat"],
              "new_b": ["wild_electric_gecko", "wild_rock_snail", "wild_ghost_kite",
                        "wild_normal_rooster", "wild_normal_buffalo"],
              "new_c": ["wild_water_betta", "wild_ghost_krathong", "wild_electric_firefly",
                        "wild_leaf_hyacinth", "wild_fire_kingfisher"]}
EVO_CELL = {"evo1": 72, "evo2": 80}
for group, base in BASE_NAMES.items():
    for stage, cell in EVO_CELL.items():
        src = f"monsters_{group}_{stage}"
        if not os.path.exists(os.path.join(SRC, src + ".png")):
            continue
        names = [f"{n}_{stage}" for n in base]
        new_strips.append(lineup(src + ".png", names, cell, cell, "monsters",
                                 f"{group}_{stage}_{cell}x{cell}.png", 28, each=True))
        if os.path.exists(os.path.join(SRC, src + "_back.png")):
            new_strips.append(lineup(src + "_back.png", [n + "_back" for n in names], cell, cell, "monsters",
                                     f"{group}_{stage}_back_{cell}x{cell}.png", 28, match=names))

# The legendary monster: one sprite on its own sheet, front view only, in a final-form cell.
if os.path.exists(os.path.join(SRC, "monsters_legend.png")):
    new_strips.append(lineup("monsters_legend.png", ["legend_sky_elephant"], 88, 88, "monsters",
                             "legend_88x88.png", 40, each=True))

walk_strips = [np.hstack([s[i * H:(i + 1) * H] for i in range(4)]) for s in [sheet] + npc_walks]
strips = walk_strips + [npc_large, np.hstack([starters, wild])]
if len(backs) == 2:
    strips.append(np.hstack(backs))
strips += new_strips
pw = max(s.shape[1] for s in strips) * Z + 2 * 24
ph = sum(s.shape[0] * Z + 24 for s in strips) + 24
yy, xx = np.mgrid[0:ph, 0:pw]
bg = np.where(((yy // 24) + (xx // 24)) % 2 == 0, 150, 175).astype(np.uint8)
prev = np.dstack([bg, bg, bg, np.full_like(bg, 255)])
y = 24
for s in strips:
    big = np.kron(s, np.ones((Z, Z, 1), np.uint8))
    m = big[..., 3] > 0
    region = prev[y:y + big.shape[0], 24:24 + big.shape[1]]
    region[m] = big[m]
    y += big.shape[0] + 24
save(prev, "preview_6x.png")

for folder, line in report:
    print(f"{folder:14s} {line}")
print("files:", sum(len(f) for _, _, f in os.walk(OUT)))
