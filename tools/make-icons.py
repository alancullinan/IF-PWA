#!/usr/bin/env python3
"""
Generate the app icon set.

No image library is assumed to be present, so this writes PNGs directly with
zlib + struct. The mark is the timer ring: an open arc on the app's ground
colour, drawn with 4x4 supersampling per pixel for clean edges.

Icons are full-bleed (no rounded corners) because the manifest declares them
"maskable any" - the OS applies its own mask, and a pre-rounded square inside
that mask reads as a shrunken sticker. The ring therefore stays inside the
maskable safe zone: a circle of 80% width, i.e. radius 0.4 * size from centre.

Run:  python3 tools/make-icons.py
"""

import math
import struct
import zlib
from pathlib import Path

BG = (0x12, 0x14, 0x2A)      # --bg
FG = (0xFF, 0xB3, 0x7A)      # --accent

R_OUTER = 0.330              # fractions of icon size; both inside the 0.40 safe zone
R_INNER = 0.246
SWEEP = 0.80                 # fraction of the circle drawn, matching the timer ring
SS = 4                       # supersampling factor per axis

SIZES = [72, 96, 128, 144, 152, 180, 192, 384, 512]
OUT = Path(__file__).resolve().parent.parent / "icons"


def coverage(px, py, size):
    """Fraction of one pixel covered by the ring, via SS x SS supersampling."""
    r_out, r_in = R_OUTER * size, R_INNER * size
    cx = cy = size / 2.0
    r_mid, r_cap = (r_out + r_in) / 2.0, (r_out - r_in) / 2.0
    max_ang = SWEEP * 2.0 * math.pi

    # Round caps: centres of the circles closing each end of the arc.
    caps = []
    for ang in (0.0, max_ang):
        caps.append((cx + r_mid * math.sin(ang), cy - r_mid * math.cos(ang)))

    hits = 0
    for sy in range(SS):
        y = py + (sy + 0.5) / SS
        for sx in range(SS):
            x = px + (sx + 0.5) / SS
            dx, dy = x - cx, y - cy
            d = math.hypot(dx, dy)
            if r_in <= d <= r_out:
                # atan2(dx, -dy) puts 0 at 12 o'clock and increases clockwise.
                ang = math.atan2(dx, -dy)
                if ang < 0:
                    ang += 2.0 * math.pi
                if ang <= max_ang:
                    hits += 1
                    continue
            if any(math.hypot(x - ccx, y - ccy) <= r_cap for ccx, ccy in caps):
                hits += 1
    return hits / (SS * SS)


def render(size):
    """Return raw RGBA scanlines, each prefixed with PNG filter byte 0."""
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            a = coverage(px, py, size)
            if a <= 0.0:
                rows.extend((BG[0], BG[1], BG[2], 255))
            else:
                rows.extend((
                    round(BG[0] + (FG[0] - BG[0]) * a),
                    round(BG[1] + (FG[1] - BG[1]) * a),
                    round(BG[2] + (FG[2] - BG[2]) * a),
                    255,
                ))
    return bytes(rows)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(render(size), 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    return len(png)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for s in SIZES:
        name = "apple-touch-icon.png" if s == 180 else f"icon-{s}x{s}.png"
        n = write_png(OUT / name, s)
        print(f"  {name:24} {s}x{s}  {n:>7,} bytes")
