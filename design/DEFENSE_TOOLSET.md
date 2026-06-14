# Defense Toolset & Combat Logic — Island Alpha

**Design intent:** you are expedition survivors, **not** soldiers. Defense is about **deterrence, distance,
and buying time to escape** — not gunning down dinosaurs. This keeps the survival/National-Geographic tone
(and the weapon-free canon: no military firearms; adults carry survival/deterrent gear). The **beacon is the
safe zone** — tools exist to get you *there alive*.

## The toolset (appropriate, on-theme)

| Tool | Effect | Notes / limits |
|---|---|---|
| **Flare** (handheld/flare gun) | Bright light + bang — most predators **recoil / break off** briefly | Few charges; primary deterrent; lights an area |
| **Air-horn / signal blast** | Startles a charging predator, **interrupts a lunge**; can also **lure** dinos toward the noise | Double-edged — noise also *draws* distant threats (ties into the noise system) |
| **Capsaicin / deterrent spray** | Close-range **repel + brief stagger** | Very short range; risky timing |
| **Throwable rock / decoy** | **Redirects** a predator's attention to a thrown spot | Distraction, not damage; great for slipping past |
| **Smoke flare** | Drops a **smoke screen** that breaks line-of-sight | Cover an escape / revive a teammate |
| **Survival knife / machete** | Last-resort **melee**, low damage, high risk | Only when cornered; not a strategy |
| **Trip-flare (placeable)** | Perimeter **early-warning + deter** on a path | Set before a hold; limited |

## Combat logic (deterrence model)
- Most tools apply a **fear/stagger** to nearby predators (reuse the existing `bb.scared` / flee logic and
  `Audio`), making them **break pursuit and retreat** rather than die. Killing is possible (melee/repeated
  hits) but slow and dangerous — escape is the intended answer.
- **Cooldowns + limited charges** keep it tense; no infinite spam.
- **Noise coupling:** loud tools (horn, flare bang) spike the player's `noise`, which can draw *other*
  predators — risk/reward, consistent with the stealth system.
- **Beacon safe zone:** inside the beacon radius predators disengage and won't attack — tools are for the
  journey, the beacon is the payoff.

## Role tie-ins (uses the existing specialist perks)
- **Survival** — better melee + more tool charges. **Tracker** — sees threats earliest (avoid > fight).
- **Comms** — noisemaker/decoy to pull threats off teammates. **Medic** — revive under a smoke flare.
- **Navigator** — escape-route awareness. **Research** — highlights a predator's hesitation/weak window.

## Implementation status
**Proposed / not yet built.** Suggested first slice: **Flare** (deter) + **throwable rock** (distract) +
**melee** (last resort), wired to a simple inventory + a `1/2/3` (desktop) / on-screen buttons (touch) HUD,
applying `scared`/stagger to predators in range. Then expand to horn / spray / smoke / trip-flare.

## Also pending (from the Opening Constitution)
- The interactive **helicopter-crash intro** code (design recorded in `OPENING_SEQUENCE.md`; the in-game
  cinematic state machine is not yet implemented). **Done now:** the evac helicopter shows on the
  minimap/tactical map as an inbound marker with a dashed track to the beacon.
