# UE5 Vertical-Slice Documentation Package

The buildable spec for the photoreal Unreal Engine 5 version — **scoped to the vertical slice** (one zone, one extraction loop, 3 creatures) so the full-build investment can be decided from an on-screen result, not concept art. Grounded in the live browser game's canon (`strings.js`, `data/*.json`, `logic.js`).

Read in order:

1. **[00_VERTICAL_SLICE_GDD.md](00_VERTICAL_SLICE_GDD.md)** — what the slice is: scope, the zone, the loop, the 3 creatures, HUD, success/go-no-go criteria, timeline & cost.
2. **[01_PROJECT_STRUCTURE.md](01_PROJECT_STRUCTURE.md)** — UE5 folder layout, plugins, asset-naming conventions, and the one-creature-Blueprint rule that preserves the data-driven design.
3. **[02_DATA_ASSET_SCHEMA.md](02_DATA_ASSET_SCHEMA.md)** — `UCreatureDataAsset` / `UArchetypeDataAsset` mirroring `species.json` + `archetypes.json` 1:1, with filled T-Rex & Triceratops examples and the JSON→DataAsset importer; now also `UDifficultyProfile` (Explorer/Survivor/Apex) + survival/resupply tuning structs.
4. **[03_SYSTEMS_DESIGN.md](03_SYSTEMS_DESIGN.md)** — AI (archetype StateTree), extraction, threat, noise/stealth, player, multiplayer hooks, **plus the systems proven this session**: traversal, water/swim, survival (GAS), difficulty profiles, drivable vehicles, airdrop resupply; with a browser→UE5 traceability table.
5. **[04_SHOPPING_LIST.md](04_SHOPPING_LIST.md)** — concrete Megascans/MetaHuman/Fab picks, costs (~$50–$225 cash), and the build order.

Parent context: **[../UE5_PRODUCTION_PLAN.md](../UE5_PRODUCTION_PLAN.md)** (full-build scope, team, budget bands) and the current-state **[../AAA_ZERO_GAP_AUDIT.md](../AAA_ZERO_GAP_AUDIT.md)** (what is shipped & proven in the browser build as of `2026-06-16-s`).

**Status:** specification only. No UE5 project/code/assets exist yet. The browser game remains the shipping product and — as of build `2026-06-16-s` — the playable proof of the full **systems set**, not just the loop (see the zero-gap audit).
