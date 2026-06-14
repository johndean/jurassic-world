# AAA ZERO-GAP AUDIT — Jurassic World Survival (Island Alpha)

> Supreme Design Authority review against two mandates: (1) zero-gap audit of **every** system, and
> (2) terrain/traversal/water physical-authenticity. Every "Current State" claim below is tied to a
> real `game.js` / `index.html` / `strings.js` / `species.json` line, not aspiration. This is a
> **document-only** pass — no code/data/assets changed. All recommendations are **conservative &
> additive** (per owner): they layer on top of existing systems and must never regress free-walk.

**Core survival test applied throughout:** *would this information / mechanic / system improve a real
field operative's ability to survive and complete the mission?* If yes → improve. If no → cut/redesign.

---

## §0 — Executive Summary & Verdict Table

The game is structurally strong: data-driven missions, a genuinely reactive (if player-centric)
predator/prey AI, an in-universe tactical HUD + map, full input parity (KB/mouse, gamepad, touch),
and detailed scripted vehicle intros. The dominant gap class is **physical-world authenticity** — the
island looks solid but mostly isn't — and a smaller class of **information completeness** gaps.

| # | System | Grade | Single biggest gap |
|---|--------|-------|--------------------|
| 1 | World solidity (collision) | 🔴 Missing | Player ghosts through rocks, ruins, buildings, mission props, vehicles, fences |
| 2 | Traversal (jump/vault/mantle/climb) | 🔴 Missing | No jump or vault; only scripted tower-climb + intro zip/canopy |
| 3 | Water / swimming / diving | 🔴 Missing | Water is cosmetic; player walks the riverbed, never swims |
| 4 | Terrain / elevation gameplay | 🟡 Partial | Heightmap exists & is followed, but elevation affects nothing (no stamina/vision/speed) |
| 5 | Dino terrain interaction | 🔴 Missing | Dinos clip terrain & all move identically; no aquatic/flying/large-body locomotion |
| 6 | Information / HUD | 🟢 Strong | No persistent beacon-distance or mission-% on HUD |
| 7 | Map & overlays | 🟡 Partial | Dino dots only — no threat radius, territory, state, or last-seen |
| 8 | Map legend (zero-gap) | 🔴 Defect | Map legend lists **SAFE ZONE** but `mapSVG` never draws it (it exists only as a 3D ground ring) |
| 9 | Mission design & flow | 🟡 Partial | Item-objects, building collision, co-op progress sync still abstracted |
| 10 | Dinosaur AI & ecosystem | 🟡 Partial | Alive but **player-centric**: no predator-v-predator, territory, nesting, feed/rest, migration |
| 11 | Vehicles | 🟡 Partial | Detailed exteriors, but no instrumentation/gauges; cinematic-only (not drivable) |
| 12 | Navigation | 🟢 Strong | Compass + GPS + map solid; no waypoint/route planning |
| 13 | Environmental storytelling | 🟡 Partial | Set-pieces exist but rarely "tell a story without exposition" |
| 14 | Combat | 🟡 Partial | Tranq/trap/sample kit is good; no lethal defense / melee feedback depth |
| 15 | Stealth | 🟡 Partial | Noise + crouch + FOV cones exist; no cover/lean/distraction systems |
| 16 | Survival systems | 🟡 Partial | Health/stamina/noise solid; no hunger/thirst/temperature/injury states |
| 17 | Progression | 🟡 Partial | Role perks exist; no persistent unlocks/loadout meta |
| 18 | Multiplayer / co-op | 🟡 Partial | Host-authoritative mission/seed works; dino & mission-progress sync is per-client |
| 19 | Accessibility | 🟡 Partial | Colorblind/scalable-text/subtitle options not surfaced |
| 20 | Audio | 🟢 Strong | Real human VO + radio + synthetic fallback; positional dino audio thin |
| 21 | Animation | 🟢 Strong | Procedural gait/attack/slump; no terrain-adaptive foot/IK |
| 22 | Controls | 🟢 Strong | KB/mouse + gamepad + touch all wired |
| 23 | Platform parity | 🟡 Partial | Compass/contact/threat hidden on small screens; minimap legend hidden on mobile |

Legend: 🟢 Strong (faithful) · 🟡 Partial · 🔴 Missing/Defect.

---

## §1 — Per-System Audit

Each entry: **Current State · AAA Benchmark · Gap · Risk · Root Cause · Impact · Recommendation
(conservative/additive) · Implementation Approach · Priority · Expected Improvement.**

### 1. World Solidity (Collision) — 🔴 Missing

- **Current State.** Only two collider types exist. Trees: ~30 solid trunks, circle push-out at
  `dist < (t.r + 0.5)` (`game.js:1375-1382`, array seeded in `buildFoliage` `game.js:826-832`).
  Watchtowers: perimeter push-out + ladder auto-climb (`game.js:1390-1395`). A perimeter clamp keeps
  the player in-bounds (`game.js:1384`). Code explicitly notes "no per-frame raycast; cost-bounded"
  (`game.js:1538`). **Everything else is walk-through**: 130 instanced rocks (`game.js:562-575`), all
  ruins (`buildRuins` `game.js:591-730`), all mission props — generator/cave/command/safehouse/supply
  (`buildSiteProp` `game.js:986-992`), the facility/bunker/comms tower (`buildFacility` `game.js:1167-1188`),
  fences, and intro vehicles. None are stored in a queryable collider list.
- **AAA Benchmark.** "If an object appears solid, it must behave as solid" — zero ghosting through any
  rock, wall, building, vehicle, or debris.
- **Gap.** ~99% of visually-solid geometry is non-solid.
- **Risk.** Immersion-breaking; trivializes threat (run *through* a building to escape a raptor);
  invalidates cover-based stealth and any "barricade" fantasy.
- **Root Cause.** A deliberate early perf decision (avoid per-frame raycasts), never revisited as the
  world filled with props. No central registry of placed solids to test against.
- **Impact.** Highest single immersion gap; undermines stealth, navigation, and threat tension at once.
- **Recommendation (conservative/additive).** Build a **queryable collider registry** populated at
  build-time (rocks, ruins, buildings, mission props, vehicles, fences) with cheap proxy shapes
  (circle for round props, AABB/oriented-box for walls). Extend the existing push-out loop — **same
  technique already used for trees** — so there is no new physics engine and no per-frame raycast.
  Tune push-out radii **inward** of the visual mesh so the player is never wedged or trapped (the
  owner's conservative bar). Spatial-hash the registry by grid cell so only nearby colliders are
  tested each frame.
- **Implementation Approach.** Add `colliders = []` with `{kind:'circle'|'box', x, z, r | hw,hl, yaw}`;
  push from each `build*` site. In `updatePlayer` after movement, query the cell hash and resolve the
  nearest few via the existing circle push + a box push helper. Reuse for `updateDinos` (`game.js:1924`).
- **Priority.** HIGH (roadmap pass 2).
- **Expected Improvement.** The island stops feeling like a stage flat; buildings/rocks become real
  cover and real obstacles; chases gain geography.

### 2. Traversal — Jump / Vault / Mantle / Climb — 🔴 Missing

- **Current State.** Locomotion is walk/run/crouch only (`updatePlayer` `game.js:1328-1413`,
  states set `game.js:1345-1349`). Player Y is *always* pinned to `playerFloorY` (`game.js:1127-1131`)
  → `groundH` (`game.js:1310-1318`); there is **no vertical velocity, no gravity, no jump**. The only
  vertical traversal is the scripted watchtower auto-climb (`climbTower` `game.js:1136-1140`) and the
  one-off zipline (`startZip`/`updateZip` `game.js:1141-1155`); intro HALO/canopy is also scripted.
- **AAA Benchmark.** Walk, sprint, crouch, jump, vault, mantle, climb, shimmy, drop, rappel — terrain
  as strategy, alternate vertical routes.
- **Gap.** No general jump/vault/mantle/climb; no ledge detection.
- **Risk.** Small obstacles hard-stop the player (once collision lands, a knee-high log would be an
  impassable wall) — *worsens* once world solidity ships, so this should follow closely.
- **Root Cause.** Movement model is purely horizontal-on-heightmap by design.
- **Impact.** Removes a whole axis of survival decision-making ("climb the cliff to escape the Rex").
- **Recommendation (conservative/additive).** Add an **opt-in** vertical layer that does not touch
  default walking: a `P.vy` vertical-velocity channel only engaged when jumping/falling/climbing;
  free-walk path unchanged when grounded and not jumping. Jump = small arc with gravity back to
  `groundH`. Vault/mantle = when blocked by a low collider with clear top, animate up-and-over.
  Climb = generalize `climbTower` to tagged climbable colliders (rock faces, ledges) with a hold input.
- **Implementation Approach.** Gate everything behind `if (P.vy || P.climbing)`; otherwise the
  existing grounded branch runs verbatim. Detect vault/mantle off the new collider registry (obstacle
  height < threshold + clear space beyond). Reuse zip's lerp pattern for climb interpolation.
- **Priority.** HIGH (roadmap pass 3, right after solidity).
- **Expected Improvement.** Terrain becomes a toolkit; players remember the cliff they climbed.

### 3. Water / Swimming / Diving — 🔴 Missing

- **Current State.** River is a carved terrain channel (`RIVER_HALF=17`, `WATER_Y=-0.55`, carve in
  `groundH` `game.js:1304-1318`) with a translucent water plane (`game.js:548-551`). During gameplay
  the player simply walks the **carved riverbed** — there is no depth check, no swim state, no
  buoyancy, no current, no drowning. Swimming exists nowhere; the boat is intro-only (`game.js:2605-2757`).
- **AAA Benchmark.** Classified water bodies; auto swim-state past walkable depth; diving, currents,
  oxygen, equipment drag, aquatic threats; "do I cross here?" as a real decision.
- **Gap.** Water is 100% cosmetic in gameplay.
- **Risk.** A signature Jurassic survival beat (river crossings, flooded facilities, Spino ambush) is
  absent; water reads as fake the moment a player steps in.
- **Root Cause.** Water plane is decorative; player Y is terrain-locked with no water-depth branch.
- **Impact.** Loses a major terrain-decision and tension system.
- **Recommendation (conservative/additive).** Add a **swim state** triggered when `WATER_Y − groundH`
  exceeds a wade threshold: float at surface, directional swim, stamina drain + current push, optional
  dive with an oxygen meter. Layer it as a new movement state alongside walk/run/crouch (same pattern
  as `game.js:1345-1349`); land movement untouched. Add at least one **lagoon** body so water matters
  outside the river.
- **Implementation Approach.** Compute depth from existing `groundH` vs `WATER_Y`; set
  `P.swim`/`P.dive`; replace floor-pin with surface-pin while swimming; add current vector from
  `riverCenter` slope; oxygen ticks during dive. Aquatic dinos (below) share the depth test.
- **Priority.** MED-HIGH (roadmap pass 4).
- **Expected Improvement.** Rivers become gates and escape routes; introduces aquatic dread.

### 4. Terrain / Elevation Gameplay — 🟡 Partial

- **Current State.** Real procedural heightmap (`groundH` `game.js:1310-1318`): rolling hills, a
  perimeter mountain ring rising 30 m+, and the carved river. Player, dinos, foliage, props all sample
  it. But elevation affects **nothing** mechanically — no slope stamina cost, no high-ground vision
  bonus, no speed change.
- **AAA Benchmark.** Height matters: visibility, recon, sniper/observation positions, escape routes,
  comms range, weather exposure — players actively seek high ground.
- **Gap.** Elevation is visual/positional only.
- **Risk.** Low (not broken, just under-exploited).
- **Root Cause.** Movement speed is flat; perception range isn't elevation-aware.
- **Impact.** Misses easy emergent-strategy wins already latent in the heightmap.
- **Recommendation (conservative/additive).** Add slope-aware stamina drain (uphill costs more) and an
  elevation term in player sight/spot range (and dino detection of the player). Purely additive to
  existing stamina (`game.js` vitals) and perception (`perceive` `game.js:1539`).
- **Implementation Approach.** Sample `groundH` gradient under the player; scale stamina cost + view
  distance. No new geometry.
- **Priority.** LOW-MED (fold into pass 3/4).
- **Expected Improvement.** Watchtowers/ridges become tactically meaningful, not just scenery.

### 5. Dino Terrain Interaction — 🔴 Missing

- **Current State.** Dinos are clamped to map bounds (`game.js:1874`) and placed at `groundH`
  (`game.js:1877`) but **ignore all obstacles** and use one shared `steer` (`game.js:1811`): movement
  differs only by `move.walk/run` scalars. Aquatic species (Spino/Baryonyx/Suchomimus/Mosasaurus)
  have no water behavior; Pteranodon has glide/flap/dive anims but no altitude — it patrols on the
  ground; Mosasaurus' `swim` anim never triggers.
- **AAA Benchmark.** Dinos obey the same world rules: raptors climb, big bodies struggle in tight
  spaces, predators use terrain for ambush, aquatic species swim, fliers fly.
- **Gap.** No terrain/obstacle respect; no per-archetype locomotion.
- **Risk.** Dinos clip through the very props the player will soon collide with — visible inconsistency.
- **Root Cause.** Single locomotion path; collision registry doesn't exist yet (see #1).
- **Impact.** Undercuts ecosystem believability and ambush design.
- **Recommendation (conservative/additive).** Once the collider registry exists, run dino movement
  through the same push-out (large bodies use bigger radii → naturally avoid tight gaps). Add
  archetype locomotion variants: aquatic dinos enter swim when depth>threshold; fliers track an
  altitude channel; small/agile species ignore low colliders (vault). All additive to `steer`.
- **Implementation Approach.** Branch `steer` by `archOf(sp)` for locomotion; reuse player swim/depth
  + collision helpers.
- **Priority.** MED (pairs with passes 2 & 4).
- **Expected Improvement.** A coherent world where threats move believably through it.

### 6. Information / HUD — 🟢 Strong (small gaps)

- **Current State.** `updateHUD` (`game.js:3161`, ~12 Hz) renders: mission title + dynamic objective
  subtitle with distance + hold timer (`game.js:3169-3170`), an objective checklist with
  ◆/▸/◇ states (`game.js:3172`), a 120° compass with heading° (`game.js:3180`, ticks `game.js:3144`),
  SQUAD STATUS + role tag + squad health + a 10-cell THREAT meter (`game.js:3192-3200`), a contact
  alert with species + cardinal bearing within ~70 m (`game.js:3204`), HEALTH/STAMINA/NOISE vitals
  with color thresholds (`game.js:3208-3210`), and the EXTRACTION WINDOW/INBOUND timer + call button
  (`game.js:3214-3228`). Labels come from `strings.js` (`STR.squadStatus`, `STR.vHealth`, `STR.gps`, …).
- **AAA Benchmark.** At every second: where am I, where to go, what's hunting me, phase, objectives
  remaining, distance to objective AND extraction, threat, resources, squad.
- **Gap.** Beacon **distance** and **mission progress %** only appear on the fullscreen map title
  (`game.js:3234`), not on the persistent HUD; no resource/tool-cooldown clarity surfaced.
- **Risk.** Low — the HUD is already one of the strongest systems.
- **Root Cause.** Distance/% were scoped to the map view.
- **Impact.** Minor awareness friction (player must open the map to gauge extraction range).
- **Recommendation (conservative/additive).** Add a persistent beacon-distance readout near the
  extraction widget and a mission-progress % from completed/total phases. Pure HUD additions.
- **Implementation Approach.** Reuse the beacon-distance math already in `mapSVG` (`game.js:3234`) and
  phase counts from the mission runtime; render two more HUD spans.
- **Priority.** HIGH (roadmap pass 1 — cheap, high-clarity).
- **Expected Improvement.** Constant extraction awareness without opening the map.

### 7. Map & Overlays — 🟡 Partial

- **Current State.** Corner minimap + togglable fullscreen tactical map share `mapSVG`
  (`game.js:3231-3348`). Layers drawn: valley boundary + mountain ring, river, extraction facility
  (pulsing), watchtowers, current objective (line + diamond), inbound evac heli (spinning rotor),
  **all live dinos** (carnivores as heading triangles, apex outlined; herbivores as cyan circles,
  with fullscreen tooltips), player view-cone + heading, and a North marker (`game.js:3305-3347`).
- **AAA Benchmark.** Map as survival tool with toggleable overlays: threat, territory, last-seen,
  nests/packs/alphas, migration routes, weather/flood/fire/blocked routes, recommended routes,
  facility/interior views.
- **Gap.** Dinos render as **live exact positions** with no threat radius, no territory/home range, no
  behavioral state (Hunting/Resting/Fleeing), no "last seen" memory, no pack/alpha/nest markers; no
  overlay toggles; no weather/hazard/route layers; no interior view.
- **Risk.** Med — perfect omniscient dino positions are both unrealistic *and* less tense than a
  "last-known + threat-radius" fog-of-war would be.
- **Root Cause.** Map draws straight from the live dino array each refresh; no perception-memory layer.
- **Impact.** The map is informative but neither tactical nor in-fiction (you shouldn't see every dino
  perfectly through the jungle).
- **Recommendation (conservative/additive).** Add a **dino intelligence layer**: show last-seen ghosts
  (decaying) for unsighted dinos, threat-radius rings sized by `combat`/`aggression`, a state label,
  and territory circles from `behavior.territoryRadiusM` (already in data). Make overlays toggleable
  (threat/territory/squad/route) and **complete the legend for each**. Keep current live view as the
  "sighted" tier so nothing regresses.
- **Implementation Approach.** Track per-dino `lastSeen{x,z,t}` updated when within player perception
  (`perceive` `game.js:1539`); draw rings/labels in `mapSVG`; add a layer-toggle row.
- **Priority.** HIGH (roadmap pass 1).
- **Expected Improvement.** The map becomes genuine threat intelligence, and fog-of-war adds tension.

### 8. Map Legend (Zero-Gap Defect) — 🔴 Defect

- **Current State.** The fullscreen **map** legend lists **11 entries** including **"SAFE ZONE · green
  circle"** (`index.html:509`), but `mapSVG` **never draws a safe-zone circle on the map**. The safe
  zone is a real mechanic — `SAFE_R = 18` m around the beacon where predators disengage and the player
  takes no damage (`game.js:1560-1561`, `playerSafe()`) — and it *is* rendered as a 3D ground ring in
  the world (`game.js:850-853`), but it is **absent from the tactical map** the legend belongs to.
  (Note: the `6.5` at `game.js:1410` is the unrelated extraction-*call* in-range distance, not the
  safe zone.) The corner minimap legend shows only 4 entries (`index.html:484-489`) and omits
  watchtowers, river, objective, evac, and apex distinction that the minimap *does* render.
- **AAA Benchmark.** Legend must match what's drawn, on every platform — zero gap.
- **Gap.** (a) Map legend promises a SAFE ZONE marker the map doesn't render; (b) minimap legend
  under-describes the minimap.
- **Risk.** Direct trust break — the player reads the key, looks on the map for the safety boundary,
  finds none. The owner has previously called out "proper KEY LEGEND zero-gap."
- **Root Cause.** Legend authored against the world ring, but the map renderer (`mapSVG`) was never
  given a matching circle.
- **Impact.** Small surface, outsized credibility cost — this is a *bug*, not a feature gap.
- **Recommendation.** **Draw the 18 m safe-zone ring** around the beacon in `mapSVG` (radius from
  `SAFE_R`, `game.js:1560`) so the map matches both the world ring and the legend; reconcile the
  minimap legend to the minimap's actual markers.
- **Implementation Approach.** One circle primitive in `mapSVG` at the beacon with radius scaled to
  map units; audit both legends against the draw list.
- **Priority.** HIGH — ship-now (roadmap pass 1, §3 defect).
- **Expected Improvement.** Legend tells the truth; players can see where safety begins.

### 9. Mission Design & Flow — 🟡 Partial

- **Current State.** Data-driven `MISSIONS` engine with `reach`/`interact`/`collect`/`extract` plus
  added `defend` and `boss` phases; `currentObjective()` (`game.js:287-299`) drives HUD + map. Per the
  existing `FAITHFULNESS_AUDIT.md`, the major bespoke beats are now real: BLACKOUT generator-draws-
  predators (#1), GHOSTS surveyor find/escort (#2), `defend` waves (#3), sequenced `extract` waves (#4),
  and the EXTINCTION Indominus boss + Mosasaurus + three endings (#5).
- **AAA Benchmark.** Every promised mechanic bespoke, not a relabeled hold-E.
- **Gap.** Remaining LOW/MED items from that audit: item-objects (access card / DNA container / radio
  log are abstract holds, not objects), building collision (see #1), and co-op sync of mission progress
  + dinos + survivors (see #18).
- **Risk.** Low-Med — core loops are faithful; residue is polish.
- **Root Cause.** Generic marker engine standing in for the last few bespoke interactions.
- **Impact.** Occasional "this is a generic hold" feel on a few steps.
- **Recommendation (conservative/additive).** Introduce a lightweight **item-object** phase type
  (pick-up/insert against a real placed prop) reusing `buildSiteProp`; resolve building collision via
  #1; resolve co-op via #18.
- **Implementation Approach.** New phase verb that references a prop id + carry flag; no rewrite of
  existing verbs.
- **Priority.** MED.
- **Expected Improvement.** The last few generic beats become tactile.

### 10. Dinosaur AI & Ecosystem — 🟡 Partial

- **Current State.** Real state machine: `decide` (`game.js:1749`) → `steer` (`game.js:1811`) →
  `updateDinos` (`game.js:1924`), **dispatched by archetype** (`archOf` `game.js:45`, `ROLE_ARCH`
  `game.js:46`, `archetypes.json`). States: Graze, Flee (with stampede propagation `game.js:1834`),
  Patrol, Investigate, Stalk, Chase (with pack flanking via `updatePackRoles` `game.js:1797`), Attack,
  Retreat, Down. Prey flee predators (`nearestPredatorTo` `game.js:1780`); predators hunt prey
  (`nearestPreyTo` `game.js:1785`, can kill, `game.js:1859`); herds cohere (`herdCenter` `game.js:1790`).
  LOD throttles distant AI. **43 species** in `species.json`.
- **AAA Benchmark.** Living ecosystem independent of the player: territory, migration, nesting,
  feeding, resting, fear hierarchy, predator-v-predator, environmental response, facility interaction.
- **Gap.** Ecosystem is **player-centric**: predators never fight each other; no territory enforcement,
  nesting/breeding, feeding/resting cycles, or migration (dinos just spawn/despawn at edges). Three
  declared fields are **unread**: `behavior.social`, `behavior.packRoles`, `behavior.noiseDrawWeight`.
- **Risk.** Med — the island feels reactive but not autonomous; goes quiet when the player isn't near.
- **Root Cause.** AI was built around the player as the primary stimulus; emergent inter-species rules
  were never added; pack roles are computed positionally rather than from species data.
- **Impact.** Limits the "living world" fantasy and replayability.
- **Recommendation (conservative/additive).** Add emergent layers **on top** of the working machine:
  predator-v-predator dominance (apex displaces lesser at kills), territory enforcement from
  `territoryRadiusM`, simple nest anchors + feeding/resting timers, and edge-to-edge migration paths.
  Wire the three unread fields (`social`→herd/pack/flock cohesion, `packRoles`→seed role assignment,
  `noiseDrawWeight`→spawn-director escalation). All additive states; existing transitions preserved.
- **Implementation Approach.** New `decide` branches + a lightweight world-tick for off-screen herds;
  reuse `nearestPreyTo`/`nearestPredatorTo` for inter-predator targeting.
- **Priority.** MED-HIGH (roadmap pass 5).
- **Expected Improvement.** The island lives whether or not the player is watching.

### 11. Vehicles — 🟡 Partial

- **Current State.** Five vehicles with detailed exteriors and partial interiors: helicopter
  (`buildHeli` `game.js:2036`), Land Rover jeep (`buildJeep` `game.js:2471`), patrol boat
  (`buildBoat` `game.js:2605`, armored hull + pilot house + .50-cal + searchlight), monorail
  (`buildMonorail` `game.js:2724`, lit interior + glass), airship flight deck (`buildAirshipDeck`
  `game.js:2808`). Players are correctly placed **inside** during intros (`INTRO_KIND` `game.js:2133`).
  All are **scripted cinematics** — no instrumentation/gauges, no drivable controls.
- **AAA Benchmark.** Every switch/button/display believable; cockpit, instrumentation, operational
  procedures; vehicles feel like genuine operational assets.
- **Gap.** No cockpit gauges/instrument readouts; not drivable.
- **Risk.** Low — intros already read well; this is a polish/depth ceiling, not a defect.
- **Root Cause.** Vehicles authored as cinematic set-pieces, not simulated systems.
- **Impact.** Vehicles impress on first view but don't reward inspection.
- **Recommendation (conservative/additive).** Add cockpit **instrumentation detail** (lit gauges,
  switches, displays) to the interiors players already see; defer drivability as a much larger,
  separate effort (not in this roadmap).
- **Implementation Approach.** Procedural instrument panels in the existing `build*` functions; emissive
  dials. No control/physics work.
- **Priority.** LOW-MED (roadmap pass 6).
- **Expected Improvement.** Vehicles reward the eye and reinforce the operational fiction.

### 12–23. Remaining Systems (complete-the-audit pass)

Shorter entries so the audit omits nothing the mandate names. Format compressed to
**State → Gap → Recommendation (additive) → Priority.**

- **12. Navigation — 🟢.** State: compass + GPS minimap + tactical map + objective line. Gap: no
  multi-waypoint or recommended/blocked-route layer. Rec: add route overlay alongside #7's toggles.
  Priority LOW-MED.
- **13. Environmental storytelling — 🟡.** State: real set-pieces (collapsed tower, ruined outpost,
  campsite, cave; survivors). Gap: scenes rarely *narrate* without text. Rec: add readable
  arrangement (claw marks, dropped gear, blood trails, last-stand tableaus) at existing sites via
  `buildSiteProp`. Priority MED (pairs with pass 6).
- **14. Combat — 🟡.** State: tranq/trap/sample field kit + threat/contact. Gap: thin lethal-defense
  + melee feedback; no weapon for adult-ranger fiction. Rec: additive defensive options + hit feedback;
  keep non-lethal core. Priority MED.
- **15. Stealth — 🟡.** State: NOISE vital, crouch, FOV cones (`perceive` `game.js:1539`). Gap: no
  cover/lean/peek or distraction throwables. Rec: cover snapping off the #1 collider registry +
  noise-decoy item. Priority MED (depends on #1).
- **16. Survival systems — 🟡.** State: health/stamina/noise. Gap: no hunger/thirst/temperature/injury
  or resource gathering. Rec: optional needs layer (toggle per mission) — additive vitals. Priority
  LOW-MED.
- **17. Progression — 🟡.** State: 6 role perks. Gap: no persistent unlocks/loadout meta across runs.
  Rec: lightweight unlock track keyed to mission completion. Priority LOW.
- **18. Multiplayer / co-op — 🟡.** State: host-authoritative mission + seed via `net.js`/`server.js`;
  `coopSpread` at hand-off. Gap: dino positions, mission-phase progress, and survivors are per-client.
  Rec: host-authoritative broadcast of dino + phase state on the existing snapshot path. Priority
  MED-HIGH (prerequisite for true co-op faithfulness).
- **19. Accessibility — 🟡.** State: scalable touch UI, monospace high-contrast HUD. Gap: no surfaced
  colorblind palette, text-scale, or subtitle toggles. Rec: options panel exposing palette/scale/
  subtitle flags. Priority MED (cheap, broad benefit).
- **20. Audio — 🟢.** State: real human VO (Inworld TTS m4a) + radio + synthetic fallback. Gap: thin
  positional dino audio. Rec: distance/bearing-attenuated roars/footfalls. Priority MED.
- **21. Animation — 🟢.** State: procedural gait/attack/slump, rotor alignment fixed. Gap: no
  terrain-adaptive foot placement/IK. Rec: defer (high cost, low survival value). Priority LOW.
- **22. Controls — 🟢.** State: KB/mouse + gamepad + touch all wired (`game.js:1233-1301`). Gap: gamepad
  lacks a dedicated map button. Rec: bind map to a gamepad button. Priority LOW.
- **23. Platform parity — 🟡.** State: full touch control suite. Gap: compass/contact/threat hidden on
  small screens (`game.js:398`); minimap legend hidden on mobile (`game.js:401`) — violates the
  "equal awareness on every platform" mandate. Rec: reflow (collapsible/condensed) instead of hiding
  critical awareness elements on mobile. Priority MED-HIGH (explicit mandate breach).

---

## §2 — Prioritized Implementation Roadmap

Ordered by impact-to-effort. Each pass is independently shippable, conservative/additive, and
preserves free-walk. Owner picks the order; this is the recommended sequence.

1. **Tactical Awareness** *(small, high-clarity — recommended first)*
   - Fix the **SAFE ZONE legend defect** — draw the 18 m ring (radius from `SAFE_R`, `game.js:1560`) in `mapSVG`.
   - Persistent HUD **beacon distance** + **mission progress %** (reuse `game.js:3234` math).
   - Map **dino-intelligence overlay**: last-seen ghosts, threat-radius rings, state labels, territory
     circles (`territoryRadiusM`), toggleable layers, **complete legend** on both map + minimap.
   - Fix **platform parity** (#23): stop hiding compass/contact/threat + minimap legend on mobile.
2. **Solid World** — collider registry (rocks/ruins/buildings/props/vehicles/fences) → push-out in
   `updatePlayer` + `updateDinos`, spatial-hashed, tuned to never trap.
3. **Traversal** — opt-in jump + vault/mantle + generalized climb (extends `climbTower`); free-walk
   path untouched. Add slope-stamina + high-ground vision (#4).
4. **Water** — swim/dive state on depth threshold (river + a new lagoon), stamina/oxygen/current;
   aquatic + flying dino locomotion (#5).
5. **Living Ecosystem** — predator-v-predator, territory, nest/feed/rest, migration; wire `social`,
   `packRoles`, `noiseDrawWeight`.
6. **Vehicle Instrumentation + Environmental Storytelling** — cockpit gauges/switches; readable
   site-story set-dressing.

---

## §3 — Zero-Gap Defects (ship-now bugs, not features)

These are outright correctness gaps, separate from feature work:

1. **SAFE ZONE legend mismatch** *(headline)* — the map legend lists it (`index.html:509`), but
   `mapSVG` never draws it on the map; the safe zone is real (`SAFE_R = 18` m, `game.js:1560-1561`) and
   rendered as a 3D ground ring (`game.js:850-853`), just missing from the map. Recommendation: **draw
   the 18 m ring on the map** so it matches the world and the legend.
2. **Minimap legend under-describes the minimap** — 4 entries (`index.html:484-489`) for a minimap that
   also renders watchtowers, river, objective, evac, and apex distinction.
3. **Mobile awareness omissions** — compass/contact/threat (`game.js:398`) and minimap legend
   (`game.js:401`) hidden on small screens, breaching the platform-parity mandate.
4. **Pteranodon never flies / Mosasaurus never swims** — anims exist (`glide/flap/dive`, `swim`) but
   are never triggered; both move as ground walkers. Visible inconsistency.

---

*End of audit. Document-only pass — no code, data, or assets modified.*
