#!/usr/bin/env python3
"""
gen_placeholders.py  -  Phase 1 seed-image generator for the portfolio galleries.

Generates throwaway .jpg placeholder images in varied aspect ratios so the image
gallery can be built and tested before real photos arrive. These are stand-ins;
they get replaced with real screenshots later, and this script (plus img/seed/)
can be retired at that point.

Design notes:
  * Output goes to <repo>/img/seed/ , named "<slug>-<NN>.jpg".
  * Each image is a flat, distinctly tinted panel with a thin inner border and,
    when big enough, a centered label showing its pixel size and which project
    slot it fills, so every image is easy to tell apart in the gallery, the
    circle thumbnails, and the next-image preview.
  * No project-specific branding is baked in: the CSS holder carries the brand
    look now, not the image.
  * Re-runnable: it overwrites its own output.

Requires Pillow (PIL). On this machine: run with the Windows py launcher, e.g.
    py tools/gen_placeholders.py
If Pillow is missing, install it with:  py -m pip install Pillow
"""

import colorsys
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit(
        "Pillow is required. Install it with:  py -m pip install Pillow\n"
        "(Phase 1 plan allows a .png fallback, but generating any image needs Pillow.)"
    )

# ----------------------------------------------------------------------------
# CONFIG: per-project image sizes. Counts are spread 1..5 on purpose so we can
# see single-image, few-image, and fuller galleries (and the auto-hide of arrows
# and circles at a count of 1). Ratios cover 16:9, 1:1, 2:1, 3:1, 1:3, and a tiny
# 32x32, so the "contain with padding" behaviour is visible across shapes.
# ----------------------------------------------------------------------------
PROJECTS = {
    "forerunner": [(1600, 900), (1600, 800), (1200, 1200)],                       # 16:9, 2:1, 1:1
    "phillips":   [(1600, 900), (1200, 1200)],                                    # 16:9, 1:1
    "planetarium":[(1600, 900), (1500, 500), (1200, 1200), (600, 1800)],          # 16:9, 3:1, 1:1, 1:3
    "cognition-vr":[(1600, 900), (1200, 1200), (1600, 800)],                     # 16:9, 1:1, 2:1
    "blockade":   [(1600, 900)],                                                  # 16:9 (single image)
    "aitooling":  [(1600, 900), (1200, 1200), (1600, 800), (600, 1800), (32, 32)],# 16:9, 1:1, 2:1, 1:3, 32x32
}

OUTPUT_SUBDIR = os.path.join("img", "seed")
JPEG_QUALITY = 86

# A few common font locations to try for nicer scalable labels; falls back to
# Pillow's tiny built-in bitmap font if none are found.
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def repo_root():
    """This script lives in <repo>/tools/ , so the repo root is its parent dir."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_font(px):
    px = max(10, int(px))
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px)
            except OSError:
                continue
    return ImageFont.load_default()


def tint_for(index, total):
    """Evenly spaced, pleasant hues so every seed image is visually distinct."""
    hue = (index / max(1, total)) % 1.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.42, 0.82)
    return (int(r * 255), int(g * 255), int(b * 255))


def draw_centered(draw, text, font, box, fill):
    """Center multiline text within (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = box
    try:
        tb = draw.multiline_textbbox((0, 0), text, font=font, align="center", spacing=6)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
    except AttributeError:  # very old Pillow
        tw, th = draw.multiline_textsize(text, font=font, spacing=6)
    cx = x0 + (x1 - x0 - tw) / 2
    cy = y0 + (y1 - y0 - th) / 2
    draw.multiline_text((cx, cy), text, font=font, fill=fill, align="center", spacing=6)


def make_image(slug, index_in_project, size, hue_index, hue_total):
    w, h = size
    base = tint_for(hue_index, hue_total)
    img = Image.new("RGB", (w, h), base)
    draw = ImageDraw.Draw(img)

    # Thin inner border, a touch darker than the fill.
    border = tuple(max(0, c - 45) for c in base)
    inset = max(1, min(w, h) // 64)
    draw.rectangle([inset, inset, w - inset - 1, h - inset - 1], outline=border, width=max(1, inset // 2))

    # Label only when there is room; a 32x32 stays a clean tinted chip.
    if min(w, h) >= 96:
        font_big = load_font(min(w, h) / 7)
        font_small = load_font(min(w, h) / 14)
        text_fill = (255, 255, 255)
        label = "%dx%d" % (w, h)
        sub = "%s #%02d" % (slug, index_in_project)
        pad = inset * 3
        # Main size label centered.
        draw_centered(draw, label, font_big, (pad, pad, w - pad, h - pad), text_fill)
        # Sub label near the bottom.
        try:
            tb = draw.textbbox((0, 0), sub, font=font_small)
            sw, sh = tb[2] - tb[0], tb[3] - tb[1]
        except AttributeError:
            sw, sh = draw.textsize(sub, font=font_small)
        draw.text(((w - sw) / 2, h - pad - sh), sub, font=font_small, fill=(255, 255, 255))

    return img


def main():
    out_dir = os.path.join(repo_root(), OUTPUT_SUBDIR)
    os.makedirs(out_dir, exist_ok=True)

    total = sum(len(v) for v in PROJECTS.values())
    made = []
    hue_index = 0
    for slug, sizes in PROJECTS.items():
        for i, size in enumerate(sizes, start=1):
            img = make_image(slug, i, size, hue_index, total)
            hue_index += 1
            name = "%s-%02d.jpg" % (slug, i)
            path = os.path.join(out_dir, name)
            img.save(path, "JPEG", quality=JPEG_QUALITY)
            made.append((name, size))

    print("Wrote %d seed images to %s" % (len(made), out_dir))
    for name, (w, h) in made:
        print("  %-18s %dx%d" % (name, w, h))


if __name__ == "__main__":
    main()
