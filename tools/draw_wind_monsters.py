"""Draw the five wind monsters and their evolved forms as pixel art.

Unlike the other monsters (cut from generated sheets by slice_sprites.py), these are drawn
here from shapes: each part is filled, lit along its upper-left rim, shaded along its
lower-right rim and outlined in a dark shade of its own colour.

    python tools/draw_wind_monsters.py            # writes sprites/monsters and game/assets/monsters

Every monster comes in four images: <name>.png and <name>_back.png (64x64), and
<name>_evo1.png and <name>_evo1_back.png (72x72), like the other monsters.
"""
import math
import os
import shutil

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "sprites", "monsters")
GAME = os.path.join(ROOT, "game", "assets", "monsters")

INK = (38, 28, 44)


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


class Sprite:
    def __init__(self, size):
        self.S = size
        self.px = np.zeros((size, size, 4), np.uint8)

    # ---- masks
    def blank(self):
        return Image.new("L", (self.S, self.S), 0)

    def m(self, img):
        return np.array(img) > 0

    def ellipse(self, cx, cy, rx, ry):
        im = self.blank()
        ImageDraw.Draw(im).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255)
        return self.m(im)

    def poly(self, pts):
        im = self.blank()
        ImageDraw.Draw(im).polygon([tuple(p) for p in pts], fill=255)
        return self.m(im)

    def rect(self, x0, y0, x1, y1):
        im = self.blank()
        ImageDraw.Draw(im).rectangle([x0, y0, x1, y1], fill=255)
        return self.m(im)

    def line(self, pts, width=1):
        im = self.blank()
        ImageDraw.Draw(im).line([tuple(p) for p in pts], fill=255, width=width)
        return self.m(im)

    def arc(self, cx, cy, r, a0, a1, width=1):
        im = self.blank()
        ImageDraw.Draw(im).arc([cx - r, cy - r, cx + r, cy + r], a0, a1, fill=255, width=width)
        return self.m(im)

    # ---- painting
    def set(self, mask, col):
        self.px[mask, :3] = col
        self.px[mask, 3] = 255

    def part(self, mask, base, outline=True, shade=True):
        base = rgb(base) if isinstance(base, str) else base
        self.set(mask, base)
        if shade:
            lit = mask & ~np.roll(mask, (2, 2), axis=(0, 1))
            self.set(lit & ~edge(mask), mix(base, (255, 255, 255), 0.35))
            dark = mask & ~np.roll(mask, (-2, -2), axis=(0, 1))
            self.set(dark, mix(base, (20, 10, 40), 0.25))
        if outline:
            self.set(edge(mask), mix(base, INK, 0.72))

    def flat(self, mask, col):
        self.set(mask, rgb(col) if isinstance(col, str) else col)

    def dot(self, x, y, col):
        if 0 <= x < self.S and 0 <= y < self.S:
            self.px[y, x, :3] = rgb(col) if isinstance(col, str) else col
            self.px[y, x, 3] = 255

    def eyes(self, xs, y, big=False):
        """Rounded dark eyes with a white shine at the top left (x is the eye's left middle)."""
        w, h = (4, 5) if not big else (5, 7)
        for x in xs:
            x0, y0 = x - w // 2, y - h // 2
            for j in range(h):
                for i in range(w):
                    corner = (i in (0, w - 1)) and (j in (0, h - 1))
                    if not corner:
                        self.dot(x0 + i, y0 + j, INK)
            self.dot(x0 + 1, y0 + 1, "#ffffff")
            self.dot(x0 + 1, y0 + 2, "#ffffff")
            if big:
                self.dot(x0 + 2, y0 + 1, "#ffffff")
                self.dot(x0 + 2, y0 + 2, "#ffffff")
            self.dot(x0 + w - 2, y0 + h - 2, "#7fb6d8")

    def blush(self, xs, y):
        for x in xs:
            for dx in (-1, 0, 1):
                self.dot(x + dx, y, "#f29aa6")

    def smile(self, x, y, w=2):
        for dx in range(-w, w + 1):
            self.dot(x + dx, y + (1 if abs(dx) < w else 0), INK)
        self.dot(x, y + 2, "#e2626f")

    def save(self, name):
        img = Image.fromarray(self.px, "RGBA")
        img.save(os.path.join(OUT, name + ".png"))
        shutil.copyfile(os.path.join(OUT, name + ".png"), os.path.join(GAME, name + ".png"))


def edge(mask):
    inner = mask.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        sh = np.roll(mask, (dy, dx), axis=(0, 1))
        inner &= sh
    return mask & ~inner


def mirror(pts, cx):
    return [(2 * cx - x, y) for x, y in pts]


def wind_swirls(s, spots, col="#bfeef4"):
    for cx, cy, r in spots:
        s.flat(s.arc(cx, cy, r, 200, 350), col)


# ------------------------------------------------------------------ 1. swallow
def swallow(back):
    s = Sprite(64)
    navy, belly, red = "#2f5597", "#f5f0e1", "#d9583b"
    s.part(s.poly([(25, 44), (39, 44), (44, 60), (32, 52), (20, 60)]), navy)   # the forked tail, behind
    wing = [(21, 31), (5, 20), (4, 27), (8, 35), (13, 41), (22, 43)]
    s.part(s.poly(wing), navy)
    s.part(s.poly(mirror(wing, 32)), navy)
    s.flat(s.line([(7, 27), (14, 36)]), "#6f97d6")
    s.flat(s.line([(57, 27), (50, 36)]), "#6f97d6")
    s.part(s.ellipse(32, 39, 12, 12), navy)
    if not back:
        s.part(s.ellipse(32, 43, 8, 8), belly)
    s.flat(s.line([(29, 51), (29, 54)]), "#e0a03a")
    s.flat(s.line([(35, 51), (35, 54)]), "#e0a03a")
    s.part(s.ellipse(32, 24, 12, 11), navy)
    if back:
        s.flat(s.line([(26, 17), (38, 17)]), "#6f97d6")
        s.flat(s.line([(28, 46), (36, 46)]), "#22427a")
    else:
        s.part(s.ellipse(32, 32, 5, 2), red, shade=False)
        s.eyes([26, 38], 23)
        s.part(s.poly([(30, 27), (34, 27), (32, 30)]), "#f0c04a", shade=False)
        s.blush([23, 41], 28)
    wind_swirls(s, [(8, 14, 4), (56, 14, 4), (10, 52, 3)])
    return s


def swallow2(back):
    s = Sprite(72)
    navy, belly, red, teal = "#284a8c", "#f5f0e1", "#d24b33", "#46b7c4"
    s.part(s.poly([(27, 48), (45, 48), (54, 71), (36, 57), (18, 71)]), navy)   # long tail streamers
    s.flat(s.line([(24, 64), (31, 55)]), teal)
    s.flat(s.line([(48, 64), (41, 55)]), teal)
    wing = [(24, 34), (1, 8), (2, 18), (5, 28), (10, 37), (16, 44), (28, 46)]
    s.part(s.poly(wing), navy)
    s.part(s.poly(mirror(wing, 36)), navy)
    for w in ([(4, 18), (12, 33)], [(7, 15), (17, 32)]):
        s.flat(s.line(w), teal)
        s.flat(s.line(mirror(w, 36)), teal)
    s.part(s.ellipse(36, 43, 14, 14), navy)
    if not back:
        s.part(s.ellipse(36, 47, 9, 9), belly)
    s.flat(s.line([(32, 57), (32, 60)], 2), "#e0a03a")
    s.flat(s.line([(40, 57), (40, 60)], 2), "#e0a03a")
    for c in ([(29, 18), (31, 5), (35, 16)], [(34, 16), (38, 3), (40, 17)], [(39, 17), (44, 8), (43, 19)]):
        s.part(s.poly(c), teal)
    s.part(s.ellipse(36, 27, 13, 12), navy)
    if back:
        s.flat(s.line([(29, 20), (43, 20)]), teal)
        s.flat(s.line([(31, 50), (41, 50)]), "#1d3a70")
    else:
        s.part(s.ellipse(36, 36, 6, 2), red, shade=False)
        s.eyes([30, 42], 26, big=True)
        for x, y in ((26, 21), (27, 21), (28, 22), (46, 21), (45, 21), (44, 22)):
            s.dot(x, y, INK)
        s.part(s.poly([(33, 30), (39, 30), (36, 34)]), "#f0c04a", shade=False)
    wind_swirls(s, [(8, 50, 5), (64, 50, 5), (14, 60, 3), (58, 60, 3)])
    return s


# ------------------------------------------------------------------ 2. flying squirrel
def squirrel(back):
    s = Sprite(64)
    fur, light, cream = "#b9773d", "#dca063", "#f6e2bf"
    s.part(s.ellipse(48, 27, 11, 15), fur)
    s.part(s.ellipse(49, 26, 5, 9), light, outline=False)
    s.part(s.poly([(9, 31), (55, 31), (57, 46), (45, 50), (32, 47), (19, 50), (7, 46)]), light)
    s.part(s.ellipse(32, 41, 11, 12), fur)
    if not back:
        s.part(s.ellipse(32, 44, 7, 8), cream)
    s.part(s.ellipse(26, 55, 4, 3), fur)
    s.part(s.ellipse(38, 55, 4, 3), fur)
    for ear in ((22, 14), (42, 14)):
        s.part(s.ellipse(ear[0], ear[1], 4, 5), fur)
        if not back:
            s.flat(s.ellipse(ear[0], ear[1] + 1, 1, 2), "#f2a7a0")
    s.part(s.ellipse(32, 25, 13, 11), fur)
    if back:
        s.flat(s.line([(32, 17), (32, 34)]), "#8f5a2a")
    else:
        s.part(s.ellipse(32, 30, 6, 4), cream, shade=False)
        s.eyes([26, 38], 23)
        s.flat(s.ellipse(32, 28, 1, 1), INK)
        s.smile(32, 30, 1)
        s.blush([21, 43], 28)
    wind_swirls(s, [(8, 22, 4), (12, 56, 3)])
    return s


def squirrel2(back):
    s = Sprite(72)
    fur, light, cream, trim, scarf = "#a8682f", "#d49456", "#f6e2bf", "#dff3f6", "#3aa6b4"
    s.part(s.ellipse(56, 26, 13, 18), fur)
    s.part(s.ellipse(57, 25, 6, 11), light, outline=False)
    cape = [(3, 28), (69, 28), (71, 52), (58, 60), (46, 55), (36, 59), (26, 55), (14, 60), (1, 52)]
    s.part(s.poly(cape), trim)
    s.part(s.poly([(6, 30), (66, 30), (67, 50), (57, 56), (46, 52), (36, 56), (26, 52), (15, 56), (5, 50)]), light, outline=False)
    s.part(s.ellipse(36, 46, 12, 14), fur)
    if not back:
        s.part(s.ellipse(36, 49, 8, 9), cream)
    s.part(s.ellipse(30, 62, 4, 3), fur)
    s.part(s.ellipse(42, 62, 4, 3), fur)
    for ex in (24, 48):
        s.part(s.poly([(ex - 5, 18), (ex, 4), (ex + 5, 18)]), fur)
        s.flat(s.line([(ex, 4), (ex, 1)]), "#5b3a1c")
    s.part(s.ellipse(36, 26, 14, 12), fur)
    s.part(s.ellipse(36, 37, 11, 3), scarf)
    s.part(s.poly([(44, 37), (60, 44), (58, 48), (42, 40)]), scarf)
    if back:
        s.flat(s.line([(36, 17), (36, 34)]), "#7c4a1f")
    else:
        s.part(s.ellipse(36, 31, 6, 4), cream, shade=False)
        s.eyes([29, 43], 24, big=True)
        s.flat(s.ellipse(36, 29, 1, 1), INK)
        s.smile(36, 31, 2)
    wind_swirls(s, [(10, 16, 5), (62, 64, 4)])
    return s


# ------------------------------------------------------------------ 3. cloud
def cloud_mask(s, puffs):
    m = np.zeros((s.S, s.S), bool)
    for cx, cy, r in puffs:
        m |= s.ellipse(cx, cy, r, r)
    return m


def cloud(back):
    s = Sprite(64)
    m = cloud_mask(s, [(21, 39, 10), (43, 39, 10), (32, 31, 13), (32, 43, 11), (13, 45, 7), (51, 45, 7)])
    s.part(m, "#f3f8ff")
    s.flat(m & s.rect(0, 50, 63, 63) & ~edge(m), "#cfdcef")
    s.flat(s.arc(32, 15, 3, 180, 450), "#9fd8e6")
    if back:
        s.flat(s.arc(26, 36, 5, 200, 320), "#cfdcef")
        s.flat(s.arc(40, 34, 5, 200, 320), "#cfdcef")
    else:
        s.eyes([26, 38], 35)
        s.blush([22, 42], 40)
        s.smile(32, 40, 2)
    wind_swirls(s, [(5, 30, 3), (59, 30, 3), (6, 56, 3), (58, 56, 3)])
    return s


def cloud2(back):
    s = Sprite(72)
    m = cloud_mask(s, [(22, 40, 12), (50, 40, 12), (36, 29, 15), (36, 45, 14), (11, 48, 8), (61, 48, 8), (36, 18, 8)])
    s.part(m, "#eef4fc")
    s.flat(m & s.rect(0, 52, 71, 71) & ~edge(m), "#aebfd9")
    for hx in (7, 64):
        s.part(cloud_mask(s, [(hx, 60, 5), (hx + (3 if hx < 36 else -3), 63, 4)]), "#dfe8f6")
    for r, col in ((9, "#5fc3d3"), (6, "#8fd8e3"), (3, "#c3eef4")):
        s.flat(s.arc(36, 12, r, 180, 360, 2), col)
    if back:
        s.flat(s.arc(28, 36, 6, 200, 320), "#c4d2e8")
        s.flat(s.arc(45, 33, 6, 200, 320), "#c4d2e8")
    else:
        s.eyes([29, 43], 36, big=True)
        for x, y in ((25, 30), (26, 30), (27, 31), (47, 30), (46, 30), (45, 31)):
            s.dot(x, y, "#6d7f9c")
        s.blush([24, 48], 42)
        s.smile(36, 43, 2)
    wind_swirls(s, [(4, 32, 4), (68, 32, 4), (8, 68, 3), (64, 68, 3)])
    return s


# ------------------------------------------------------------------ 4. wind chime
def chime(back):
    s = Sprite(64)
    glass, rim, paper = "#86d3dc", "#5bb0bd", "#f4ead0"
    s.flat(s.line([(32, 1), (32, 9)]), "#6b5a4a")
    s.part(s.ellipse(32, 23, 14, 15) & s.rect(0, 0, 63, 33), glass)
    s.part(s.ellipse(32, 33, 15, 3), rim)
    if not back:
        for x, y in ((22, 17), (42, 17), (24, 27), (40, 27)):
            s.flat(s.ellipse(x, y, 1, 1), "#e0636d")
    s.part(s.ellipse(32, 38, 3, 3), "#e6b740")
    s.flat(s.line([(32, 41), (33, 44)]), "#6b5a4a")
    strip = [(29, 44), (37, 44), (41, 61), (33, 61)]
    s.part(s.poly(strip), paper)
    s.flat(s.poly([(30, 48), (38, 48), (38, 50), (30, 50)]) & s.poly(strip) & ~edge(s.poly(strip)), "#d9554f")
    if not back:
        s.eyes([26, 38], 22)
        s.blush([22, 42], 27)
        s.smile(32, 27, 2)
    else:
        s.flat(s.line([(20, 22), (44, 22)]), "#a7e3ea")
    wind_swirls(s, [(8, 40, 4), (56, 44, 4), (12, 56, 3)])
    return s


def chime2(back):
    s = Sprite(72)
    gold, band, paper, glass = "#e2b13c", "#3fa7b4", "#f4ead0", "#86d3dc"
    s.part(s.poly([(34, 2), (36, 0), (38, 2), (39, 8), (33, 8)]), gold)
    bell = (s.ellipse(36, 24, 18, 17) & s.rect(0, 0, 71, 32)) | s.poly([(16, 30), (56, 30), (61, 39), (11, 39)])
    s.part(bell, gold)
    s.flat(s.rect(13, 33, 59, 35) & bell & ~edge(bell), band)
    s.part(s.ellipse(36, 40, 24, 3), "#c4952c")
    for hx, hy in ((17, 50), (36, 53), (55, 50)):
        s.flat(s.line([(hx, 42), (hx, hy - 5)]), "#6b5a4a")
        s.part(s.ellipse(hx, hy, 5, 5) & s.rect(0, 0, 71, hy + 1), glass)
        s.part(s.ellipse(hx, hy + 1, 6, 1), "#5bb0bd")
        st = [(hx - 2, hy + 3), (hx + 2, hy + 3), (hx + 5, 71), (hx + 1, 71)]
        s.part(s.poly(st), paper)
        s.flat(s.rect(hx - 1, hy + 8, hx + 4, hy + 9) & s.poly(st), "#d9554f")
    if not back:
        s.eyes([29, 43], 21, big=True)
        for x, y in ((25, 15), (26, 15), (27, 16), (47, 15), (46, 15), (45, 16)):
            s.dot(x, y, "#8a5d14")
        s.blush([24, 48], 27)
        s.smile(36, 26, 2)
    else:
        s.flat(s.line([(22, 20), (50, 20)]), "#f2d17a")
    wind_swirls(s, [(5, 20, 4), (67, 20, 4), (4, 60, 3), (68, 60, 3)])
    return s


# ------------------------------------------------------------------ 5. pinwheel fox
def pinwheel(s, cx, cy, r, blades, cols):
    for i in range(blades):
        a = 2 * math.pi * i / blades
        b = a + 2 * math.pi / blades * 0.9
        p1 = (cx + r * math.cos(a), cy + r * math.sin(a))
        p2 = (cx + r * 0.55 * math.cos(b), cy + r * 0.55 * math.sin(b))
        s.part(s.poly([(cx, cy), p1, p2]), cols[i % len(cols)])
    s.part(s.ellipse(cx, cy, 2, 2), "#f5e7b8")


def fox(back):
    s = Sprite(64)
    fur, mark, cream = "#e6f2ef", "#56b2ac", "#fff9ec"
    s.part(s.poly([(36, 50), (40, 34), (46, 26), (50, 30), (44, 40), (42, 52)]), fur)
    pinwheel(s, 48, 19, 13, 4, ["#e0636d", "#f2c84b", "#56b2ac", "#8f7fd6"])
    s.part(s.ellipse(29, 45, 12, 12), fur)
    if not back:
        s.part(s.ellipse(29, 48, 7, 7), cream)
    s.part(s.ellipse(23, 57, 4, 3), mark)
    s.part(s.ellipse(35, 57, 4, 3), mark)
    for ear in ([(18, 24), (16, 8), (27, 19)], [(40, 24), (42, 8), (31, 19)]):
        s.part(s.poly(ear), fur)
        if not back:
            tip = s.poly(ear) & s.rect(0, 0, 63, 13)
            s.flat(tip, mark)
    s.part(s.ellipse(29, 28, 12, 10), fur)
    if back:
        s.flat(s.line([(29, 21), (29, 36)]), mark)
        s.flat(s.line([(26, 40), (32, 40)]), mark)
    else:
        s.part(s.ellipse(29, 33, 5, 3), cream, shade=False)
        s.flat(s.line([(17, 26), (20, 28)]), mark)
        s.flat(s.line([(41, 26), (38, 28)]), mark)
        s.eyes([24, 34], 27)
        s.flat(s.ellipse(29, 31, 1, 1), INK)
        s.smile(29, 33, 1)
    wind_swirls(s, [(6, 40, 4), (58, 44, 4)])
    return s


def fox2(back):
    s = Sprite(72)
    fur, mark, cream, ruff = "#e2f0ed", "#3f9f9a", "#fff9ec", "#ffffff"
    s.part(s.poly([(38, 58), (44, 40), (52, 28), (57, 32), (50, 46), (46, 60)]), fur)
    pinwheel(s, 52, 20, 19, 6, ["#e0636d", "#f2c84b", "#56b2ac", "#8f7fd6", "#f29a5a", "#6fc3e6"])
    s.part(s.ellipse(30, 50, 13, 13), fur)
    s.part(s.poly([(19, 52), (17, 70), (24, 70), (25, 56)]), fur)
    s.part(s.poly([(41, 52), (43, 70), (36, 70), (35, 56)]), fur)
    s.flat(s.line([(18, 66), (24, 66)]), mark)
    s.flat(s.line([(37, 66), (43, 66)]), mark)
    s.part(cloud_mask(s, [(20, 40, 5), (26, 43, 5), (34, 43, 5), (40, 40, 5), (30, 44, 5)]), ruff)
    for ear in ([(17, 24), (12, 3), (26, 17)], [(43, 24), (48, 3), (34, 17)]):
        s.part(s.poly(ear), fur)
        if not back:
            s.flat(s.poly(ear) & s.rect(0, 0, 71, 10), mark)
    s.part(s.ellipse(30, 28, 13, 11), fur)
    if back:
        s.flat(s.line([(30, 19), (30, 36)]), mark)
    else:
        s.part(s.ellipse(30, 34, 6, 3), cream, shade=False)
        s.flat(s.line([(17, 25), (21, 28)]), mark)
        s.flat(s.line([(43, 25), (39, 28)]), mark)
        s.eyes([24, 36], 27, big=True)
        for x, y in ((20, 21), (21, 21), (22, 22), (40, 21), (39, 21), (38, 22)):
            s.dot(x, y, INK)
        s.flat(s.ellipse(30, 32, 1, 1), INK)
        s.smile(30, 34, 2)
    wind_swirls(s, [(5, 50, 5), (66, 56, 4), (8, 66, 3)])
    return s


MONSTERS = {
    "wild_wind_swallow": (swallow, swallow2),
    "wild_wind_squirrel": (squirrel, squirrel2),
    "wild_wind_cloud": (cloud, cloud2),
    "wild_wind_chime": (chime, chime2),
    "wild_wind_fox": (fox, fox2),
}

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(GAME, exist_ok=True)
    for name, (base, evo) in MONSTERS.items():
        base(False).save(name)
        base(True).save(name + "_back")
        evo(False).save(name + "_evo1")
        evo(True).save(name + "_evo1_back")
    print("wrote", len(MONSTERS) * 4, "images")
