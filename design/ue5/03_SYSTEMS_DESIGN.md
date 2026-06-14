# UE5 Systems Design (AI · Extraction · Threat · Noise · Multiplayer)

Maps the live browser systems (`game.js`, `logic.js`) onto UE5 C++/Blueprint + StateTree. Same behavior, engine-native implementation. Where a browser function exists, it's named so the port is traceable.

---

## 1. Creature AI — archetype-driven StateTree

The browser AI (`steer()` + `decide()`) is already a state machine that dispatches on a `state` string and reads archetype helpers, **never** the species. UE5 mirrors this with **one StateTree (`ST_Creature`)** shared by every creature; the per-creature `UCreatureDataAsset->Archetype` parameterizes it.

**`ACreatureBase`** (one class for all species)
- Holds `UCreatureDataAsset* Profile`. On `BeginPlay`: set skeletal mesh/anim class from the asset, init `Health = Combat.Health`, set initial state = `Archetype->BaseState` (mirrors `baseStateFor()`).
- `UCreaturePerceptionComponent` — vision cone (`Senses.SightRangeM` + `SightFovDeg`) + hearing (`HearingRangeM`), cost-bounded (no per-frame raycast spam; use UE **AIPerception** with sight/hearing senses). Mirrors `perceive()`.
- Movement via `UCharacterMovementComponent` (or `Mover` plugin) clamped to `Move.Walk/Run` and `Move.TurnRateDeg`.

**`ST_Creature` states** (superset matching the browser + the migration-step states the archetype flags forward-declare):

| State | Entered when | Browser parallel |
|---|---|---|
| `Graze` | prey baseState | `baseStateFor` prey |
| `Patrol` | predator baseState | `baseStateFor` predator |
| `Flee` | prey & predator within `FleeFromPredatorM`, or hp < `FleeHealthPct` | flee logic |
| `Hunt` | predator has target & post-grace | `decide()` carnivore targeting |
| `Stalk` | predator & `Archetype.bStalkPreferred` | step 4–5 (ambush) |
| `Territorial` | intruder in `TerritoryRadiusM` | step 4–5 |
| `Fight` | cornered (`bFightsWhenCornered`) or apex engaged | step 4–5 |
| `Migrate` / `Scavenge` / `ProtectYoung` / `Stampede` | ecosystem ticks | step 4–5 |

**Pack tactics** (`Archetype.bPackTactics`): a lightweight `UPackCoordinator` (one per pack, an `AActor` or subsystem entry) assigns `lead / flank / harry` roles from `Behavior.PackRoles` and shares the target's last-seen position — the UE port of `updatePackRoles()`. Deinonychus/Velociraptor use it; solitary species ignore it.

**Dispatch rule (the invariant):** behavior selection reads **only** `Profile->Archetype->{BehaviorClass, bPackTactics, bApexThreat, BaseState, ...}` — never `Profile->Id`. Adding a species can never require touching `ST_Creature`. (`Role` is read solely by HUD/minimap, exactly as in the browser.)

**Ecosystem without players:** creatures run graze/migrate/flee + hunt/compete/scavenge among themselves; the player is just another perceivable noise/threat source. Mirrors the browser's player-agnostic sim. LOD: creatures beyond an active radius (browser `activeRadiusM: 95`) downgrade to cheap drift — use UE **Significance Manager** + AI tick throttling.

---

## 2. Extraction loop — `UExtractionSubsystem` (GameInstance/World subsystem)

Mirrors `biome.alpha.json extraction` + the browser extraction state in `S.extraction`.

- On level start: pick a beacon location in `beaconPickRingM: [70,95]` from spawn; place `BP_ExtractionBeacon` at the facility.
- Objective flow drives the UMG objective widget with `STR` lines (`objReach` → `objCall`).
- Player in beacon ring + input `CallExtraction` (E) → `bCalled = true`, start `HoldTimer = holdSeconds (75)`, emit a **noise spike** (`callNoiseSpike: 1.0`) into the Noise system, broadcast `OnExtractionCalled`.
- During hold: `EXTRACTION INBOUND` MM:SS counts down; `ThreatSubsystem` escalation kicks in (below). Leaving the ring pauses/penalizes per current rules.
- Hold complete → `EXTRACTED` (`STR.winTitle`); player death → `WIPED` (`STR.loseTitle`).
- **Escalation** (`extraction.escalation`): on call, raise pressure — `deinonychusBonusAtMax: 3` extra pack members, `trexAggroBonus: 0.4`, spawn interval `9 s`. Implement as a multiplier the spawn director + AI aggression read while `bCalled`.

## 3. Threat system — `UThreatSubsystem` (0..10, the HUD `THREAT LEVEL`)

- Aggregates: nearest-predator distance/aggression, number of active hunters, apex presence (`Archetype.bApexThreat`), and current noise. Produces a 0–10 value for `WBP_Threat`.
- Predator-contact bearing feeds `Predator movement · [bearing]` (`STR.contactPredator`).
- Rises sharply during the extraction hold (couples with escalation). This is the browser `S.threat` ported to a subsystem so HUD + audio + spawn director all read one source.

## 4. Noise & stealth — `UNoiseComponent` on the player

- Per-tick noise = gait value from `biome player.noise`: crouch 0.05 / walk 0.4 / run 1.0 / idle 0.0; `call 1.0` on extraction call.
- Emits via UE **AIPerception hearing** (`MakeNoise` / `UAISense_Hearing::ReportNoiseEvent`) at a radius scaled by the noise value → predators with `HearingRangeM` pick it up; predators weight draw by `Behavior.NoiseDrawWeight` (T-Rex 1.0). Direct port of the browser noise→draw model, now using the engine's hearing sense.
- Stealth = crouch (`crouchSpeed 1.9`, noise 0.05) lets the player pass near predators; sprint (`runSpeed 7.4`, noise 1.0) is fast but loud. Vitals: stamina drain/regen + health regen from the `player` block drive `WBP_Vitals`.

## 5. Player & camera

- `AJSIPlayerCharacter` (MetaHuman cadet) + `UCharacterMovementComponent`: walk 4.2 / run 7.4 / crouch 1.9 (m/s → cm/s ×100). Stamina gates sprint.
- Enhanced Input: WASD, Shift sprint, Ctrl crouch, mouse look, **E** call extraction (matches `STR.howto_desktop`). Gamepad map per `STR.howto_gamepad`.
- Third-person orbit camera (browser `cam` orbit) → `USpringArmComponent` + `UCameraComponent`.

## 6. Multiplayer hooks (designed-in, NOT built in the slice)

`logic.js` already declares the seam: `meta = { minPlayers: 1, maxPlayers: 1 }` with `setup/validateAction/applyAction/isGameOver/viewFor` stubs — the authoritative-sim shape. UE5 path to 10–20p (parent-plan Beta):
- **Dedicated server** authoritative; `AJSIGameState` replicates extraction/threat; creatures are server-spawned `ACreatureBase` with movement + key state replicated (`COND_SkipOwner` where possible).
- The `applyAction`/`validateAction` server-authority model maps to **server RPCs + validation** on the PlayerController; `viewFor` maps to per-client relevancy/replication graph.
- Raise `maxPlayers` 1 → 20 in config; the ecosystem sim already runs server-side independent of player count, so it scales without per-player special-casing.
- Network LOD: replicate only creatures within relevancy radius (reuse the Significance/active-radius split from §1).

**Slice stance:** build everything single-player but keep systems in **subsystems + replicatable actors** (no logic baked into HUD/Blueprint tick) so turning on replication later is wiring, not a rewrite.

---

## Traceability: browser → UE5

| Browser (`game.js`/`logic.js`/data) | UE5 |
|---|---|
| `steer()` / `decide()` state machine | `ST_Creature` StateTree |
| `perceive()` vision/hearing | `UCreaturePerceptionComponent` + AIPerception |
| `updatePackRoles()` | `UPackCoordinator` |
| `resolveArchetype/archOf/isPrey/usesPackTactics/isApex/baseStateFor` | reads on `UArchetypeDataAsset` |
| `S.extraction` + `extraction` data | `UExtractionSubsystem` |
| `S.threat` | `UThreatSubsystem` |
| `player.noise` + draw | `UNoiseComponent` + AISense_Hearing |
| spawn director (`spawnDirector` roster) | `USpawnDirectorSubsystem` reading the same roster data |
| `logic.js` colyseus stubs | dedicated-server authority + replication |
