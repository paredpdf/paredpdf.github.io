"""Draws the app icons in icons/ (run: python3 scripts/icons.py).

The mark is the logo from the page header: a dashed landscape sheet with
the real (portrait) page in orange. "Maskable" icons keep the mark inside
the central safe zone so Android can crop them to any shape.
"""
from pathlib import Path
from PIL import Image, ImageDraw

BG, INK, ACCENT = (244, 242, 238), (95, 91, 84), (210, 85, 31)
OUT = Path(__file__).resolve().parent.parent / 'icons'


def dashed_rect(d, box, width, dash, gap, fill):
    x0, y0, x1, y1 = box
    for (ax, ay, bx, by) in [(x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)]:
        length = abs(bx - ax) + abs(by - ay)
        dx, dy = (bx - ax) / length, (by - ay) / length
        t = 0
        while t < length:
            e = min(t + dash, length)
            d.line([(ax + dx * t, ay + dy * t), (ax + dx * e, ay + dy * e)], fill=fill, width=width)
            t += dash + gap


def icon(size, scale, rounded):
    s = 4  # supersample for smooth edges
    W = size * s
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=BG)
    else:
        d.rectangle([0, 0, W, W], fill=BG)
    u = W * scale / 32  # the header logo is drawn on a 32-unit grid
    ox = oy = (W - 32 * u) / 2
    P = lambda x, y: (ox + x * u, oy + y * u)
    dashed_rect(d, [*P(2, 7), *P(30, 25)], int(2 * u), 3 * u, 2.5 * u, INK)
    d.rounded_rectangle([*P(11, 3), *P(21, 29)], radius=int(1.5 * u), fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
icon(192, 0.82, True).save(OUT / 'icon-192.png')
icon(512, 0.82, True).save(OUT / 'icon-512.png')
icon(512, 0.62, False).save(OUT / 'icon-maskable-512.png')
icon(180, 0.78, False).convert('RGB').save(OUT / 'apple-touch-icon.png')
print('wrote', ', '.join(sorted(p.name for p in OUT.glob('*.png'))))
