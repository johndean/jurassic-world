# Platform Parity Matrix — Desktop vs Mobile/Touch (+ Gamepad)

> Per the "one game, equal awareness on every device" mandate. Every gameplay function and how it is
> reached on each input. Detection: touch mode = `navigator.maxTouchPoints > 0 || "ontouchstart" ||
> pointer:coarse` (catches iPad desktop-mode too). Gamepad is polled every frame on any platform.

## Controls — how each action is performed

| Action | Desktop (KB+Mouse) | Gamepad | Mobile / Touch |
|--------|--------------------|---------|----------------|
| Move | `W A S D` / arrows | Left stick | Left on-screen stick (drag) |
| Look / aim | Mouse (pointer lock) | Right stick | Right look-pad (drag) |
| Sprint | `Shift` | A | SPRINT button |
| Crouch (quieter) | `Ctrl` | B | CROUCH button |
| **Jump / vault / climb** | `Space` | Y (edge) | **JUMP** button |
| Interact (climb tower · zip · call) | `E` | X (call) | CALL button |
| Use selected tool | `F` | RT (edge) | USE button |
| Select tool 1–6 | `1`–`6` | LB / RB cycle | Tap a tool chip (tap again = use) |
| Binoculars | `B` | LT (edge) | 👁 button |
| Binocular zoom | mouse wheel / `+` `-` | D-pad ↑ / ↓ | on-screen `+ / −` (bnIn/bnOut) |
| **Open / ENLARGE map** | `M` / click minimap | Start/Select (edge) | 🗺 button **and ⛶ ENLARGE** button |
| Close map | `M` / `Esc` / ✕ / tap backdrop | Start/Select | ✕ / tap backdrop |
| Controls reference | `H` / `?` | — | ❔ button (touch-mapping panel) |
| **Options / accessibility** | ⚙ OPTIONS button | — | ⚙ OPTIONS button |
| Map layer toggles (THREAT/TERRITORY/LAST-SEEN) | click chips | — | tap chips |

Notes:
- **Tools are tappable on all platforms** (`#tools .tool` click → select, re-tap → use), so the 1–6
  keys are a desktop convenience, not a requirement — touch reaches every tool.
- **Jump** is now wired on all three inputs (was keyboard-only before this pass).
- **Map** has an explicit **⛶ ENLARGE** button on the minimap so the full tactical view (all
  objectives, range rings, dino intel) is reachable without knowing the `M` shortcut.

## HUD / awareness — parity

| Element | Desktop | Mobile | Notes |
|---------|---------|--------|-------|
| Objective panel + mission % | ✅ | ✅ (narrower) | parity |
| Compass + heading | ✅ | ✅ (compacted) | **was hidden on mobile — fixed this pass** |
| Squad + THREAT meter | ✅ | ✅ (scaled 0.9) | **was hidden on mobile — fixed** |
| Contact alert (bearing) | ✅ | ✅ (compacted) | **was hidden on mobile — fixed** |
| Vitals (HP/STAM/NOISE) | ✅ | ✅ | parity |
| Oxygen (in water) | ✅ | ✅ | shown only while swimming |
| Survival chips (injured/cold/…) | ✅ | ✅ | shown only when relevant |
| Extraction widget + beacon distance | ✅ | ✅ | parity |
| Minimap + legend | ✅ | ✅ (legend compacted, not hidden) | **legend was hidden on mobile — fixed** |
| Tactical (ENLARGE) map + all objectives | ✅ | ✅ | full-screen, legend wraps |
| Directional damage indicator | ✅ | ✅ | screen-space, input-agnostic |
| Subtitles (VO captions) | ✅ | ✅ | optional (Options) |

The earlier audit flagged the mobile HUD hiding compass/threat/contact/legend as a **parity breach** —
that is resolved: those elements now reflow compact instead of disappearing.

## Accessibility (Options panel, all platforms, saved to localStorage)

| Option | Effect |
|--------|--------|
| Colorblind mode | Deuteranopia / Protanopia / Tritanopia palettes (Okabe-Ito), applied to HUD + map |
| HUD size | 100 / 115 / 130% (`zoom` on the HUD layer) |
| Subtitles | Radio/VO captions on/off |
| High-contrast text | Stronger text shadow for readability |

## Platform-specific handling

- **iPad / iOS Safari zoom:** `user-scalable=no` is ignored by iOS, so pinch + double-tap zoom are
  blocked via `gesturestart/change/end` + multi-touch `touchmove` preventDefault + `touch-action:
  manipulation`. Single taps on buttons are unaffected. This fixes the "stuck zoomed-in, can't expand"
  bug. The in-game HUD-size option (`zoom` on `#hud`) is separate and still works.
- **Pointer lock:** desktop only (mouse look); touch/gamepad use their own look paths, so no lock needed.
- **Binocular zoom:** desktop wheel/`+`/`-`; touch on-screen `+/−` buttons (page pinch is blocked, so
  zoom is always button-driven — no conflict).
- **Co-op lobby:** name/room text fields accept native keyboard on all platforms (typing guard prevents
  WASD/Space from leaking into gameplay while typing).

## Full parity — all prior gaps CLOSED ✅

- **Gamepad** is now fully mapped: move/look (sticks), A sprint · B crouch · Y jump · X call ·
  **LB/RB cycle tools · RT use · LT binoculars · D-pad ↑↓ zoom** · Start map. No action requires
  another input device.
- **Controls reference** is reachable on **every** platform: desktop `H`/`?` + ⌨ button shows the
  keyboard+gamepad panel; touch shows a dedicated **touch-mapping panel** via the ❔ button.
- **Co-op finale** is now **host-authoritative**: `startBoss`, `spawnAtEdge` (extract waves) and
  `spawnDrawn` (defend waves) are host-only; the Indominus + every wave is a normal `dinos[]` entry, so
  it syncs to clients as a puppet. Clients no longer spawn anything locally. *(Co-op design note: in a
  shared run the host drives the EXTINCTION ending choice; all players share the outcome.)*

### Mobile layout notes (this pass)
- The redundant 🗺 map button is hidden on touch — the minimap's **⛶ ENLARGE** button opens the map.
- **Options (⚙)** and **Controls (❔)** are compact icon buttons in the clear bottom-right corner,
  below the action buttons, so they never collide with the squad/compass/contact HUD that was un-hidden
  for parity.

## Verification checklist (per platform)

1. Move/look/sprint/crouch/jump all function.
2. Every tool selectable + usable; binoculars enter first-person and zoom.
3. Map opens via the primary control AND the ENLARGE button; all objectives + legend visible.
4. Compass, threat, contact, minimap legend all visible (not hidden) on a ≤760px screen.
5. iPad: pinch/double-tap do not zoom the page; HUD-size option still scales the HUD.
6. Options persist across reload; colorblind palette visibly changes alert/good/accent hues.
