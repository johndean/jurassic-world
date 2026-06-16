#!/usr/bin/env python3
"""
PHASE 1 · STEP 3 — Import the valley heightmap as a UE5 Landscape, 1:1 with the browser game.

Run this in the Unreal Editor's Python console (Window > Output Log > Cmd dropdown > Python),
or:  py "…/Source/Heightmap/import_landscape.py"

What it does (all deterministic, no art judgement needed):
  1. Decodes the committed valley_heightmap_1009.png (pure stdlib — UE's Python has no Pillow).
  2. Writes valley_heightmap_1009.r16 (little-endian uint16, raw) — the format UE's Landscape
     "Import from File" tool accepts most reliably across engine versions.
  3. Recomputes the exact metric scale + Z offset from the game's own groundH() formula, so the
     UE Landscape reproduces real metres (valley floor, river channel, mountain ring).
  4. If run inside the editor, ATTEMPTS to create the Landscape actor programmatically and apply
     the transform. Scripted heightmap import varies by engine build, so if the API path isn't
     available on your UE 5.7, the script prints the exact one-time "Import from File" settings and
     you click through them with the generated .r16 — same numbers, guaranteed result.

Production safety: read-only mirror of the browser terrain function; touches no game file. All
output stays inside ue5-cinematic-slice/. Rollback = delete the .r16 (and the Landscape you make).
"""
import math, os, struct, zlib, sys

# ---- terrain constants, copied verbatim from game.js groundH() (the source of truth) ----
MAP_SIZE   = 240.0     # BIOME.map.size — playable valley spans 240 m
RIVER_HALF = 17.0
def river_center(x):
    return 48.0 + math.sin(x * 0.02) * 28.0
def ground_h(x, z):
    r = math.hypot(x, z)
    h = 1.8 + math.sin(x * 0.05) * math.cos(z * 0.045) * 1.3 + math.sin(x * 0.13 + z * 0.09) * 0.5
    e = max(0.0, (r - 70.0) / 48.0)
    h += e * e * 32.0 * (0.75 + 0.25 * math.sin(x * 0.07) * math.cos(z * 0.06))
    d_river = abs(z - river_center(x))
    if d_river < RIVER_HALF:
        t = d_river / RIVER_HALF
        h -= (1.0 - t * t) * 6.0
    return h

HERE = os.path.dirname(os.path.abspath(__file__))
PNG  = os.path.join(HERE, "valley_heightmap_1009.png")
R16  = os.path.join(HERE, "valley_heightmap_1009.r16")

# ---- 1) decode the 16-bit grayscale PNG (we wrote it with filter 0 / None per row) ----
def decode_png_gray16(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, width, height, idat = 8, 0, 0, bytearray()
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos+4])[0]; tag = data[pos+4:pos+8]
        body = data[pos+8:pos+8+ln]; pos += 12 + ln
        if tag == b"IHDR":
            width, height, bit_depth, color = struct.unpack(">IIBB", body[:10])
            assert bit_depth == 16 and color == 0, "expected 16-bit grayscale"
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
    raw = zlib.decompress(bytes(idat))
    stride = width * 2
    rows = []
    for y in range(height):
        off = y * (stride + 1)
        ftype = raw[off]
        assert ftype == 0, "row %d uses PNG filter %d; this decoder expects None(0)" % (y, ftype)
        rows.append(raw[off+1:off+1+stride])
    return width, height, rows  # rows are big-endian uint16 scanlines

# ---- 2) write a raw .r16 (little-endian uint16) that UE imports cleanly ----
def write_r16(width, height, rows, out):
    with open(out, "wb") as f:
        for r in rows:
            # re-pack each big-endian sample as little-endian
            vals = struct.unpack(">%dH" % width, r)
            f.write(struct.pack("<%dH" % width, *vals))
    return width * height * 2

# ---- 3) exact transform from the formula (same sampling as the generator) ----
def transform_params(n):
    half = MAP_SIZE / 2.0
    hmin, hmax = float("inf"), float("-inf")
    for j in range(n):
        z = -half + MAP_SIZE * j / (n - 1)
        for i in range(n):
            x = -half + MAP_SIZE * i / (n - 1)
            h = ground_h(x, z)
            if h < hmin: hmin = h
            if h > hmax: hmax = h
    span = hmax - hmin
    scale_xy = (MAP_SIZE * 100.0) / (n - 1)        # cm per quad → n px == 240 m
    scale_z  = 100.0 * span / 512.0                # so full 16-bit range == `span` metres
    # UE maps stored value 32768 to landscape-local Z 0; full range is ±256*(scaleZ/100) m.
    # Value 0 (real height hmin) lands at -span/2 m, so offset the actor up to put hmin at world hmin.
    z_offset_cm = (hmin + span / 2.0) * 100.0
    return dict(hmin=hmin, hmax=hmax, span=span, scale_xy=scale_xy, scale_z=scale_z, z_offset_cm=z_offset_cm)

# 1009 quads-1 = 1008 = 63 quads/section × 1 section/component × 16×16 components (a clean UE config)
def component_layout(n):
    quads = n - 1
    section = 63
    sections_per_comp = 1
    comps = quads // (section * sections_per_comp)
    return dict(resolution=n, quads=quads, section_size=section,
                sections_per_component=sections_per_comp, component_count=comps,
                exact=(comps * section * sections_per_comp == quads))

def main():
    if not os.path.exists(PNG):
        print("ERROR: %s not found — run gen_valley_heightmap.py first." % PNG); return
    w, h, rows = decode_png_gray16(PNG)
    nbytes = write_r16(w, h, rows, R16)
    t = transform_params(w)
    L = component_layout(w)

    print("=" * 74)
    print("PHASE 1 · STEP 3 — Landscape import data ready")
    print("=" * 74)
    print("Decoded : %s  (%d x %d, 16-bit)" % (os.path.basename(PNG), w, h))
    print("Wrote   : %s  (%d bytes, little-endian uint16, raw)" % (os.path.basename(R16), nbytes))
    print("-" * 74)
    print("LANDSCAPE TRANSFORM (set these exactly):")
    print("  Location  X=0  Y=0  Z=%.1f cm        (puts the valley floor at real-world height)" % t["z_offset_cm"])
    print("  Scale     X=%.4f  Y=%.4f  Z=%.4f   (cm/quad XY, metric Z)" % (t["scale_xy"], t["scale_xy"], t["scale_z"]))
    print("  → %d px spans %.0f m; height range %.2f..%.2f m (span %.2f m)"
          % (w, MAP_SIZE, t["hmin"], t["hmax"], t["span"]))
    print("-" * 74)
    print("IMPORT GEOMETRY (UI 'Import from File' fields):")
    print("  Heightmap File : %s" % R16)
    print("  Resolution     : %d x %d   (auto-detected from file size)" % (w, w))
    print("  Section Size   : %d x %d quads" % (L["section_size"], L["section_size"]))
    print("  Sections/Comp  : %d x %d" % (L["sections_per_component"], L["sections_per_component"]))
    print("  Components     : %d x %d   (exact fit: %s)" % (L["component_count"], L["component_count"], L["exact"]))
    print("=" * 74)

    # ---- 4) try programmatic creation inside the editor; otherwise leave the .r16 + steps ----
    try:
        import unreal
    except Exception:
        print("Not running inside Unreal — .r16 + numbers above are ready for the UI import.")
        return

    print("Unreal detected — attempting programmatic Landscape creation…")
    try:
        # Read heights back as a flat uint16 list (row-major) for the import call.
        heights = []
        for r in rows:
            heights.extend(struct.unpack(">%dH" % w, r))

        loc = unreal.Vector(0.0, 0.0, t["z_offset_cm"])
        rot = unreal.Rotator(0.0, 0.0, 0.0)
        scale = unreal.Vector(t["scale_xy"], t["scale_xy"], t["scale_z"])
        xform = unreal.Transform(loc, rot, scale)

        created = None
        # Preferred path: LandscapeEditorSubsystem.import_landscape (UE 5.x where exposed).
        try:
            les = unreal.get_editor_subsystem(unreal.LandscapeEditorSubsystem)
            if hasattr(les, "import_landscape"):
                created = les.import_landscape(
                    transform=xform,
                    section_size=L["section_size"],
                    sections_per_component=L["sections_per_component"],
                    component_count_x=L["component_count"],
                    component_count_y=L["component_count"],
                    size_x=w, size_y=w,
                    height_data=heights,
                    height_map_file_name=R16,
                    import_layers=[])
        except Exception as e:
            print("  (LandscapeEditorSubsystem.import_landscape unavailable: %s)" % e)

        if created is None:
            # Fallback: spawn an empty Landscape actor at the right transform so the level is staged;
            # then finish the heights via the UI import using the printed settings + the .r16.
            eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
            created = eas.spawn_actor_from_class(unreal.Landscape, loc, rot)
            if created:
                created.set_actor_scale3d(scale)
                created.set_actor_label("JSISlice_Valley_Landscape")
                print("  Spawned an empty Landscape actor at the correct transform.")
                print("  → Finish in Landscape mode: Manage > Import from File, pick the .r16 above,")
                print("    and use the Section/Components fields printed above.")
        else:
            try: created.set_actor_label("JSISlice_Valley_Landscape")
            except Exception: pass
            print("  Landscape imported programmatically. ✔")

        # Save the level so the work persists.
        try:
            unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).save_current_level()
        except Exception:
            try: unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
            except Exception: pass
    except Exception as e:
        print("Programmatic creation hit an error: %s" % e)
        print("Use the UI 'Import from File' path with the .r16 + settings above (reliable on any 5.x).")

if __name__ == "__main__":
    main()
