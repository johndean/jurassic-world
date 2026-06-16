# /ue5-cinematic-slice — Isolated UE5 R&D Project

**This folder is the zero-risk boundary for all UE5 work.** It is a *parallel R&D project*, not a migration.
The live browser/iPad game (everything else in this repo) is a **protected, READ-ONLY production system**
and must keep shipping unchanged. Nothing in this folder is loaded by, linked to, or depended on by the
running game — it is inert relative to production.

**Target platform (owner decision):** **native iPad app** — iOS/iPadOS (Metal), **iPadOS 18.5+**, floor
**iPad 9th gen (A13) / iPad Pro 4th gen (A12Z)** → M4. Renderer = **UE5 Mobile (Metal) + baked lighting**;
**Nanite & Lumen are OFF at this floor** (M-series-only opt-in). **Two auto-detected quality tiers**
(Baseline A12Z/A13–A15 · Enhanced M1+). Input is **touch-first** (port the browser touch UX as reference).
Packaging needs a **Mac + Xcode** + **Apple Developer Program**. The browser PWA is **not** retired — it
stays as the instant-URL / oldest-device client.

> Governing plan: **`../design/UE5_PRODUCTION_PLAN.md`** · Current browser state: **`../design/AAA_ZERO_GAP_AUDIT.md`**
> · Detailed slice spec (GDD, project structure, data schema, systems design, shopping list): **`../design/ue5/`**

---

## The boundary (non-negotiable)

**Protected / READ-ONLY production** (may be read & mirrored, never modified by this initiative):
`../game.js`, `../index.html`, `../net.js`, `../server.js`, `../strings.js`, `../logic.js`,
`../data/*.json`, `../vendor/*`, `../assets/*`.

**This initiative may only create/modify files inside `ue5-cinematic-slice/`** (plus inert planning markdown
under `../design/`). If any task would touch the running game, it is rejected and replaced with an isolated
alternative.

**Mandatory safety check before any change:** *"Does this alter, replace, delete, refactor, or endanger the
current game?"* → if YES, reject and provide a zero-risk isolated alternative.

**Per-task output format:** 1) Reasoning · 2) Risk to production · 3) Confirm production untouched ·
4) Implementation · 5) Validation plan · 6) Rollback plan.

**Rollback for this entire initiative:** delete the `ue5-cinematic-slice/` folder. Because it has zero
inbound dependencies from production, removal restores the prior state completely. The browser game is
unaffected at every point.

---

## Intended project structure (created as work proceeds — all UE5 outputs stay here)

```
ue5-cinematic-slice/
├── README.md                  ← this file (the boundary)
├── PARITY_MATRIX.md           ← Phase 1 Discovery: current system → UE5 → gap (DONE)
├── RulesCore/                 ← Phase 2: read-only mirror of browser rules + golden-parity tests
│   ├── README.md              ← why a mirror, not a refactor of game.js
│   └── golden/                ← test vectors captured FROM the browser game (read-only capture)
├── UnrealProject/             ← the standalone UE5 project (no production coupling)
│   ├── Config/                ← DefaultEngine/Game/Input + DefaultDeviceProfiles (iOS Metal,
│   │                            Mobile renderer, baked lighting; Baseline/Enhanced tier scalability)
│   ├── Platforms/IOS/         ← iOS packaging settings (bundle id, iPadOS 18.5+ min, Metal)
│   ├── Content/
│   │   ├── Creatures/         ← rigged dino assets (Fab pack / Control Rig) + Data Assets
│   │   ├── Environment/       ← Megascans jungle, Landscape, water, foliage
│   │   ├── Characters/        ← MetaHuman cadet + locomotion
│   │   ├── Systems/           ← StateTree, subsystems (extraction/threat/noise/survival/difficulty)
│   │   ├── UI/                ← UMG HUD (touch-first) mirroring strings.js labels + palette + the
│   │   │                        proven browser touch controls (dual-stick, action buttons)
│   │   └── Cinematics/        ← Sequencer fly-throughs for the go/no-go screenshot
│   └── Source/                ← C++ (ACreatureBase, subsystems, Data Assets) if used
└── docs/                      ← slice-specific working notes, perf captures, validation logs
```

(UE5 binary assets and `.uproject`/`.uasset` files are authored in the UE editor by a hands-on engineer/
artist; this scaffold documents where they live. No binaries are committed by the planning pass.)

---

## Status

- **Phase 0 (browser stabilization):** ~80% done in the production game, build `2026-06-16-s` (iPad zoom,
  reset view, map pan-zoom, touch). Remaining: 60 FPS iPad gate + frame cap — handled as production
  maintenance, **outside this folder**.
- **Phase 1 Discovery:** parity matrix complete (`PARITY_MATRIX.md`).
- **Phase 1 visual prototype onward:** specification only; no UE5 project/binaries exist yet. Requires
  hands-on UE5 editor + artist work.

The browser game remains the authoritative production version throughout.
