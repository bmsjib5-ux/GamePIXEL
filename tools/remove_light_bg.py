"""Make a light, glowing backdrop transparent.

Usage: python remove_light_bg.py <in.png> <out.png>

Starting from the image border, flood through pixels that are already transparent or that
are light and nearly grey (the backdrop and its glow). Sprites have a dark outline, so the
fill stops there and light colours inside a sprite (white walls, umbrellas) are kept.
"""
import sys
from collections import deque

import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
a = np.array(Image.open(src).convert("RGBA"))
rgb = a[..., :3].astype(int)
light = (rgb.min(axis=2) >= 150) & (rgb.max(axis=2) - rgb.min(axis=2) <= 70)
passable = (a[..., 3] < 128) | light
h, w = passable.shape
bg = np.zeros((h, w), bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if passable[y, x] and not bg[y, x]:
            bg[y, x] = True
            q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if passable[y, x] and not bg[y, x]:
            bg[y, x] = True
            q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        yy, xx = y + dy, x + dx
        if 0 <= yy < h and 0 <= xx < w and passable[yy, xx] and not bg[yy, xx]:
            bg[yy, xx] = True
            q.append((yy, xx))
# soft glow pixels hugging the outline: light-ish and bordering the backdrop
glow = (rgb.min(axis=2) >= 120) & (rgb.max(axis=2) - rgb.min(axis=2) <= 90) & ~bg
near = np.zeros_like(bg)
near[1:] |= bg[:-1]; near[:-1] |= bg[1:]; near[:, 1:] |= bg[:, :-1]; near[:, :-1] |= bg[:, 1:]
bg |= glow & near
a[bg] = 0
a[~bg, 3] = 255
Image.fromarray(a).save(dst)
print(f"{dst}: backdrop {bg.mean():.0%} of the image")
