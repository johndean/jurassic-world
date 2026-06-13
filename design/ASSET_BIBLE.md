# JURASSIC SURVIVAL: ISLAND ALPHA — Higgs Asset Production Bible

**Purpose:** one source of truth for generating a *consistent* visual world. Every Higgs prompt = a category template below **+** the Master Style DNA block **+** the Canon Constants. Never write a one-off prompt; extend a template.

---

## §0 — HIGGS MASTER STYLE DNA

Append this verbatim to the end of **every** prompt:

```text
Apply HIGGS MASTER STYLE DNA.

Style: ultra-photorealistic AAA cinematic realism. Visual target: Jurassic World
Dominion, Avatar: The Way of Water, Planet Earth III, Unreal Engine 5 cinematic.

Rendering: 8K detail, physically based rendering, film-quality lighting, global
illumination, volumetric fog, realistic atmospheric scattering, hyper-detailed
materials, realistic vegetation simulation, cinematic depth of field, real-world
scale accuracy, natural color grading, documentary realism.

No cartoon styling. No stylized rendering. No exaggerated proportions. No toy-like
appearance.

Camera: IMAX documentary quality, National Geographic wildlife cinematography,
dynamic environmental storytelling.

Output: production-ready AAA game key art.
```

### §0.1 — Human-render rule (MANDATORY override)
For any prompt containing a **human minor (under 18)**, the "indistinguishable from reality" target is **narrowed to "high-end UE5 in-engine cinematic CG character render"** — clearly a rendered game character, **not** a real photograph of a real child, and **not** a real-person likeness. Append to human-minor prompts:

```text
Rendered as a high-fidelity UE5 in-engine cinematic CG game character (stylized
photoreal), not a photograph of a real person. No real-person likeness.
```

- **No firearms, no military weapons in the hands of minors.** Cadets carry survival/rescue gear only (see §9). Weapons, if shown at all, belong to **adult rangers** only (§2).
- The full "indistinguishable from reality" target applies without narrowing to **dinosaurs, environments, vehicles, equipment, weather** (§3–§9).

### §0.2 — Canon Constants (paste relevant ones into each prompt)
- **Title lockup:** `JURASSIC SURVIVAL` (primary, all-caps, white, weight 800) over subtitle `ISLAND ALPHA` (orange accent, wide letter-spacing). Never "Jurassic Survival World."
- **Palette (hex):** accent/beacon `#e0772f` (warm orange-amber) · alert/danger `#d6562f` · safe/good `#6fae6b` · warn `#c9a23a` · stamina `#8fb8c4` · water/hydration `#5b9fd6` · text `#d7e0da` · dim text `#8a978f` · base dark `#0b0f0e`.
- **HUD typeface:** monospace, all-caps labels, technical/procedural feel.
- **World mood:** Island Alpha = foggy blue-grey jungle valley, low oppressive light, blue-grey exponential fog, pale concrete-grey ground, muted blue-grey sky. Tense survival-horror, isolation.
- **Real HUD labels (use these exact strings on any HUD-overlay art):** `MISSION OBJECTIVE` · `Reach the extraction beacon` · `Call extraction & survive the hold` · `SQUAD STATUS` · `THREAT LEVEL 0/10` … `10/10` · `HEALTH` `STAMINA` `NOISE` · `GPS · ISLAND ALPHA` + heading° · `EXTRACTION WINDOW` → `EXTRACTION INBOUND` (MM:SS) · `CALL EXTRACTION` · predator alert `Predator movement · [bearing]`. Do **not** invent labels like "EDIBLE/POISONOUS", "GATHER INTEL", weapon-count icons, or "06:01:23:37" timers — those appeared in draft art and are off-canon.

---

## §1 — Model routing & output specs

| Category | Higgs model | Aspect | Notes |
|---|---|---|---|
| Hero cover / marketing key art | **Recraft 4.1** (`recraft-v4-1`, 2k) | 16:9 | Renders title/HUD text; pin palette via `colors` to the hexes above |
| Store/social square, favicon source | Recraft 4.1 | 1:1 | |
| Character identity (reuse across scenes) | **Soul Cast** (`soul_cast`) | 16:9 | Generate once per character, reuse for consistency |
| Environments / biomes / weather | **Soul Location** (`soul_location`) | 16:9 or 21:9 | |
| Individual species portraits / behavior shots | Recraft 4.1 or Soul Location | 16:9 | |

Budget guidance: validation passes ~50/img; lock style on a small set before any full-roster run.

---

## §2 — HUMAN CHARACTERS

Apply §0.1 to all minors. Three playable **cadet** roles + adult support cast.

### Cadet — Scout (age 12)
```text
A 12-year-old jungle survival cadet, scout role. Athletic, realistic child anatomy.
Photoreal CG skin with sweat, mud, minor scratches. Weathered field clothing, tactical
survival backpack, binoculars at chest, NO weapons. Determined, focused expression
(not smiling, not heroic posing). Natural crouched observation posture in dense foggy
Jurassic jungle. Realistic cloth physics, cinematic environmental light.
[apply §0.1 human-render rule] [Apply HIGGS MASTER STYLE DNA]
```

### Cadet — Medic (age 13)
```text
A 13-year-old field-medic cadet. Emergency medical backpack with red-cross patch,
portable trauma kit on hip, NO weapons. Worn survival clothing, wet from rain. Fear
mixed with courage in the expression. Kneeling at a jungle extraction zone, fog behind.
[apply §0.1] [Apply HIGGS MASTER STYLE DNA]
```

### Cadet — Navigator (age 14)
```text
A 14-year-old navigator cadet. Holding a rugged digital map tablet glowing faint cyan,
GPS unit clipped to vest, NO weapons. Weathered field clothing, mud-streaked. Photoreal
CG facial detail, concentrated expression. Standing at a Jurassic river crossing in fog.
[apply §0.1] [Apply HIGGS MASTER STYLE DNA]
```

### Adult — Ranger Team Leader
```text
An elite adult Jurassic containment ranger, team leader. Weathered tactical uniform,
advanced field communications gear, tracking equipment, sidearm holstered (adult only).
Commanding, alert. Jungle operations environment, fog, low light.
[Apply HIGGS MASTER STYLE DNA]
```

### Adult — Ranger Extraction Team
```text
A dinosaur-containment extraction team of adult rangers in defensive formation at a
jungle landing zone, extraction helicopter rotor-wash and floodlights behind. Weathered
gear, tense readiness. [Apply HIGGS MASTER STYLE DNA]
```

### Adult — Genetic Scientist
```text
A senior genetic scientist in an abandoned, storm-damaged Jurassic laboratory. Hybrid
DNA research equipment, flickering screens, emergency lighting, oppressive atmosphere.
[Apply HIGGS MASTER STYLE DNA]
```

---

## §3 — PREDATORS (authoritative roster: 20)

One prompt per species. Template — substitute `{SPECIES}` and `{BEHAVIOR}`:
```text
A scientifically believable {SPECIES}, {BEHAVIOR}. Biological realism: natural muscle
mass, correct real-world scale, lifelike scale/skin texture, scars, parasites, mud,
environmental wear, wet from rain. Terrifying because it is real, not exaggerated.
Foggy Island Alpha jungle. [Apply HIGGS MASTER STYLE DNA]
```

**Pack hunters** — `{BEHAVIOR}` = "intelligent pack hunter, coordinated stalking posture, wet scales":
1. Velociraptor · 2. Deinonychus · 3. Troodon · 4. Atrociraptor · 5. Pyroraptor

**Ambush predators** — "ambush predator, low concealed posture in undergrowth":
6. Dilophosaurus · 7. Cryolophosaurus · 8. Ceratosaurus · 9. Monolophosaurus · 10. Rugops

**Pursuit predators** — "powerful pursuit predator mid-charge, driving leg muscles, jungle clearing":
11. Carnotaurus · 12. Majungasaurus · 13. Allosaurus · 14. Yangchuanosaurus · 15. Megalosaurus

**Water / river predators** — "river-hunting predator standing in shallow water, hunting fish, realistic water reflections":
16. Baryonyx · 17. Suchomimus · 18. Spinosaurus

**Apex predators** — "apex predator, massive scale, realistic weight, storm environment":
19. Tyrannosaurus Rex · 20. Giganotosaurus

> Gameplay note: the shipping game currently simulates 3 of these — **Deinonychus** (pack), **Tyrannosaurus Rex** (apex), and **Parasaurolophus** (herbivore, §4). Prioritize those three for in-game-facing art; the rest are the design/expansion target.

---

## §4 — HERBIVORES (authoritative roster: 10)

Template — substitute `{SPECIES}` and `{BEHAVIOR}`:
```text
A {SPECIES}, {BEHAVIOR}. Biological realism, correct scale, lifelike hide, mud, herd
context. Living-ecosystem feel. Foggy Island Alpha valley. [Apply HIGGS MASTER STYLE DNA]
```

**Small** — "alert, fast, flocking": 1. Gallimimus · 2. Dryosaurus · 3. Hypsilophodon
**Medium** — "grazing in a herd, crest/display visible, wary": 4. Parasaurolophus · 5. Corythosaurus · 6. Iguanodon · 7. Pachyrhinosaurus
**Large** — "defensive posture protecting young, massive": 8. Triceratops (herd, migrating, protecting young) · 9. Stegosaurus · 10. Ankylosaurus

---

## §5 — HYBRIDS (foreshadow only, do not fully reveal)
```text
A next-generation hybrid predator — combined Tyrannosaurus, Velociraptor and camouflage
genetics, extremely intelligent, partially obscured by night jungle and fog. Faint
bioluminescent tracking elements. Terrifying realism. Reveal only a silhouette/fragment;
build dread. [Apply HIGGS MASTER STYLE DNA]
```
Future set (config-only in-game, see SPECIES_ARCHITECTURE_v2.md): Indoraptor, Indominus Rex, aquatic / flying / camouflaged / enhanced-intelligence / pack-commander hybrids.

---

## §6 — ENVIRONMENTS (Soul Location)
- **Dense jungle:** `Jurassic tropical rainforest, towering ancient trees, fog, standing water, distant wildlife, massive scale, oppressive blue-grey light.`
- **River system:** `prehistoric river ecosystem, dense banks, predator crossing points, realistic water simulation and reflections.`
- **Swamp:** `prehistoric swamp biome, fog, murky water, predator nesting mounds, eggshells.`
- **Coastal/valley extraction zone:** `fortified evacuation facility — helipad, perimeter fencing (partly breached), ranger watchtower, comms tower, emergency floodlights, red warning beacons; seen across a foggy valley.`

Each ends with `[Apply HIGGS MASTER STYLE DNA]`.

---

## §7 — WEATHER SYSTEMS
Tropical storm · heavy rain · dense fog · thunderstorm · sunrise · sunset · full moon · jungle night · volcanic ash event. Each prompt:
```text
{WEATHER} over Island Alpha. Extreme environmental realism, natural atmospheric effects,
Jurassic ecosystem interaction. [Apply HIGGS MASTER STYLE DNA]
```

---

## §8 — VEHICLES
- **Ranger jeep:** `Jurassic containment ranger vehicle, heavy-duty off-road platform, weathered, operational, photoreal engineering.`
- **Extraction helicopter:** `military-grade rescue helicopter at a Jurassic jungle landing zone, rotor-wash, floodlights.`
- **River patrol boat:** `river patrol craft for Jurassic operations, realistic engineering, weathered.`

Each ends with `[Apply HIGGS MASTER STYLE DNA]`.

---

## §9 — EQUIPMENT & TOOLS (child-safe: NO military weapons)
Survival backpacks · medical/trauma kits · flashlights · radios · GPS devices · binoculars · flares · tracking devices · water-purification kits · climbing gear · extraction beacons. Template:
```text
{ITEM} designed for a Jurassic survival expedition. Weathered, functional, field-tested.
Photoreal materials, AAA product visualization, neutral studio or jungle context.
[Apply HIGGS MASTER STYLE DNA]
```

---

## §10 — HERO / KEY-ART RECIPES
Reconcile the gaps flagged by the owner: survival stress (sweat/mud/exhaustion), a *living* ecosystem (herbivore herds + predator-prey activity in the same frame), believable tactical movement, and a **mission-critical** HUD using only §0.2 labels.

### Hero cover (Recraft 4.1, 16:9, palette-pinned)
```text
In-game cinematic from a live extraction run on Island Alpha. A small squad (mix of
young cadets per §0.1 and an adult ranger) moving in tactical formation through dense
foggy jungle foreground — sweat, mud, exhaustion, hand signals, no weapons on the
cadets. Mid-ground: a living ecosystem — a Parasaurolophus/sauropod herd, scavengers,
and a scarred Tyrannosaurus Rex emerging by a river (predator-prey tension). Far
background through the fog: the fortified extraction facility (helipad, floodlights,
breached fence). Oppressive blue-grey light, volumetric fog, real-world scale.
Title lockup "JURASSIC SURVIVAL" / "ISLAND ALPHA" in white + #e0772f. Natural color
grading, documentary realism, NOT a movie poster. [Apply HIGGS MASTER STYLE DNA]
```

### Hero + HUD overlay (16:9)
Same scene, plus a restrained tactical HUD using ONLY §0.2 labels: top-left `MISSION OBJECTIVE / Reach the extraction beacon`; top-right `SQUAD STATUS` + `THREAT LEVEL 7/10`; center-top `EXTRACTION WINDOW 01:15`; bottom-left vitals `HEALTH / STAMINA / NOISE` bars in palette; `GPS · ISLAND ALPHA`; a red `Predator movement · NE` bracket on the T-Rex. Monospace, semi-transparent dark panels (`rgba(10,14,13,.62)`).

---

*Consistency check before any batch: title correct? palette pinned to hexes? cadets weapon-free & rendered as CG (not real photo)? dinos biologically real (scars/mud/scale)? HUD uses only §0.2 labels? — if any "no", fix the prompt, don't ship the image.*
