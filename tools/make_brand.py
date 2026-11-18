#!/usr/bin/env python3
"""
Cut the Assam down town University logo into web assets.

    python tools/make_brand.py [path/to/logo.jpg]

Produces (in web/assets/brand/):
  adtu-logo.png      seal + "Assam down town University" wordmark, transparent
  adtu-seal.png      the round seal only (header icon), transparent outside
  adtu-tagline.png   "NAAC A+ Accredited & UGC 12(B) Status Holder" line
  favicon-32.png, favicon-192.png, apple-touch-icon.png
Requires Pillow and numpy.
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tools" / "brand" / "adtu-logo-source.jpg"
OUT = ROOT / "web" / "assets" / "brand"


def background_mask(rgb, bg, tol=28):
    """Pixels connected to the image border whose colour is close to the background."""
    h, w, _ = rgb.shape
    near = np.abs(rgb.astype(int) - bg).sum(axis=2) <= tol
    seen = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if near[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and near[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return seen


def to_rgba(rgb, bg, transparent):
    """Alpha from distance to the background colour, so edges stay anti-aliased."""
    dist = np.abs(rgb.astype(int) - bg).sum(axis=2).astype(float)
    alpha = np.clip(dist / 90.0, 0, 1)
    alpha = np.where(transparent, alpha, 1.0)
    # un-blend the light background from edge pixels
    a = np.maximum(alpha, 1e-3)[..., None]
    col = np.clip((rgb.astype(float) - bg * (1 - a)) / a, 0, 255)
    out = np.dstack([col, alpha * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def crop(rgb, box, letters_box=None):
    x0, y0, x1, y1 = box
    part = rgb[y0:y1, x0:x1]
    bg = np.array([247, 247, 247])
    transparent = background_mask(part, bg)
    if letters_box is not None:
        # letter counters (the hole in "o", "d", ...) are not connected to the border
        lx0, ly0, lx1, ly1 = letters_box
        near = np.abs(part.astype(int) - bg).sum(axis=2) <= 28
        region = np.zeros_like(near)
        region[ly0 - y0:ly1 - y0, lx0 - x0:lx1 - x0] = True
        transparent |= near & region
    return to_rgba(part, bg, transparent)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rgb = np.asarray(Image.open(SRC).convert("RGB"))
    full = crop(rgb, (258, 288, 1340, 726), letters_box=(740, 288, 1340, 726))
    full.save(OUT / "adtu-logo.png", optimize=True)
    seal = crop(rgb, (258, 288, 718, 726))
    seal.save(OUT / "adtu-seal.png", optimize=True)
    tag = crop(rgb, (100, 728, 1495, 800), letters_box=(100, 728, 1495, 800))
    tag.save(OUT / "adtu-tagline.png", optimize=True)
    # square icons from the seal
    side = max(seal.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(seal, ((side - seal.size[0]) // 2, (side - seal.size[1]) // 2), seal)
    for name, px in (("favicon-32.png", 32), ("favicon-192.png", 192)):
        sq.resize((px, px), Image.LANCZOS).save(OUT / name, optimize=True)
    touch = Image.new("RGBA", (180, 180), (255, 255, 255, 255))
    s = sq.resize((160, 160), Image.LANCZOS)
    touch.paste(s, (10, 10), s)
    touch.convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    print("brand assets written to", OUT)


if __name__ == "__main__":
    main()
