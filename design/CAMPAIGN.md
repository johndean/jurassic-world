# Jurassic Survival — Campaign Architecture (Island Alpha)

Authoritative design for the 5-mission campaign. The browser build ships a **data-driven multi-phase
mission engine**: each mission is an ordered list of `phases`, each phase a generic objective the engine
drives (reach a marker → interact/hold → collect → survive → extract). The top-left OBJECTIVE panel
reflects the active mission and current phase. Adding/editing missions, phases, sites and dinosaurs is
**config only** (the `MISSIONS` map in `game.js`).

## Phase types (engine vocabulary)
- `reach` — get within `r` of a world site (objective marker shown).
- `interact` — reach the site + press **E** (CALL on touch): repair / hack / retrieve / insert / activate.
  `starts:"evac"` triggers the extraction/distress sequence.
- `collect` — gather `count` items (e.g. DNA samples via the field kit).
- `extract` — the finale: survive the evac hold while predators (`species`) converge, then board.
- Failure: player death, or extraction missed. Success: reach the boarded-evac win.

## Player roles (design target)
Ranger (recon/stealth), Security Officer (defense/escort), Scientist (research/ID/DNA), Veterinarian
(heal/stabilise/calm), Engineer (repair/power/access). Current build ships 6 specialist perks that map
onto these; a dedicated 5-role set with the strengths/weaknesses below is a follow-up.

## Missions (escalating campaign arc)
1. **THE LAST SAMPLE** — Easy · Scientist · stealth/exploration. Dock → access card → restore power →
   retrieve DNA → Cold Storage Vault → distress beacon → survive (T-Rex enters) → extract. Dinos:
   Velociraptor, Dilophosaurus, Carnotaurus. *(Fully built on the engine.)*
2. **OPERATION BLACKOUT** — Medium · Engineer · open-world survival. Restore Power Stations Alpha/Bravo/
   Charlie (each restart draws predators) → restart the grid → escape. Dinos: Raptors, Allosaurus, T-Rex.
   Dynamic events: fence failures, storms, generator explosions, migrations.
3. **GHOSTS OF SECTOR 9** — Hard · Ranger · investigation/tracking/horror. Campsite → attack evidence →
   survivor logs → cave system (Spinosaurus territory) → find survivor → escort → extract. Dinos:
   Raptors, Spinosaurus, Pteranodon.
4. **FALLEN OUTPOST** — Hard · Veterinarian · rescue/escort/defense. Reach Outpost Echo → find Maya in
   the collapsed watchtower → stabilise → escort to safehouse (raptor pursuit) → 10-min defense
   (Carnotaurus then T-Rex) → load Maya first → escape. AI-survivor follow is a follow-up.
5. **EXTINCTION PROTOCOL** — Nightmare · Security + Engineer · campaign finale. Command Center → restore
   comms → activate sector systems → unlock routes → defend → ACTIVATE EXTINCTION PROTOCOL → reach the
   final helicopter. Dinos: Raptors, Carnotaurus, Indominus Rex (boss), T-Rex, Mosasaurus, Pteranodon.
   Multiple endings (A all rescued / B bittersweet / C dark) — a follow-up.

## Deferred (UE5 / future iterations)
Bespoke set-pieces: Indominus/Mosasaurus/Pteranodon-swarm creatures, the Indominus boss encounter,
multiple endings, AI-survivor escort companion, storms & flooded-room engineering puzzles, per-role
ability kits. The generic engine plays each mission as a real multi-objective survival+extraction loop
today; these deepen it without a rewrite (config + per-type handlers).
