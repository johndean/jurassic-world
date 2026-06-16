# AAA ZERO-GAP AUDIT — Jurassic Survival: Island Alpha

> **Current-state audit as of build `2026-06-16-s`** (live on Railway).
> Method: five parallel read-only code audits (missions, toolset/combat, dino AI/ecosystem,
> player/traversal/survival/vehicle, world/HUD/map/platform/co-op) against `game.js`,
> `index.html`, `net.js`, `data/species.json` — every "state" claim is tied to a real file:line.
> Disputed "critical" findings were re-verified against the source before inclusion (see §3).
>
> This **supersedes** the prior version of this doc, which graded the game before this session's work.
> Most of the formerly 🔴/🟡 items (world collision, traversal, swim/dive, survival, map overlays,
> drivable vehicles, living ecosystem) are now **shipped**. See §1 for the delta.

**Core survival test applied throughout:** *would this mechanic/information improve a real field
operative's ability to survive and complete the mission?* If yes → keep/improve. If no → cut.

---

## §0 — Executive Summary & Verdict Table

The game is now a **content-complete, systemically deep extraction survival prototype**. The dominant
gap class has shifted from "physical-world authenticity" (largely closed this session) to **online
robustness** (co-op net sync) and **content depth** (ecosystem behaviors not yet modeled). It is fully
playable solo on desktop, gamepad, and iPad, across three difficulty tiers.

| # | System | Grade | Single biggest remaining gap |
|---|--------|-------|------------------------------|
| 1 | World solidity (collision) | 🟢 Strong | Small rocks (s≤1.35) & survivor NPC are walk-through by design |
| 2 | Traversal (jump/vault/mantle/climb/zip) | 🟢 Strong | Vault height cap is a hard 1.3 m with no feedback |
| 3 | Water / swimming / diving | 🟢 Strong | Drowning lacks a distinct audio cue; no underwater geometry |
| 4 | Terrain / elevation gameplay | 🟢 Strong | Uphill stamina + slope tilt done; no vision/altitude advantage rules |
| 5 | Dino terrain interaction | 🟢 Strong | Fliers/aquatic/wading + structure-slide done; no true pathfinding |
| 6 | Information / HUD | 🟢 Strong | Threat meter is integer-quantised; contact bearing is 8-point |
| 7 | Map & overlays | 🟢 Strong | Pinch-zoom strokes thicken; ghost TTL fixed at 28 s |
| 8 | Map legend / safe-zone (former defect) | 🟢 Fixed | Safe-zone ring now drawn (game.js:4254) + airdrop marker |
| 9 | Mission design & flow | 🟢 Strong | `collect` phase handler is dead code; no item-pickup phase type |
| 10 | Dinosaur AI & ecosystem | 🟢 Strong | No nesting/migration/drinking; `fightsWhenCornered`/`stalkPreferred` unwired |
| 11 | Vehicles | 🟢 Strong | Jeep body is a static 2.2 m circle; no respawn if destroyed |
| 12 | Navigation | 🟢 Strong | No multi-waypoint route planning |
| 13 | Environmental storytelling | 🟡 Partial | Set-pieces exist; few "tell a story without exposition" beats |
| 14 | Combat / defense kit | 🟢 Strong | No lethal-vs-deterrent escalation tree beyond melee |
| 15 | Stealth | 🟢 Strong | Noise+crouch+FOV+LOS done; no lean/cover-snap/peek |
| 16 | Survival systems | 🟢 Strong | Hunger/thirst/temp/injury done; no rest/sleep or rations inventory |
| 17 | Progression | 🟡 Partial | Win-gated unlocks + career line; thin meta (2 unlock tiers) |
| 18 | Multiplayer / co-op | 🟡 Partial | Host-authoritative works; **no remote interpolation / packet ACK** |
| 19 | Difficulty (NEW) | 🟢 Strong | Static per-run; no adaptive/dynamic scaling |
| 20 | Airdrop resupply (NEW) | 🟢 Strong | Landing spot not terrain-filtered (could land in water/rock) |
| 21 | iPad/Safari hardening (NEW) | 🟢 Strong | Double-tap guard could false-positive; Android pinch relies on touch-action |
| 22 | Rendering / performance | 🟢 Strong | No texture LOD, no frame cap (mobile thermals), no shadows |
| 23 | Accessibility | 🟢 Strong | Colourblind/HUD-scale/subtitles/high-contrast; no audio slider/reduce-motion |

Legend: 🟢 Strong/shipped · 🟡 Partial · 🔴 Missing. **Zero systems are 🔴 as of this build.**

---

## §1 — What shipped since the previous audit (the delta)

These were 🔴 Missing or 🟡 Partial in the prior audit and are now implemented & live:

| Area | What landed | Evidence |
|------|-------------|----------|
| World collision | Queryable collider grid + push-out for player **and dinos** | game.js:928–985, dino call 2407 |
| Traversal | Jump, auto-vault, mantle-onto-props, tower climb, zipline; height-aware | game.js:1550–1594, 1309–1332 |
| Water | Swim + dive + oxygen + current drift + entry toast + swim body pitch | game.js:1625–1677, 1712–1716 |
| Survival | Hunger, thirst, temperature, injury/bleeding, speed penalties + HUD chips | game.js:1762–1777, 4114–4122 |
| Map | Threat radius, territory, last-seen ghosts, safe-zone ring, layer toggles | game.js:4254–4326 |
| Ecosystem | Predator-vs-prey hunt→feed, predator hierarchy, herd cohesion, stampede, pack roles | game.js:2280–2304, 2363–2377 |
| Vehicles | **Drivable** jeep in every mission, safe-zone-on-board, chase-cam | game.js:3299–3363 |
| **Difficulty tiers (new)** | Explorer/Survivor/Apex; 8 multipliers; 3rd start-tab; persisted | game.js:446–459, initDifficultySelect |
| **Airdrop resupply (new)** | RESUPPLY when a consumable is empty → plane → parachute crate ≤100 m → map objective → refill | game.js:1960–2027, map 4256 |
| **iPad/Safari hardening (new)** | gesturestart + 2-finger + double-tap guards, in-map pan/zoom, RESET VIEW recovery | game.js:2873–2909, 4349+ |
| **Dino movement overhaul (new)** | Arrival slowdown, jitter dead-zone, stable wander, agility-scaled turning, water/structure behavior | game.js:2382–2418, 2308–2317 |

---

## §2 — Per-system current state (verified)

### Missions & campaign — 🟢 Strong
- 7 missions: `evac`, `dna` (simple, step-based) + 5 campaigns with declarative phase chains
  (`last_sample`, `blackout`, `ghosts`, `fallen_outpost`, `extinction`). game.js:150–275.
- Phase engine handles `reach / interact / defend / boss / extract` with linear advance + objective
  toasts + 3D markers. game.js:393–437, 281–306.
- Survivor/escort generalised (Maya, Surveyor) with follow logic. game.js:1064–1190.
- Indominus boss: arrival→hunt→outcome with three branching endings (contain/lagoon/run). game.js:1255–1303.
- Evac: 6-phase helicopter state machine (incoming→…→liftoff). game.js:2697–2738.
- 7 distinct intro cinematics + voiced radio (crash/research/jeep/boat/monorail/halo/airship). game.js:2742–3854.
- **Gaps:** `collect` phase type handled (game.js:402) but used by no mission (dead code); no item-pickup
  phase type; extract waves have no hard cap (game.js:426–428); boss location hard-coded (game.js:1257).

### Toolset / combat / stealth — 🟢 Strong
- 6 tools (flare, decoy, melee, tranq, trap, sample) with charges/cooldowns and function-labeled FIRE
  button. game.js:2069–2076, 385.
- First-person tranq/sample SCOPE with look-to-aim reticle + re-tap-to-lower. game.js:2085–2107, 1421.
- Sedation model (`sedThreshold`, dart accumulation, `downT`, partial-dose decay). game.js:2093–2155.
- Binoculars (zoomable, species ID, scan→map sync). game.js:4173–4209.
- Deterrent effects: flare scare radius, decoy lure, melee damage+knockback+fear. game.js:2108–2141.
- **Gaps:** re-tap-lower hard-codes melee index 2 (game.js:1421); sampled dinos have no visual mark;
  reticle goes green on live dinos even for sample (which needs sedated/trapped).

### Dino AI & ecosystem — 🟢 Strong
- 11-state decision system at ~4 Hz; perception with sight range/FOV/LOS + noise-scaled hearing +
  crouch stealth + role `seen` mod. game.js:2227–2273, 1922–1937.
- Emergent ecosystem: prey hunting + kill→feed, predator hierarchy (`domScore`), herd cohesion,
  stampede contagion, pack lead/flank/harry. game.js:2280–2304.
- Movement overhaul (this session): arrival easing, jitter dead-zone, agility-scaled turn rate, stable
  wander, water uphill-avoidance, structure push-out, wade/float vertical. game.js:2382–2418, 2525–2535.
- **Gaps:** `Stalk` state effectively unreachable (Investigate preempts); `fightsWhenCornered` &
  `stalkPreferred` declared in data but unwired; no nesting/migration/drinking/calf-protection; pack
  roles re-shuffle every 0.4 s (no persistent bonds); naive seek (no pathfinding around concave geometry).

### Player / traversal / survival / vehicle — 🟢 Strong
- Free-look latched movement, 4 gaits, stamina/noise/fear, slope drain. game.js:1598–1733.
- Full traversal stack + height-aware collision (see §1). game.js:1550–1594.
- Swim/dive/oxygen/current; survival hunger/thirst/temp/injury with HUD chips; all state reset each
  run. game.js:1625–1677, 1762–1777, 3866.
- Drivable jeep with arcade physics, safe-zone-on-board, chase-cam. game.js:3299–3363.
- Roles/specialists: all 6 perks **verified applied** — speed (1624), seen (1926), heal (1637),
  hold (3873), drain (1632), noise (1628).
- **Gaps:** vault hard-cap 1.3 m without feedback; jeep has no respawn if removed; exit-vehicle/zipline
  landing not validated against geometry.

### World / HUD / map / platform — 🟢 Strong
- Collider grid + height field terrain (rolling hills, mountain ring, carved river). game.js:928–985, 1529–1537.
- Full tactical HUD (vitals, threat, contact bearing, compass, objective, survival chips, squad, DNA,
  RESUPPLY, RESET VIEW). game.js:4054–4172.
- Minimap + fullscreen tactical map with intel overlays, fog-of-war, **in-map pinch/drag pan-zoom**,
  airdrop & objective markers, safe-zone ring. game.js:4237–4400.
- iPad/Safari: layered zoom prevention + RESET VIEW recovery + viewport-meta reset. game.js:2873–2909.
- Options: colourblind / HUD-scale / subtitles / high-contrast, persisted. game.js:2853–2921.
- Rendering: DPR-cap 1.5, ACES tone-map, bloom+vignette, instanced rocks/foliage, tiered model
  streaming with grey-box fallback, dino LOD at `activeRadiusM`. game.js:566–597, 485–497, 2495–2511.
- **Gaps:** co-op has no remote interpolation or packet ACK (jitter/ghosts on loss); no frame cap
  (mobile thermals); no texture LOD/shadows; threat meter integer-quantised.

---

## §3 — Verified FALSE POSITIVES (do not re-flag)

An automated audit pass flagged these as "critical." Each was re-checked against source and is **correctly
implemented**. Recorded here so future audits don't waste effort re-investigating:

| Claimed gap | Reality | Evidence |
|-------------|---------|----------|
| COMMS `mod.hold` never applied | Applied to extraction holdMax each run | game.js:3873–3874 |
| TRACKER `mod.seen` never applied | Multiplied into predator sight range in `perceive` | game.js:1926 |
| Oxygen not initialised (could insta-kill) | Reset to 100 in startRun player Object.assign | game.js:3866 |
| Survival (hunger/thirst/temp/injured) not initialised | All reset in the same startRun assign | game.js:3866 |
| `missionSites` never populated | Built per-mission and pushed in the site builders | buildMissionSites + missionSites.push |

**Lesson reinforced:** verify before editing/reporting. (Consistent with prior FULL_REGRESSION_AUDIT findings.)

---

## §4 — Genuine remaining gaps, ranked

**P0 — online robustness (only true reliability gap):**
1. Co-op remote-player **interpolation** + dino-snapshot **sequence/ACK** — fixes jitter and ghost dinos
   on >100 ms latency / packet loss. (net.js + game.js:4534–4591.)

**P1 — content depth (gameplay richness, not bugs):**
2. Living-ecosystem behaviors: wire `fightsWhenCornered` (desperate herbivore defense) & a real `Stalk`
   ambush path; add drinking/nesting/migration; persistent pack bonds.
3. Mission variety: implement an item-pickup phase type; remove/justify the dead `collect` handler;
   cap extract-wave spawns; data-drive the boss location.
4. Progression meta: more unlock tiers + a loadout screen (only 2 win-gated unlocks today).

**P2 — polish & mobile:**
5. Frame cap + texture LOD for sustained mobile FPS/thermals.
6. Airdrop landing-spot terrain filter (avoid water/mountain/structure).
7. Jeep dynamic collider (box, not static circle) + respawn safeguard.
8. Vault-too-high feedback; sampled-dino visual mark; drowning audio cue.
9. Map pinch-zoom stroke compensation; finer compass bearing.

None of P1/P2 block play; they raise ceiling/finish. Only P0 affects reliability (co-op only).

---

## §5 — Relationship to the UE5 build

Every system above is **engine-agnostic game design** that now exists as a *proven, playable* reference —
not a spec. The browser prototype has de-risked the full loop (traversal, water, survival, ecosystem,
vehicles, difficulty, resupply, accessibility). See `UE5_PRODUCTION_PLAN.md` and `ue5/` for how these port
to Nanite/Lumen/MetaHuman, and `ue5/02_DATA_ASSET_SCHEMA.md` for the Data-Asset schema (now extended with
difficulty tiers, survival, and resupply). The prototype's role is unchanged: **vertical-slice reference +
public-facing playable** while the UE5 slice is built.
