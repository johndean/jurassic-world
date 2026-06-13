# Species & Ecosystem Architecture — v2 (Design Spec)

**Status:** design only. No gameplay code is changed by this document. It defines the
data-driven schema and generic AI that let Island Alpha scale from 3 → 30+ species (and
future hybrids) by **config + assets only**, with no AI/gameplay/database rewrite.

**Design goals (from product strategy):** one island, one extraction loop, 10–20 players
(future), 20 predators + 10 herbivores, living ecosystem that runs without players,
predator-vs-predator and predator-vs-prey emerging naturally, hybrids deployable by config.

---

## 1. Guiding principle (already half-true in the codebase)

`data/species.json` header already states: *"AI reads ONLY this. New dinosaur = new row + new .glb. No gameplay/AI code per species."* v2 makes that literally true. Today three things break it: AI branches on the hardcoded `role` strings (`grazer`/`pack`/`apex`) in `game.js`, and two declared fields (`behavior.packRoles`, `behavior.noiseDrawWeight`) are **never read**. v2 fixes both.

---

## 2. v2 schema — strict superset of current `species.json`

**Every existing key is preserved** (`id`, `displayName`, `diet`, `role`, `size`, `move`, `senses`, `combat`, `behavior`, `modelPath`, `animSet`, `greybox`). v2 adds six sibling blocks mapping to the 10 required profiles:

| Product profile | Where it lives in v2 |
|---|---|
| Species Profile | `id`, `displayName`, `diet`, `role`, `archetype` *(new)* |
| Size Profile | `size` (existing) |
| Animation Set | `animSet` (existing) |
| Diet Type | `diet` (existing) |
| Territory Rules | `territory` *(new; absorbs `behavior.territoryRadiusM`)* |
| Aggression Rules | `aggressionRules` *(new; absorbs `behavior.aggression`)* |
| Awareness Rules | `awareness` *(new; absorbs `senses`)* |
| Social Behaviour Rules | `social` *(new; absorbs `behavior.social`, `packRoles`)* |
| Migration Rules | `migration` *(new)* |
| Combat Rules | `combat` (existing) + `aggressionRules` |

New top-level key per species: **`archetype`** (string) — the behavior-profile reference (§4). Old `behavior.*` fields are kept for one migration release as deprecated aliases, then folded into the new blocks.

### 2.1 Filled predator example (T-Rex, apex)
```jsonc
{
  "id": "trex",
  "displayName": "Tyrannosaurus Rex",
  "diet": "carnivore",
  "role": "apex",                       // retained: HUD/minimap color coding
  "archetype": "apex",                  // NEW: drives AI dispatch
  "size":  { "lengthM": 12.5, "massKg": 8000, "eyeHeightM": 4.0 },
  "move":  { "walk": 2.8, "run": 10.5, "turnRate": 110 },
  "awareness": {                        // NEW (absorbs `senses`)
    "sightRangeM": 70, "sightFovDeg": 130, "hearingRangeM": 110,
    "smellRangeM": 140, "noiseDrawWeight": 1.0   // now actually read (§5)
  },
  "combat": { "damage": 55, "attackRangeM": 4.5, "attackCooldownS": 1.8, "health": 600 },
  "aggressionRules": {                  // NEW (absorbs `behavior.aggression`)
    "base": 0.55, "targetWeakBonus": 0.3, "fleeHealthPct": 0.0,
    "scavenges": true, "huntsSpecies": ["*herbivore", "*predator"]
  },
  "territory": { "radiusM": 220, "defends": true, "displaceRivals": true },
  "social":    { "kind": "solitary", "groupMin": 1, "groupMax": 1, "packRoles": [] },
  "migration": { "migrates": false },
  "modelPath": "/assets/models/dinos/trex.glb",
  "animSet": ["idle","walk","run","attack","roar","stagger","die"],
  "greybox": { "color": "#2b2d2e", "bodyL":3.4,"bodyW":1.2,"bodyH":1.7,"standH":4.6,"crest":false }
}
```

### 2.2 Filled herbivore example (Triceratops, large/armored herd)
```jsonc
{
  "id": "triceratops",
  "displayName": "Triceratops",
  "diet": "herbivore",
  "role": "grazer",
  "archetype": "herd-grazer-armored",
  "size":  { "lengthM": 9.0, "massKg": 9000, "eyeHeightM": 2.5 },
  "move":  { "walk": 2.0, "run": 8.0, "turnRate": 140 },
  "awareness": { "sightRangeM": 45, "sightFovDeg": 250, "hearingRangeM": 50, "smellRangeM": 30, "noiseDrawWeight": 0.0 },
  "combat": { "damage": 40, "attackRangeM": 3.0, "attackCooldownS": 1.5, "health": 700 },
  "aggressionRules": { "base": 0.0, "fleeHealthPct": 0.4, "fightsWhenCornered": true, "defendsYoung": true },
  "territory": { "radiusM": 80, "defends": false },
  "social":    { "kind": "herd", "groupMin": 4, "groupMax": 9, "protectsYoung": true, "stampedes": true },
  "migration": { "migrates": true, "routeTag": "valley-loop", "triggers": ["dawn","predatorPressure"] },
  "modelPath": "/assets/models/dinos/triceratops.glb",
  "animSet": ["idle","walk","run","graze","charge","stagger","die"],
  "greybox": { "color":"#6f746c","bodyL":2.4,"bodyW":1.2,"bodyH":1.2,"standH":2.6,"crest":false,"frill":true }
}
```

`huntsSpecies` supports `*herbivore` / `*predator` wildcards so a new species is huntable/hunter with zero edits to existing rows.

---

## 3. On-disk layout

```
data/
  species/
    manifest.json        # ["trex","triceratops",...] load order + spawn weights
    trex.json            # one file per species (v2 row)
    triceratops.json
    ...
  archetypes.json        # behavior-profile library (§4)
  biome.alpha.json       # unchanged
```

A small loader merges `manifest` + per-species files into the **same in-memory `SPECIES[id]` map** the code uses today, so downstream lookups are untouched. (Interim option: keep one `species.json` array and just add the new blocks — the per-file split is the scalable target for 30+ rows and per-species PRs.)

---

## 4. Archetype library (`archetypes.json`) — the "config-only" enabler

Each species names one `archetype`; the archetype supplies default state-machine wiring and tuning so a new species only overrides what's unusual.

| archetype | default state set | notes |
|---|---|---|
| `pack-hunter` | Idle, Stalk, Hunt, Flank, Harry, Fight, Scavenge, Flee | uses `social.packRoles` |
| `ambush` | Idle, Conceal, Lunge, Hunt, Fight, Flee | low noise, waits near routes |
| `pursuit` | Idle, Patrol, Chase, Hunt, Fight, Scavenge | high stamina |
| `water` | Idle, Wade, FishHunt, Ambush, Hunt, Fight | bound to river/swamp nav |
| `apex` | Idle, Patrol, Hunt, Territorial, Scavenge, Roar | displaces rivals; high `noiseDrawWeight` |
| `small-herbivore` | Idle, Graze, Flock, Flee, Stampede | |
| `herd-grazer` | Idle, Graze, Herd, Migrate, Flee, Stampede | |
| `herd-grazer-armored` | + ProtectYoung, FightWhenCornered | Trike/Anky/Stego |

Hybrids reference an existing archetype (or compose two) — **no new code**.

---

## 5. Generic AI / ecosystem state machine

**Key existing seam:** `steer()` in `game.js` already dispatches on a `state` **string** — so adding states is additive. The work is to stop branching on the hardcoded `role` enum and branch on `archetype` + data instead.

- **`decide(entity)`** — replace `if role === 'grazer'/'pack'/'apex'` with: look up `archetype` → allowed states → choose by data (`awareness`, `aggressionRules`, `territory`, `social`, `migration`) and world facts (nearby prey/rivals/carcasses/noise). Pure function of profile + perception.
- **New states** (each a `steer()` case): `Migrate`, `Territorial`, `Scavenge`, `Fight`, `ProtectYoung`, `Stampede`, `Conceal/Ambush`, `FishHunt`. Existing `idle/walk/run/graze/attack/flee` stay.
- **Wire up dead fields:** `awareness.noiseDrawWeight` feeds predator attraction during the extraction-hold noise spike; `social.packRoles` drives `updatePackRoles()` generically (any pack species, not just Deinonychus).
- **Ecosystem without players:** the sim already ticks all dinos on the fixed update; with the above, herbivores graze/herd/migrate/flee/stampede/defend-young and predators hunt/compete/defend-territory/target-weak/scavenge regardless of player proximity. Predator-vs-predator falls out of `territory.displaceRivals` + overlapping `huntsSpecies` `*predator`.

**Touch points in `game.js`:** `decide()`, `spawnDino()` (spawn by `manifest` weights + `archetype`, not enum), `updatePackRoles()` (generic), `steer()` (add state cases), and the noise/extraction code that should consult `noiseDrawWeight`. HUD/minimap keep reading `role` for color — unchanged.

---

## 6. Expansion seams

- **Hybrids (config-only):** drop `data/species/indoraptor.json` with `archetype: "pack-hunter"` (or a composed profile) + a `.glb` + a manifest entry. No code path is hybrid-aware; they're just species with strong stats and an archetype. Bioluminescent/camouflage/intelligence are data flags consumed by existing states.
- **Multiplayer (future, 10–20p):** the snapshot object `S` + fixed-tick loop is the seam. Make the ecosystem sim **server-authoritative** (one sim, N viewers); `logic.js` already exposes Colyseus-style stubs (`meta`, `setup`, `validateAction`, `applyAction`, `isGameOver`, `viewFor`) and `minPlayers/maxPlayers` (today 1/1 → raise to 20). No species/AI rewrite — the same `decide()`/`steer()` run on the authoritative host.

---

## 7. Migration path (fewest breaking changes)

1. **Additive schema:** add `archetype` + new blocks to the existing 3 rows; keep old `behavior.*` as deprecated aliases. *(No behavior change yet.)*
2. **Loader:** introduce `archetypes.json` + reader; map archetype→state set. Existing code still runs off `role`.
3. **Refactor dispatch:** swap `decide()`/`spawnDino()`/`updatePackRoles()` from `role` enum → `archetype`. **This is the only real breaking change** — isolate and test against the current 3 species (behavior must match today's).
4. **Wire dead fields:** `noiseDrawWeight`, `packRoles` (generic).
5. **Add states:** `Migrate/Territorial/Scavenge/Fight/ProtectYoung/Stampede/Conceal/FishHunt`.
6. **Split to per-species files** + manifest; add herbivore/predator rows incrementally (art from ASSET_BIBLE.md).
7. **(Later)** server-authoritative sim for multiplayer.

Risk is contained to step 3; everything else is additive. `role` is deliberately retained so HUD/minimap code is never touched.

---

## 8. Acceptance
A new species (or hybrid) ships with: one JSON row referencing an archetype + one `.glb` + one manifest line. No edits to `decide()`, `steer()`, spawn, combat, multiplayer, or DB. The ecosystem exhibits grazing, herding, migration, stampedes, young-defense, hunting, scavenging, territorial displacement, and predator-vs-predator — with no players present.
