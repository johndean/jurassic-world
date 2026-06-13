# Visual Target Roadmap — from grey-box to the start-screen look

**Goal:** make the realtime 3D game approach the look of the photoreal start-screen background
(`background.webp`): dense foggy jungle valley, scarred apex predators, herds, the extraction
facility, heavy atmosphere, cinematic color.

**Read this first — the honest ceiling.** The background is a **2D painted/offline render**. A
browser Three.js game is **realtime** and cannot reproduce a painted frame exactly. What it *can*
reach with the phases below is a strong **stylized-realistic** look (mobile-AAA / Switch-tier) that
is atmospheric and convincing. True film-grade realtime (Nanite/Lumen) means **Unreal Engine 5 — a
full rebuild in different tech, not browser-deliverable** (see Phase 7). Also key: **~70% of the
background's impact is environment + atmosphere, only ~30% is the creatures.** We've proven the
creature pipeline; the biggest remaining gap is the world around them.

## Current state (done)
- ✅ GLTFLoader + **CDN model pipeline** (models served from Higgsfield CDN, out of git)
- ✅ **IBL** (procedural `RoomEnvironment`) + **ACES** tone-mapping in `initRenderer()`
- ✅ Data-driven species/archetype system (`species.json` + `archetypes.json`)
- ✅ POC creatures: restyled **T-Rex** (in-world) + **player character** (rigged, walk clip, scaled correctly)
- ✅ Asset Production Bible (`design/ASSET_BIBLE.md`) governing style consistency
- ⛺ Still grey-box: **all terrain, trees (boxes), facility, the other 29 species**

## Phases at a glance

| Phase | What | Impact on "the look" | Effort | Higgs credits |
|---|---|---|---|---|
| 1 | Full creature roster (30 dinos + characters) | ●●○ | M | ~1,400 |
| 2 | Environment & terrain (foliage, ground, facility) | ●●● | L | ~300–600 |
| 3 | Atmosphere & post-processing | ●●● | M | ~0 (code) |
| 4 | Animation & character polish | ●●○ | M | ~300 |
| 5 | Performance & delivery (compression, LOD) | (enabler) | M | ~0 |
| 6 | Audio & game-feel | ●○○ | S | ~0–100 |
| 7 | Engine decision (stay vs UE5) | — | — | — |

**Recommended order:** 3 → 2 → 1 → 5 → 4 → 6. Atmosphere/post (Phase 3) is the cheapest, highest-ROI
step for matching the background's *feel*, and it makes every later asset look better immediately.

---

## Phase 1 — Full creature roster
Turn all 30 species (+ characters) into real models via the proven pipeline.
- For each species: `generate_image` clean single-subject reference (per `ASSET_BIBLE.md` style) →
  `image_to_3d` (textured + PBR) → CDN URL into `species.json` `modelPath`. Box fallback covers any gap.
- Per-species `modelYaw` facing pass; scale already handled by `fitModel()` + skinned `measureBox()`.
- Characters: cadets (3) + rangers + scientist as rigged models.
- **Done when:** every active species spawns as a textured model, correctly sized and facing.
- **Risks:** Meshy hands/quadruped rigging are weak; ~38 credits/creature; re-rolls for bad lifts.

## Phase 2 — Environment & terrain *(biggest visual lever)*
The world is currently boxes (`buildWorld()`): noise-plane ground, `BoxGeometry` "trees", slab walls.
- **Foliage:** real jungle tree / fern / palm / vine `.glb` (generate or source); render with
  `THREE.InstancedMesh` (150+ instances) for performance. Replace the box-tree loop.
- **Terrain:** textured ground (diffuse + normal + roughness), heightmap relief, ground-cover grass/fern
  instances, scattered rocks. Replace the flat grey `MeshStandardMaterial`.
- **Extraction facility:** a real structure model in the mid-distance (matches the background's helipad/towers).
- **Sky:** gradient/HDRI sky dome integrated with fog (replaces flat `skyColor`).
- **(Optional) River/water** with reflection, per the background.
- **Done when:** a standing screenshot reads as "foggy jungle valley," not "grey boxes."
- **Risks:** content volume; performance (instancing + LOD mandatory — see Phase 5).

## Phase 3 — Atmosphere & post-processing *(cheapest cinematic win, do first)*
This is what makes it *feel* painted. All code, no/low credits.
- **Post stack** via `EffectComposer`: **bloom**, **depth of field**, **GTAO/SSAO** (contact shadows),
  **color grading / LUT**, **vignette**, subtle **film grain**.
- **Volumetric atmosphere:** layered/height fog + light shafts (god rays) to match the heavy haze.
- **Lighting:** swap procedural IBL for a **foggy-jungle HDRI** environment; enable soft **shadow maps**
  on the sun; tune `toneMappingExposure`.
- **Particles:** drifting spores/mist, optional rain.
- **Done when:** the same grey-box scene already looks moody/cinematic with depth and glow.
- **Risks:** post-processing perf cost on low-end; gate effects behind a quality setting.

## Phase 4 — Animation & character polish
- Player: blend **idle / walk / run / crouch** (currently one walk clip, gait-scaled). Generate the
  extra clips (Meshy `enable_animation` + clip IDs) or drive the shared rig.
- Dinos: locomotion + **attack / roar / flee** clips; wire to the existing AI states in `steer()`.
- Address the **hands** weak spot (retopo, multi-image input, or accept at distance).
- **Done when:** creatures and player move believably, not gliding.

## Phase 5 — Performance & delivery *(enabler; required before/with Phase 2)*
- **Compress every model:** Draco / meshopt + KTX2 textures → ~10 MB ⇒ ~1–2 MB. Critical at 30+ models + foliage.
- **LOD** for distant creatures/trees; **InstancedMesh** for vegetation; frustum culling (already on).
- Mobile/low-end **quality tiers** (toggle post-FX, shadow res, draw distance).
- **Done when:** 60 fps on desktop, playable on mid mobile, fast first load.
- Note: needs a small build step (gltf-pipeline / gltfpack) — not currently in the toolchain.

## Phase 6 — Audio & game-feel
- Ambient jungle bed, creature calls, footstep/impact SFX, music stings; camera shake on roars.
- Low effort, disproportionate immersion gain.

## Phase 7 — Engine decision (the fork)
- **Stay in Three.js:** ship a striking *stylized-realistic* browser game. Reachable, lightweight, the
  current trajectory. **Recommended.**
- **Move to Unreal Engine 5:** to literally match the cinematic frames (Nanite geometry, Lumen GI). A
  full rebuild in C++/Blueprints, not a browser title at that fidelity, months of work. Only if photoreal
  realtime is a hard requirement.

---

## What I'd do next (recommendation)
Start with **Phase 3** on the current scene — bloom + DoF + GTAO + height-fog + an HDRI + soft shadows.
It's almost all code (minimal credits), and it will make even the grey-box world read cinematic, proving
the target is reachable before we invest in the full asset push (Phases 1–2). Then Phase 2 (environment)
delivers the biggest remaining jump, and Phase 1 fills the roster. Phase 5 runs alongside 2 to keep it fast.
