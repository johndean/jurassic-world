# UE5 Vertical Slice — Game Design Document

**Project:** Jurassic Survival: Island Alpha (UE5 photoreal build)
**This doc:** the *vertical slice* only — the smallest playable thing that proves the photoreal target on screen, so the full-build investment can be decided with eyes-on evidence rather than concept art.
**Parent plan:** `../UE5_PRODUCTION_PLAN.md` (full scope, team, budget). **Canon source:** the live browser game (`strings.js`, `data/species.json`, `data/archetypes.json`, `data/biome.alpha.json`, `logic.js`).

> The browser game keeps shipping in parallel and serves as the *playable proof the loop is fun*. The slice proves the loop is **beautiful**. Neither blocks the other.

---

## 1. Purpose & success criteria

**Goal:** one zone, one full extraction loop, photoreal (Nanite + Lumen), running at 60 fps on a mid-range gaming PC.

The slice is a **success** when all of these are true:
1. A player walks/sprints/crouches a MetaHuman cadet through a foggy jungle valley that reads as the start-screen key art (`background.webp`), not grey-box.
2. The full loop works solo: **reach beacon → call extraction (`E`) → survive the 75 s hold → evac.**
3. At least **3 creatures** are present and behave by **archetype** (one herd-grazer, one pack-hunter, one apex) — driven by Data Assets, not bespoke Blueprints.
4. The **threat / noise / stealth** systems are live: sprinting draws predators, crouching reduces detection, threat level rises during the hold.
5. A standing screenshot is **indistinguishable in look** from a target render to a non-expert. This is the go/no-go artifact.

**Explicitly OUT of the slice** (deferred to Alpha/Beta — see parent plan): full island/World Partition, all 30 species, multiplayer, hybrids, weather system, audio polish, console. The slice is single-player, one zone, fixed weather (overcast fog).

---

## 2. The zone

One hand-built **~250 m × 250 m valley** mirroring `biome.alpha.json` `map.size: 240`:
- Foggy jungle valley floor, mountain ring on the perimeter, a **winding river**, dirt clearings, scattered boulders — same silhouette as the browser game's terrain so the layout is already validated.
- **Extraction facility** in the mid-distance (helipad + bunker + comms tower + floodlights), matching `buildFacility()` in the browser build.
- Heavy **Lumen** GI + volumetric fog + god-rays = the painted "feel" the browser version can only approximate.
- Lighting preset: **overcast, low sun, blue-grey haze** (palette below). No day/night in the slice.

## 3. The loop (mirrors the shipping loop exactly)

| Beat | Source of truth | UE5 system |
|---|---|---|
| Spawn at valley edge, objective `Reach the extraction beacon` | `STR.objReach` | UMG objective widget |
| Traverse to beacon ring (`beaconPickRingM: [70,95]`) | `biome.alpha.json extraction` | nav + GPS widget |
| Press **E** → `CALL EXTRACTION` | `STR.callExtraction` | input action |
| Survive **75 s hold**, threat escalates | `extraction.holdSeconds: 75` | Extraction subsystem + threat |
| Evac → `EXTRACTED` / death → `WIPED` | `STR.winTitle` / `STR.loseTitle` | game-state |

**Player constants (verbatim from `biome.alpha.json player`):** health 100, stamina 100, walk 4.2, run 7.4, crouch 1.9, staminaDrain 22/s, staminaRegen 16/s, healthRegen 2.4/s. Noise: crouch 0.05 / walk 0.4 / run 1.0 / idle 0.0 / call 1.0.

## 4. Creatures in the slice (3, one per core archetype)

Chosen so each exercises a different branch of the archetype AI (`data/archetypes.json`):

| Species | Archetype | `behaviorClass` | Proves |
|---|---|---|---|
| **Parasaurolophus** | `herd-grazer` | prey | herd graze + flee-from-predator + ambient ecosystem |
| **Deinonychus** | `pack-hunter` | predator | `packTactics` lead/flank/harry coordination |
| **Tyrannosaurus Rex** | `apex` | predator | `apexThreat` pressure, noise-draw, the hold-phase escalation |

All three already exist as profiles in `species.json` with sizes/senses/combat tuned — the slice **reuses those numbers directly** as Data Asset values (see `02_DATA_ASSET_SCHEMA.md`).

## 5. HUD (UMG, match real labels — not the decorative mock)

From `strings.js`, in palette: `MISSION OBJECTIVE`, `SQUAD STATUS`, `THREAT LEVEL 0/10`, vitals `HEALTH`/`STAMINA`/`NOISE`, `GPS · ISLAND ALPHA` + heading°, `EXTRACTION WINDOW` → `EXTRACTION INBOUND` MM:SS, `CALL EXTRACTION`, predator alert `Predator movement · [bearing]`.

**Palette (from `index.html` CSS vars):** bg `rgba(10,14,13,.62)`, text `#d7e0da` / dim `#8a978f`, accent (amber) `#e0772f`, good `#6fae6b`, warn `#c9a23a`, alert `#d6562f`, stamina `#8fb8c4`, water `#5b9fd6`. Monospace, all-caps titles.

## 6. Player character

One **MetaHuman** adult cadet, weapon-free survival outfit (matches the browser player styling: olive technical jacket, cargo trousers, boots). MetaHuman solves the hand/rig problems we hit with AI image→3D in the browser build. Locomotion: idle / walk / run / crouch blendspace (Lyra or marketplace locomotion set retargeted).

## 7. Timeline & cost (slice only)

~**2–4 months** part-time (per parent plan milestone 1). Cash: **engine + Megascans + MetaHuman are free**; the only spend is an optional dinosaur marketplace pack (tens–low-hundreds USD) — see `04_SHOPPING_LIST.md`. The expensive resource is *artist/engineer time*, not licenses.

## 8. Go / no-go after the slice

If the slice screenshot convinces and the loop still feels good in photoreal → greenlight Alpha (World Partition island, 10–15 species) per parent plan. If not → the browser game remains the product and we've spent only free assets + slice time to learn that. **This is the entire point of doing a slice before a budget.**
