#!/usr/bin/env python3
"""Icône de barre de menus macOS (template) : petit orbe + éclat, noir + alpha.
Génère icon-Template.png (16 px) et icon-Template@2x.png (32 px) dans assets/."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets")

def draw(size):
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # orbe pleine (cercle plein)
    r = s * 0.32
    cx, cy = s * 0.44, s * 0.56
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(0, 0, 0, 255))
    # anneau orbital
    rw = max(1, s // 16)
    rr = r * 1.55
    bbox = (cx - rr, cy - rr, cx + rr, cy + rr)
    d.arc(bbox, start=200, end=80, fill=(0, 0, 0, 235), width=rw)
    # satellite sur l'anneau
    import math
    ang = math.radians(-20)
    sx = cx + rr * math.cos(ang)
    sy = cy + rr * math.sin(ang)
    sr = max(1.0, s * 0.07)
    d.ellipse((sx - sr, sy - sr, sx + sr, sy + sr), fill=(0, 0, 0, 255))
    return img

os.makedirs(OUT, exist_ok=True)
draw(16).save(os.path.join(OUT, "iconTemplate.png"))
draw(32).save(os.path.join(OUT, "iconTemplate@2x.png"))
print("OK →", os.path.abspath(OUT))
