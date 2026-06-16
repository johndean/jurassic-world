#!/usr/bin/env python3
"""
Generate a UE5-importable 16-bit grayscale heightmap from the BROWSER GAME's exact
terrain function groundH() (game.js). This makes the UE5 Landscape match the live
game's valley 1:1 — same rolling hills, mountain ring, and carved river channel.

Read-only with respect to production: it mirrors the formula, touches no game file.
Pure stdlib (zlib + struct) so it runs anywhere, no Pillow/numpy needed.

Output: valley_heightmap_<N>.png  (16-bit grayscale, N x N)
Import in UE5: Landscape > Import from File. Set X/Y scale so N px spans 240 m,
and Z scale per the printed value so heights reproduce real metres.
"""
import math, zlib, struct, sys

# ---- constants copied verbatim from game.js (the source of truth) ----
MAP_SIZE   = 240.0     # BIOME.map.size
RIVER_HALF = 17.0      # game.js RIVER_HALF
def river_center(x):   # game.js riverCenter
    return 48.0 + math.sin(x * 0.02) * 28.0
def ground_h(x, z):    # game.js groundH — verbatim port
    r = math.hypot(x, z)
    h = 1.8 + math.sin(x * 0.05) * math.cos(z * 0.045) * 1.3 + math.sin(x * 0.13 + z * 0.09) * 0.5
    e = max(0.0, (r - 70.0) / 48.0)
    h += e * e * 32.0 * (0.75 + 0.25 * math.sin(x * 0.07) * math.cos(z * 0.06))
    d_river = abs(z - river_center(x))
    if d_river < RIVER_HALF:
        t = d_river / RIVER_HALF
        h -= (1.0 - t * t) * 6.0
    return h

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1009   # UE-friendly: 505 / 1009 / 2017
half = MAP_SIZE / 2.0                                  # sample x,z in [-120, 120]

# ---- sample the field ----
rows = []
hmin, hmax = float("inf"), float("-inf")
grid = [[0.0] * N for _ in range(N)]
for j in range(N):
    z = -half + MAP_SIZE * j / (N - 1)
    for i in range(N):
        x = -half + MAP_SIZE * i / (N - 1)
        h = ground_h(x, z)
        grid[j][i] = h
        if h < hmin: hmin = h
        if h > hmax: hmax = h
span = hmax - hmin

# ---- normalize to 16-bit and build scanlines (filter byte 0 + big-endian uint16) ----
raw = bytearray()
for j in range(N):
    raw.append(0)  # filter: none
    for i in range(N):
        v = int(round((grid[j][i] - hmin) / span * 65535.0))
        v = 0 if v < 0 else (65535 if v > 65535 else v)
        raw += struct.pack(">H", v)

# ---- minimal 16-bit grayscale PNG encoder ----
def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))
png  = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 16, 0, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
png += chunk(b"IEND", b"")
out = "valley_heightmap_%d.png" % N
with open(out, "wb") as f:
    f.write(png)

# ---- UE import guidance: choose Z scale so 16-bit range reproduces real metres ----
# UE Landscape: at Z scale S, full 0..65535 spans 512*(S/100) m. To span `span` m:
ue_z_scale = 100.0 * span / 512.0
ue_xy_scale = (MAP_SIZE * 100.0) / (N - 1)   # cm per quad so N px == 240 m
print("wrote %s  (%d x %d, 16-bit grayscale)" % (out, N, N))
print("height range: min=%.2f m  max=%.2f m  span=%.2f m" % (hmin, hmax, span))
print("UE Landscape transform:")
print("  Scale X = Y = %.4f   (cm per quad, so %d px = %.0f m)" % (ue_xy_scale, N, MAP_SIZE))
print("  Scale Z = %.4f       (so 16-bit range = %.2f m of real height)" % (ue_z_scale, span))
print("  Then offset Z so the valley floor (~%.1f m) sits at world 0 if desired." % hmin)
