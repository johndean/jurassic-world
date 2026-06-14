# Jurassic Survival — Mission Introduction Design System (Island Alpha)

Authoritative design for **per-mission insertion cinematics**. Every mission opens with a *unique*
insertion method that is cinematic but player-controlled, contains gameplay, teaches the objective, and
hands off seamlessly into the live mission. No loading-screen intros. No two intros share a structure.

This document is the design contract. Implementation is phased (see **§ Build Plan** at the end) and is
strictly **additive** — the data-driven intro engine layers on top of the existing
`startIntro`/`updateIntro`/`endIntro` state machine; free movement is never removed (intros use only
brief, deliberate, skippable input locks, exactly like the current crash cinematic and the zipline).

---

## Intro → Mission mapping (canonical)

| Mission ID        | Mission name          | Insertion method                       | Type archetype          |
|-------------------|-----------------------|-----------------------------------------|-------------------------|
| `evac`            | EVACUATION            | **Helicopter Arrival** (existing)       | Free-for-all survival   |
| `dna`             | DNA SAMPLE COLLECTION | **Research Helicopter Deployment**      | Field-science expedition|
| `fallen_outpost`  | FALLEN OUTPOST        | **HALO Parachute Infiltration**         | Rescue operation        |
| `blackout`        | OPERATION BLACKOUT    | **Armored River-Boat Insertion**        | Power restoration       |
| `ghosts`          | GHOSTS OF SECTOR 9    | **Ranger Jeep-Convoy Expedition**       | Missing-team investigation|
| `last_sample`     | THE LAST SAMPLE       | **Abandoned Monorail Arrival**          | Facility approach        |
| `extinction`      | EXTINCTION PROTOCOL   | **Vertical-Lift Evac Airship**          | Island evacuation (finale)|

Shared spine: the existing crash sequence is generalized into the engine as the `heli_crash` template and
remains the `evac` intro. Each mission below replaces only the *insertion descriptor* — environment,
vehicle, beats, dialogue, camera, hand-off — not the engine.

---

## Engine vocabulary (data-driven intro descriptor)

Each intro is a descriptor `INTRO[missionId] = { vehicle, env, beats[], radio[], handoff }`:

- **vehicle** — which procedural/GLB rig to spawn (`heli`, `boat`, `jeep`, `transport`+`chute`, `monorail`, `airship`).
- **env** — weather/time/biome overrides (storm, dawn mist, night, ash) applied to scene fog/light for the intro only.
- **beats[]** — ordered `{ t, phase, cam, shake, tint, hud, fx }` timeline entries (mirrors current `updateIntro` phase table).
- **radio[]** — `{ t, h (caption HTML), say (spoken line) }` (mirrors current `INTRO_RADIO`).
- **handoff** — where/how the player gains control: `{ x, z, facing, mode }` where `mode ∈ { land, jump, disembark, descend }`.

Interactive intro gameplay reuses existing systems: `updateAction` hold-prompts (tablet/equipment checks),
`interact()` press actions (jump / disembark), the FX pool (`addFx`/`fxRing`/`fxFlare`/`fxTracer`), and the
contextual `#prompt` bar. Failure/skip always falls through to the safe `skipIntro()` hand-off.

---

# 1 · EVACUATION — Helicopter Arrival *(existing, keep)*

**1. Cinematic overview** — A lone Huey thuds in over a fog-choked valley at dusk; the island reveals
itself as the chopper descends, then catastrophically fails and crashes. Player wakes at the wreck.
**2. Environmental storytelling** — Wreck, fire, drifting smoke, distant roar; the valley "hears every step."
**3. Interactive moments** — Player chooses *when* to stand and move out of the wreck (control returns at wake).
**4. Dialogue** — Pilot mayday cascade → static. (current `INTRO_RADIO`)
**5. Tutorial** — On wake, movement + noise meter surfaced; threat HUD lights.
**6. Dynamic events** — Crash site offset randomized within the valley bowl.
**7. Failure conditions** — None (cinematic); skip always lands player at wreck.
**8. Multiplayer variations** — Riders = co-op count; squad shares one wreck, fan out on wake.
**9. Solo variation** — Single rider, single wreck.
**10. Transition** — Black → fade-in at wreck, control returns, ambient + threat online.
**11. Role variations** — Specialist model is the rider; perk surfaced in wake HUD blurb.
**12. Randomized events** — Crash bearing, ember density, time-of-dusk tint.
**13. Camera** — Trailing chase → orbit-spin during failure → hard cut to black on impact → low wake angle.
**14. Audio** — Rotor wash, alarm tone, mayday VO, impact, silence, distant roar.
**15. Emotional goal** — *Isolation & dread.* You are alone, hunted, and the way out just died.

*Status: shipped. Becomes the `heli_crash` template in the engine.*

---

# 2 · DNA SAMPLE COLLECTION — Research Helicopter Deployment

**1. Cinematic overview** — A marked research chopper banks low over wrecked field-labs at golden hour, a
scientist briefing you on the headset, before a *controlled* emergency landing at a distress beacon (no
crash — distinct from `evac`).
**2. Environmental storytelling** — Collapsed greenhouses, overturned containment, scattered sample crates
below — the program died here.
**3. Interactive moments** — In the cabin: pick up the **field tablet** (hold-prompt) to see the species
target board and DNA quota; glass the LZ through the open door (binocular flavor).
**4. Dialogue** — Scientist NPC: objective, quota, "tranq or trap — we need them *alive*."
**5. Tutorial** — Surfaces the field kit (binoculars/tranq/trap/sample) + the watchtower hint.
**6. Dynamic events** — A herd scatters below as the chopper passes; one target species highlighted at random.
**7. Failure conditions** — None; if the cabin-tablet beat is skipped the board still posts on landing.
**8. Multiplayer variations** — Briefing addresses the squad; quota scales with player count.
**9. Solo variation** — One-on-one briefing.
**10. Transition** — Skids touch, door slides, control returns at the LZ (no fade — continuous).
**11. Role variations** — RESEARCH/TRACKER get an extra flagged target; others get the base board.
**12. Randomized events** — Which derelict lab the flight path crosses; target species spotlight.
**13. Camera** — Banking aerial pass over labs → side-door over-shoulder of scientist → settle on skids-down.
**14. Audio** — Steady rotor (no failure tone), calm scientist VO, herd calls below.
**15. Emotional goal** — *Purpose under pressure.* A clean job in a ruined place — until it isn't.

---

# 3 · FALLEN OUTPOST — HALO Parachute Infiltration

**1. Cinematic overview** — A military transport's rear ramp yawns open over a thunderhead; lightning
strobes herds far below. You jump, freefall through storm cloud, and steer a canopy to a chosen LZ near
Outpost Echo where Ranger Maya's beacon pulses.
**2. Environmental storytelling** — From altitude: the dead outpost, a collapsed watchtower, predator
movement converging on the beacon — you *see* the rescue you're about to run.
**3. Interactive moments** — **(a)** Walk the cargo bay (free movement) — check the equipment rack
(hold-prompt), read the survivor's last transmission on the wall tablet. **(b)** Approach ramp → countdown
→ press to jump. **(c)** Full directional **canopy control**: lean to steer, wind drift, avoid the
Pteranodon that crosses your descent; flare to land.
**4. Dialogue** — Mission Commander live briefing on the ramp; Maya's faint, broken beacon audio under it.
**5. Tutorial** — Cargo-bay walk teaches movement; canopy teaches look-steer; flare teaches the timing of
a deliberate input.
**6. Dynamic events** — Wind vector + a turbulence gust randomized; Pteranodon fly-through; LZ outcomes.
**7. Failure conditions** — Late flare = hard landing (brief stun + noise spike, not death); steering into
the storm wall = off-course LZ (longer approach run). Never a death — the rescue must always be reachable.
**8. Multiplayer variations** — Squad stick-jump in sequence; canopies visible around you; muster on the ground.
**9. Solo variation** — Solo jump, single canopy.
**10. Transition** — Canopy flares, boots hit dirt, chute cuts away, control is already yours (no fade).
**11. Role variations** — VETERINARIAN gets Maya's vitals pre-briefed; SURVIVAL gets a tighter wind read.
**12. Randomized events** — LZ (perfect / off-course / tree-snag / roof), wind, reptile fly-through.
**13. Camera** — Interior handheld in the bay → 3rd-person at the ramp → into a stable freefall trail cam →
canopy chase → snap to ground stance on flare.
**14. Audio** — Engine drone + wind roar in the bay, ramp klaxon, jump-whoosh, canopy snap, storm thunder, Maya's static.
**15. Emotional goal** — *Heroic commitment.* You leapt into a storm for a stranger — no turning back.

---

# 4 · OPERATION BLACKOUT — Armored River-Boat Insertion

**1. Cinematic overview** — Dawn mist on a black river; an armored patrol boat noses up a narrow jungle
canyon toward the dead power grid. A blocked channel forces a detour through a flooded maintenance tunnel,
then the boat reaches a ruined dock.
**2. Environmental storytelling** — Dark fences hanging open, a beached service skiff, generator stacks
gone cold; in the tunnel: nests, fallen infrastructure, lights stuttering on emergency cells.
**3. Interactive moments** — **(a)** Move around the deck (free): inspect the **grid schematic** at the
console (hold-prompt) to mark the three stations on your map; scan the shoreline (binocular flavor).
**(b)** At the channel block, the boat diverts on its own (scripted) — player keeps looking around.
**4. Dialogue** — Engineer dispatch over comms: Alpha/Bravo/Charlie, "every generator you wake draws them in."
**5. Tutorial** — Schematic beat pre-marks the three station markers + the Control Center on the map.
**6. Dynamic events** — A Brachiosaurus drinks at the bank / a tail-splash in the mist / Pteranodons overhead — one picked at random.
**7. Failure conditions** — None; the detour and dock arrival are guaranteed.
**8. Multiplayer variations** — Squad shares the deck; schematic posts to all; disembark together.
**9. Solo variation** — Solo on the deck.
**10. Transition** — Hull grinds the dock, ramp drops, control returns on the planks (continuous).
**11. Role variations** — ENGINEER/COMMS see a repair-time estimate per station; others see only locations.
**12. Randomized events** — Which bank wildlife event fires; tunnel light-flicker pattern; mist density.
**13. Camera** — Low water-skimming bow cam → slow push past the wildlife beat → tunnel darkness with light
stabs → rise to reveal the dock.
**14. Audio** — Idling diesel + water wash, mist-muffled jungle, distant generator hum (dead), tunnel drips, dino calls.
**15. Emotional goal** — *Creeping unease.* Quiet, beautiful, and very wrong — the lights are off for a reason.

---

# 5 · GHOSTS OF SECTOR 9 — Ranger Jeep-Convoy Expedition

**1. Cinematic overview** — Two ranger jeeps grind up a muddy track at last light, radios crackling about
the survey team that went silent. The lead jeep finds a destroyed checkpoint; the trail goes on where
wheels can't, so you dismount on foot into Spinosaurus territory.
**2. Environmental storytelling** — Smashed checkpoint gate, claw-raked truck, a dropped survey camera
still recording, drag-marks into the treeline.
**3. Interactive moments** — **(a)** Look around the moving jeep (free look + lean): open the **mission log**
on the dash tablet (hold-prompt), play the missing team's last footage. **(b)** At the checkpoint, step out
and **examine the evidence** (hold-prompt) to lock the first investigation phase.
**4. Dialogue** — Convoy chatter (driver + second jeep) → the unsettling cut to silence on the team's frequency.
**5. Tutorial** — The dash-log beat teaches the investigate/examine hold action used throughout the mission.
**6. Dynamic events** — A herd crosses the headlights / a shape in the trees / the radio catches a fragment of a scream — one at random.
**7. Failure conditions** — None; the dismount always happens.
**8. Multiplayer variations** — Squad split across two jeeps; all dismount at the checkpoint.
**9. Solo variation** — One jeep, one ranger.
**10. Transition** — Jeep halts at the wrecked gate, door opens, control returns standing beside it.
**11. Role variations** — TRACKER/RANGER auto-reveal the first track marker; others must examine to reveal it.
**12. Randomized events** — Which roadside event fires; checkpoint wreck dressing; dusk tint.
**13. Camera** — Interior over-shoulder bouncing with the suspension → headlight reveal of the checkpoint →
step-out to a low, wary stance.
**14. Audio** — Engine + tire mud, wiper squeak, radio static and chatter, the silence on the team's channel, jungle night.
**15. Emotional goal** — *Investigative dread.* Something erased these people — and you're following it home.

---

# 6 · THE LAST SAMPLE — Abandoned Monorail Arrival

**1. Cinematic overview** — You ride a dead Jurassic monorail through the dark toward the Sector 4 research
facility on emergency cells. Halfway, the car loses power; you restore it from the cabin as the facility
— under attack, alarms flaring — slides into view.
**2. Environmental storytelling** — Blood trails on the floor, abandoned lab kit on the seats, a security
recording looping on a cracked screen, the facility lit by failing strobes ahead.
**3. Interactive moments** — **(a)** Walk the carriage (free): read the security recording (hold-prompt) —
it shows the breach. **(b)** When the car stalls, pull the **manual power lever** (hold-prompt) to limp it
to the platform — your first "restore power" beat, teaching the mission's core verb.
**4. Dialogue** — Automated transit VO → facility alarm callouts → a scientist's recorded warning.
**5. Tutorial** — The power-lever beat teaches the interact-hold used for restore/retrieve/insert phases.
**6. Dynamic events** — Lights cut at a random point; a silhouette passes a window; the recording's content varies.
**7. Failure conditions** — None; the car always reaches the platform (slower if you dawdle on the lever).
**8. Multiplayer variations** — Squad shares the carriage; one pulls the lever, all proceed.
**9. Solo variation** — Solo in the carriage.
**10. Transition** — Brakes hiss, doors part onto the platform, control returns (continuous).
**11. Role variations** — SCIENTIST/RESEARCH get the facility map pre-loaded; others reveal it on arrival.
**12. Randomized events** — Power-loss timing, window silhouette, recording variant.
**13. Camera** — Confined interior dolly along the car → snap to the lever on the stall → forward through the
doors to reveal the besieged facility.
**14. Audio** — Rail hum, breaker trips into emergency tone, distant facility alarms and impacts, the recording's panic.
**15. Emotional goal** — *Tightening claustrophobia.* A locked box rolling toward something already inside.

---

# 7 · EXTINCTION PROTOCOL — Vertical-Lift Evac Airship *(finale)*

**1. Cinematic overview** — You stand aboard an enormous evac carrier above a burning island; landers and
choppers launch around you, thousands of survivors below. The Commander frames the end — apex outbreak,
total collapse — then a predator breach forces an emergency deployment and you descend to the surface.
**2. Environmental storytelling** — Packed evac decks, status boards flashing sector losses, the island
glowing red through the observation glass — the world is ending and you're the last play.
**3. Interactive moments** — **(a)** Explore the airship deck (free): read the **island status board**
(hold-prompt) to see the campaign map fall, look out the observation deck at the converging apexes.
**(b)** Alarm hits → choose your **descent**: fast-rope / wingsuit / parachute — choice sets your insertion
point and opening tempo. **(c)** Controlled descent to the Command Center approach.
**4. Dialogue** — Commander's grave full-squad briefing → breach klaxon → "GO GO GO."
**5. Tutorial** — Status-board beat recaps the finale's multi-objective chain; descent reuses the canopy/rope steering.
**6. Dynamic events** — Which sector falls on the board first; a lander explodes off the bow; descent route.
**7. Failure conditions** — None on descent (always survivable); tempo/insertion varies by choice and execution.
**8. Multiplayer variations** — Squad picks descents independently; insertion points fan around the Command Center.
**9. Solo variation** — Solo descent.
**10. Transition** — Boots/rope-release onto the Command Center approach, control live, finale clock starts.
**11. Role variations** — SECURITY/COMMS get the breach vector flagged; others learn it on the ground.
**12. Randomized events** — Sector-fall order, deck explosion, descent outcome.
**13. Camera** — Sweeping deck establishing shot → Commander framed against the burning island → step to the
open bay → committed descent trail cam → ground stance.
**14. Audio** — Turbine thrum, launch roars, crowd murmur, Commander VO, breach klaxon, wind of descent.
**15. Emotional goal** — *Epic resolve.* Everything has led here; you jump into the apocalypse to end it.

---

## Cross-cutting rules (all intros)

- **Player-controlled, never a movie:** every intro grants at least one real free-movement window
  (cabin/deck/carriage walk) and one deliberate input (jump / pull / examine / descend). Locks are brief and skippable.
- **Teach by doing:** each intro's interactive beat *is* the tutorial for that mission's core verb.
- **Seamless hand-off:** prefer continuous control return (no fade) on disembark intros; reserve fade-to-black
  for the crash. The mission's first objective marker is already placed when control returns.
- **Skip-safe:** `skipIntro()` always drops the player at the mission's hand-off point with the first phase armed.
- **Additive & free-movement-safe:** the engine extends the current state machine; no existing mission breaks,
  and no permanent movement rails are introduced.
- **Replayability:** every intro carries 1 randomized wildlife/environment event and a randomized outcome
  (LZ, timing, route) so repeat runs differ.

---

## Build Plan (phased — additive)

**Phase 0 — Engine (foundation).** Generalize `startIntro/updateIntro` into a data-driven `INTRO[missionId]`
descriptor; current crash becomes `heli_crash` (zero behavior change for `evac`). *Low risk.*

**Phase 1 — Reuse-only intros (no new vehicle art).** `dna` (research-heli, no-crash landing) and the
"continuous hand-off" plumbing. Reuses `buildHeli`. *Low risk, high coverage.*

**Phase 2 — Jeep convoy (`ghosts`).** Reuses/extends the existing procedural `truck()` into a ranger jeep;
interior look + dash-log examine beat. *Medium — one new procedural rig.*

**Phase 3 — River boat (`blackout`) & Monorail (`last_sample`).** Two new procedural rigs (boat hull,
monorail car) + deck/carriage walk + schematic/lever hold beats. *Medium-high.*

**Phase 4 — HALO parachute (`fallen_outpost`) & Evac airship (`extinction`).** New transport/airship rigs +
**canopy/descent control** (the one genuinely new gameplay system) + cargo-bay/deck walk. *High — most work,
highest payoff; reuse one canopy controller across both.*

Each phase ships independently and is verified live before the next. New vehicle rigs follow the standing
**realistic / zero-gap** rule; where a high-fidelity GLB is unavailable, the procedural rig is built solid
(no gaps) and flagged here for a later art pass.
