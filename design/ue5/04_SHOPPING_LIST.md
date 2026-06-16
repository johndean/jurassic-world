# UE5 Vertical-Slice Shopping List

Concrete assets/tools to build the slice in `00_VERTICAL_SLICE_GDD.md`. Goal: a cinematic one-zone extraction loop on the **native iPad target** (iOS/Metal, floor A12Z/A13) using **mostly free** assets, so the only real cost is time + an optional dinosaur pack + the Apple toolchain.

> Prices are ballpark as of writing and move around — verify on Fab at purchase. "Free" = no license cost (Epic-owned or free-tier).

## iOS / iPad packaging (REQUIRED for the native target)

| Item | Cost | Note |
|---|---|---|
| **Mac** (Apple Silicon recommended) | (hardware) | **Mandatory** — iOS packaging/signing only works from macOS + Xcode |
| **Xcode** (current, for iPadOS 18.5/26 SDK) | Free | Build/deploy to device + TestFlight |
| **Apple Developer Program** | **$99/yr** | TestFlight + App Store distribution; on-device testing |
| Physical **iPad 9th gen + iPad Pro 4th gen** to profile | (hardware) | Profile on the **floor devices early** — they are the design constraint, not an M-series |

> **Rendering note:** target = **UE5 Mobile (Metal) renderer + baked lighting**. **Nanite and Lumen are OFF**
> at the A12Z/A13 floor (M-series Enhanced tier may opt into a Nanite trial). The "Free (engine)" Lumen/
> Nanite lines below are **desktop-only** — substitute **baked GI (GPU Lightmass)** + mobile fog for the
> iPad build.

## Tools / engine (all free)

| Item | Cost | Note |
|---|---|---|
| Unreal Engine 5.4+ | **Free** | Royalty only past $1M lifetime revenue |
| Quixel Bridge / **Fab** | **Free** | Megascans now under Fab; Epic content free tier |
| MetaHuman Creator + plugin | **Free** | Photoreal cadet, auto-rigged/LOD'd |
| Visual Studio 2022 (Community) / Rider | **Free** / paid | C++ build; Rider optional ($) |
| Substance 3D Painter | ~$20/mo or Steam perpetual | Re-texture dino skins to the Asset-Bible style; optional for slice |

## Environment — the valley (target ~$0)

| Need | Source | Cost |
|---|---|---|
| Jungle trees / palms / ferns / vines | **Megascans/Fab foliage** + Epic's free jungle/tropical packs | Free |
| Ground: dirt, mud, rock, leaf litter (PBR) | Megascans surfaces | Free |
| Boulders / rock outcrops / cliffs | Megascans 3D assets + Nanite | Free |
| River | UE5 **Water** plugin | Free |
| Volumetric fog, god-rays, mist motes | Niagara + Exponential Height Fog + Lumen | Free (engine) |
| Extraction facility (helipad, bunker, tower) | Fab modular military/industrial kit *or* block out + Megascans trim | Free–$30 |
| Sky / lighting | UE5 sky atmosphere + a foggy HDRI (free HDRIs: Poly Haven) | Free |

PCG (Procedural Content Generation, built-in) scatters the foliage across the valley like the browser's instanced billboards — but real meshes with Nanite.

## Characters (target ~$0)

| Need | Source | Cost |
|---|---|---|
| Player cadet (photoreal) | **MetaHuman** + free clothing/outfit (or marketplace field-gear) | Free–$25 |
| Locomotion (idle/walk/run/crouch) | **Lyra** sample or free Fab locomotion set, retargeted via IK Retargeter | Free |

## Creatures — the one place to consider spending

AI image→3D (our browser pipeline) is fine at browser fidelity but **not** photoreal/clean-rigged for UE5 hero creatures. **Proven the hard way:** AI auto-rig (Meshy) landed a usable skinned+animated dino on only **1 of 13 attempts** in the browser build — buy rigged creatures, don't auto-rig them (see `03_SYSTEMS_DESIGN.md` §5b). Best value for the slice:

| Option | What you get | Cost |
|---|---|---|
| **Fab dinosaur pack** (rigged + animated) | Drop-in T-Rex / raptor / herbivore with walk/attack/idle anims | ~$30–$150 per pack |
| Individual creature on Fab/Sketchfab (Store license) | One hero dino, rigged | ~$20–$80 each |
| Commission custom | Bible-accurate, exclusive | $$$ (post-slice) |

**Slice recommendation:** buy **one** quality multi-dino pack that includes a T-Rex + a raptor + at least one herbivore (covers all 3 slice archetypes from a single purchase). Budget **~$50–$150 total**. Re-author their materials to `MI_*` instances for a consistent Asset-Bible look.

## Audio (mostly deferred; minimal for slice feel)

| Need | Source | Cost |
|---|---|---|
| Jungle ambience bed | Free SFX (e.g. Sonniss GDC packs) | Free |
| Creature calls / footsteps | Free libraries for slice; license proper libs later | Free–$ |
| MetaSounds wiring | Engine | Free |

## Slice total

| Line | Cost |
|---|---|
| Engine + Megascans + MetaHuman + plugins | **$0** |
| One dinosaur pack (3 archetypes) | **~$50–$150** |
| Optional: facility kit, outfit, Substance | **~$0–$75** |
| **Cash total** | **~$50–$225** |
| **Real cost** | **artist/engineer time (~2–4 months part-time)** |

## Build order (so something photoreal is on screen fast)

1. **Greybox the valley + loop** in UE5 with the data/systems from docs 02–03 (no art) — proves it runs.
2. **Drop in MetaHuman cadet** + locomotion → walk the valley.
3. **Megascans + PCG foliage + Water river + facility** → the valley becomes photoreal (this is the "wow" milestone).
4. **Lumen + volumetric fog + HDRI + post** → match the key-art atmosphere. **Take the go/no-go screenshot here.**
5. **Import the dino pack**, wire 3 `DA_Creature_*` + archetypes → AI loop live.
6. **Threat/noise/extraction polish** → full loop playable. Slice done.

## What I (Claude) can produce next without the editor

- The C++ headers for `ACreatureBase`, `UCreatureDataAsset`, `UArchetypeDataAsset`, the subsystems (skeletons compile-ready).
- The Python `unreal` import script that turns `species.json`/`archetypes.json` into `DA_*` assets.
- The StateTree behavior spec as a node-by-node breakdown.
- A precise Fab search list (exact pack candidates) once you're ready to buy.

What needs you/an artist in-editor: importing assets, MetaHuman creation, lighting/material art, and clicking the slice together. That's the hands-on UE5 work no amount of docs replaces.
