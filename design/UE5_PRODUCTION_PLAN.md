# UE5 Production Plan — "Jurassic Survival: Island Alpha" as a true AAA-realistic game

This is the plan for the **big build**: a photoreal, cutting-edge version matching the cinematic key
art. It is a different project from the live browser game (which keeps shipping in parallel). The point
of this doc is to let you decide the UE5 investment with real scope, team, time, and budget.

## Why Unreal Engine 5 (not the browser stack)
Photoreal realtime = **UE5**: **Nanite** (film-density geometry with no manual LODs), **Lumen** (realtime
global illumination + reflections), **Virtual Shadow Maps**, **Niagara** (volumetric fog, weather, particles),
and **MetaHuman** (photoreal characters). Three.js/WebGL cannot reach this; it's an engine-class difference.
Trade-off: UE5 ships as a **multi-GB download for gaming PC/console**, not an instant browser URL.

## What carries over from work already done (real value, not wasted)
- **Game design** is engine-agnostic: the extraction loop, threat system, noise/stealth, data-driven
  species + **archetype AI** (`SPECIES_ARCHITECTURE_v2.md`) all translate directly to UE5 (Blueprints/C++ + Data Assets).
- **Concept art / art direction:** the **Asset Production Bible** (`ASSET_BIBLE.md`), hero key art, the
  start-screen background, and the dino references become the **art bible + modeling references** for UE5 artists.
- **The browser game becomes the playable prototype / vertical-slice reference** that proves the loop is fun.
- **HUD/UX** design (real labels, palette) ports to UMG.

## Prototype maturity — what is now PROVEN, not just designed (as of browser build `2026-06-16-s`)
The browser prototype has graduated from "proves the loop" to **"proves the systems."** The following are
implemented, live, and validated in `AAA_ZERO_GAP_AUDIT.md` — they are reference *behaviour to match*,
not open design questions, when authored in UE5:
- **Traversal & solid world:** jump / auto-vault / mantle / tower-climb / zipline over a queryable collider
  world (player + AI both collide). → UE5: CharacterMovementComponent + nav-mesh + climbable volumes.
- **Water:** swim / dive / oxygen / current; AI wade-and-avoid or swim by archetype. → UE5: PhysicsVolumes
  + buoyancy + a swim movement mode; Water plugin for the lagoon/river.
- **Survival layer:** hunger / thirst / temperature / injury-bleed with speed penalties + HUD chips.
  → UE5: an AttributeSet (GAS) driving a status-effect UMG strip.
- **Living ecosystem AI:** 11-state utility AI, predator-vs-prey hunt→feed, predator hierarchy, herd
  cohesion + stampede, pack lead/flank/harry, agility-scaled turning, arrival/anti-jitter steering.
  → UE5: StateTree/Behaviour Tree + EQS, one controller per archetype.
- **Drivable vehicles** (jeep) with a safe-zone-on-board rule. → UE5: Chaos Vehicles.
- **Difficulty tiers** (Explorer / Survivor / Apex) as 8 AI/combat multipliers, selectable + persisted.
  → UE5: a `DifficultyProfile` Data Asset read by the AI/spawn systems (schema in `ue5/02_DATA_ASSET_SCHEMA.md`).
- **Airdrop resupply** as a dynamic objective (call → inbound → land ≤100 m → map marker → refill).
  → UE5: a spawned actor + objective entry + minimap marker.
- **Accessibility & platform:** colourblind palettes, HUD scale, subtitles, high-contrast, and a hardened
  touch layer (iPad zoom prevention + RESET VIEW recovery). → UE5: EnhancedInput + UMG + platform settings.
These close most "is it fun / does it work" risk **before** any UE5 spend; the remaining open risk is
art/animation fidelity and (for co-op) network robustness — see Milestones.

## Tech stack
- **Engine:** UE 5.4+ (Nanite, Lumen, VSM, World Partition for the island).
- **Characters:** **MetaHuman** (cadets, rangers) — photoreal, auto-rigged, LOD'd. Solves the hand/rig
  problems we hit with AI image→3D.
- **Environment:** **Quixel Megascans** (UE-native, free) for jungle, rock, ground, foliage; UE5 foliage tools.
- **Creatures:** the hard part. Options, cheapest→best: (a) **Fab/Unreal Marketplace** dinosaur packs
  (rigged + animated, ready to drop in — fastest); (b) commission custom dino models/anims; (c) custom in-house.
  **Do NOT rely on AI image→3D auto-rig for creatures** — proven unreliable on dinosaur meshes in the
  browser build (1/13 usable rigs); buy pre-rigged or rig with Control Rig.
- **Animation:** **true per-species skeletal walking lives here, not in AI auto-rig.** Control Rig +
  IK Retargeter with **one shared rig per body archetype** (biped theropod, quadruped ceratopsian/
  stegosaur/ankylosaur, ostrich-mimic) so locomotion sets cover every species of that archetype;
  marketplace anim packs; optional mocap for hero moments. Quadrupeds must never use a humanoid walk clip.
- **Materials/Texturing:** Substance 3D Painter/Designer.
- **Audio:** MetaSounds; licensed jungle ambience + creature SFX libraries.
- **Multiplayer (10–20p target):** UE5 replication / dedicated servers (a major workstream — phase it later).

## Asset pipeline
Higgsfield concept art → ref board → model (or Megascans/marketplace) → retopo + UV → Substance texture →
rig (Control Rig / MetaHuman) → import to UE5 → Nanite/Lumen setup → in-engine polish.

## Milestones
Because the prototype already proves the systems (see "Prototype maturity"), the slice can focus risk on
**look + animation fidelity** rather than re-deriving gameplay; port the proven rules 1:1.
1. **Vertical Slice (1 zone, 1 playable loop, 2–3 creatures, photoreal):** proves the look + feel by
   re-skinning the *already-proven* loop in UE5. Port from the browser reference: free-look traversal +
   one drivable vehicle + the survival HUD strip + 1 difficulty profile + 1 predator archetype with the
   utility AI. ~2–4 months.
2. **Alpha (full island via World Partition, 10–15 species, core systems):** swim/dive PhysicsVolumes,
   the full survival AttributeSet, all three difficulty profiles, airdrop objective. ~6–10 months.
3. **Beta (all 30 species, ecosystem AI, multiplayer if in scope, optimization, content-complete):**
   port the predator-vs-prey / hierarchy / pack / herd behaviours to StateTree+EQS; **net robustness is
   the genuine new workstream** (the browser co-op is host-authoritative but lacks interpolation/ACK —
   UE5 replication solves this properly). ~4–8 months.
4. **Ship (polish, certification if console, marketing):** ~2–4 months.
Rough total: **~14–26 months** depending on team size, multiplayer, and console.

## Team (realistic minimum for AAA-look)
- Tech/gameplay programmer (UE5 C++/BP) · Environment artist · Character artist (or MetaHuman + contractors)
  · Animator · Technical artist (Nanite/Lumen/perf) · Designer · Audio (contract) · Producer/QA.
- **Solo + AI is not enough for true AAA** — AI accelerates concept/prototype, but shippable AAA assets,
  optimization, and multiplayer need specialists or marketplace assets + contractors.

## Budget bands (ballpark, USD)
- **Lean indie-AAA** (small team + heavy Megascans/MetaHuman/marketplace assets, no console, co-op-lite):
  **~$150k–$500k**.
- **Mid** (custom creatures/anims, full 10–20p multiplayer, more polish): **~$0.5M–$2M**.
- **Full AAA** (large team, console, original everything): **$5M+** and years.
- DIY/hobby with marketplace assets: time-heavy but cash-light for a **vertical slice** (engine + Megascans
  + MetaHuman are free; a dino marketplace pack is tens–hundreds of dollars).

## Recommended de-risking path (before any big spend)
1. **UE5 Vertical Slice** using **free/marketplace assets** (Megascans jungle + MetaHuman cadet + a
   marketplace T-Rex): one zone, walk + the extraction loop, photoreal. This is the cheapest way to (a) see
   the real target on screen and (b) decide if the full build is worth funding.
2. Keep the **browser game live** as the public-facing playable + marketing while the slice is built.
3. Reassess budget/team after the slice.

## My role here
I can: scaffold the UE5 project structure, write the GDD/tech-design docs, define the Data-Asset schema
mirroring `species.json`, draft Blueprint/C++ system designs (AI, extraction, threat), set up the import/
asset-naming conventions, and write the marketplace/Megascans/MetaHuman shopping list for the vertical slice.
I cannot author production-grade 3D art/animation or run the editor for you — that's hands-on UE5 + artist work.
