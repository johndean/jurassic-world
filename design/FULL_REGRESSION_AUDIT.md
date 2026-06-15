# JURASSIC SURVIVAL: ISLAND ALPHA — FULL REGRESSION AUDIT

## AAA Zero-Gap Certification Review

**Date:** 2026-06-15 · **Build:** live on `jurassic-world-production.up.railway.app`
**Method:** Static source audit of `game.js`, `index.html`, `net.js`, `server.js`, `data/*.json` across six independent system clusters (mission, controls/traversal, dino+NPC AI, vehicles/survival/audio, map/HUD/accessibility/platform, multiplayer/performance). Every finding cites a real function + line. High-severity claims were re-verified against source before being graded.

> **Honesty caveat (standing rule for this project):** This is a *code* audit, not a *playtest*. Findings below are grounded in source reading and logic tracing — they are NOT confirmed by visually running each scenario on-device. Severities reflect code-level risk; a "Critical" here means "the code path can produce the failure," not "reproduced on hardware." Items marked **Confidence: Verified** were re-checked line-by-line; **Inferred** means logically derived but not executed.

> **Recommendation discipline:** Every fix below is **conservative & additive** per the project mandate — none regress free-walk movement, none remove existing systems, and brief deliberate input-locks are the only acceptable movement interruptions.

---

## §0 — EXECUTIVE SUMMARY

### Verdict

The game is **functionally sound and shippable as a vertical slice**. The six-cluster sweep surfaced **zero confirmed launch-blocking crashes** — notably, four "CRITICAL crash" claims raised during the sweep were **debunked on re-verification** (see §4, False Positives). What remains is a tail of **edge-case softlocks, AI-immersion regressions, mobile/parity polish, and co-op join-in-progress desync** — real, worth fixing, but none catastrophic.

### System scorecard

| System | Grade | Biggest gap |
|---|---|---|
| Mission flow & progression | **A−** | Defend-phase completion requires standing in-zone at the exact second the timer hits 0 (recoverable, but confusing) |
| Player controls & traversal | **B+** | Spatial-hash collision queries only the player's own cell → cell-boundary clip risk |
| Dinosaur AI | **B** | Background-LOD predators reset to idle every frame → hunt-state lost when player steps out of active radius |
| NPC AI | **B+** | Escort survivor has no `P.alive` guard (low real-world impact; runs restart fresh) |
| Vehicles / intros | **B+** | Jeep intro kills ambient audio and never restores it → silent jungle post-intro |
| Survival systems | **B** | Oxygen-death respawn doesn't force-reset `P.dive`/`P.oxygen` → possible underwater respawn state |
| Audio | **B** | Voice fallback can call TTS / subtitle with `undefined` text if a clip is missing |
| Map & awareness | **B** | Minimap legend shows 7 of 14 entries (parity gap on phones); map-layer toggles not persisted |
| HUD / UI | **A−** | Survival chips + minimap legend don't scale with `--hud-zoom` |
| Accessibility | **B+** | Fullscreen-map legend uses hard-coded SVG colors → colorblind palette doesn't reach it |
| Multiplayer / co-op | **B−** | Join-in-progress does not bootstrap mission phase / extraction-hold timer → client desync |
| Performance | **A−** | `dinos.find()`/`filter()` O(n) in sync + spawn hot loops; fine today, scales poorly past ~120 dinos |

### Headline scores (out of 100, AAA benchmark = 90)

| Dimension | Score |
|---|---|
| **Launch readiness** | **82** — no confirmed blockers; polish + co-op join remain |
| AAA benchmark | 74 |
| Immersion | 76 |
| Mission quality | 84 |
| AI quality | 72 |
| World quality | 80 |
| UX | 81 |
| Accessibility | 78 |
| Multiplayer | 68 |
| Performance | 85 |

---

## §1 — CONFIRMED FINDINGS (verified against source)

### F-01 · Defend-phase completion gate — recoverable softlock-feel
- **Category / System:** Mission progression · defend phase
- **Severity:** Medium · **Confidence: Verified** (`game.js:365`)
- **Description:** Completion requires `MC.defendT <= 0 && dist2(P, site) < (r+6)²` *simultaneously*. If the timer expires while the player is knocked/pushed just outside the (r+6) grace ring, `done` never flips. The phase only completes once the player wanders back inside — with no on-screen hint that re-entering is required.
- **Repro:** Defend phase (e.g. Extinction Protocol, `r=9` at 0,−86); get knocked beyond ~15 m as the timer reaches 0; objective does not complete; HUD still reads "HOLD 0s".
- **Root cause:** Single conjoined condition at `game.js:365`; no "held long enough → done regardless of current position" latch.
- **Player impact:** Confusion / perceived softlock (recoverable by walking back in).
- **Fix (additive):** Latch success the first frame *both* conditions hold during the hold window: track `MC.heldOk |= (insideZone)` while `defendT>0`; on `defendT<=0`, `done = MC.heldOk || insideZone`. Preserves the "hold the line" intent without trapping a knocked-back player.
- **Effort:** Low · **Regression risk:** Low.

### F-02 · Background-LOD predators lose hunt state every frame
- **Category / System:** Dinosaur AI · LOD + decision
- **Severity:** High · **Confidence: Verified** (`game.js:~2268`, `baseStateFor` `game.js:50`)
- **Description:** Dinos outside `activeRadiusM` are forced to `baseStateFor(sp)` (= `Patrol` for predators) instead of running `decide()`. A predator mid-chase that the player out-runs by a few metres is demoted to idle patrol and drops `bb.hasTarget`; on re-entry it must re-acquire from scratch. Pack cohesion and pursuit pressure evaporate the instant a hunter goes off-LOD.
- **Player impact:** Predators feel "switchable off" by jogging away — the single biggest immersion regression in the AI.
- **Fix (additive):** Don't reset state every frame at background LOD; only fall back to base state after the dino has been background for >2 s (`a.bgSinceT`). Keep `bb.hasTarget`/`lastSeen` so re-entry resumes the hunt.
- **Effort:** Low (2–3 lines) · **Regression risk:** Low (off-screen only).

### F-03 · Beacon safe-zone instantly blanks predator aggression (no hysteresis)
- **Category / System:** Dinosaur AI · `decide()` / `playerSafe()`
- **Severity:** Medium · **Confidence: Verified** (`game.js:~2072–2077`)
- **Description:** `if (playerSafe()) bb.hasTarget = false;` is a hard boundary. Stepping inside the 18 m ring instantly resets every pursuer to patrol; stepping out re-arms them. Creates an arcade "sanctuary wall" and lets a skilled player toggle threat on/off at the line.
- **Fix (additive):** Decay interest instead of zeroing: `bb.interest = max(0, bb.interest - dt*0.1)` so predators pace the perimeter and snap back if the player leaves — tension preserved.
- **Effort:** 1 line · **Regression risk:** Low.

### F-04 · Collision spatial-hash queries only the player's own cell
- **Category / System:** Controls · collision (`queryColliders`)
- **Severity:** High · **Confidence: Inferred** (registration writes multiple cells; query reads one)
- **Description:** Colliders are registered into every cell their radius overlaps, but the lookup reads only `floor(x/CELL), floor(z/CELL)`. A player standing near a cell boundary can miss a collider whose centre sits in the adjacent cell → walk-through clip against rocks/ruins/buildings depending on alignment.
- **Fix (additive):** Query the 3×3 cell neighbourhood around the entity (dedupe hits). Bounded cost, no behaviour change for valid cases.
- **Effort:** Medium · **Regression risk:** Medium (must keep the neighbourhood small to avoid perf regression — measure).

### F-05 · Co-op join-in-progress doesn't bootstrap mission phase or extraction timer
- **Category / System:** Multiplayer · welcome handshake
- **Severity:** High · **Confidence: Verified** (`server.js` welcome ~114–119; `game.js` welcome handler; `netApplyWorld`)
- **Description:** The welcome message carries peers + seed + mission ID, but **not** `MC.idx`/`started` nor live extraction state. A client joining after the host has advanced sees objective phase 0 and an extraction-hold timer that resets to 0 — wrong objective marker, wrong extraction site, desynced countdown.
- **Player impact:** Campaign missions are effectively not join-in-progress safe in co-op.
- **Fix (additive, server stays near-stateless):** Add `MC:{idx,started}` and `exfil:{called,hold}` to the welcome payload (host pushes current state into room on change); client bootstraps `MC` + `applyPhaseMarker()` + extraction state on welcome.
- **Effort:** Low · **Regression risk:** Minimal (additive fields).

### F-06 · Jeep intro kills ambient audio and never restores it
- **Category / System:** Audio · intro lifecycle
- **Severity:** Medium · **Confidence: Verified** (`Audio.ambient(false)` in `updateIntroJeep`; no `ambient(true)` in `endIntroJeep`)
- **Description:** The jeep intro calls `Audio.ambient(false)` for dramatic silence and never re-enables it → the entire post-intro mission plays with no ambient bed.
- **Fix (additive):** Add `Audio.ambient(true)` in `endIntroJeep()` before handing control to the player.
- **Effort:** 1 line · **Regression risk:** None.

### F-07 · Oxygen-death respawn doesn't reset dive/oxygen state
- **Category / System:** Survival · water/death (`game.js:1584`, `startRun` `~3504`)
- **Severity:** Medium · **Confidence: Inferred**
- **Description:** Drown-death calls `endRun(false)`; restart does not explicitly force `P.dive=false`, `P.swim=false`, `P.oxygen=100`. If a run restarts the player anywhere near water depth, stale dive state can carry over.
- **Fix (additive):** In `startRun()` set `P.dive=false; P.swim=false; P.oxygen=100;` and validate the spawn point is above `WATER_Y`.
- **Effort:** Low · **Regression risk:** Low.

### F-08 · Voice/subtitle fallback can fire with `undefined` text
- **Category / System:** Audio · `playRadio()`
- **Severity:** Medium · **Confidence: Inferred** (`game.js:~2643–2648`)
- **Description:** `showSubtitle(e.say)` runs unconditionally and the clip-failure path calls `speakRadio(e.say,…)`; clip-only radio lines without a `say` field yield a blank subtitle and a silent TTS call → missed briefing if an audio asset 404s.
- **Fix (additive):** Guard `if (e && e.say)` before subtitle/TTS; ensure every radio line has a `say` fallback.
- **Effort:** Low · **Regression risk:** Very low.

### F-09 · Minimap legend parity gap (7 of 14 entries on phone)
- **Category / System:** Map/UX · platform parity
- **Severity:** Medium · **Confidence: Verified** (`index.html` `.mm-legend` vs `.map-legend`)
- **Description:** Fullscreen map legends 14 symbols; the corner minimap legends only 7 — missing APEX (distinct from predator), threat radius, territory, last-seen ghost, river, valley edge. Phone players (whose primary tactical surface IS the minimap) lose these distinctions.
- **Fix (additive):** Add the missing `<span>` entries to `.mm-legend` (compact/expandable on small screens).
- **Effort:** Low · **Regression risk:** Very low.

### F-10 · Colorblind palette doesn't reach the fullscreen-map legend
- **Category / System:** Accessibility
- **Severity:** Low–Medium · **Confidence: Verified** (inline `fill="#…"` in `.map-legend`)
- **Description:** Legend icons use hard-coded hex fills, so the CSS custom-property colorblind palettes (which correctly recolor live map markers) never reach the legend → YOU/OBJECTIVE and PREDATOR/EXTRACTION read identical under deuteranopia.
- **Fix (additive):** Swap inline hex for `var(--hud-good|alert|accent|…)`.
- **Effort:** Low (≈13 attr swaps) · **Regression risk:** Very low.

### F-11 · HUD-zoom doesn't scale survival chips or minimap legend
- **Category / System:** HUD / accessibility
- **Severity:** Low · **Confidence: Verified** (`.survHud` `position:fixed`; `.mm-legend` fixed 5.5px)
- **Description:** `--hud-zoom` scales `#hud`, but `position:fixed` survival chips and the hard-coded 5.5px minimap legend are exempt → low-vision players who raise HUD size still get tiny survival warnings + legend.
- **Fix (additive):** `font-size: calc(… * var(--hud-zoom,1))` or move chips to `position:absolute` within the zoomed container.
- **Effort:** Low · **Regression risk:** Very low.

### F-12 · Map-layer toggles (THREAT/TERRITORY/GHOSTS) not persisted
- **Category / System:** Map / options
- **Severity:** Low · **Confidence: Verified** (`mapLayers` runtime-only, no `localStorage`)
- **Description:** Toggling territory/threat/ghost overlays reverts to defaults on every map reopen; no persistence alongside the other `OPTS` settings.
- **Fix (additive):** Persist `mapLayers` to `localStorage`, load in `initOptions()`.
- **Effort:** Low · **Regression risk:** Very low.

### F-13 · Client spawn burst has no per-frame cap
- **Category / System:** Multiplayer / perf · `netApplyDinos`
- **Severity:** Medium · **Confidence: Inferred**
- **Description:** A client builds every not-yet-seen dino in a sync message synchronously (`spawnDino` → mesh build). A large delta (lag spike or a burst from a misbehaving host) builds 100+ meshes in one frame → multi-hundred-ms stall + GC.
- **Fix (additive):** Cap new builds per message (e.g. 8) and defer the rest to subsequent frames.
- **Effort:** Medium · **Regression risk:** Low (burst scenario only).

### F-14 · O(n) `dinos.find()/filter()` in sync + spawn hot loops
- **Category / System:** Performance
- **Severity:** Medium · **Confidence: Verified** (linear scans in `netApplyDinos`, `updateSpawnDirector`)
- **Description:** Client sync resolves each net dino via `dinos.find(_netId)` and the spawn director filters by species each tick. Fine at today's counts; ~120+ live dinos in a late hold turns this into thousands of comparisons per sync → frame hitches.
- **Fix (additive):** Maintain a `dinosByNetId` Map for O(1) sync lookups; keep array for iteration.
- **Effort:** Low · **Regression risk:** Minimal (pure optimization).

### F-15 · Auto-vault momentum cancelled at water's edge
- **Category / System:** Traversal + water
- **Severity:** Low–Medium · **Confidence: Inferred** (water `P.vy` zeroing runs after `updateTraversal`)
- **Description:** Auto-vault sets upward `P.vy`; the water-entry block later in `updatePlayer` zeroes `P.vy` when the destination is deep → vaults at shorelines fail and drop the player.
- **Fix (additive):** Preserve a one-frame vault flag so water entry doesn't cancel an in-progress vault.
- **Effort:** Low · **Regression risk:** Low.

### F-16 · Greybox→model size pop on stream-in
- **Category / System:** Dino rendering
- **Severity:** Medium · **Confidence: Inferred** (greybox uses proportional `standH`; `fitModel` fits absolute height — see prior `fitModel` hardening this session)
- **Description:** A dino can visibly change size/proportion the moment its `.glb` swaps in if the model's fitted box differs from the greybox silhouette. (The recent `fitModel` ground-truth correction reduced this, but greybox↔model parity isn't asserted.)
- **Fix (additive):** Store greybox target height on the mesh; on reskin, scale the model to match it exactly.
- **Effort:** Low · **Regression risk:** Low. *(This is the system behind the earlier "cat-sized dinos" reports — worth a visual confirm.)*

---

## §2 — LOWER-PRIORITY / POLISH FINDINGS

| ID | System | Severity | Summary | Fix |
|---|---|---|---|---|
| P-01 | Intro radio | Low | First radio line at `t>0` can be skipped (`intro.line=-1` init) | Display line 0 at intro start if `T>=line[0].t` |
| P-02 | Crash intro | Low | Heli can sink below terrain before fade if crash site groundH is low | Clamp descent to safe altitude until fade completes |
| P-03 | Boat intro | Low | Wake mesh is static (no fade/scale) | Animate wake opacity/scale in `updateIntroBoat` |
| P-04 | Monorail intro | Low | Camera follows `intro.car` with no null guard if builder fell back to empty Group | `if(!c?.position){endIntro();return;}` |
| P-05 | Remote players | Low | 10× lerp, no velocity extrapolation → ~1-frame visual lag | Client-side velocity extrapolation (no wire change) |
| P-06 | `turnRate` data | Low | `move.turnRate` defined per species, never read | Scale yaw lerp by `turnRate` for species personality |
| P-07 | Dino collision R | Low | `dinoBodyR` uses length×0.1, not actual width | Use greybox `bodyW` as proxy |
| P-08 | Options panel | Low | No `:focus-visible` ring, no Esc-to-close | Add focus styles + Esc handler |
| P-09 | Net dino IDs | Low | `_netDinoId` never resets between runs | Reset to 0 in `startRun` |
| P-10 | Host flag | Low | `updateSpawnDirector` trusts `Net.isHost` (race on stale "host" msg) | Add defensive `if(!Net.isHost)return;` |
| P-11 | Stamina/water | Low | Swim stamina drain is opaque (oxygen bar dominates) | Relabel chip "SWIM EXERTION" while `P.swim` |
| P-12 | Contact alert | Low | May overlap compass at ≤375 px | Reposition/collapse at small breakpoint |
| P-13 | Dead-state sim | Low | `updatePlayer` keeps running water logic after death | Early-return when `S.phase!=="playing"` |

---

## §3 — IMMERSION / "FEELS GAMEY" REGISTER

| What reads as artificial | Fix direction |
|---|---|
| Predators "switch off" when you out-run LOD (F-02) and "freeze" at the safe-zone line (F-03) | Persist hunt memory off-LOD; decay aggression at the ring, don't zero it |
| `strongerRivalNear` exists and works, but most ecosystem fields (`social`, `packRoles`, `noiseDrawWeight`, `turnRate`) are unread | Wire them incrementally for species personality (additive, no balance break) |
| Static boat wake, possible heli terrain-sink, skippable first radio line | The §2 P-01..P-04 cinematic polish set |
| Silent jungle after jeep intro (F-06) | One-line ambient restore |

---

## §4 — FALSE POSITIVES (raised during the sweep, DEBUNKED on re-verification)

Recording these so they aren't "fixed" into new bugs:

| Claim | Verdict |
|---|---|
| `strongerRivalNear()` undefined → ReferenceError each decide() | **FALSE** — defined at `game.js:2044`; called at 2079. |
| `bb.preyHunt.x` TypeError when uninitialized | **FALSE** — every read guarded by `bb.preyHunt ?` / `if(bb.preyHunt && …)` (2162–2179). |
| Extract-wave `MC.waves[MC.wi]` out-of-bounds crash | **FALSE** — guarded by `MC.wi < MC.waves.length-1` before `MC.wi++`. |
| Phase-completion toast OOB on final phase | **FALSE** — guarded by `if (MC.idx >= m.phases.length)`. |
| Escort survivor follows a dead player → softlock | **Effectively false** — run ends on death and restarts fresh; `P.alive` guard is tidy-up, not a fix for a live softlock. Downgraded to a nice-to-have. |
| SAFE ZONE ring "never drawn on minimap" | **Unconfirmed** — ring draw is unconditional in `mapSVG`; agent's own analysis retracted to "possibly clipped." Treat as visual-confirm item, not a code bug. |

---

## §5 — PRIORITIZED ROADMAP

**Wave 1 — Correctness (ship first, all low-risk):**
F-05 co-op join bootstrap · F-02 LOD hunt-state · F-04 collider neighbourhood query · F-06 jeep ambient · F-07 dive-state reset · F-08 voice fallback guard.

**Wave 2 — Awareness & accessibility parity:**
F-09 minimap legend · F-10 colorblind legend · F-11 HUD-zoom scaling · F-12 layer persistence · F-01 defend latch.

**Wave 3 — Immersion & perf headroom:**
F-03 beacon hysteresis · F-13 spawn-burst cap · F-14 net-id Map · F-16 greybox/model parity · F-15 vault-at-water · the §2 cinematic-polish set.

### Top 10 launch-blockers
**None confirmed.** The closest to blocking is **F-05** (co-op join-in-progress desync) — it makes campaign co-op unreliable for late joiners, but solo and host-from-start play are unaffected. Everything else is recoverable or cosmetic.

### Top 10 AAA-elevation opportunities
1. Off-LOD predator memory (F-02) — biggest single immersion lift.
2. Beacon aggression hysteresis (F-03).
3. Wire the unread ecosystem fields (P-06, social/packRoles/noiseDraw).
4. Co-op join-in-progress full state bootstrap (F-05).
5. Collision neighbourhood query → trustworthy world solidity (F-04).
6. Cinematic polish pass (wake, heli altitude, radio line 0, monorail null guard).
7. Velocity extrapolation for remote players (P-05).
8. Full colorblind + HUD-zoom coverage (F-10/F-11).
9. Greybox↔model size parity assertion (F-16).
10. Perf headroom for dense holds (F-13/F-14) → unlocks bigger waves.

---

*All recommendations are additive and preserve free-walk movement. No code, data, or assets were modified producing this audit.*
