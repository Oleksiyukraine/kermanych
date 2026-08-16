#!/usr/bin/env python3
"""Generate the Kermanych app-icon set from design/icon-prompt.svg ("Промпт").

The mark is three primitives (dark field, red chevron, off-white cursor), so we
rasterize it directly with an anti-aliased scanline fill — no SVG engine and no
third-party dependencies. PNG and ICO are written by hand (zlib + struct); the
macOS .icns is packed by `iconutil` from a generated .iconset.

Palette is fixed by the design: field #12110f, chevron #ff563c, cursor #f3f2f2.
Rounding: every raster target gets a generous iOS-style squircle — a smooth
continuous-curvature (superellipse) corner (see SQUIRCLE_CORNER) with
transparent corners baked in. The source <rect> stays square; mask lives here.

Run:  python3 scripts/gen-icons.py
"""
from __future__ import annotations

import math
import re
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "design" / "icon-prompt.svg"
UI = ROOT / "apps" / "ui"
PUB = UI / "public"
PUB_ICONS = PUB / "icons"
ELECTRON_ICONS = UI / "src-electron" / "icons"

CANVAS = 1024.0            # source viewBox size
SQUIRCLE_CORNER = 0.34     # corner radius ratio — rounder than Apple's 22.37% grid, by design
SQUIRCLE_N = 3.5           # superellipse exponent → smooth iOS-style continuous-curvature corners


# ── SVG source parsing ─────────────────────────────────────────────────────
def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


class Shapes:
    def __init__(self, bg, chevron, chevron_fill, cursor, cursor_fill):
        self.bg = bg                      # rgb of the field
        self.chevron = chevron            # [(x, y)] polygon in canvas space
        self.chevron_fill = chevron_fill
        self.cursor = cursor              # [(x, y)] rectangle corners
        self.cursor_fill = cursor_fill


def _attr(s: str, name: str, default: str | None = None) -> str | None:
    m = re.search(rf'{name}\s*=\s*"([^"]*)"', s)
    return m.group(1) if m else default


def parse_path(d: str) -> list[tuple[float, float]]:
    """Absolute M/L/Z polylines only — all this mark needs."""
    toks = re.findall(r"[MLZmlz]|-?\d+\.?\d*", d)
    pts: list[tuple[float, float]] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in "MLml":
            i += 1
            continue
        if t in "Zz":
            break
        pts.append((float(toks[i]), float(toks[i + 1])))
        i += 2
    return pts


def parse_svg(path: Path) -> Shapes:
    text = path.read_text(encoding="utf-8")
    bg = cursor = cursor_fill = chevron = chevron_fill = None

    for r in re.findall(r"<rect\b([^>]*?)/?>", text):
        w = float(_attr(r, "width", "0"))
        h = float(_attr(r, "height", "0"))
        x = float(_attr(r, "x", "0"))
        y = float(_attr(r, "y", "0"))
        fill = _attr(r, "fill", "#000000")
        if w >= CANVAS and h >= CANVAS and x == 0 and y == 0:
            bg = hex_to_rgb(fill)
        else:
            cursor = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
            cursor_fill = hex_to_rgb(fill)

    for p in re.findall(r"<path\b([^>]*?)/?>", text):
        pts = parse_path(_attr(p, "d", ""))
        if pts:
            chevron, chevron_fill = pts, hex_to_rgb(_attr(p, "fill", "#000000"))

    if not (bg and cursor and chevron):
        sys.exit(f"gen-icons: could not parse all shapes from {path}")
    return Shapes(bg, chevron, chevron_fill, cursor, cursor_fill)


# ── geometry ────────────────────────────────────────────────────────────────
def squircle(size: float, r: float, seg: int = 64) -> list[tuple[float, float]]:
    """Rounded rect with iOS continuous-curvature (superellipse) corners.

    Straight edges, but each corner follows |x/r|^n + |y/r|^n = 1 rather than a
    circular arc (n == 2). SQUIRCLE_N > 2 spreads the curvature the way Apple's
    icon grid does, so corners read as an iOS squircle, not a rounded rectangle.
    """
    r = min(r, size / 2)
    p = 2.0 / SQUIRCLE_N
    pts: list[tuple[float, float]] = []
    for cx, cy, a0, a1 in (
        (r, r, 180, 270),
        (size - r, r, 270, 360),
        (size - r, size - r, 0, 90),
        (r, size - r, 90, 180),
    ):
        for s in range(seg + 1):
            a = math.radians(a0 + (a1 - a0) * s / seg)
            c, si = math.cos(a), math.sin(a)
            x = cx + r * math.copysign(abs(c) ** p, c)
            y = cy + r * math.copysign(abs(si) ** p, si)
            pts.append((x, y))
    return pts


def scaled(pts, size):
    k = size / CANVAS
    return [(x * k, y * k) for x, y in pts]


# ── rasterizer: analytic-x + subY-supersampled scanline fill ────────────────
def fill_polygon(cov, W, H, pts, subY):
    n = len(pts)
    if n < 3:
        return
    ys = [p[1] for p in pts]
    y0i = max(0, int(math.floor(min(ys))))
    y1i = min(H - 1, int(math.ceil(max(ys))))
    inv = 1.0 / subY
    for py in range(y0i, y1i + 1):
        base = py * W
        for s in range(subY):
            yc = py + (s + 0.5) * inv
            xs = []
            j = n - 1
            for i in range(n):
                ya, yb = pts[j][1], pts[i][1]
                if (ya <= yc < yb) or (yb <= yc < ya):
                    xa, xb = pts[j][0], pts[i][0]
                    xs.append(xa + (yc - ya) / (yb - ya) * (xb - xa))
                j = i
            if not xs:
                continue
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                a, b = xs[k], xs[k + 1]
                if b <= 0 or a >= W:
                    continue
                a = max(a, 0.0)
                b = min(b, float(W))
                ia = int(math.floor(a))
                ib = int(math.floor(b - 1e-9))
                if ia == ib:
                    cov[base + ia] += (b - a) * inv
                else:
                    cov[base + ia] += (ia + 1 - a) * inv
                    for xx in range(ia + 1, ib):
                        cov[base + xx] += inv
                    cov[base + ib] += (b - ib) * inv


def render(shapes: Shapes, size: int) -> bytearray:
    W = H = size
    out = bytearray(W * H * 4)  # transparent RGBA
    subY = 16 if size <= 32 else (8 if size <= 64 else 4)

    def layer(pts, rgb):
        cov = [0.0] * (W * H)
        fill_polygon(cov, W, H, pts, subY)
        r, g, b = rgb
        for i in range(W * H):
            a = cov[i]
            if a <= 0.0:
                continue
            o = i * 4
            if a >= 1.0:
                out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255
                continue
            da = out[o + 3] / 255.0
            oa = a + da * (1 - a)
            if oa <= 0:
                continue
            for c, sc in ((0, r), (1, g), (2, b)):
                out[o + c] = int((sc * a + out[o + c] * da * (1 - a)) / oa + 0.5)
            out[o + 3] = int(oa * 255 + 0.5)

    layer(squircle(size, SQUIRCLE_CORNER * size), shapes.bg)
    layer(scaled(shapes.chevron, size), shapes.chevron_fill)
    layer(scaled(shapes.cursor, size), shapes.cursor_fill)
    return out


# ── encoders ────────────────────────────────────────────────────────────────
def encode_png(rgba: bytearray, w: int, h: int) -> bytes:
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)                       # filter type 0 (none)
        raw += rgba[y * stride:(y + 1) * stride]
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def encode_ico(entries: list[tuple[int, bytes]]) -> bytes:
    """PNG-compressed ICO (modern browsers/Windows Vista+)."""
    out = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    body = b""
    for size, png in entries:
        dim = 0 if size >= 256 else size    # 0 encodes 256 in the ICO dir
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset)
        body += png
        offset += len(png)
    return out + body


# ── driver ──────────────────────────────────────────────────────────────────
def png_for(shapes, size, cache):
    if size not in cache:
        cache[size] = encode_png(render(shapes, size), size, size)
    return cache[size]


def build_icns(shapes, out: Path, cache) -> None:
    spec = {
        "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    }
    with tempfile.TemporaryDirectory() as td:
        iconset = Path(td) / "icon.iconset"
        iconset.mkdir()
        for name, size in spec.items():
            (iconset / name).write_bytes(png_for(shapes, size, cache))
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True
        )


def main() -> None:
    shapes = parse_svg(SVG)
    cache: dict = {}
    PUB_ICONS.mkdir(parents=True, exist_ok=True)
    ELECTRON_ICONS.mkdir(parents=True, exist_ok=True)

    def write(path: Path, data: bytes):
        path.write_bytes(data)
        print(f"  {path.relative_to(ROOT)}  ({len(data):,} B)")

    print("favicons (iOS squircle):")
    for s in (16, 32, 96, 128):
        write(PUB_ICONS / f"favicon-{s}x{s}.png", png_for(shapes, s, cache))
    write(PUB / "favicon.ico",
          encode_ico([(s, png_for(shapes, s, cache)) for s in (16, 32, 48)]))

    print("electron (iOS squircle .png/.ico/.icns):")
    write(ELECTRON_ICONS / "icon.png", png_for(shapes, 1024, cache))
    write(ELECTRON_ICONS / "icon.ico",
          encode_ico([(s, png_for(shapes, s, cache)) for s in (16, 32, 48, 256)]))

    if subprocess.run(["which", "iconutil"], capture_output=True).returncode == 0:
        build_icns(shapes, ELECTRON_ICONS / "icon.icns", cache)
        print(f"  {(ELECTRON_ICONS / 'icon.icns').relative_to(ROOT)}  (squircle)")
    else:
        print("  ! iconutil not found — skipped icon.icns (macOS only)")


if __name__ == "__main__":
    main()
