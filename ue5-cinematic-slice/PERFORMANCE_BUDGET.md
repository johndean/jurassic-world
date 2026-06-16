# Baseline Performance Budget — A12Z / A13 floor (Phase 1 starting targets)

Starting budgets to author against, **to be confirmed/retuned from the real device numbers** captured in
`PHASE1_RUNBOOK.md` step 12. The floor device is the design constraint, not the M4.

## Frame budget
| Target | Frame time | Notes |
|--------|-----------|-------|
| A12Z (8-core GPU, 6 GB) | **16.6 ms (60 fps)** goal; 33 ms (30) fallback | strong baseline device |
| A13 (4-core GPU) | **33 ms (30 fps)** locked; 16.6 (60) if it holds | true floor |
| **Sustained, not burst** | hold target after 10 min | A12Z/A13 *will* thermally throttle — budget for the throttled state |

## Per-frame scene budget (Baseline tier)
| Resource | Starting budget | Rationale |
|----------|-----------------|-----------|
| Draw calls | **≤ 700–900** | mobile forward; batch via instancing/HISM + PCG |
| Triangles on screen | **≤ 1.5–2 M** | no Nanite → manual LODs; aggressive distance LOD |
| Texture streaming pool | **≤ ~1.5–2 GB** | of the 6 GB shared; leave headroom for OS + buffers |
| Material instructions | **mobile-simple** | few layers; bake detail into textures, no heavy runtime layering |
| Dynamic lights | **1 sun (CSM) + ≤4 point** | everything else baked |
| Foliage instances (view) | **start 0.5 density** | scale up only if frame budget allows |
| Shadow res | **1024, 1 cascade** | bump only on Enhanced+ |
| MSAA | **2–4×** | 4 if GPU headroom on A12Z, else 2 |
| AO | **off at baseline** | mobile SSAO on Enhanced/Showcase only |

## Lighting doctrine
- **Bake everything static** (GPU Lightmass), one fixed overcast time-of-day. Indirect light + AO baked into
  lightmaps = the realism jump, paid at build time, ~free at runtime.
- Dynamic objects (creatures/player, Phase 2) use **CSM + baked sky/ambient + a couple of stationary lights**
  — not realtime GI.

## Memory doctrine
- App target **< ~2.5–3 GB** resident on the 6 GB A12Z (OS + Safari-in-background can exist). Use LOD groups,
  texture mip bias (set in `DefaultScalability.ini`), and World Partition streaming to stay under.

## If GPU-bound, cut in THIS order (re-measure each)
1. Foliage density → 2. View distance → 3. Shadow resolution/cascades → 4. MSAA 4→2 → 5. Post-FX (AO/DoF off)
→ 6. Texture mip bias up. Cutting foliage + view distance first preserves the lit, grounded look (the part
that actually reads as "realistic") while reclaiming the most ms.

## Tier deltas (reference)
- **Enhanced (M1–M3):** density 1.0, view 1.0, shadows 2048/2-cascade, AO on, DoF, 2K–4K textures, 60 fps.
- **Showcase (M4):** as Enhanced + Nanite trial + hardware-RT reflections/shadows trial, 4K, 120 Hz — the
  marketing/Sequencer beauty-shot device.
