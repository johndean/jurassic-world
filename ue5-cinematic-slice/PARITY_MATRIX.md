# Phase 1 — Discovery & Parity Matrix

**Source of truth:** the live browser game (`../game.js`, `../index.html`, `../net.js`, `../data/*.json`),
build `2026-06-16-s`, as audited in `../design/AAA_ZERO_GAP_AUDIT.md`. **The UE5 Cinematic Slice is a visual
interpretation of this game — gameplay behaviour and values must MATCH; no divergence unless documented here.**

This matrix is the discovery deliverable required before slice build: every production system, its UE5
equivalent, and a gap analysis. "Parity" = the UE5 client must reproduce the *same numbers and rules*; only
the *presentation* changes. Production is untouched by this document (it is read-only analysis).

Gap legend: **Port** = straight 1:1 mapping of proven rules · **Fidelity** = same rules, dramatically better
presentation (the whole point) · **New** = genuine new engineering not present/robust in the browser.

---

## A. Player, movement & traversal

| Current system (browser) | UE5 equivalent | Gap | Parity requirement |
|---|---|---|---|
| Free-look latched movement, 4 gaits (game.js:1598) | `CharacterMovementComponent` + EnhancedInput | Port | walk 4.2 / run 7.4 / crouch 1.9 m/s; stamina gates run |
| Jump / auto-vault / mantle (game.js:1550–1594) | CMC jump + Motion Warping + climbable tags | Port + Fidelity | GRAV 22, JUMP_V 7.4; vault ≤1.3 m, mantle 1.6–4.2 m |
| Tower climb + zipline (game.js:1309–1332) | ladder volume + Spline ride | Port | scripted traversal, ~1.7 s zip |
| Third-person orbit camera (cam, game.js:525) | SpringArm + Camera | Fidelity | over-shoulder, pitch/dist preserved |
| Stamina / noise / fear (game.js:1631–1637) | attributes + UMG vitals | Port | same drain/regen; fear throttles regen |

## B. Water

| Swim/dive/oxygen/current (game.js:1625–1677) | Water plugin volumes + `MOVE_Swimming` + Oxygen attribute | Port + Fidelity | deep>1.1 m swims; dive>2.0 m; O₂ −14/s diving; 1.5 m/s downstream current |
| Per-archetype water behaviour (dinoY, game.js:2525) | swim (aquatic) / wade-avoid (land) / ignore (flier) via EQS | Port | aquatic float at surface; land steers uphill out unless hunting |

## C. Survival layer

| Hunger/thirst/temp/injury (game.js:1762–1777) | GAS AttributeSet + status UMG strip | Port | thirst 100/420 s, hunger 100/780 s; HP≤28→bleed (non-lethal); injured ×0.78 speed |
| Refills (supply/campsite/water) | overlap GameplayEffects | Port | same site list + water=thirst |

## D. Dinosaur AI & ecosystem

| 11-state utility AI `decide`/`steer` (game.js:2227–2418) | `ST_Creature` StateTree (one shared, archetype-parameterized) | Port + Fidelity | same states/transitions; dispatch on **archetype**, never species id |
| Perception sight/FOV/LOS + hearing (game.js:1922) | AIPerception (sight+hearing senses) | Port | sightRange×FOV×LOS; hearing scales with player noise; crouch ×0.45 |
| Predator-vs-prey hunt→feed, hierarchy `domScore` (game.js:2280) | EQS + StateTree services | Port | emergent pecking order; kill→feed timers |
| Herd cohesion + stampede (game.js:2285–2347) | flock/EQS + event propagation | Port + Fidelity | cohesion>16 m; scare contagion <≈15 m |
| Pack lead/flank/harry (`updatePackRoles`, game.js:2292) | `UPackCoordinator` subsystem | Port | roles from `behavior.packRoles` |
| Movement overhaul: arrival, jitter dead-zone, agility turn, wander (game.js:2382–2418) | CMC + StateTree steering | Port | reproduce the anti-twitch feel (arrival slowdown, turnRate-scaled) |
| Procedural gait/roar/footfall (animateDino, game.js:2423) | **skeletal clips** via AnimBP per archetype | **Fidelity (big)** | browser procedural = design-intent ref for real clips; quadrupeds never use humanoid walk |
| Forward-declared `fightsWhenCornered`/`stalkPreferred` (unwired) | StateTree `Fight`/`Stalk` states | **New** | implement the behaviours the data already declares |

## E. Combat / toolset / stealth

| 6 tools flare/decoy/melee/tranq/trap/sample (game.js:2069) | input actions + ability components | Port | same charges/cooldowns/effects |
| First-person tranq/sample scope (aimMode, game.js:2085) | ADS camera + trace | Port + Fidelity | look-to-aim; FIRE/COLLECT labels |
| Sedation model (sedThreshold, game.js:2093) | attribute accumulation | Port | darts-to-drop by mass/diet; partial-dose decay |
| Binoculars + species ID (game.js:4173) | zoom camera + scan UMG | Port + Fidelity | identify→codex set |
| Deterrent effects: flare scare / decoy lure / melee fear (game.js:2108) | gameplay events the AI reads | Port | same radii/durations |
| Noise→draw stealth (player noise, game.js:1628) | `MakeNoise` + AISense_Hearing | Port | gait noise values + extraction spike |

## F. Missions, campaign & set-pieces

| 7 missions, declarative phase chains (game.js:150–275) | `UMissionDataAsset` + a mission subsystem | Port | reach/interact/defend/boss/extract; same coords/labels |
| Survivor/escort (Maya/Surveyor, game.js:1064) | follower AI + objective | Port | escortFrom phase, follow logic |
| Indominus boss, 3 endings (game.js:1255–1303) | boss StateTree + Sequencer | Port + Fidelity | arrival→hunt→outcome (contain/lagoon/run) |
| Evac helicopter state machine (game.js:2697) | Sequencer + gameplay | Port + Fidelity | incoming→…→liftoff; hold-the-line |
| 7 intro cinematics + voiced radio (game.js:2742) | Sequencer + MetaSounds | **Fidelity (big)** | same beats; real cinematics |
| Difficulty tiers (DIFFICULTIES, game.js:446) | `UDifficultyProfile` Data Asset | Port | 8 multipliers verbatim; default Survivor |
| Airdrop resupply (game.js:1960) | `AAirdropManager` + crate + objective | Port | empty→inbound→land ≤100 m→marker→refill |
| Drivable jeep + safe-zone-on-board (game.js:3299) | Chaos Vehicle + `bInVehicle` flag | Port + Fidelity | arcade feel; predators disengage on board |

## G. World, terrain & collision

| Collider grid + push-out (game.js:928–985) | UE capsule/world collision + nav-mesh | Port (free) | keep "cleared obstacle = passable" intent |
| Height-field terrain: hills/mountain ring/river (groundH, game.js:1529) | UE5 Landscape (sculpt to same silhouette) | Fidelity | 240 m valley silhouette preserved for layout parity |
| Trees/rocks/foliage (instanced, game.js:868) | UE5 foliage + Megascans at **mobile LODs** (Nanite only on M-series Enhanced) | **Fidelity (big)** | same density/placement intent; foliage/draw-distance budgeted per tier |

## H. HUD, map & UI

| Tactical HUD (vitals/threat/contact/compass/objective/chips, game.js:4054) | UMG, mirror `strings.js` labels + palette | Port + Fidelity | exact labels, monospace, palette from index.html CSS vars |
| Minimap + tactical map + overlays + pan-zoom (mapSVG, game.js:4237) | UMG map widget / render-target | Port | threat/territory/ghost/safe-zone layers; fog-of-war |
| Options: colourblind/scale/subtitles/contrast (game.js:2853) | UE accessibility settings | Port | preserve all four |

## I. Platform, input & rendering  *(UE5 client = native iPad app, iOS/Metal, iPadOS 18.5+, floor A12Z/A13)*

| Touch dual-stick + action buttons + iPad hardening (game.js:2873) | EnhancedInput **touch HUD** (port browser UX 1:1) | Port | iPad-native → touch IS the primary input; mirror dual-stick + look + labelled buttons; no page-zoom issue in a native app |
| Three.js renderer, DPR cap, bloom (game.js:566) | **UE5 Mobile (Metal) renderer + baked lighting** (Nanite/Lumen OFF at floor; Nanite trial M-series only) | **Fidelity (within mobile path)** | visual leap from Megascans + baked GI + post-FX, not Nanite/Lumen; no gameplay change |
| Model streaming tiers (game.js:485) | World Partition + HLOD + Significance **within a mobile memory budget (≤6 GB on A12Z)** | Port + Fidelity | LOD by distance; world sized to the floor device |
| (none) | **Device-profile tiers**: Baseline (A12Z/A13–A15) / Enhanced (M1–M3) / **Showcase (iPad Pro M4 11″/13″)** | **New** | one content set; scalability auto-switches by chip; author baked-first to the floor, showcase + Nanite/RT trial on M4 (hardware ray tracing) |

## J. Networking & persistence

| Host-authoritative co-op, snapshots, join-in-progress (net.js, game.js:4499) | UE5 dedicated-server replication | **New (the real engineering)** | browser lacks interpolation/ACK; UE5 replication graph + interpolation + reliable RPCs is the correct fix — do NOT port fire-and-forget |
| Progression/unlocks/career (PROGRESS, game.js:3916) | SaveGame + backend (Phase 2 core) | Port | same win-gated unlocks |
| logic.js authoritative-sim stubs (setup/validate/apply/isGameOver/viewFor) | server authority + RPC validation | Port (seam already declared) | shared rules-core (Phase 2) |

---

## Documented divergences (intentional, with rationale)

| Divergence | Rationale |
|---|---|
| UE5 client is a **native iPad app** (not desktop) | Owner decision. Floor A12Z/A13 on iPadOS 18.5+ → Mobile (Metal) renderer, baked lighting, **no Nanite/Lumen**; two tiers (Baseline/Enhanced). The browser PWA is **not** retired — it stays as the instant-URL / oldest-device client. Keeps Rules 3 & 4. |
| Touch input IS built in UE5 (vs. earlier desktop assumption) | Because the target is iPad, the proven browser touch UX is ported as the reference, not dropped. |
| Creature animation becomes real skeletal clips | The browser's procedural gait/roar/attack are stylized stand-ins; UE5 uses Control Rig/marketplace clips wired to the *same* AI states. Behaviour parity holds; fidelity rises. |
| Co-op gains interpolation + ACK | Browser co-op is host-authoritative without interpolation; this is an upgrade, not a behaviour change to solo play. |

Any future divergence MUST be added here with a rationale, or it is a parity defect.

---

## Validation method (Phase 5 hook)

For each ported system, parity is verified by: (1) **golden vectors** captured read-only from the browser
(same inputs → same state transitions in the isolated `RulesCore/` mirror), and (2) **side-by-side feel
checks** (same difficulty profile, same species values). Differences are either fixed or recorded in
"Documented divergences." Production is never modified to make a test pass — the browser is the reference,
not a dependency of the test.
