# UE5 Project Structure & Conventions

How to lay out the UE5 project so it stays clean from the slice through to Beta, and so the data-driven roster from the browser game carries over without per-species code.

## Engine & plugins

- **UE 5.4+** (Nanite, Lumen, Virtual Shadow Maps, World Partition, StateTree).
- Project type: **C++** (not Blueprint-only) — gameplay systems are C++, content/tuning is Blueprint + Data Assets.
- Enable plugins: **MetaHuman**, **Quixel Bridge / Fab**, **StateTree**, **Gameplay Abilities (GAS)** *(optional, for vitals/effects)*, **Niagara**, **Water** (river), **Enhanced Input**.
- Source control: Git LFS (UE binary assets) **or** Perforce. Add `*.uasset *.umap` to LFS. Keep `Saved/`, `Intermediate/`, `DerivedDataCache/`, `Binaries/` out of VCS.

## Top-level content layout

```
Content/
  JSI/                         # game namespace (Jurassic Survival: Island)
    Core/                      # GameMode, GameState, PlayerController, GameInstance
    Player/                    # MetaHuman cadet, ABP_Cadet, input mapping contexts
    Creatures/
      Base/                    # BP_CreatureBase (one Blueprint for ALL species)
      Meshes/                  # skeletal meshes per species (or shared rig + variants)
      Anim/                    # ABP_Quadruped, ABP_Biped, anim sets
      Data/                    # DA_Creature_* assets (see 02_DATA_ASSET_SCHEMA)
      Archetypes/              # DA_Archetype_* assets
      AI/                      # BT/StateTree, ST_Creature, BB keys, EQS queries
    World/
      Maps/                    # L_IslandAlpha_Slice (the one zone)
      Landscape/               # heightmap, layers, foliage types
      Facility/                # extraction facility kit
    Environment/
      Megascans/               # imported via Bridge (auto-pathed; don't hand-move)
      Foliage/                 # PCG graphs, foliage types, biome scatter
      VFX/                     # Niagara: fog motes, mist, god-rays
    UI/
      HUD/                     # WBP_HUD, WBP_Objective, WBP_Vitals, WBP_Threat, WBP_GPS
      Style/                   # palette (DA_Palette), fonts (monospace)
    Audio/                     # MetaSounds, ambience, creature calls (post-slice)
    Systems/
      Extraction/              # ExtractionSubsystem, beacon actor
      Threat/                  # ThreatSubsystem
```

C++ lives under `Source/JSI/` mirroring the runtime systems:
```
Source/JSI/
  Core/            AJSIGameMode, AJSIGameState, AJSIPlayerCharacter
  Creatures/       ACreatureBase, UCreatureDataAsset, UArchetypeDataAsset
  AI/              ACreatureAIController, UCreaturePerceptionComponent
  Systems/         UExtractionSubsystem, UThreatSubsystem, UNoiseComponent
  Data/            FCreatureProfile (struct mirroring species.json)
```

## Asset naming convention

Prefix by type, `PascalCase` body, `_Variant` suffix. (Standard UE/Allar style.)

| Type | Prefix | Example |
|---|---|---|
| Blueprint class | `BP_` | `BP_CreatureBase`, `BP_ExtractionBeacon` |
| C++-derived BP | `BP_` | `BP_Cadet` (from `AJSIPlayerCharacter`) |
| Data Asset | `DA_` | `DA_Creature_TRex`, `DA_Archetype_PackHunter` |
| Level / map | `L_` | `L_IslandAlpha_Slice` |
| Skeletal mesh | `SK_` | `SK_TRex` |
| Static mesh | `SM_` | `SM_Boulder_01` |
| Anim Blueprint | `ABP_` | `ABP_Biped`, `ABP_Cadet` |
| Anim sequence | `AS_` | `AS_TRex_Walk`, `AS_TRex_Attack` |
| Blend space | `BS_` | `BS_Cadet_Locomotion` |
| Material / instance | `M_` / `MI_` | `M_CreatureSkin`, `MI_TRex` |
| Texture | `T_` | `T_TRex_BaseColor`, `T_TRex_Normal` |
| Niagara system | `NS_` | `NS_FogMotes` |
| Behavior Tree / StateTree | `BT_` / `ST_` | `ST_Creature` |
| Widget Blueprint | `WBP_` | `WBP_HUD` |
| Sound / MetaSound | `S_` / `MS_` | `MS_TRexRoar` |

## The one rule that preserves the data-driven design

**There is exactly one creature Blueprint (`BP_CreatureBase`) and one AI graph (`ST_Creature`).** A creature *is* a `BP_CreatureBase` carrying a `DA_Creature_*` Data Asset that points at a `DA_Archetype_*`. Adding a species = new `DA_Creature_*` (+ mesh) + pick an archetype. Adding a hybrid = same. **No new class, no new BT, no gameplay code** — identical to how `game.js` reads `species.json` + `archetypes.json` today (`resolveArchetype`, `archOf`, `isPrey`, `usesPackTactics`, `isApex`, `baseStateFor`).

## Import conventions

- **MetaHuman:** via Quixel Bridge → MetaHuman plugin; keep under `Player/`. Don't retarget by hand-editing — use IK Retargeter assets (`RTG_`).
- **Megascans:** always import through Bridge so it auto-creates `Environment/Megascans/...` with correct material setups; never relocate those folders or you break the auto-LOD/Nanite wiring.
- **Dinosaur marketplace packs:** import into a temp `Vendor/<PackName>/`, then move only the meshes/anims you use into `Creatures/Meshes` + `Creatures/Anim` and **re-author materials** to `M_CreatureSkin` instances for a consistent look (per the Asset Bible style DNA).
