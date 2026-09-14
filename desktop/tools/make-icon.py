#!/usr/bin/env python3
"""Génère l'icône de l'app Nova (orbe violette, style macOS)."""
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# Fond : carré arrondi macOS (marge 10 %) avec dégradé vertical clair
margin = int(SIZE * 0.10)
box = (margin, margin, SIZE - margin, SIZE - margin)
radius = int((box[2] - box[0]) * 0.225)

base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
grad = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
top, bottom = (250, 250, 255, 255), (232, 231, 248, 255)
for y in range(box[1], box[3]):
    t = (y - box[1]) / max(1, box[3] - box[1])
    c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(4))
    gd.line([(box[0], y), (box[2], y)], fill=c)
mask = Image.new("L", (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle(box, radius=radius, fill=255)
base.paste(grad, (0, 0), mask)

# Orbe central : dégradé radial violet → bleu + reflet clair
cx, cy = SIZE // 2, SIZE // 2 + 20
r = int(SIZE * 0.30)
orb = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
od = ImageDraw.Draw(orb)
for i in range(r, 0, -2):
    t = i / r
    col = (int(90 + 40 * (1 - t)), int(70 + 30 * (1 - t)), int(246 - 10 * t), 255)
    od.ellipse((cx - i, cy - i, cx + i, cy + i), fill=col)
orb_mask = Image.new("L", (SIZE, SIZE), 0)
omd = ImageDraw.Draw(orb_mask)
omd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
orb.putalpha(orb_mask)
base = Image.alpha_composite(base, orb)

# Reflet : petite ellipse floue en haut à gauche de l'orbe
glint = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gld = ImageDraw.Draw(glint)
gld.ellipse((cx - r * 0.45, cy - r * 0.72, cx - r * 0.05, cy - r * 0.30), fill=(255, 255, 255, 215))
glint = glint.filter(ImageFilter.GaussianBlur(18))
base = Image.alpha_composite(base, glint)

# Deux satellites (comme l'interface) + un anneau discret
ring = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
rr = int(r * 1.55)
rd.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=(124, 108, 255, 60), width=int(SIZE * 0.008))
ring = ring.filter(ImageFilter.GaussianBlur(2))
base = Image.alpha_composite(base, ring)
for ang, sat_r in ((210, 14), (330, 10)):
    import math
    ax = cx + int(rr * math.cos(math.radians(ang)))
    ay = cy + int(rr * math.sin(math.radians(ang)))
    sd = ImageDraw.Draw(base)
    sd.ellipse((ax - sat_r, ay - sat_r, ax + sat_r, ay + sat_r), fill=(124, 108, 255, 235))

img = base
out_png = os.path.join(HERE, "..", "assets", "icon.png")
os.makedirs(os.path.dirname(out_png), exist_ok=True)
img.save(out_png)

# iconset pour .icns
iconset = os.path.join(HERE, "Nova.iconset")
os.makedirs(iconset, exist_ok=True)
for s in (16, 32, 64, 128, 256, 512, 1024):
    img.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}.png"))
    if s <= 512:
        img.resize((s * 2, s * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{s}x{s}@2x.png"))
print("icon.png + iconset OK ->", os.path.abspath(out_png))
