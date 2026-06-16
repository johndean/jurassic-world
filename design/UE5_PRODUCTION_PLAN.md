# UE5 Production Plan — Cinematic Slice & Phased Migration (Implementation Directive)

**Status:** governing implementation plan. **Doctrine:** *museum glass.* The live browser/iPad game is a
**protected, READ-ONLY production system.** This initiative is a **parallel R&D project**, not a migration —
it builds a standalone UE5 Cinematic Slice that proves the future visual potential **while the browser
version keeps shipping, unchanged and first-class, forever.**

> Companion docs: current-state **`AAA_ZERO_GAP_AUDIT.md`** (what's shipped/proven in the browser build),
> the slice spec in **`ue5/`** (GDD, project structure, data schema, systems design, shopping list), and
> the **isolated project** at **`../ue5-cinematic-slice/`** (boundary doctrine + Phase-1 parity matrix).

---

## 0. NON-NEGOTIABLE PRODUCTION-SAFETY DOCTRINE

These rules bind every task in this plan. They exist so an AI-assisted build can **never** damage the
live game.

**Rule 1 — The existing game is protected (READ-ONLY).**
The production system is everything that makes the browser/iPad game run: `game.js`, `index.html`,
`net.js`, `server.js`, `strings.js`, `data/*.json`, `vendor/*`, `assets/*`. You MAY read, analyze,
reference, and mirror it. You MAY NOT delete, modify, refactor, rename, replace, remove features from,
re-deploy, or introduce dependencies into it.

**Rule 2 — Zero-risk isolation.** All UE5 work lives inside **`/ue5-cinematic-slice`** (in this repo:
`jurassic-island-alpha/ue5-cinematic-slice/`). No file outside that boundary may be modified *except* the
design/planning docs under `design/` (which are inert markdown, not the running game). If any proposed
change would touch the running game, **stop and provide an isolated alternative.**

**Rule 3 — Preserve the player experience.** The browser/iPad game stays fully playable, supported,
deployable, and maintainable at all times. No player notices anything from this initiative.

**Rule 4 — No forced migration.** The UE5 client is optional, standalone, experimental, parallel. No plan
may require shutting the browser version down. The browser remains the **authoritative production version.**

**Mandatory safety check (run before every change):** *"Does this alter, replace, delete, refactor, or
endanger the current game?"* If YES → reject, provide a zero-risk isolated alternative. Only zero-production-
risk solutions are permitted.

**Required output format (every UE5 task uses this):**
1. Reasoning · 2. Risk to production · 3. Confirm production untouched · 4. Implementation · 5. Validation
plan · 6. Rollback plan.

**Success is NOT** "replace the current game." **Success IS** "a visually stunning UE5 cinematic slice that
proves the future potential while the browser/mobile version continues operating unchanged."

---

## Why Unreal Engine 5 (and why a *parallel* client, not a rewrite)
Photoreal realtime = **UE5**: **Nanite** (film-density geometry, no manual LODs), **Lumen** (realtime GI +
reflections), **Virtual Shadow Maps**, **Niagara** (volumetric fog/weather/particles), **MetaHuman**
(photoreal characters), **World Partition** (a 25 km²+ streaming island). Three.js/WebGL cannot reach this —
it is an engine-class difference. The trade-off (multi-GB PC/console download vs. an instant browser URL) is
*exactly why the browser client must survive*: it owns accessibility (iPad, casual, instant), UE5 owns
fidelity (PC/Mac/console). This is how MMOs evolve — one world, multiple front-ends.

---

## THE PHASED ROADMAP (Phase 0 → 8)

### Phase 0 — Stabilize the existing game *(do this before any UE5 spend)*
Don't migrate a game with unresolved platform issues. **Status: ~80% complete this session — verified live
in build `2026-06-16-s`** (see `AAA_ZERO_GAP_AUDIT.md`):

| Item | Status | Evidence |
|------|--------|----------|
| iPad Safari zoom bug | ✅ Fixed | layered gesturestart/2-finger/double-tap guards (game.js:2873) |
| Viewport reset / camera reset | ✅ Fixed | RESET VIEW button + `resetView()`/`resetViewportZoom()` (game.js:2899) |
| Map interaction | ✅ Fixed | in-map pinch/drag pan-zoom (game.js:4349), SVG double-tap vector closed |
| Touch controls | ✅ Stable | dual-stick + labelled action buttons; touch-action locks |
| Responsive UI scaling | 🟡 Partial | HUD-scale option exists; needs device-matrix pass |
| Performance profiling → 60 FPS on modern iPads | ⛔ Open | **the remaining Phase-0 gate** |
| Frame cap (mobile thermals) | ⛔ Open | no rAF cap yet (audit P2) |

**Phase-0 exit gate:** 60 FPS on a modern iPad, stable controls, no viewport break. **Remaining work is
all inside the production repo and is the ONE place this plan touches production — handle it as normal
browser-game maintenance, separate from the UE5 initiative, under its own review.** (It is listed here only
to mark the gate; it is not part of the isolated `/ue5-cinematic-slice` work.)

### Phase 1 — UE5 Visual Prototype (standalone, no gameplay)
A `/ue5-cinematic-slice` environment that demonstrates **look only**: dinosaurs, terrain, vegetation,
weather, day/night, water, cinematic camera — using **Nanite + Lumen + World Partition + UE5 Landscape +
a MetaHuman-compatible pipeline.** Goal: determine the achievable visual ceiling and **measure performance
on PC, Steam Deck, and iPad (via remote-streaming tests — NOT native iPad UE5).** This is the vertical-slice
look target; gameplay comes in Phase 2. *(Detailed spec: `ue5/00_VERTICAL_SLICE_GDD.md`.)*

### Phase 2 — Separate game logic from rendering *(the most important architectural step)*
The browser game co-locates logic + UI + rendering + net + persistence. The target is a **headless rules
core** consumed by every client:

```
Game Server / Rules Core         Clients
├── Dino AI / ecosystem          ├── Browser  (Three.js — unchanged)
├── Growth / progression         ├── iPad     (browser client)
├── Combat / survival            └── UE5      (PC/Mac/console)
├── Inventory / economy
└── Persistence / world state
```

**Museum-glass method:** do **not** refactor the production `game.js` to extract the core. Instead, build an
**isolated read-only mirror** of the rules (ported from the audited browser logic) inside
`/ue5-cinematic-slice/RulesCore/`, validated for parity against the browser by golden-test vectors. The
browser keeps its embedded logic and keeps shipping; the shared core is *additive* and only adopted later,
by choice, never as a forced production change. (`logic.js` already declares the authoritative-sim seam —
`setup/validateAction/applyAction/isGameOver/viewFor` — so the shape is known.)

### Phase 3 — Browser + UE5 hybrid (two front-ends, one world)
- **Browser client** (iPad, casual, instant): existing gameplay, simplified visuals — *the production app,
  untouched.*
- **UE5 client** (PC/Mac, console later): cinematic environments, better animation, dynamic weather,
  enhanced audio.
Both connect to the same backend (Phase 2 core). Browser survives; UE5 is optional.

### Phase 4 — Upgrade art assets (one source → many tiers)
A single high-fidelity master asset generates every quality tier — **without replacing any existing browser
asset** (new files only, in `/ue5-cinematic-slice/Content/`):

```
High-poly cinematic master → LOD generation → UE5 gameplay variant → mobile/browser variant
```
| Asset | Triangles |
|-------|-----------|
| Cinematic Rex | 500k+ (Nanite) |
| Gameplay Rex | ~60k |
| Mobile/browser Rex | 10k–20k |

*Lesson carried from the browser build:* **do not rely on AI image→3D auto-rig for creatures** (1/13 usable
rigs). Buy pre-rigged (Fab) or rig with Control Rig per body archetype.

### Phase 5 — Streaming world architecture
A realistic dinosaur world is enormous. **World Partition + Data Layers + HLOD + runtime streaming**, map
target **25 km²+**, only nearby content loads. Essential for large ecosystems. (Slice uses one ~250 m zone;
streaming is an Alpha+ concern.)

### Phase 6 — Preserve iPad support *(where indie projects fail)*
**Do NOT run full UE5 graphics on iPad.**
- **Option A (recommended):** the browser/iPad client stays WebGL/Three.js; **UE5 = premium client.** Same
  world (Phase 2 core). This is the default and it directly satisfies Rules 3 & 4.
- **Option B (not recommended for the slice):** native iPad UE5 build — expect reduced foliage/shadows/view
  distance, no Nanite, simplified Lumen; a separate optimization effort. Defer indefinitely.

### Phase 7 — Cinematic features *(once the foundation is stable)*
- **Environment:** dynamic storms, fog systems, volumetric clouds, river simulation, footprints,
  destructible vegetation.
- **Dinosaurs:** motion matching, IK foot placement, procedural tail/neck, dynamic muscle.
- **Immersion / ecosystem:** nest building, migration events, predator-prey behaviors (port & deepen the
  browser ecosystem AI — see audit §4 P1).

### Phase 8 — Long-term architecture (ideal final state)
```
Dedicated Server (Dino sim · persistence · AI · economy · world state)
        ├── Browser Client
        ├── iPad Client
        ├── UE5 PC/Mac Client
        └── Future Console Client
```

---

## What carries over from the browser build (proven, not wasted)
- **Game design is engine-agnostic:** extraction loop, threat, noise/stealth, data-driven species +
  **archetype AI** (`SPECIES_ARCHITECTURE_v2.md`) translate directly to UE5 (StateTree/C++ + Data Assets).
- **Art direction:** `ASSET_BIBLE.md`, hero key art, dino references = the UE5 art bible / modeling refs.
- **The browser game is the playable proof** — now of the full *systems set*, not just the loop.
- **HUD/UX** (real labels, palette) ports to UMG.

## Prototype maturity — PROVEN systems to mirror (browser build `2026-06-16-s`)
These are implemented, live, audited — *reference behaviour to match in UE5*, not open design:
traversal (jump/vault/mantle/climb/zip over a solid collider world) · water (swim/dive/oxygen/current) ·
survival (hunger/thirst/temp/injury) · living ecosystem AI (11-state utility, predator-vs-prey, hierarchy,
herd/stampede, pack roles) · drivable vehicles · 3 difficulty tiers · airdrop resupply · accessibility +
hardened touch. UE5 mappings in `ue5/03_SYSTEMS_DESIGN.md`; difficulty/survival/resupply schemas in
`ue5/02_DATA_ASSET_SCHEMA.md`. The remaining genuine risk is **art/animation fidelity** and **co-op net
robustness** — everything else is de-risked.

## Tech stack
- **Engine:** UE 5.4+ (Nanite, Lumen, VSM, World Partition).
- **Characters:** MetaHuman (cadets/rangers) — solves the hand/rig problems hit with AI image→3D.
- **Environment:** Quixel Megascans (UE-native, free) + UE5 foliage/Landscape.
- **Creatures:** cheapest→best — (a) Fab/Marketplace rigged+animated dino packs (fastest), (b) commissioned,
  (c) in-house. **Never** AI auto-rig for creatures.
- **Animation:** Control Rig + IK Retargeter, **one shared rig per body archetype** (biped theropod,
  quadruped ceratopsian/stegosaur/ankylosaur, ostrich-mimic); marketplace anim packs; optional mocap for
  hero beats. Quadrupeds never use a humanoid walk clip.
- **Materials:** Substance 3D Painter/Designer. **Audio:** MetaSounds + licensed libraries.
- **Multiplayer (10–20p):** UE5 replication / dedicated servers — a major workstream, phased to Beta. This
  is the *genuine new* engineering vs. the browser (which is host-authoritative without interpolation/ACK).

## Asset pipeline
Higgsfield concept art → ref board → model (or Megascans/marketplace) → retopo + UV → Substance texture →
rig (Control Rig / MetaHuman) → import to UE5 → Nanite/Lumen setup → in-engine polish → LOD/variant export
(Phase 4). **All outputs land in `/ue5-cinematic-slice/Content/` — no production asset is replaced.**

## Milestones & timeline (small team, 1–3 devs)
| Phase | Scope | Time |
|-------|-------|------|
| 0 | Stabilize browser/iPad (≈80% done; FPS gate remains) | ~1 month |
| 1 | UE5 visual prototype (look only, perf measured) | ~2–3 months |
| 2 | Decouple logic↔rendering (isolated rules-core mirror) | ~2–4 months |
| 3 | Browser+UE5 hybrid on shared core | ~4–8 months |
| 4–7 | Asset tiers · streaming world · cinematic features | ~6–18 months |
| **Total** | polished cinematic transition | **~12–24 months** |

## Team & budget bands (USD)
- **Team (AAA-look minimum):** UE5 gameplay programmer · environment artist · character artist (or MetaHuman
  + contractors) · animator · technical artist (Nanite/Lumen/perf) · designer · audio (contract) · producer/QA.
  Solo + AI is enough for concept/prototype, **not** shippable AAA art/optimization/multiplayer.
- **Lean indie-AAA** (small team, heavy Megascans/MetaHuman/marketplace, no console, co-op-lite): **~$150k–$500k.**
- **Mid** (custom creatures/anims, full 10–20p MP, more polish): **~$0.5M–$2M.**
- **Full AAA** (large team, console, original everything): **$5M+** and years.
- **DIY vertical slice:** cash-light — engine + Megascans + MetaHuman are free; a rigged dino pack is
  tens–low-hundreds USD. The expensive resource is artist/engineer time, not licenses.

## What I (Claude) can and cannot do here
**Can:** scaffold `/ue5-cinematic-slice` docs/structure, write GDD/tech-design, define the Data-Asset schema
mirroring `species.json`, draft StateTree/C++ system designs, build the **read-only rules-core mirror** +
golden-parity tests, set import/naming conventions, write the Megascans/MetaHuman/Fab shopping list, and the
parity matrix. **Cannot:** author production-grade 3D art/animation or run the UE5 editor — that is hands-on
artist/engineer work. **Will never:** modify the live browser game as part of this initiative.

## First six concrete steps (the recommended order)
1. Close the Phase-0 FPS gate on the browser game (separate production-maintenance task, own review).
2. Implement the RESET VIEW + viewport recovery — **done** (build `2026-06-16-s`).
3. Stand up `/ue5-cinematic-slice` with the boundary README + Phase-1 parity matrix — **done** (this pass).
4. Build the UE5 dinosaur **environment** prototype (Phase 1, look only).
5. Keep the browser/iPad client alive permanently (Rules 3 & 4).
6. Ship a UE5 "Enhanced Edition" for desktop on the shared core (Phases 2–3).
