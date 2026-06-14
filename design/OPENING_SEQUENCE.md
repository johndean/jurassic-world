# Opening Experience Constitution — Helicopter Crash Intro

The deployment-flight → crash → awakening → first-objective sequence that opens *Jurassic Survival:
Island Alpha*. Goal: in the first minutes the player feels **stranded, vulnerable, and that the island
is alive**, with a seamless cinematic→gameplay handoff and emotional investment before free play.

> **Two fidelities.** The full spec below is the **design target** (AAA / UE5-scope). The live browser
> game ships a **compressed interactive version (~35–40s)** that hits every beat — see "Browser build" per phase.

## Emotional arc
Wonder → Curiosity → Concern → Fear → Chaos → Survival → Player agency.
End state in the player's head: **"We survived the crash. Now we need to survive the island."**

## The eight phases

| # | Phase | Full (UE5 target) | Browser build (live) |
|---|---|---|---|
| 1 | **Deployment flight** | Seated in a military transport; full head-look; squad, pilot/co-pilot, cargo, gear; rotor vibration, wind, turbulence; island emerges through fog — canopy, waterfalls, rivers, mountains, Pteranodons, herds below | Camera flies in with the chopper high over the foggy valley; title + ambient; the world reads as enormous |
| 2 | **First signs of trouble** | Radio chatter ("entering Alpha airspace", "thermal readings high", "lost contact with Ranger Outpost Seven"); warning lights; light turbulence | Radio lines fade in over the flight; first warning tint; light camera shake |
| 3 | **Something is wrong** | Alarms; "Mayday… lost navigation… controls unresponsive"; a large flier passes near; lightning in distant storm | "MAYDAY" overlay + alarm; warning red; a shadow passes; sky flickers |
| 4 | **Loss of control** | Slow terrifying spin; horizon/mountains/waterfalls rotating; loose gear breaks free; "BRACE! BRACE!"; smoke in cabin | Chopper + camera spin, horizon rotates, heavy shake, "BRACE" overlay, smoke tint |
| 5 | **Crash** | Canopy impact, rotor destruction, glass, deformation, sparks, fire, slide, final impact, silence, ringing | Impact flash → hard shake → fade to black + impact/ring SFX |
| 6 | **Awakening** | Regain consciousness slowly; blurred vision, muffled audio; burning wreck; rain; smoke; pilot gone; comms/nav/beacon destroyed | Black → blurred vignette fade-in at the **burning wreck**; muffled → clear |
| 7 | **First objective** | HUD: PRIMARY **SURVIVE**; SECONDARY **LOCATE EMERGENCY EXTRACTION**; a damaged tablet reveals **Military Extraction Facility Alpha — 2.3 KM** | Mission-update panel animates in with those exact lines + distance |
| 8 | **First dinosaur encounter** | Jungle goes silent (birds/insects/wind stop); a distant **territorial roar**; branches break, trees move; predator only glimpsed — fear through anticipation | Ambient cuts to silence → distant roar + "Something heard the crash"; then control |

## Phase 9 — Gameplay begins (handoff)
Control is handed over seamlessly. **No pop-up tutorials.** Movement, comms, inventory, healing,
navigation, tracking, threat detection and resource collection are learned through the survival
situation itself. Browser: the existing HUD/controls take over at the wreck; a couple of contextual
hints only.

## Narrative jobs the crash must do
1. Why you're stranded. 2. Why the extraction site changed (backup facility, not the planned LZ).
3. Why equipment is limited (lost in the crash). 4. Introduce the ecosystem. 5. Emotional investment.

## Beacon = SAFE ZONE (gameplay rule)
Reaching the **extraction beacon** is reaching safety: within the beacon's safe radius predators
**disengage and won't attack** (they avoid the lit facility perimeter), threat decays, and a subtle
safe-zone ring marks it. This makes the beacon a genuine refuge and the run's emotional anchor —
"if a player makes it to the beacon, it is the safe zone." (Live in the browser build.)

## Browser build — what's implemented vs deferred
**Implemented (live):** the compressed 8-beat interactive intro (scripted camera + chopper fly-in/spin/
crash + fade + wreck awakening + mission-update HUD + silence→roar), a **Skip** control, and the
beacon safe-zone rule.
**Deferred (UE5 / future):** seated first-person cabin with head-look, modeled pilot/co-pilot/cargo,
real crash physics + destruction, Pteranodons/herds flyover, rain & volumetric smoke, full voice radio.
These belong to the UE5 path (see `ue5/` + `UE5_PRODUCTION_PLAN.md`); the browser intro is the
design-intent reference for them.

## Multiplayer note
Co-op: each player plays the intro then spawns as a squad at the wreck (see the cluster-spawn already
in `startRun`). A shared synchronized crash (everyone in one cabin) is a UE5/host-authoritative follow-up.
