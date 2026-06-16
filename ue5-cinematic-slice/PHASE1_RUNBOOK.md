# Phase 1 Runbook — UE5 Environment Prototype, profiled on the A12Z/A13 floor

**Goal of Phase 1:** a *look-only* one-zone environment (no gameplay) on the native-iPad target, then
**profile it on a physical iPad 9th gen (A13) and iPad Pro 4th gen (A12Z)** to learn the real visual ceiling
at the floor. Mobile (Metal) renderer + **baked lighting** — Nanite/Lumen OFF (already set in `Config/`).

> **What this repo gives you:** the project scaffold (`UnrealProject/JSISlice.uproject` + `Config/*.ini`),
> this runbook, the profiling protocol, and `PERFORMANCE_BUDGET.md`. **What you do on a Mac:** the editor
> work (steps 1–9), packaging (step 10), and on-device profiling (steps 11–12). I can't run the editor or a
> device — follow the steps; bring the filled-in results table back and we tune from real numbers.
>
> **Production safety:** all of this lives in `ue5-cinematic-slice/`. The browser game is untouched.
> **Rollback:** delete the folder (zero inbound production dependencies).

---

## Prerequisites (one-time)
- **Mac** (Apple Silicon recommended) + **Xcode** (current, for the iPadOS 18.5/26 SDK) + command-line tools.
- **Unreal Engine 5.4+** (from the Epic Games Launcher). The project file targets **5.7**; any recent 5.x works
  via *Switch Unreal Engine Version*.
- **Apple Developer Program** ($99/yr); a signing team + a test device UDID registered.
- Physical **iPad 9th gen (A13)** and **iPad Pro 4th gen (A12Z)** (the floor). M-series + **iPad Pro M4** for
  the Enhanced/Showcase comparison.
- **Fab / Quixel Bridge** account (free) for Megascans + a rigged dino (optional in Phase 1 — environment first).

## 1. Open the project
- Copy `UnrealProject/` to your working drive. Double-click `JSISlice.uproject`.
- **Engine version:** the project targets **UE 5.7** (`EngineAssociation: "5.7"`). If you have a different
  5.x, right-click the `.uproject` → *Switch Unreal Engine Version* → pick your installed engine, or just let
  the editor offer to open it with your version.
- **No compile step:** Phase 1 is **content/Blueprint-only** (no C++ module declared), so it opens directly —
  you will **not** see a "missing modules / rebuild?" prompt. (The `JSISlice` C++ module is added in Phase 2
  when gameplay code lands; that step generates project files and compiles on this Mac.)
- The `Config/*.ini` here pre-set the mobile/iOS/baked render mode. Confirm in **Project Settings**:
  - *Rendering*: Static Lighting **on**, Dynamic GI **None**, Nanite **off**, VSM **off**, Mobile HDR **on**, Forward shading on mobile.
  - *Platforms > iOS*: Metal on, MetalMRT off, iPad-only, landscape, min iOS set, **your signing team + bundle id** (don't commit these).

## 2. Enable plugins (verify)
EnhancedInput, Water, PCG, Landmass, Niagara, GameplayCameras, Bridge. (Pre-listed in the `.uproject`.)

## 3. Landscape — the 240 m valley (automated)
- **Run the importer** instead of sculpting by hand: in the editor, open **Window > Output Log**, switch the
  command dropdown to **Python**, and run:
  `py "Source/Heightmap/import_landscape.py"`  (use the full path to the file).
  It decodes the committed `valley_heightmap_1009.png`, writes an importable `valley_heightmap_1009.r16`,
  prints the **exact** transform + import settings, and — if the engine exposes the API — creates the
  Landscape actor with the transform applied. The valley then matches the browser 1:1 (rolling floor,
  perimeter mountain ring past r≈70 m, the winding river channel `48 + sin(x*0.02)*28`).
- If scripted import isn't available on your build, the script spawns an empty Landscape at the right
  transform and prints the **Import from File** fields — in **Landscape mode > Manage > Import from File**,
  pick the generated `.r16` and enter: Resolution **1009×1009**, Section **63×63**, Sections/Comp **1×1**,
  Components **16×16**; Location **Z = 5890.9 cm**; Scale **X=Y=23.8095, Z=25.2493**.
- Paint Megascans ground layers (dirt / mud / rock / leaf litter) over it.

## 4. Water (river)
- Use the **Water plugin** `Water Body River` along the channel; set depth so it reads as the swimmable
  river. (Phase 1 = visual only; the swim *mechanic* is Phase 2.)

## 5. Foliage (PCG)
- Use **PCG** to scatter Megascans trees / palms / ferns / grass across the valley (mirrors the browser's
  instanced billboards, but real meshes). Author at **FoliageQuality level 1 density first** (the floor).
- Add vertex-animated **wind** (Megascans foliage ships with it).

## 6. Sky, fog, lighting mood
- **Directional Light = Stationary**, low sun, blue-grey overcast (match the start-screen key art palette).
- **Sky Atmosphere** + **Exponential Height Fog** (the browser's `FogExp2` analogue) + light shafts.
- Set **Lightmass / GPU Lightmass** for a single fixed time-of-day. Mark static geometry **Static**; mark the
  hero set-dressing for lightmaps.

## 7. Extraction facility set-piece (visual)
- Block out helipad + bunker + comms tower + floodlights in the mid-distance (matches `buildFacility()`),
  Megascans/Fab modular trim. No gameplay — just the silhouette + a beacon glow.

## 8. Cinematic camera
- A **Sequencer** fly-through (slow push across the valley toward the facility) for the go/no-go screenshot.
  This is the frame you compare against the key art — locked camera, best light.

## 9. BAKE lighting
- Build/bake with **GPU Lightmass** (Static + Stationary lights). Confirm no "Lighting needs to be rebuilt."
  This is where the realism jump over the browser comes from — verify AO/contact shadows read well.

## 10. Package for iPad
- Set the **iOS** platform as target. **Platforms > iOS > Package** (Shipping) → `.ipa`.
- Install via **Xcode** (Window > Devices) or **TestFlight**. Launch on the **A12Z first**, then **A13**.

## 11. Profiling protocol (on device) — see also `PERFORMANCE_BUDGET.md`
Run the Sequencer fly-through + free-fly the valley on each device and capture:

**In-engine (development build, on-screen):**
```
stat unit        ; Frame / Game / Draw / GPU ms  ← the headline numbers
stat fps
stat scenerendering ; draw calls, primitives
stat rhi         ; draw primitive calls, GPU memory
stat memory      ; / stat llm — texture + total memory
stat foliage
```
**Xcode (shipping build, accurate):** **Instruments → Metal System Trace** (GPU frame time, hitches,
thermal state) + **Game Performance** template. Watch for **thermal throttling** after ~5–10 min (the A12Z
will throttle — record sustained, not burst, fps).

**Toggle tests** (find what the floor affords): `r.MobileMSAA 2` vs `4`; `foliage.DensityScale 0.4/0.6/1.0`;
`r.ViewDistanceScale 0.5/0.7/1.0`; `sg.ShadowQuality 0/1/2`; `r.Mobile.AmbientOcclusion 0/1`.

## 12. Record results (bring this back filled in)

| Device (chip) | Scene | Frame ms | GPU ms | Draw calls | Tris (M) | Tex mem (MB) | Sustained FPS | Thermal after 10 min | Notes |
|---|---|---|---|---|---|---|---|---|---|
| iPad Pro 4th gen (A12Z) | fly-through | | | | | | | | |
| iPad Pro 4th gen (A12Z) | free-fly dense foliage | | | | | | | | |
| iPad 9th gen (A13) | fly-through | | | | | | | | |
| iPad 9th gen (A13) | free-fly dense foliage | | | | | | | | |
| iPad Pro M4 (showcase) | fly-through, Enhanced+RT trial | | | | | | | | |

**Go/no-go:** floor devices hold the target (A12Z ~60 / A13 ~30–60) at Baseline settings **without thermal
collapse**, and the fly-through frame convinces. If GPU-bound: cut foliage density → view distance → shadow
res → MSAA, in that order, and re-measure. Feed the numbers back and we set the final Baseline budget.
