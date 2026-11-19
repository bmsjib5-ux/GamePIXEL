"""Cut the tileset source sheets into a 32x32 tile atlas, object sprites and a demo map."""
import os
import sys

import numpy as np
from PIL import Image

SRC = sys.argv[1]
OUT = sys.argv[2]
T = 32


# ------------------------------------------------------------------ helpers
def load(name):
    a = np.array(Image.open(os.path.join(SRC, name)).convert("RGBA"))
    solid = a[..., 3] >= 128
    a[~solid] = 0
    a[solid, 3] = 255
    return a


def runs(flags, min_len):
    out, start = [], None
    for i, v in enumerate(list(flags) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    return out


def despeckle(a, r=3):
    """Drop stray specks: keep only pixels near a solid r-pixel core."""
    m = a[..., 3] > 0
    core = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            core &= np.roll(np.roll(m, dy, 0), dx, 1)
    keep = np.zeros_like(m)
    for dy in range(-r - 1, r + 2):
        for dx in range(-r - 1, r + 2):
            keep |= np.roll(np.roll(core, dy, 0), dx, 1)
    a = a.copy()
    a[~(m & keep)] = 0
    return a


def square_grid(a, n, inset=0.03):
    """Boxes of an n x n grid of opaque squares."""
    alpha = a[..., 3] > 0
    rows = runs(alpha.mean(axis=1) > 0.35, 60)
    assert len(rows) == n, ("rows", len(rows))
    grid = []
    for r0, r1 in rows:
        cols = runs(alpha[r0:r1].mean(axis=0) > 0.6, 60)
        assert len(cols) == n, ("cols", len(cols))
        row = []
        for c0, c1 in cols:
            ys = np.flatnonzero(alpha[r0:r1, c0:c1].mean(axis=1) > 0.6)
            y0, y1 = r0 + ys[0], r0 + ys[-1] + 1
            dx, dy = (c1 - c0) * inset, (y1 - y0) * inset
            row.append((c0 + dx, y0 + dy, c1 - dx, y1 - dy))
        grid.append(row)
    return grid


def resample(a, box, tw, th):
    """Dominant-colour downsample of a[box] to tw x th RGBA (no blending)."""
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


def reduce_palette(rgba, colors):
    """k-means palette with farthest-point seeding (keeps small accent colours)."""
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


def regrass(img, canon, edge=3, tol=30.0):
    """Replace this piece's own grass colours with the canonical grass tile,
    so every tile shares exactly the same grass and joins without seams."""
    h, w = img.shape[:2]
    ring = np.concatenate([img[:edge].reshape(-1, 4), img[-edge:].reshape(-1, 4),
                           img[:, :edge].reshape(-1, 4), img[:, -edge:].reshape(-1, 4)])
    cols, counts = np.unique(ring[:, :3], axis=0, return_counts=True)
    main = cols[np.argsort(-counts)[:6]].astype(np.float64)
    px = img[..., :3].astype(np.float64)
    dist = np.sqrt(((px[:, :, None, :] - main[None, None]) ** 2).sum(axis=3)).min(axis=2)
    tiled = np.tile(canon, (h // T + 1, w // T + 1, 1))[:h, :w]
    out = img.copy()
    sel = (dist < tol) & (img[..., 3] > 0)
    out[sel] = tiled[sel]
    return out


# ------------------------------------------------------------ terrain atlas
BASE_NAMES = ["grass", "grass_tufts", "grass_white_flowers", "grass_color_flowers",
              "tall_grass", "dirt", "sand", "cobble",
              "water", "deep_water", "bridge_h", "bridge_v",
              "floor_wood", "wall_indoor", "cliff_face", "stone_steps"]
BLOCK_NAMES = ["path", "pond", "plateau", "plaza"]
PART = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"]

a = despeckle(load("tileset_base_tiles.png"))
base = [resample(a, b, T, T) for row in square_grid(a, 4) for b in row]
canon = base[0]
for i in (1, 2, 3):
    base[i] = regrass(base[i], canon)

a = despeckle(load("tileset_terrain_blocks.png"))
blocks = [regrass(resample(a, b, 3 * T, 3 * T), canon)
          for row in square_grid(a, 2, inset=0.01) for b in row]



def rim_profile(t, canon_t, interior):
    """For a tile with terrain on top and outside grass at the bottom: per column,
    the row where the rim starts and the row where the outside grass starts."""
    grass = (t[..., :3] == canon_t[..., :3]).all(axis=2)
    top, grass_at = np.zeros(T, int), np.zeros(T, int)
    for x in range(T):
        y = T
        while y > 0 and grass[y - 1, x]:
            y -= 1
        grass_at[x] = y
        while y > 0 and not grass[y - 1, x] and tuple(t[y - 1, x, :3]) not in interior:
            y -= 1
        top[x] = max(0, y - 1)
    return top, grass_at


def inner_corner(s, e, c, canon_t):
    """Concave corner with grass only in the bottom-right quadrant, built from the
    bottom-edge tile s, the right-edge tile e and the centre tile c, so that its
    right side continues s and its bottom side continues e exactly."""
    cols, counts = np.unique(c[..., :3].reshape(-1, 3), axis=0, return_counts=True)
    order = np.argsort(-counts)
    keep = order[:max(1, int(np.searchsorted(np.cumsum(counts[order]), 0.9 * counts.sum())) + 1)]
    interior = {tuple(v) for v in cols[keep]}
    top_s, grass_s = rim_profile(s, canon_t, interior)
    top_e, grass_e = rim_profile(e.transpose(1, 0, 2), canon_t.transpose(1, 0, 2), interior)
    out = np.zeros_like(c)
    for y in range(T):
        for x in range(T):
            ds, ks = y - top_s[x], grass_s[x] - top_s[x]
            de, ke = x - top_e[y], grass_e[y] - top_e[y]
            if ds < 0 and de < 0:
                out[y, x] = c[y, x]
            elif de < 0:
                out[y, x] = e[y, x]
            elif ds < 0:
                out[y, x] = s[y, x]
            elif ds >= ks and de >= ke:
                out[y, x] = canon_t[y, x]
            elif ks - ds >= ke - de:
                out[y, x] = s[y, x]
            else:
                out[y, x] = e[y, x]
    return out


def autotile(kind, cells, outside_is_terrain=False, width=0, height=0):
    """Tile name for every cell of a terrain shape (set of (col, row))."""
    def has(c, r):
        if outside_is_terrain and not (0 <= c < width and 0 <= r < height):
            return True
        return (c, r) in cells
    out = {}
    for c, r in cells:
        n, s_, w, e_ = has(c, r - 1), has(c, r + 1), has(c - 1, r), has(c + 1, r)
        part = ("" if n else "n") + ("" if s_ else "s") if not (n and s_) else ""
        part += ("" if w else "w") + ("" if e_ else "e") if not (w and e_) else ""
        if not part:
            for dc, dr, name in ((-1, -1, "inner_nw"), (1, -1, "inner_ne"),
                                 (-1, 1, "inner_sw"), (1, 1, "inner_se")):
                if not has(c + dc, r + dr):
                    part = name
                    break
        out[(c, r)] = f"{kind}_{part or 'c'}"
    return out


HALF, SHIFT = T // 2, 10


def quarter(src, canon_t, qx, qy, x_shifted, y_shifted):
    """One 16x16 quarter of a new tile, cut from tile src. A shifted axis moves the
    terrain boundary (at the middle of src) out to 6 px from the new tile's side;
    an unshifted axis keeps src's own rows or columns so it still repeats."""
    def start(q, shifted):
        if shifted:
            return SHIFT if q == 0 else HALF - SHIFT
        return q * HALF
    sx, sy = start(qx, x_shifted), start(qy, y_shifted)
    block = src[sy:sy + HALF, sx:sx + HALF]
    was_grass = (block[..., :3] == canon_t[sy:sy + HALF, sx:sx + HALF, :3]).all(axis=2)
    out = block.copy()
    out[was_grass] = canon_t[qy * HALF:(qy + 1) * HALF, qx * HALF:(qx + 1) * HALF][was_grass]
    return out


def drop_fragments(t, canon_t):
    """Keep the main terrain shape; turn stray bits (cut-off grass tufts) into grass."""
    other = ~(t[..., :3] == canon_t[..., :3]).all(axis=2)
    label = np.zeros((T, T), int)
    sizes = {}
    for y0 in range(T):
        for x0 in range(T):
            if other[y0, x0] and not label[y0, x0]:
                k = len(sizes) + 1
                stack, label[y0, x0], sizes[k] = [(y0, x0)], k, 0
                while stack:
                    y, x = stack.pop()
                    sizes[k] += 1
                    for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                        if 0 <= yy < T and 0 <= xx < T and other[yy, xx] and not label[yy, xx]:
                            label[yy, xx] = k
                            stack.append((yy, xx))
    if len(sizes) > 1:
        main = max(sizes, key=sizes.get)
        stray = (label > 0) & (label != main)
        t = t.copy()
        t[stray] = canon_t[stray]
    return t


def narrow_tile(tiles, kind, canon_t, n, e, s, w):
    """One-tile-wide strip of terrain joined to the given sides."""
    out = np.zeros((T, T, 4), np.uint8)
    for qy, (v_on, v) in enumerate([(n, "n"), (s, "s")]):
        for qx, (h_on, h) in enumerate([(w, "w"), (e, "e")]):
            if v_on and h_on:
                q = quarter(tiles[f"{kind}_inner_{v}{h}"], canon_t, qx, qy, True, True)
            elif v_on:
                q = quarter(tiles[f"{kind}_{h}"], canon_t, qx, qy, True, False)
            elif h_on:
                q = quarter(tiles[f"{kind}_{v}"], canon_t, qx, qy, False, True)
            else:
                q = quarter(tiles[f"{kind}_{v}{h}"], canon_t, qx, qy, True, True)
            out[qy * HALF:(qy + 1) * HALF, qx * HALF:(qx + 1) * HALF] = q
    return out


def join_tile(tiles, kind, canon_t, side):
    """Edge tile of a wide patch with a narrow strip leaving through that edge."""
    out = np.zeros((T, T, 4), np.uint8)
    for qy in range(2):
        for qx in range(2):
            if side in "ns":
                src = tiles[f"{kind}_inner_{side}{'we'[qx]}"]
                q = quarter(src, canon_t, qx, qy, True, False)
            else:
                src = tiles[f"{kind}_inner_{'ns'[qy]}{side}"]
                q = quarter(src, canon_t, qx, qy, False, True)
            out[qy * HALF:(qy + 1) * HALF, qx * HALF:(qx + 1) * HALF] = q
    return out


# wide terrain kind -> (prefix of its one-tile-wide tiles, prefix of its join tiles)
STRIPS = {"path": ("path_narrow_", "path_join_"), "pond": ("river_", "river_join_")}


def strip_layout(kind, wide, narrow, outside_is_terrain=False, width=0, height=0):
    """Tile names for wide cells of a terrain plus its one-tile-wide cells."""
    narrow_prefix, join_prefix = STRIPS[kind]
    names = autotile(kind, wide, outside_is_terrain, width, height)
    step = {"n": (0, -1), "e": (1, 0), "s": (0, 1), "w": (-1, 0)}

    def joins(c, r):
        if outside_is_terrain and not (0 <= c < width and 0 <= r < height):
            return True
        return (c, r) in narrow or (c, r) in wide

    for c, r in narrow:
        dirs = "".join(d for d, (dc, dr) in step.items() if joins(c + dc, r + dr))
        names[(c, r)] = narrow_prefix + (dirs or "dot")
    for (c, r) in wide:
        for d, (dc, dr) in step.items():
            if names[(c, r)] == f"{kind}_{d}" and (c + dc, r + dr) in narrow:
                names[(c, r)] = join_prefix + d
    return names


atlas = np.zeros((12 * T, 10 * T, 4), np.uint8)
index = []
for i, tile in enumerate(base):
    r, c = divmod(i, 4)
    atlas[r * T:(r + 1) * T, c * T:(c + 1) * T] = tile
    index.append((BASE_NAMES[i], c, r))
for bi, blk in enumerate(blocks):
    c0, r0 = 4 + 3 * (bi % 2), 3 * (bi // 2)
    atlas[r0 * T:(r0 + 3) * T, c0 * T:(c0 + 3) * T] = blk
    for k, part in enumerate(PART):
        index.append((f"{BLOCK_NAMES[bi]}_{part}", c0 + k % 3, r0 + k // 3))
atlas = reduce_palette(atlas, 56)
tile = {name: atlas[r * T:(r + 1) * T, c * T:(c + 1) * T] for name, c, r in index}

# Inner (concave) corners, named by the quadrant that holds the grass. Each is built
# in the "grass at bottom-right" orientation and flipped back.
FLIPS = {"inner_se": ("s", "e", False, False), "inner_sw": ("s", "w", True, False),
         "inner_ne": ("n", "e", False, True), "inner_nw": ("n", "w", True, True)}


def flip(t, fx, fy):
    t = t[:, ::-1] if fx else t
    return t[::-1] if fy else t


canon = tile["grass"]
for bi, kind in enumerate(BLOCK_NAMES):
    for k, corner in enumerate(["inner_nw", "inner_ne", "inner_sw", "inner_se"]):
        v, h, fx, fy = FLIPS[corner]
        made = inner_corner(flip(tile[f"{kind}_{v}"], fx, fy), flip(tile[f"{kind}_{h}"], fx, fy),
                            flip(tile[f"{kind}_c"], fx, fy), flip(canon, fx, fy))
        c, r = 2 * bi + k % 2, 6 + k // 2
        atlas[r * T:(r + 1) * T, c * T:(c + 1) * T] = flip(made, fx, fy)
        index.append((f"{kind}_{corner}", c, r))
tile = {name: atlas[r * T:(r + 1) * T, c * T:(c + 1) * T] for name, c, r in index}

# One-tile-wide dirt path and river: for each, 16 tiles by which sides they join,
# then 4 joins to the wide terrain. 20 tiles = two atlas rows per kind.
slot = 0
for kind, (narrow_prefix, join_prefix) in STRIPS.items():
    for mask in range(16):
        n, e, s, w = bool(mask & 1), bool(mask & 2), bool(mask & 4), bool(mask & 8)
        dirs = "".join(d for d, on in zip("nesw", (n, e, s, w)) if on) or "dot"
        c, r = slot % 10, 8 + slot // 10
        atlas[r * T:(r + 1) * T, c * T:(c + 1) * T] = drop_fragments(
            narrow_tile(tile, kind, canon, n, e, s, w), canon)
        index.append((narrow_prefix + dirs, c, r))
        slot += 1
    for side in "nesw":
        c, r = slot % 10, 8 + slot // 10
        atlas[r * T:(r + 1) * T, c * T:(c + 1) * T] = drop_fragments(
            join_tile(tile, kind, canon, side), canon)
        index.append((join_prefix + side, c, r))
        slot += 1
tile = {name: atlas[r * T:(r + 1) * T, c * T:(c + 1) * T] for name, c, r in index}


# Bridges over the one-tile-wide river. The deck is as wide as the narrow path,
# so path_narrow tiles meet it on both sides.
def bridge_layer(planks):
    """Deck running left-right, on a transparent tile: planks, two side beams,
    four posts, and a soft shadow line below. planks = texture with vertical boards."""
    cols = np.unique(planks[..., :3].reshape(-1, 3), axis=0)
    lum = cols.astype(int) @ np.array([299, 587, 114])
    dark, light = cols[lum.argmin()], cols[lum.argmax()]
    layer = np.zeros((T, T, 4), np.uint8)
    layer[7:25] = planks[7:25]
    for top in (4, 25):
        layer[top, :, :3], layer[top + 1, :, :3], layer[top + 2, :, :3] = dark, light, dark
        layer[top:top + 3, :, 3] = 255
        for x0 in (2, 27):
            layer[top - 2:top + 3, x0:x0 + 3, :3] = dark
            layer[top - 1:top + 2, x0 + 1, :3] = light
            layer[top - 2:top + 3, x0:x0 + 3, 3] = 255
    layer[28, :, 3] = np.where(layer[28, :, 3] == 0, 70, layer[28, :, 3])
    return layer


def over(base, layer):
    out = base.copy()
    solid = layer[..., 3] == 255
    out[solid] = layer[solid]
    shade = (layer[..., 3] > 0) & ~solid
    out[shade, :3] = (out[shade, :3] * 0.72).astype(np.uint8)
    return out


def swap(t):
    return t.transpose(1, 0, 2)


bridge_layers = {"bridge_deck_ew": bridge_layer(tile["bridge_v"]),
                 "bridge_deck_ns": swap(bridge_layer(swap(tile["bridge_h"])))}
for i, (name, layer, water) in enumerate([
        ("river_bridge_ew", bridge_layers["bridge_deck_ew"], "river_ns"),
        ("river_bridge_ns", bridge_layers["bridge_deck_ns"], "river_ew")]):
    atlas[4 * T:5 * T, i * T:(i + 1) * T] = over(tile[water], layer)
    index.append((name, i, 4))

# Upper part of an indoor wall (no skirting board), for walls two tiles high.
upper = tile["wall_indoor"].copy()
upper[T // 2:] = upper[:T // 2]
atlas[4 * T:5 * T, 2 * T:3 * T] = upper
index.append(("wall_upper", 2, 4))
tile = {name: atlas[r * T:(r + 1) * T, c * T:(c + 1) * T] for name, c, r in index}
save(atlas, "tileset_terrain_32x32.png")
with open(os.path.join(OUT, "tileset_terrain_32x32.txt"), "w", encoding="utf-8") as f:
    f.write("tileset_terrain_32x32.png - 32x32 tiles, 10 columns x 12 rows\n")
    f.write("name, column, row (both counted from 0, top-left)\n")
    f.write("suffixes: nw n ne / w c e / sw s se = the nine parts of a patch on grass\n")
    f.write("inner_nw inner_ne inner_sw inner_se = concave corners, named by the\n")
    f.write("quadrant of the tile that is grass (the rest of the tile is the terrain)\n")
    f.write("path_narrow_<sides> = one-tile-wide path; <sides> lists the sides it joins\n")
    f.write("(n e s w), e.g. ns = straight up-down, ne = bend, nes = T, dot = no joins\n")
    f.write("path_join_<side> = edge of the wide path where a narrow path leaves that side\n")
    f.write("river_<sides> = one-tile-wide water, named the same way as path_narrow_<sides>\n")
    f.write("river_join_<side> = edge of the pond where a river leaves that side\n")
    f.write("river_bridge_ew = bridge walked east-west, use in place of river_ns\n")
    f.write("river_bridge_ns = bridge walked north-south, use in place of river_ew\n")
    f.write("wall_upper = indoor wall without the skirting board, goes above wall_indoor\n\n")
    for name, c, r in index:
        f.write(f"{name}, {c}, {r}\n")
print("terrain tiles:", len(index))



# ------------------------------------------------------ objects, buildings
def merged_spans(mask_1d, min_gap=40, min_len=15):
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


def piece_grid(a, n_rows, n_cols):
    alpha = a[..., 3] > 0
    rows = merged_spans(alpha.sum(axis=1) >= 3)
    assert len(rows) == n_rows, ("rows", rows)
    boxes = []
    for r0, r1 in rows:
        cols = merged_spans(alpha[r0:r1].sum(axis=0) >= 3)
        assert len(cols) == n_cols, ("cols", cols)
        for c0, c1 in cols:
            ys = np.flatnonzero(alpha[r0:r1, c0:c1].any(axis=1))
            boxes.append((c0, r0 + ys[0], c1, r0 + ys[-1] + 1))
    return boxes


def on_canvas(spr, min_w, min_h):
    """Bottom-centre the sprite on a canvas whose sides are multiples of T."""
    h, w = spr.shape[:2]
    cw = -(-max(w, min_w) // T) * T
    ch = -(-max(h, min_h) // T) * T
    out = np.zeros((ch, cw, 4), np.uint8)
    x = (cw - w) // 2
    out[ch - h:, x:x + w] = spr
    return out


def pack(pieces, folder, sheet_name):
    """Save each piece and one sheet with all of them in a row, plus an index."""
    names = list(pieces)
    h = max(p.shape[0] for p in pieces.values())
    w = sum(p.shape[1] for p in pieces.values())
    sheet = np.zeros((h, w, 4), np.uint8)
    lines, x = [], 0
    for n in names:
        p = pieces[n]
        save(p, folder, f"{n}.png")
        sheet[h - p.shape[0]:, x:x + p.shape[1]] = p
        lines.append(f"{n}, {x}, {h - p.shape[0]}, {p.shape[1]}, {p.shape[0]}")
        x += p.shape[1]
    save(sheet, sheet_name + ".png")
    with open(os.path.join(OUT, sheet_name + ".txt"), "w", encoding="utf-8") as f:
        f.write(f"{sheet_name}.png\nname, x, y, width, height (pixels, from top-left)\n\n")
        f.write("\n".join(lines) + "\n")
    return sheet


# name, fit width, fit height, group that shares one scale
OBJ = [("tree_round", 64, 96, "trees"), ("tree_pine", 64, 96, "trees"),
       ("tree_apple", 64, 96, "trees"), ("tree_orange", 64, 96, "trees"),
       ("bush", 32, 32, "bushes"), ("bush_berry", 32, 32, "bushes"),
       ("boulder", 32, 32, "rocks"), ("rocks", 32, 32, "rocks"),
       ("signpost", 32, 32, None), ("fence_h", 32, 32, "fence"),
       ("fence_v", 32, 32, None), ("fence_post", 32, 32, "fence"),
       ("well", 48, 64, None), ("flower_bed", 64, 32, None),
       ("crate", 32, 32, None), ("barrel", 32, 32, None)]

objects = {}
if os.path.exists(os.path.join(SRC, "tileset_objects.png")):
    a = despeckle(load("tileset_objects.png"))
    boxes = piece_grid(a, 4, 4)
    fit = [min(fw / (b[2] - b[0]), fh / (b[3] - b[1])) for b, (_, fw, fh, _) in zip(boxes, OBJ)]
    for b, (name, fw, fh, group), s in zip(boxes, OBJ, fit):
        if group:
            s = min(f for f, o in zip(fit, OBJ) if o[3] == group)
        tw, th = max(1, round((b[2] - b[0]) * s)), max(1, round((b[3] - b[1]) * s))
        objects[name] = on_canvas(reduce_palette(resample(a, b, tw, th), 20), fw, fh)
    objects.update(bridge_layers)   # the decks alone, to lay over any water tile
    obj_sheet = pack(objects, "objects", "tileset_objects")
    print("objects:", len(objects))

BLD = ["house_red", "house_teal", "lab_dome", "shop", "healing_center", "windmill"]
buildings = {}
if os.path.exists(os.path.join(SRC, "tileset_buildings.png")):
    a = despeckle(load("tileset_buildings.png"))
    boxes = piece_grid(a, 2, 3)
    s = 160 / (boxes[0][2] - boxes[0][0])          # red cottage = 5 tiles wide
    for b, name in zip(boxes, BLD):
        tw, th = round((b[2] - b[0]) * s), round((b[3] - b[1]) * s)
        buildings[name] = on_canvas(reduce_palette(resample(a, b, tw, th), 40), T, T)
    # the gym was drawn on its own sheet: one building, made six tiles wide
    if os.path.exists(os.path.join(SRC, "tileset_gym.png")):
        g = despeckle(load("tileset_gym.png"))
        gb = piece_grid(g, 1, 1)[0]
        gs = 192 / (gb[2] - gb[0])
        buildings["gym"] = on_canvas(reduce_palette(
            resample(g, gb, 192, round((gb[3] - gb[1]) * gs)), 40), T, T)
    bld_sheet = pack(buildings, "buildings", "tileset_buildings")
    print("buildings:", len(buildings), f"{1 / s:.2f} source px per pixel")

# name, fit width, fit height (each piece is scaled to fit, then bottom-centred on whole tiles)
FURN = [("bed", 32, 64), ("table", 64, 48), ("stool", 24, 26), ("bookshelf", 64, 64),
        ("shop_counter", 96, 48), ("goods_shelf", 64, 64), ("healing_machine", 64, 64),
        ("reception_desk", 96, 48), ("computer_desk", 64, 64), ("tank", 32, 64),
        ("plant", 32, 48), ("rug", 96, 64), ("door_mat", 32, 22), ("kitchen_counter", 64, 64),
        ("millstone", 64, 64), ("sacks", 32, 32)]
furniture = {}
if os.path.exists(os.path.join(SRC, "tileset_furniture.png")):
    a = despeckle(load("tileset_furniture.png"))
    for b, (name, fw, fh) in zip(piece_grid(a, 4, 4), FURN):
        s = min(fw / (b[2] - b[0]), fh / (b[3] - b[1]))
        tw, th = max(1, round((b[2] - b[0]) * s)), max(1, round((b[3] - b[1]) * s))
        furniture[name] = on_canvas(reduce_palette(resample(a, b, tw, th), 24), fw, fh)
    furn_sheet = pack(furniture, "furniture", "tileset_furniture")
    print("furniture:", len(furniture))


# ----------------------------------------------------------------- previews
def checker(arr, z, cell=16):
    big = np.kron(arr, np.ones((z, z, 1), np.uint8))
    yy, xx = np.mgrid[0:big.shape[0], 0:big.shape[1]]
    bg = np.where(((yy // cell) + (xx // cell)) % 2 == 0, 150, 175).astype(np.uint8)
    out = np.dstack([bg, bg, bg, np.full_like(bg, 255)])
    out[big[..., 3] > 0] = big[big[..., 3] > 0]
    return out


save(checker(atlas, 4), "preview_terrain_4x.png")
if furniture:
    save(checker(furn_sheet, 3), "preview_furniture_3x.png")

# Test shapes: a ring of each terrain around a grass hole uses all 13 parts.
ring = {(c, r) for c in range(1, 8) for r in range(1, 8)} - {(c, r) for c in range(3, 6) for r in range(3, 6)}
test = np.tile(canon, (18, 18, 1))
for bi, kind in enumerate(BLOCK_NAMES):
    ox, oy = 9 * (bi % 2), 9 * (bi // 2)
    for (c, r), name in autotile(kind, ring).items():
        test[(oy + r) * T:(oy + r + 1) * T, (ox + c) * T:(ox + c + 1) * T] = tile[name]
save(np.kron(test, np.ones((2, 2, 1), np.uint8)), "preview_inner_corners_2x.png")

# Test network for the narrow path: a loop with spurs (bends, T's, caps), a
# crossing, a lone tile, and a wide patch with a narrow path leaving each side.
loop = ({(c, 1) for c in range(1, 6)} | {(c, 4) for c in range(1, 6)}
        | {(1, r) for r in range(1, 5)} | {(5, r) for r in range(1, 5)})
narrow = (loop | {(3, 0), (0, 3), (3, 5), (6, 2), (7, 2), (8, 2), (7, 1), (7, 3), (10, 4)}
          | {(7, 6), (4, 9), (10, 8), (7, 11)})
wide = {(c, r) for c in range(5, 10) for r in range(7, 11)}
for kind, preview in (("path", "preview_narrow_path_3x.png"), ("pond", "preview_river_3x.png")):
    test = np.tile(canon, (12, 12, 1))
    for (c, r), name in strip_layout(kind, wide, narrow).items():
        test[r * T:(r + 1) * T, c * T:(c + 1) * T] = tile[name]
    save(np.kron(test, np.ones((3, 3, 1), np.uint8)), preview)

# Bridge test: a narrow path crossing a river both ways.
test = np.tile(canon, (5, 11, 1))
for i in range(5):
    for (c, r), name in (((2, i), "river_ns"), ((i, 2), "path_narrow_ew"),
                         ((6 + i, 2), "river_ew"), ((8, i), "path_narrow_ns")):
        test[r * T:(r + 1) * T, c * T:(c + 1) * T] = tile[name]
for (c, r), name in (((2, 2), "river_bridge_ew"), ((8, 2), "river_bridge_ns")):
    test[r * T:(r + 1) * T, c * T:(c + 1) * T] = tile[name]
save(np.kron(test, np.ones((4, 4, 1), np.uint8)), "preview_bridge_4x.png")
if objects and buildings:
    w = max(obj_sheet.shape[1], bld_sheet.shape[1])
    both = np.zeros((obj_sheet.shape[0] + bld_sheet.shape[0] + 8, w, 4), np.uint8)
    both[:obj_sheet.shape[0], :obj_sheet.shape[1]] = obj_sheet
    both[obj_sheet.shape[0] + 8:, :bld_sheet.shape[1]] = bld_sheet
    save(checker(both, 2), "preview_objects_2x.png")

# ----------------------------------------------------------------- demo map
if objects and buildings:
    MW, MH = 20, 15
    rng = np.random.default_rng(7)
    demo = np.zeros((MH * T, MW * T, 4), np.uint8)

    def put_tile(name, c, r):
        if 0 <= c < MW and 0 <= r < MH:
            demo[r * T:(r + 1) * T, c * T:(c + 1) * T] = tile[name]

    def patch(kind, c0, r0, c1, r1, open_bottom=False):
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                v = "n" if r == r0 else "s" if (r == r1 and not open_bottom) else ""
                h = "w" if c == c0 else "e" if c == c1 else ""
                put_tile(f"{kind}_{(v + h) or 'c'}", c, r)

    for r in range(MH):
        for c in range(MW):
            put_tile(rng.choice(["grass", "grass_tufts", "grass_white_flowers", "grass_color_flowers"],
                                p=[0.72, 0.16, 0.06, 0.06]), c, r)
    patch("plaza", 7, 6, 13, 9)
    # L-shaped wide path running off the map, plus a narrow path from the red
    # house's door that bends twice and joins the wide path from the north
    path_cells = ({(c, r) for c in range(9, 12) for r in range(10, 15)}
                  | {(c, r) for c in range(5, 9) for r in range(12, 15)})
    narrow_cells = {(3, 6), (3, 7), (3, 8), (4, 8), (5, 8), (6, 8), (6, 9), (6, 10), (6, 11)}
    # a second narrow path leaves the wide path westwards and crosses the river
    narrow_cells |= {(c, 13) for c in range(0, 5)}
    for (c, r), name in strip_layout("path", path_cells, narrow_cells, True, MW, MH).items():
        put_tile(name, c, r)
    # pond with a river leaving its south side and running off the map
    pond_cells = {(c, r) for c in range(1, 5) for r in range(9, 13)}
    for (c, r), name in strip_layout("pond", pond_cells, {(2, 13), (2, 14)}, True, MW, MH).items():
        put_tile(name, c, r)
    put_tile("river_bridge_ew", 2, 13)
    patch("plateau", 14, 10, 18, 12)
    for r in (13, 14):
        for c in range(14, 19):
            put_tile("tall_grass", c, r)

    spr_dir = os.path.join(SRC, "sprites")

    def sprite(*parts):
        return np.array(Image.open(os.path.join(spr_dir, *parts)).convert("RGBA"))

    # (image, left x, bottom y) drawn back to front
    things = [(buildings["house_red"], 1 * T, 6 * T), (buildings["lab_dome"], 7 * T + 8, 6 * T),
              (buildings["healing_center"], 14 * T, 6 * T),
              (objects["tree_round"], 0, 9 * T), (objects["tree_apple"], 18 * T, 9 * T),
              (objects["tree_pine"], 15 * T + 16, 9 * T), (objects["bush"], 0, 15 * T),
              (objects["tree_orange"], 12 * T, 15 * T),
              (objects["well"], 9 * T + 16, 8 * T + 8), (objects["signpost"], 8 * T, 11 * T),
              (objects["barrel"], 6 * T, 6 * T + 8), (objects["crate"], 13 * T, 6 * T + 8),
              (objects["fence_h"], 3 * T, 15 * T), (objects["fence_h"], 4 * T, 15 * T), (objects["flower_bed"], 4 * T, 7 * T + 16),
              (objects["bush_berry"], 19 * T, 13 * T), (objects["boulder"], 16 * T, 12 * T - 8),
              (sprite("hero", "hero_down_1.png"), 10 * T, 12 * T),
              (sprite("npc_researcher", "npc_researcher_down_1.png"), 8 * T, 9 * T),
              (sprite("npc_healer", "npc_healer_left_1.png"), 12 * T, 8 * T),
              (sprite("npc_rival", "npc_rival_right_2.png"), 7 * T, 14 * T),
              (sprite("monsters", "starter_fire_lamb.png"), 11 * T + 8, 13 * T)]
    for img, x, bottom in sorted(things, key=lambda t: t[2]):
        h, w = img.shape[:2]
        y = bottom - h
        y0, x0 = max(y, 0), max(x, 0)
        y1, x1 = min(y + h, demo.shape[0]), min(x + w, demo.shape[1])
        part = img[y0 - y:y1 - y, x0 - x:x1 - x]
        region = demo[y0:y1, x0:x1]
        region[part[..., 3] > 0] = part[part[..., 3] > 0]
    save(demo, "demo_map.png")
    save(np.kron(demo, np.ones((2, 2, 1), np.uint8)), "demo_map_2x.png")
    print("demo map:", demo.shape[1], "x", demo.shape[0])
