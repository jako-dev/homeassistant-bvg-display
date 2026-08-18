"""Generate HACS/brands icon for bvg_display, reusing the card's own 5x7 font."""
import pathlib
import re
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
CARD = ROOT / "custom_components" / "bvg_display" / "www" / "bvg-display-card.js"

# ---- extract FONT_5x7 from the real card so the icon matches the display ----
src = CARD.read_text(encoding="utf-8")
block = re.search(r"const FONT_5x7 = \{(.*?)\n\};", src, re.S).group(1)
FONT = {}
for m in re.finditer(r"""['"](\\u[0-9A-Fa-f]{4}|.)['"]\s*:\s*\[([^\]]+)\]""", block):
    key, vals = m.group(1), m.group(2)
    if key.startswith("\\u"):
        key = chr(int(key[2:], 16))
    FONT[key] = [int(v.strip(), 16) for v in vals.split(",") if v.strip()]

# ---- logical canvas, same coordinate style as the card ----
L = 50                      # logical size
SS = 20                     # supersample -> 1000px master
W = H = L * SS

BG_PANEL = (0, 0, 0)
FRAME = (72, 72, 72)      # light enough to hold a silhouette on dark themes
YELLOW = "#ffcc00"
ROWS = [  # (line, badge colour, badge text colour, minutes)
    ("U2", "#0060aa", "#ffffff", "3"),
    ("S7", "#008d4f", "#ffffff", "7"),
    ("M10", "#be1414", "#ffffff", "12"),
]


def draw_char(d, ch, x, y, colour, s):
    """Mirror of the card's _drawChar: 5 cols, 7 bits/col, LSB = top."""
    glyph = FONT.get(ch) or FONT.get(ch.upper()) or FONT.get("?")
    if not glyph:
        return
    for col in range(5):
        data = glyph[col]
        for row in range(7):
            if data & (1 << row):
                px, py = (x + col) * s, (y + row) * s
                d.rectangle([px, py, px + s - 1, py + s - 1], fill=colour)


def draw_text(d, text, x, y, colour, s):
    for i, ch in enumerate(text):
        draw_char(d, ch, x + i * 6, y, colour, s)


img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded panel: outer frame + inner black display
r = 8 * SS
d.rounded_rectangle([0, 0, W - 1, H - 1], radius=r, fill=FRAME)
inset = 2 * SS
d.rounded_rectangle(
    [inset, inset, W - 1 - inset, H - 1 - inset], radius=r - SS, fill=BG_PANEL
)

# three departure rows, vertically centred
row_h, gap = 7, 4
total = len(ROWS) * row_h + (len(ROWS) - 1) * gap
y0 = round((L - total) / 2)
left = 5
right = L - 5

for i, (line, badge_bg, badge_fg, mins) in enumerate(ROWS):
    y = y0 + i * (row_h + gap)
    # line badge
    bw = len(line) * 6
    d.rectangle(
        [(left - 1) * SS, (y - 1) * SS, (left + bw) * SS - 1, (y + 7) * SS - 1],
        fill=badge_bg,
    )
    draw_text(d, line, left, y, badge_fg, SS)
    # minutes, right aligned
    mx = right - len(mins) * 6
    draw_text(d, mins, mx, y, YELLOW, SS)

out_dir = ROOT / "brands"
out_dir.mkdir(exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save(out_dir / "icon@2x.png")
img.resize((256, 256), Image.LANCZOS).save(out_dir / "icon.png")
print("wrote icon.png (256) and icon@2x.png (512)")
print("glyphs available:", len(FONT))
