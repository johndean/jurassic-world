# Mission Faithfulness Audit — design intent vs. engine reality

Audit of every mission against its own blurb/design (CAMPAIGN.md), grounded in what the code actually
does. Goal: name every place the **generic marker engine** stands in for a promised bespoke mechanic.

## What the generic engine actually does (the substitution layer)
Each campaign mission is an ordered `phases[]` list the engine drives with four verbs:
- **reach** — get within `r` of (x,z). *(proximity check, nothing else)*
- **interact** — reach the site + HOLD E at an auto-generated console. **Its only side effect is
  `starts:"evac"`** (begins extraction). Repair / hack / retrieve / insert / examine / defend are all the
  *same* hold with different label text.
- **collect** — count items (defined in the engine but **used by zero campaign missions**; only the simple
  DNA mission collects, via its own `dnaSamples`).
- **extract** — begin the evac hold + spawn **one** `species` at the edge, repeated; win on board.

Recently added (real, not generic): per-site **structures** (`buildMissionSites`), and **Maya**
(find/stabilise/escort) for FALLEN OUTPOST.

---

## Per-mission faithfulness

### EVACUATION (`evac`, simple) — ✅ Faithful
Promise: reach beacon, call evac, survive the hold as the apex closes in. Engine: locate→call steps, real
extraction hold + threat/spawns. Matches.

### DNA SAMPLE COLLECTION (`dna`, simple) — ✅ Faithful (the most complete mission)
Promise: glass with binoculars, tranq/trap & blood-sample live dinos from the towers, then evac. Engine:
full field kit (binoculars/tranq/trap/sample), `DNA_GOAL`, watchtowers, then beacon. Real systems, matches.

### THE LAST SAMPLE (`last_sample`, Easy) — 🟡 Mostly faithful
Spine present: dock → restore power → retrieve → cold vault → distress beacon → survive T-Rex; now has
facility/generator/dock structures + T-Rex at extract.
**Gaps (cosmetic):** "find the access card", "retrieve the DNA container", "insert DNA" are all generic
holds — no card/container objects or inventory; "predators have already entered" isn't shown until the
finale.

### OPERATION BLACKOUT (`blackout`, Medium) — 🟠 Core mechanic missing
Spine present: 3 generators → restart grid → escape; now has generator + command structures + Allosaurus.
**HIGH gap:** "**every generator you wake draws predators**" — the mission's defining mechanic — is **not
implemented**. `interact` has no noise/spawn effect; predators only arrive at the final `extract`.
**Also missing:** fence failures, storms, generator explosions, migrations (all promised in the blurb/CAMPAIGN.md).

### GHOSTS OF SECTOR 9 (`ghosts`, Hard) — 🔴 Low faithfulness
Spine present in text: campsite → evidence → radio log → cave → find surveyor → escort; now has
campsite/cave/structure props + Spinosaurus at extract.
**HIGH gaps:** there is **no surveyor NPC** — "Find the missing surveyor" is an empty hold at the cave;
there is **no escort** and nothing to "protect" (the survivor doesn't exist). Investigation/tracking
("examine the attack evidence", "follow the tracks") are generic holds with no clues/trail. The emotional
core (a person to find and save) is absent. *Maya's find/stabilise/escort pattern should be ported here.*

### FALLEN OUTPOST (`fallen_outpost`, Hard) — 🟡 Much improved, waves/pursuit missing
Now real: collapsed watchtower + ruined outpost, **Maya** (find → stabilise → she stands & follows to the
safehouse). Big step up.
**Gaps:** "raptors pursue" during the escort isn't implemented (no pursuit spawns); the finale spawns only
**Carnotaurus**, not the promised **Carnotaurus *then* T-Rex** two-wave hold; "load Maya first" isn't a real
load step (she isn't required at the evac); escort has no fail state (Maya can't be lost/killed).

### EXTINCTION PROTOCOL (`extinction`, Nightmare / finale) — 🔴 Low faithfulness for a finale
Spine present in text: command → comms → sector systems → unlock routes → defend → activate protocol →
final heli; now has command + generator structures + T-Rex at extract.
**HIGH gaps:** "**Defend the Command Center — hold the line**" is a generic HOLD-E, not a defense wave; **no
Indominus Rex boss**; **no Mosasaurus / Pteranodon**; **no multiple endings (A/B/C)**. As the campaign
finale it currently plays as one more reach/interact/extract chain with bigger numbers.

---

## Cross-cutting faithfulness gaps (affect multiple missions)

| # | Gap | Promised in | Status | Severity |
|---|-----|-------------|--------|----------|
| 1 | **Noise/"draws predators" on interact** | BLACKOUT (core), CAMPAIGN.md | Not implemented — `interact` only does `starts:"evac"` | **HIGH** |
| 2 | **AI survivor to find + escort + protect** | GHOSTS (surveyor) | Only Maya exists (FALLEN OUTPOST); ghosts has none | **HIGH** |
| 3 | **Boss encounter (Indominus Rex)** | EXTINCTION finale | Absent (0 refs) | **HIGH** |
| 4 | **Defense / hold-the-line waves** | EXTINCTION, FALLEN OUTPOST | "Defend" is a hold-E; no wave system | **HIGH** |
| 5 | **Multiple endings (A/B/C)** | EXTINCTION | Absent | MED |
| 6 | **Multi-wave extract ("X then Y")** | FALLEN OUTPOST (Carno→T-Rex) | `extract` spawns one species | MED |
| 7 | **Role system** | All tags (Ranger/Security/Scientist/Vet/Engineer) | Ships 6 generic perks (navigator/tracker/medic/comms/survival/research); tag roles don't map; no role-gated mechanics | MED |
| 8 | **Dynamic events** (storms/weather, fence failures, migrations, explosions) | BLACKOUT, CAMPAIGN.md | None in gameplay (storm is intro-cosmetic only) | MED |
| 9 | **Missing creatures** (Indominus, Mosasaurus, Pteranodon) | EXTINCTION, GHOSTS | Not in roster/spawns | MED |
| 10 | **Item interactions** (access card, DNA container, insert, radio log, evidence) | LAST SAMPLE, GHOSTS | Abstracted to generic holds — no objects/inventory | LOW |
| 11 | **Building collision** | implied by all set-pieces | Structures are visual only (walk-through) | LOW |
| 12 | **Co-op sync of mission progress + dinos + Maya** | co-op | Per-client (phase progress, dino positions, Maya all local) | MED |
| 13 | **Declared-but-unwired species data**: `behavior.noiseDrawWeight` (trex), `behavior.packRoles` (deinonychus) | species.json | Present in data, never read by code | LOW |

---

## Severity-ranked fix list (recommended order)

1. **BLACKOUT noise-draws-predators** (HIGH, smallest fix) — add a per-`interact` `draws` spawn: completing
   a generator repair spawns/aggros predators toward the player. Restores the mission's core loop. *(~engine-local)*
2. **GHOSTS surveyor + escort** (HIGH) — port the Maya pattern (a survivor NPC at the cave you find →
   trigger → escort). Generalize Maya into a reusable `survivor` system keyed off a phase tag.
3. **Defense waves** (HIGH) — a `defend` phase type (hold N seconds while waves spawn) for EXTINCTION &
   FALLEN OUTPOST, replacing the hold-E stand-in.
4. **Multi-wave extract** (MED) — let `extract` take `species: ["carnotaurus","trex"]` sequenced waves.
5. **EXTINCTION finale set-piece** (HIGH but large) — Indominus boss + (optionally) endings; the biggest
   bespoke build, multi-session.
6. **Role system** (MED) — reconcile the 6 perks to the 5 design roles + add role-gated mission beats.
7. **Dynamic events, item objects, building collision, co-op sync** (LOW–MED) — polish passes.

## Bottom line
The two **simple** missions (EVACUATION, DNA) are faithful. Of the five **campaign** missions: LAST SAMPLE
and FALLEN OUTPOST are now mostly faithful (FALLEN OUTPOST after the Maya/set-piece work); **OPERATION
BLACKOUT, GHOSTS OF SECTOR 9, and EXTINCTION PROTOCOL have core promised mechanics still served by the
generic hold-E marker** (generator-draws-predators, the survivor/escort, and the defend/boss/endings finale
respectively). Fixes #1–#4 above remove most of the "generic marker" feel for a contained amount of work;
#5 (Indominus finale) is the one genuinely large bespoke build.
