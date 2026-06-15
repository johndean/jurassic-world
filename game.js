import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";
import { EffectComposer } from "./vendor/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "./vendor/postprocessing/ShaderPass.js";
import { OutputPass } from "./vendor/postprocessing/OutputPass.js";
import { mergeGeometries } from "./vendor/BufferGeometryUtils.js";
import { clone as skeletonClone } from "./vendor/SkeletonUtils.js";
import { Net } from "./net.js";
import { STR } from "./strings.js";

/* ============================================================================
   Jurassic Survival: Island Alpha — single-player vertical slice.
   Architecture note: this is the SOLO port of a server-authoritative co-op
   brief. There is one source-of-truth state object `S` (the would-be room
   snapshot). The HUD reads only `S`. Sim runs on a fixed 60Hz step; AI decides
   at ~4Hz; HUD refreshes at ~12Hz — the same cadences the netcode brief names.
   // TODO v2: replace `S` mutation with Colyseus schema + server tick; clients
   //          predict self, interpolate remotes & all dinos. Seams kept intact.
   ============================================================================ */

// ---- deterministic RNG (mulberry32) — same seed → same run (design-system §12.1)
let _seed = (Date.now() ^ 0x9e3779b9) >>> 0;
function rng() { _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0; let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function rand(a, b) { return a + (b - a) * rng(); }
function reseed(s) { _seed = (s ^ 0x9e3779b9) >>> 0; }

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const DEG = Math.PI / 180;

// ---- DOM refs
const $ = (id) => document.getElementById(id);
const canvas = $("c");

// ---- data, loaded at boot (data-driven content; no per-species code)
let SPECIES = {};      // id -> profile (with resolved .arch attached at boot)
let ARCHETYPES = {};   // archetype name -> behavior profile (data/archetypes.json)
let CODEX = {};        // id -> field-guide content (data/codex.json)
let BIOME = null;

// Map the legacy per-species `role` enum onto archetypes, so a species missing
// an explicit `archetype` (or archetypes.json failing to load) still behaves.
const ROLE_ARCH = { grazer: "herd-grazer", pack: "pack-hunter", apex: "apex" };
function resolveArchetype(sp) {
  return ARCHETYPES[sp.archetype] || ARCHETYPES[ROLE_ARCH[sp.role]] || {
    behaviorClass: sp.diet === "herbivore" ? "prey" : "predator",
    baseState: sp.diet === "herbivore" ? "Graze" : "Patrol",
    packTactics: sp.role === "pack", apexThreat: sp.role === "apex",
  };
}
// AI reads these, never the role enum. role stays as HUD/minimap metadata.
function archOf(sp) { return sp.arch || (sp.arch = resolveArchetype(sp)); }
function isPrey(sp) { return archOf(sp).behaviorClass === "prey"; }
function usesPackTactics(sp) { return !!archOf(sp).packTactics; }
function isApex(sp) { return !!archOf(sp).apexThreat; }
function baseStateFor(sp) { return archOf(sp).baseState || (isPrey(sp) ? "Graze" : "Patrol"); }

// ---- 3D model cache (real .glb dino models replace grey-box primitives) ----
const MODELS = {};                 // modelPath/url -> prepared THREE.Object3D template, or null if unavailable
const MODEL_ANIMS = {};            // modelPath/url -> AnimationClip[] (for rigged/animated models)
// Served from the Higgsfield CDN (CORS *), so big .glb files stay out of the git repo.
// Models are WebP+quantized-compressed (gltf-transform), ~1-2 MB each, served from the repo
// (was ~10-16 MB each off the Higgsfield CDN — 12x smaller, so dinos texture in near-instantly).
const PLAYER_MODEL = "./assets/models/player.glb";
const GROUND_TEX = "https://d8j0ntlcm91z4.cloudfront.net/user_3F4NGeiRVgVtbKFFkoeC4vFwa2f/hf_20260614_002025_be16d317-be18-49b8-95e3-b3ad06fb8dc2.png";
const _texLoader = new THREE.TextureLoader();
// alpha-cutout billboard textures (transparent PNGs) for dense instanced jungle foliage
const BILLBOARDS = {
  bush: "https://d8j0ntlcm91z4.cloudfront.net/user_3F4NGeiRVgVtbKFFkoeC4vFwa2f/hf_20260614_004601_9bbfa90f-b025-45fd-8a5e-c2b5601b0e93.png",
  grass: "https://d8j0ntlcm91z4.cloudfront.net/user_3F4NGeiRVgVtbKFFkoeC4vFwa2f/hf_20260614_004607_4167c467-a11a-4419-9fda-2cf0f04ac6dd.png",
};
// foliage models (CDN .glb) used to replace grey-box trees; filled with URLs once generated
const FOLIAGE = {
  tree: "./assets/models/tree.glb",
  fern: "./assets/models/fern.glb",
};
const HELI_MODEL = "./assets/models/helicopter.glb";   // realistic evac chopper (streams in; procedural fallback)
// photoreal hero ruin structures (streamed .glb); empty until generated. {url, x, z, targetH, yaw}
const RUINS = {
  gate: { url: "./assets/models/ruin_gate.glb", x: 0, z: -56, h: 12, yaw: 0 },
  centre: { url: "./assets/models/ruin_centre.glb", x: -45, z: 26, h: 10, yaw: 0.5 },
};
const PLAYER_MODEL_YAW = 0;        // facing correction; flip to Math.PI if the player faces the camera
let playerMixer = null, playerAction = null;
const GAIT_RATE = { idle: 0, walk: 1, run: 1.9, crouch: 0.6 };  // walk-clip playback speed per gait

// ---- selectable expedition specialists (role = player character + a gameplay perk) ----
// model: per-role rigged .glb (streams in; falls back to the default player model until present).
const EMPTY_MOD = {};
const ROLES = [
  { id: "navigator", name: "NAVIGATOR", img: "./assets/keyart/squad/card_navigator.png", model: "./assets/models/char_navigator.glb", perk: "Efficient routes · +8% movement", mod: { speed: 1.08 } },
  { id: "tracker",   name: "TRACKER",   img: "./assets/keyart/squad/card_tracker.png",   model: "./assets/models/char_tracker.glb",   perk: "Field-craft · predators notice you slower", mod: { seen: 0.78 } },
  { id: "medic",     name: "MEDIC",     img: "./assets/keyart/squad/card_medic.png",     model: "./assets/models/char_medic.glb",     perk: "Field medicine · 2× health regen", mod: { heal: 2.0 } },
  { id: "comms",     name: "COMMS",     img: "./assets/keyart/squad/card_comms.png",     model: "./assets/models/char_comms.glb",     perk: "Fast evac · extraction hold −15s", mod: { hold: -15 } },
  { id: "survival",  name: "SURVIVAL",  img: "./assets/keyart/squad/card_survival.png",  model: "./assets/models/char_survival.glb",  perk: "Endurance · stamina lasts far longer", mod: { drain: 0.6 } },
  { id: "research",  name: "RESEARCH",  img: "./assets/keyart/squad/card_research.png",  model: "./assets/models/char_research.glb",  perk: "Careful steps · −30% noise", mod: { noise: 0.7 } },
];
let selectedRole = ROLES[0];
function curPlayerModel() { const u = selectedRole && selectedRole.model; return (u && MODELS[u]) ? u : PLAYER_MODEL; }
function initCharSelect() {
  const host = $("charSelect"); if (!host) return;
  host.innerHTML = ROLES.map((r, i) => `<div class="char-card${i === 0 ? " sel" : ""}" data-i="${i}">
    <img src="${r.img}" alt="${r.name}" loading="lazy"><div class="cc-role">${r.name}</div><div class="cc-perk">${r.perk}</div></div>`).join("");
  host.querySelectorAll(".char-card").forEach(card => card.addEventListener("click", () => {
    selectedRole = ROLES[+card.dataset.i];
    host.querySelectorAll(".char-card").forEach(c => c.classList.toggle("sel", c === card));
    if (MODELS[curPlayerModel()]) buildPlayer();   // live-preview the chosen avatar if loaded
    tabsDone.role = true; showTab("coop");          // auto-advance to the name / co-op tab
  }));
}

/* ============================================ missions (data-driven) ===== *
 * Additive: pick a mission on the homepage; its steps drive the top-left
 * objective panel. Both end in extraction — free movement throughout. */
const DNA_GOAL = 3;
const beaconDistM = () => Math.round(Math.sqrt(dist2(S.player.x, S.player.z, S.extraction.beacon.x, S.extraction.beacon.z)));
const MISSIONS = {
  evac: {
    id: "evac", name: "EVACUATION", tag: "FREE-FOR-ALL · BASIC",
    short: "Reach the beacon, call the evac, survive the hold.",
    blurb: "One survivor. A foggy valley that hears every step. Reach the beacon, call the evac, and live through the hold while the apex closes in.",
    sub: () => STR.objReach + " · " + beaconDistM() + " " + STR.km,
    steps: [
      { l: () => STR.objLocate, done: () => S._everInRange },
      { l: () => STR.objCall, done: () => S.extraction.won },
    ],
  },
  dna: {
    id: "dna", name: "DNA SAMPLE COLLECTION", tag: "FIELD SCIENCE",
    short: "Tranq / trap & sample live dinosaurs, then evac.",
    blurb: "Recover live dinosaur DNA. Use the watchtowers and binoculars to hunt safely — tranq or trap a target, draw a blood sample, then reach the beacon and evac. Extraction unlocks once the samples are secured.",
    sub: () => dnaSamples >= DNA_GOAL ? "DNA secured · reach the beacon · " + beaconDistM() + " " + STR.km : `Samples ${dnaSamples}/${DNA_GOAL} · climb a tower, glass (B), tranq (4) & sample (6)`,
    steps: [
      { l: () => `Collect DNA samples  (${dnaSamples}/${DNA_GOAL})`, done: () => dnaSamples >= DNA_GOAL },
      { l: () => "Reach the beacon & extract", done: () => S.extraction.won },
    ],
  },
};
let selectedMission = MISSIONS.evac;
function initMissionSelect() {
  const host = $("missionSelect"); if (!host) return;
  const keys = Object.keys(MISSIONS);
  host.innerHTML = keys.map((k, i) => { const m = MISSIONS[k]; return `<div class="mission-card${i === 0 ? " sel" : ""}" data-k="${k}"><div class="mc-name">${m.name}</div><div class="mc-tag">${m.tag}</div><div class="mc-desc">${m.short}</div></div>`; }).join("");
  host.querySelectorAll(".mission-card").forEach(card => card.addEventListener("click", () => {
    selectedMission = MISSIONS[card.dataset.k];
    host.querySelectorAll(".mission-card").forEach(c => c.classList.toggle("sel", c === card));
    const b = $("sBlurb"); if (b) b.textContent = selectedMission.blurb;
    tabsDone.mission = true; showTab("role");   // auto-advance to the specialist tab
  }));
}
let tabsDone = { mission: false, role: false, coop: false };
function showTab(k) {   // switch tab; visiting the co-op tab counts it complete (solo needs no input)
  const tabs = $("startTabs"); if (!tabs) return;
  tabs.querySelectorAll(".tab").forEach(x => x.classList.toggle("sel", x.dataset.tab === k));
  document.querySelectorAll(".tabpanel").forEach(p => p.classList.toggle("on", p.dataset.panel === k));
  if (k === "coop") tabsDone.coop = true;
  refreshStart();
}
function refreshStart() {   // BEGIN EXTRACTION RUN is locked until mission + specialist + co-op tab are all done
  const btn = $("startBtn"); if (!btn) return;
  const ready = tabsDone.mission && tabsDone.role && tabsDone.coop;
  btn.disabled = !ready; btn.classList.toggle("locked", !ready);
  btn.textContent = ready ? STR.start : "▸ COMPLETE ALL 3 TABS";
  const tabs = $("startTabs"); if (tabs) tabs.querySelectorAll(".tab").forEach(x => x.classList.toggle("done", !!tabsDone[x.dataset.tab]));
}
function initTabs() {   // homepage: Select Mission | Select Specialist | Name & Co-op (Field Guide + START always visible)
  const tabs = $("startTabs"); if (!tabs) return;
  tabs.querySelectorAll(".tab").forEach(tb => tb.addEventListener("click", () => showTab(tb.dataset.tab)));
  refreshStart();
}

/* ===== campaign missions (multi-phase, data-driven; run on the generic engine below) ===== */
Object.assign(MISSIONS, {
  last_sample: {
    id: "last_sample", name: "THE LAST SAMPLE", tag: "EASY · SCIENTIST · STEALTH",
    short: "Recover the final DNA sample from the research facility, then evac.",
    blurb: "The genetics program has collapsed. One final DNA sample remains inside the Sector 4 research facility — but predators have already entered. Restore power, retrieve the container, reach the Cold Storage Vault, and hold for extraction as the T-Rex closes in.",
    phases: [
      { t: "interact", l: "Research dock — swipe the access card", x: -74, z: -56, r: 7, site: "safehouse" },
      { t: "interact", l: "Restore facility power — hold to start the generator", x: -42, z: -74, r: 7, site: "generator" },
      { t: "interact", l: "Retrieve the DNA container", x: 36, z: -52, r: 7, site: "facility" },
      { t: "interact", l: "Reach the Cold Storage Vault — insert DNA", x: 66, z: 48, r: 7, site: "facility" },
      { t: "interact", l: "Activate the distress beacon", atBeacon: true, r: 7, starts: "evac" },
      { t: "extract", l: "Survive the hold — T-REX inbound — board the evac", species: "trex" },
    ],
  },
  blackout: {
    id: "blackout", name: "OPERATION BLACKOUT", tag: "MEDIUM · ENGINEER · SURVIVAL",
    short: "Restart three power stations and the island grid, then escape.",
    blurb: "The power grid failed and the fences are offline — predators roam freely. Restart Power Stations Alpha, Bravo and Charlie (every generator draws dinosaurs), return to the Control Center to restart the grid, then escape before the trapped predators reach you.",
    phases: [
      { t: "reach", l: "Reach Power Station Alpha", x: -80, z: 40, r: 7, site: "generator" },
      { t: "interact", l: "Repair Generator Alpha — the noise draws predators", x: -80, z: 40, r: 7, site: "generator", draws: "deinonychus", drawN: 3 },
      { t: "reach", l: "Reach Power Station Bravo", x: 18, z: -82, r: 7, site: "generator" },
      { t: "interact", l: "Repair Generator Bravo", x: 18, z: -82, r: 7, site: "generator", draws: "velociraptor", drawN: 3 },
      { t: "interact", l: "Restart Generator Charlie", x: 84, z: 10, r: 7, site: "generator", draws: "deinonychus", drawN: 4 },
      { t: "interact", l: "Return to Control Center — restart the grid", x: 0, z: 0, r: 8, starts: "evac", site: "command" },
      { t: "extract", l: "Escape before the trapped predators reach you", species: "allosaurus" },
    ],
  },
  ghosts: {
    id: "ghosts", name: "GHOSTS OF SECTOR 9", tag: "HARD · RANGER · INVESTIGATION",
    short: "Track the missing survey team through Spinosaurus territory.",
    blurb: "A survey team vanished in Sector 9 and satellite shows movement. Investigate the campsite, follow the tracks through the cave system — Spinosaurus territory — find the survivor and get them to extraction.",
    phases: [
      { t: "reach", l: "Investigate the abandoned campsite", x: -60, z: 70, r: 7, site: "campsite" },
      { t: "interact", l: "Examine the attack evidence — follow the tracks", x: -60, z: 70, r: 7, site: "campsite" },
      { t: "reach", l: "Recover the survivor's radio log", x: 10, z: 88, r: 7, site: "safehouse" },
      { t: "reach", l: "Enter the cave system — Spinosaurus territory", x: 78, z: 64, r: 7, site: "cave" },
      { t: "interact", l: "Find the missing surveyor", x: 78, z: 64, r: 7, site: "cave" },
      { t: "interact", l: "Signal for extraction", atBeacon: true, r: 7, starts: "evac" },
      { t: "extract", l: "Protect the survivor & reach the evac", species: "spinosaurus" },
    ],
  },
  fallen_outpost: {
    id: "fallen_outpost", name: "FALLEN OUTPOST", tag: "HARD · VETERINARIAN · RESCUE",
    short: "Reach the injured ranger, stabilise her, escort to extraction.",
    blurb: "An emergency beacon is transmitting from Ranger Outpost Echo — Ranger Maya is injured, alone, and being hunted. Reach her, stabilise the bleeding, escort her to the safehouse, then hold the extraction as Carnotaurus and the T-Rex arrive. Load Maya first.",
    phases: [
      { t: "reach", l: "Reach Ranger Outpost Echo", x: 70, z: -70, r: 7, site: "outpost" },
      { t: "interact", l: "Search the collapsed watchtower — find Maya", x: 70, z: -70, r: 7, site: "outpost" },
      { t: "interact", l: "Stabilise Maya — stop the bleeding", x: 70, z: -70, r: 7, site: "outpost" },
      { t: "reach", l: "Escort Maya to the safehouse (raptors pursue)", x: -20, z: -30, r: 7, site: "safehouse" },
      { t: "interact", l: "Activate the emergency extraction beacon", atBeacon: true, r: 7, starts: "evac" },
      { t: "extract", l: "Hold — Carnotaurus then T-Rex — load Maya & escape", waves: ["carnotaurus", "trex"] },
    ],
  },
  extinction: {
    id: "extinction", name: "EXTINCTION PROTOCOL", tag: "NIGHTMARE · FINALE",
    short: "Reach Command, activate the protocol, escape the collapsing island.",
    blurb: "Jurassic World is collapsing — a containment breach has freed multiple apex predators and the evacuation has begun. Reach the Command Center, restore comms, unlock the evacuation routes, defend the line, ACTIVATE EXTINCTION PROTOCOL, then reach the final helicopter as the apexes converge.",
    phases: [
      { t: "reach", l: "Reach the Command Center", x: 0, z: -86, r: 8, site: "command" },
      { t: "interact", l: "Restore communications", x: 0, z: -86, r: 8, site: "command" },
      { t: "reach", l: "Activate sector emergency systems", x: -88, z: -20, r: 7, site: "generator" },
      { t: "interact", l: "Unlock the evacuation routes", x: -88, z: -20, r: 7, site: "generator" },
      { t: "defend", l: "Defend the Command Center — hold the line", x: 0, z: -86, r: 9, site: "command", dur: 45, species: "velociraptor", n: 3, every: 7 },
      { t: "interact", l: "ACTIVATE EXTINCTION PROTOCOL", x: 0, z: -86, r: 8, site: "command" },
      { t: "boss", l: "INDOMINUS REX — survive, then choose how this ends", x: 0, z: -86, r: 9 },
    ],
  },
});

/* ---- generic multi-phase mission engine (additive; only runs for missions with .phases) ---- */
let MC = null, objMarker = null;   // MC = campaign runtime { idx, started }
const activeCampaign = () => (selectedMission && selectedMission.phases) ? selectedMission : null;
function phaseSite(ph) { return ph.atBeacon ? [S.extraction.beacon.x, S.extraction.beacon.z] : [ph.x, ph.z]; }
function setObjMarker(x, z, color, kind) {
  if (objMarker) { scene.remove(objMarker); objMarker = null; }
  if (x == null) return;
  const g = new THREE.Group(); g.position.set(x, groundH(x, z), z);
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.5, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12; g.add(ring);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 18, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false })); beam.position.y = 9; g.add(beam);
  g.add(Object.assign(new THREE.PointLight(color, 1.5, 44), { position: new THREE.Vector3(0, 5, 0) }));
  if (kind === "interact") {   // a physical console you walk up to and operate (button glows)
    const metal = new THREE.MeshStandardMaterial({ color: 0x3c4038, roughness: 0.7, metalness: 0.4 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 1.1, 8), metal); post.position.y = 0.55; g.add(post);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.12), metal); panel.position.set(0, 1.2, 0); panel.rotation.x = -0.45; g.add(panel);
    const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4 }));
    btn.rotation.x = Math.PI / 2 - 0.45; btn.position.set(0, 1.24, 0.12); g.add(btn); g.userData.btn = btn;
  }
  objMarker = g; objMarker.userData.ring = ring; scene.add(g);
}
function applyPhaseMarker() {
  const m = activeCampaign(); if (!m || !MC) { setObjMarker(null); return; }
  const ph = m.phases[MC.idx];
  if (!ph) { setObjMarker(null); return; }
  if (ph.t === "interact") { const [x, z] = phaseSite(ph); setObjMarker(x, z, 0x8fb8c4, "interact"); }
  else if (ph.t === "reach") { const [x, z] = phaseSite(ph); setObjMarker(x, z, 0x8fb8c4); }
  else if (ph.t === "defend" || ph.t === "boss") { const [x, z] = phaseSite(ph); setObjMarker(x, z, 0xd6562f); }   // hold-the-line / boss marker (alert)
  else if (ph.t === "extract") setObjMarker(S.extraction.beacon.x, S.extraction.beacon.z, 0xe0772f);
  else setObjMarker(null);
}
function startMission() {
  const m = activeCampaign();
  if (!m) { MC = null; setObjMarker(null); return; }
  m.phases.forEach(p => { p._done = false; });   // clear per-run interact flags
  MC = { idx: 0, started: false }; applyPhaseMarker();
}
const phLabel = ph => (typeof ph.l === "function" ? ph.l() : ph.l);
// The single source of truth for "what's the current step + where" — used by the HUD and the map so the
// objective always tracks the NEXT step of the active mission (not the fixed extraction beacon).
function currentObjective() {
  const cm = activeCampaign();
  if (cm && MC) {
    const ph = cm.phases[MC.idx]; if (!ph) return null;
    if (ph.t === "extract" || ph.atBeacon) return { x: S.extraction.beacon.x, z: S.extraction.beacon.z, label: phLabel(ph), atBeacon: true };
    const [x, z] = phaseSite(ph); return { x, z, label: phLabel(ph) };
  }
  if (selectedMission.id === "dna") {
    if (dnaSamples < DNA_GOAL) return { roaming: true, label: `Tranq & sample a live dino  (${dnaSamples}/${DNA_GOAL})` };
    return { x: S.extraction.beacon.x, z: S.extraction.beacon.z, label: "Reach the beacon & extract", atBeacon: true };
  }
  return { x: S.extraction.beacon.x, z: S.extraction.beacon.z, label: "Reach the extraction beacon", atBeacon: true };   // evac / default
}
function missionInteractInRange() {   // the active interact phase if the player is standing at its console, else null
  const m = activeCampaign(); if (!m || !MC) return null;
  const ph = m.phases[MC.idx]; if (!ph || ph.t !== "interact" || ph._done) return null;
  const [x, z] = phaseSite(ph);
  return dist2(S.player.x, S.player.z, x, z) < (ph.r || 7) * (ph.r || 7) ? ph : null;
}
function finishMissionInteract(ph) {   // called when the player completes the HOLD (see updateAction)
  ph._done = true;
  if (ph.starts === "evac" && !S.extraction.called) { S.extraction.called = true; S.player.noise = 1; spawnTimer = 0; Audio.beacon(true); Audio.roar(); startEvac(); }
  if (ph.draws) {   // the machine's noise pulls predators in (OPERATION BLACKOUT's core loop)
    S.player.noise = 1; spawnTimer = 0; Audio.roar();
    for (let i = 0; i < (ph.drawN || 3); i++) spawnDrawn(ph.draws, S.player);
    toast("⚠ THE NOISE DRAWS PREDATORS");
  }
  Audio.beacon(false); flash(); toast("✓ " + phLabel(ph));
}
function callReady() {   // would tryCall() succeed right now? (drives the CALL prompt)
  if (S.extraction.called) return false;
  const cm = activeCampaign();
  if (cm && MC) { const ph = cm.phases[MC.idx]; return !!(ph && ph.t === "extract"); }
  if (selectedMission.id === "dna") return dnaSamples >= DNA_GOAL;
  return true;
}
// Contextual interaction prompt + HOLD-to-act. The player always SEES what they can do and chooses to
// act; hold actions fill a progress bar for clear feedback. Press actions (zip/call) fire on E/CALL.
let actionHold = 0;
const INTERACT_HOLD = 1.2;
function updateAction(dt) {
  const prompt = $("prompt"); if (!prompt) return;
  const P = S.player, touch = isTouch, keyTxt = touch ? "HOLD ACTION" : "HOLD E", pressTxt = touch ? "TAP ACTION" : "PRESS E";
  let label = null, hold = false, prog = 0;
  const holding = keys.has("KeyE") || input.action;
  if (P.zip) { actionHold = 0; }
  else if (P.onTower) { label = pressTxt + " · ZIP DOWN"; actionHold = 0; }
  else {
    const ph = missionInteractInRange();
    if (ph) {
      hold = true;
      if (holding) { actionHold = Math.min(INTERACT_HOLD, actionHold + dt); if (actionHold >= INTERACT_HOLD) { finishMissionInteract(ph); actionHold = 0; } }
      else actionHold = Math.max(0, actionHold - dt * 2.5);
      prog = actionHold / INTERACT_HOLD;
      if (objMarker && objMarker.userData.btn) objMarker.userData.btn.material.emissiveIntensity = 1.2 + prog * 3.2;   // button glows as it engages
      label = keyTxt + " · " + phLabel(ph).toUpperCase();
    } else { actionHold = 0; if (S.extraction.inRange && callReady()) label = pressTxt + " · CALL EXTRACTION"; }
  }
  if (label) { prompt.classList.add("on"); $("promptTxt").textContent = label; const bar = $("promptBar"); bar.style.opacity = hold ? "1" : "0"; bar.style.width = (hold ? prog * 100 : 0).toFixed(0) + "%"; }
  else prompt.classList.remove("on");
  // light up the on-screen ACTION button whenever something can be activated (the "power button" cue)
  const ba = $("btnCall"); if (ba) ba.classList.toggle("act-ready", !!label);
}
function updateMission(dt) {
  const m = activeCampaign(); if (!m || !MC) return;
  if (objMarker) objMarker.userData.ring.rotation.z += dt * 1.2;
  const sc = SURVIVORS[m.id];   // the survivor stands & follows once the escort phase is reached
  if (survivor) { survivor.following = !!(sc && MC.idx >= sc.escortFrom); updateSurvivor(dt); }
  const ph = m.phases[MC.idx]; if (!ph) return;
  const P = S.player; let done = false;
  if (ph.t === "reach") { const [x, z] = phaseSite(ph); if (dist2(P.x, P.z, x, z) < (ph.r || 7) * (ph.r || 7)) done = true; }
  else if (ph.t === "interact") { if (ph._done) done = true; }
  else if (ph.t === "collect") { if (dnaSamples >= (ph.count || 3)) done = true; }
  else if (ph.t === "defend") {   // hold the line: survive a timed predator assault at the site
    const [x, z] = phaseSite(ph);
    if (!MC.started) { MC.started = true; MC.defendT = ph.dur || 45; MC.spawnAcc = 0; MC.heldOk = false; S.player.noise = 1; spawnTimer = 0; Audio.roar(); for (let i = 0; i < (ph.n || 3); i++) spawnDrawn(ph.species || "deinonychus", P); toast("⚠ HOLD THE LINE — " + Math.ceil(MC.defendT) + "s"); }
    const inZone = dist2(P.x, P.z, x, z) < ((ph.r || 9) + 6) * ((ph.r || 9) + 6);
    if (MC.defendT > 0) {                                        // still holding: count down and keep the assault coming
      MC.defendT -= dt; MC.spawnAcc += dt;
      if (MC.spawnAcc >= (ph.every || 8)) { MC.spawnAcc = 0; spawnDrawn(ph.species || "deinonychus", P); }
      if (MC.defendT <= 0) { MC.heldOk = inZone; if (!inZone) toast("⚠ RETURN TO THE POST TO SECURE IT"); }   // bell rung: snapshot whether you held, prompt if knocked off
    }
    // timer done → no more waves (no infinite spawns while a knocked-back player scrambles back); complete if you held at the bell or step back in
    if (MC.defendT <= 0 && (MC.heldOk || inZone)) done = true;
  }
  else if (ph.t === "boss") {   // EXTINCTION finale — Indominus encounter + branching endings (resolves the run itself)
    if (!MC.started) { MC.started = true; startBoss(); }
    updateBoss(dt);
  }
  else if (ph.t === "extract") {
    if (!MC.started) {
      MC.started = true; if (!S.extraction.called) { S.extraction.called = true; S.player.noise = 1; spawnTimer = 0; Audio.beacon(true); Audio.roar(); startEvac(); }
      MC.waves = ph.waves || (ph.species ? [ph.species] : []); MC.wi = 0; MC.waveT = 0;
      if (MC.waves[0]) spawnAtEdge(MC.waves[0], P);
    }
    MC.waveT += dt;   // sequenced waves: next apex inbound once this one is cleared (or after a dwell)
    if (MC.waves && MC.wi < MC.waves.length - 1) {
      const aliveCur = dinos.filter(d => d.alive && d.sp.id === MC.waves[MC.wi]).length;
      if ((aliveCur === 0 && MC.waveT > 4) || MC.waveT > 28) { MC.wi++; MC.waveT = 0; spawnAtEdge(MC.waves[MC.wi], P); const nm = SPECIES[MC.waves[MC.wi]]; toast("⚠ " + (nm ? nm.displayName.toUpperCase() : "PREDATOR") + " INBOUND"); }
    }
    if (S.extraction.won) done = true;
  }
  if (done) {
    MC.idx++; MC.started = false;
    if (MC.idx >= m.phases.length) setObjMarker(null);
    else { applyPhaseMarker(); const np = m.phases[MC.idx]; toast("OBJECTIVE · " + (typeof np.l === "function" ? np.l() : np.l)); }
  }
}
const GRACE_S = 7;   // predators ignore the player for the first seconds of a run (anti-spawn-camp)
const _gltfLoader = new GLTFLoader();
function loadModel(path) {
  return new Promise(res => _gltfLoader.load(path,
    gltf => { gltf.scene.traverse(o => { if (o.isMesh) o.frustumCulled = true; }); MODEL_ANIMS[path] = gltf.animations || []; res(gltf.scene); },
    undefined,
    () => res(null)));            // missing/failed model -> null -> grey-box fallback
}
// All .glb are WebP+1024 texture-compressed to ~1-2 MB (gltf-transform), so no model gates the rest.
const _loadingModels = {};   // path -> in-flight Promise, so preload + the guide never double-fetch the same .glb
function loadModelOnce(path) {
  if (!path) return Promise.resolve(null);
  if (MODELS[path]) return Promise.resolve(MODELS[path]);
  if (_loadingModels[path]) return _loadingModels[path];
  const p = loadModel(path).then(m => { MODELS[path] = m; if (m) reskinDinos(path); delete _loadingModels[path]; return m; });
  return (_loadingModels[path] = p);
}
// Fetch a batch of models at most `conc` at a time (bandwidth cap so one huge .glb can't starve the rest).
async function loadWave(paths, conc = 5) {
  let i = 0;
  const worker = async () => { while (i < paths.length) await loadModelOnce(paths[i++]); };
  await Promise.all(Array.from({ length: Math.min(conc, paths.length || 1) }, worker));
}
// Tiered, non-blocking model streaming (best practice):
//   T0 helicopter (first thing seen in the crash intro) · T1 player+specialists (gate play on these only)
//   T2 all creatures · environment (foliage, ruins) — all background, grey-box until landed.
async function preloadModels() {
  if (HELI_MODEL) loadModelOnce(HELI_MODEL);
  const tier1 = [...new Set([PLAYER_MODEL, ...ROLES.map(r => r.model)].filter(Boolean))];
  await loadWave(tier1, 4);                                // the ONLY wait before the game is playable
  if (!playerMixer) buildPlayer();
  (async () => {                                           // everything else streams in the background, prioritised
    const all = [...new Set(Object.values(SPECIES).map(s => s.modelPath).filter(Boolean))].filter(p => !tier1.includes(p));
    await loadWave(all, 5);                                // creatures reskin as they land (all now ~1-2 MB)
    const foliage = [...new Set([FOLIAGE.tree, FOLIAGE.fern].filter(Boolean))];
    await loadWave(foliage, 2); buildFoliage();
    const ruins = [...new Set([RUINS.gate.url, RUINS.centre.url].filter(Boolean))];
    await loadWave(ruins, 2); buildRuinModels();
  })();
}

// ---- core state object (the "room snapshot")
const S = {
  phase: "menu",        // menu | playing | won | lost
  t: 0,                 // elapsed sim seconds
  player: { x: 0, z: 0, yaw: 0, hp: 100, stamina: 100, noise: 0, fear: 0, gait: "idle", alive: true },
  threat: 0,            // 0..10 (HUD)
  extraction: { called: false, hold: 0, holdMax: 75, beacon: { x: 0, z: 0 }, inRange: false, won: false },
  contact: { active: false, bearing: "", dist: 999 },
  killedBy: "",
};

// ---- three.js scaffolding
let renderer, scene, camera, sun, composer, bloomPass;
const DPR_CAP = 1.5;
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

// ---- world collections
let trees = [];         // {x,z,r}
let foliageGroup = null;
let dinos = [];         // active dino agents
let dinosByNetId = new Map();   // co-op client only: _netId → puppet, for O(1) snapshot reconciliation
let blobPool = [];
let beaconMesh, beaconRing, beaconGlow, playerMesh;

// camera orbit
const cam = { yaw: 0, pitch: -0.18, dist: 7.2, height: 2.4 };

/* ---------------------------------------------------------------- boot ---- */
async function boot() {
  const [sp, bi, ar, cx] = await Promise.all([
    fetch("./data/species.json").then(r => r.json()),
    fetch("./data/biome.alpha.json").then(r => r.json()),
    fetch("./data/archetypes.json").then(r => r.json()).catch(() => ({ archetypes: {} })),
    fetch("./data/codex.json").then(r => r.json()).catch(() => ({ codex: {} })),
  ]);
  ARCHETYPES = ar.archetypes || {};
  CODEX = cx.codex || {};
  sp.species.forEach(s => { s.arch = resolveArchetype(s); SPECIES[s.id] = s; });
  BIOME = bi;

  initRenderer();
  buildWorld();
  initInput();
  initAudio();
  buildStaticHUD();
  showStart();
  initMissionSelect();
  initTabs();
  initCharSelect();
  initLobby();
  initOptions();
  loadProgress();
  { const cl = $("careerLine"); if (cl) cl.textContent = careerLine(); }
  requestAnimationFrame(frame);
  // stream models in the background so the menu/start button appears instantly;
  // creatures load first (re-skinning as they arrive), player + foliage build inside preloadModels
  preloadModels();
}

// subtle vignette (edge darkening) for cinematic framing
const VIGNETTE = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.85 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  fragmentShader: "uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - 0.5; float v = smoothstep(0.85, 0.2, dot(d,d)*strength*2.0); gl_FragColor = vec4(c.rgb * mix(0.78, 1.0, v), c.a); }",
};
function initRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, DPR_CAP));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // filmic response = more cinematic
  renderer.toneMappingExposure = 1.2;
  scene = new THREE.Scene();
  const m = BIOME.map;
  scene.background = new THREE.Color(0xa6b6a4);   // greener overcast sky
  scene.fog = new THREE.FogExp2(new THREE.Color(0x93a791), 0.009); // lighter green haze so the dense foliage reads
  // image-based lighting: procedural neutral studio env so PBR materials get real ambient + reflections
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
  camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.1, 400);
  // post-processing: subtle cinematic bloom on bright/foggy areas; OutputPass does tone-map + sRGB
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.5, 0.8); // strength, radius, threshold
  composer.addPass(bloomPass);
  composer.addPass(new ShaderPass(VIGNETTE));   // subtle edge darkening = cinematic framing
  composer.addPass(new OutputPass());
  addEventListener("resize", onResize);
  onResize();
}
function onResize() {
  if (!renderer) return;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, DPR_CAP));
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(Math.min(devicePixelRatio || 1, DPR_CAP)); composer.setSize(innerWidth, innerHeight); }
}

/* --------------------------------------------------------------- world ---- */
function buildWorld() {
  const m = BIOME.map, half = m.size / 2;

  // lighting: low directional "moonlight" + dim ambient (formula blocks 3-4)
  sun = new THREE.DirectionalLight(0xbcc6cf, 0.85); sun.position.set(-60, 90, 40); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x9aa6ad, 0x32383a, 0.55));
  scene.add(new THREE.AmbientLight(0x6b7378, 0.35));
  buildSky();

  // ground: rolling valley floor ringed by mountains, carved by a winding river (shaped by groundH)
  const seg = 110;
  const gGeo = new THREE.PlaneGeometry(m.size, m.size, seg, seg);
  gGeo.rotateX(-Math.PI / 2);
  const pos = gGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, groundH(pos.getX(i), pos.getZ(i)));
  gGeo.computeVertexNormals();
  const groundTex = _texLoader.load(GROUND_TEX);
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(36, 36);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(gGeo, new THREE.MeshStandardMaterial({ map: groundTex, color: 0x93a487, roughness: 1, metalness: 0 }));
  scene.add(ground);

  // river: one translucent water plane; the terrain occludes it everywhere except the carved channel
  const water = new THREE.Mesh(new THREE.PlaneGeometry(m.size, m.size),
    new THREE.MeshStandardMaterial({ color: 0x274a50, roughness: 0.18, metalness: 0.3, transparent: true, opacity: 0.9 }));
  water.rotation.x = -Math.PI / 2; water.position.y = WATER_Y; scene.add(water);

  // boundary walls (charcoal slabs) — soft fence of the valley
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x24282a, roughness: 1, flatShading: true });
  const wGeo = new THREE.BoxGeometry(m.size, 8, 2);
  [[0, -half, 0], [0, half, 0], [half, 0, 90], [-half, 0, 90]].forEach(([x, z, ry]) => {
    const w = new THREE.Mesh(wGeo, wallMat); w.position.set(x, 3, z); w.rotation.y = ry * DEG; scene.add(w);
  });

  buildFoliage();

  // INSTANCED rocks — boulders across the valley, clustered along the river, sitting on the terrain
  const dm = new THREE.Object3D();
  const NR = 130;
  clearColliders();
  const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x5b615f, roughness: 1, flatShading: true }), NR);
  for (let i = 0; i < NR; i++) {
    let x, z;
    if (i % 3 === 0) { x = rand(-half + 10, half - 10); z = 48 + Math.sin(x * 0.02) * 28 + rand(-13, 13); }  // riverside
    else { x = rand(-half + 4, half - 4); z = rand(-half + 4, half - 4); }
    const s = rand(0.7, 3.6) * (i % 3 === 0 ? 1.4 : 1);
    dm.position.set(x, groundH(x, z) + s * 0.25, z); dm.rotation.set(rand(0, 3), rand(0, 6), rand(0, 3)); dm.scale.set(s, s * 0.7, s); dm.updateMatrix();
    rocks.setMatrixAt(i, dm.matrix);
    if (s > 1.35) { const h = s * 0.95, top = groundH(x, z) + h; addCollider(x, z, s * 0.6, { h, top, climb: h >= 1.6 && h <= 4.2 }); }   // big boulders are solid; mid ones are climbable; small stay steppable
  }
  rocks.instanceMatrix.needsUpdate = true;
  scene.add(rocks);

  buildRuins();
  addCollidersFromObject(ruinsGroup, { min: 0.9, minH: 1.1, scale: 0.78 });   // ruined masonry / columns / jeep are solid
  buildTowers();
  buildPlayer();

  buildBeacon();
  // blob shadow pool for dinos
  blobPool = [];
}

// Jurassic-World theme: moss-overgrown ruins built from irregular weathered stone — broken masonry
// walls, segmented/toppled columns with protruding rebar, rubble piles, a derelict watchtower, a
// broken perimeter fence and an abandoned jeep. The hero gate + visitor-centre are streamed in as
// photoreal .glb models (buildRuinModels); this lays down the procedural surround + fallbacks.
let ruinsGroup = null;
function buildRuins() {
  const half = BIOME.map.size / 2;
  const g = new THREE.Group(); ruinsGroup = g;
  // a few weathered-stone variants (jittered so masonry doesn't read as one flat colour)
  const stone = [0x8a8d83, 0x7c8377, 0x717a68, 0x6a6f63].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 1, metalness: 0.02, flatShading: true }));
  const moss = new THREE.MeshStandardMaterial({ color: 0x5a6b46, roughness: 1, flatShading: true });
  const rust = new THREE.MeshStandardMaterial({ color: 0x6f4630, roughness: 1, metalness: 0.15, flatShading: true });
  const torchMat = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff7a1a, emissiveIntensity: 2.4 });
  const sm = () => stone[(rand(0, 1) * stone.length) | 0];

  // a broken masonry wall: a run of irregular stacked blocks with a jagged (broken) top + gaps
  function brokenWall(cx, cz, len, baseH, ry) {
    const w = new THREE.Group(), bw = 1.8;
    for (let x = -len / 2; x < len / 2; x += bw * rand(0.95, 1.18)) {
      if (rand(0, 1) < 0.13) continue;                   // a missing block
      const h = baseH * rand(0.42, 1.0);
      const b = new THREE.Mesh(new THREE.BoxGeometry(bw * rand(0.82, 1.0), h, 1.5 * rand(0.9, 1.12)), rand(0, 1) < 0.3 ? moss : sm());
      b.position.set(x, h / 2, rand(-0.14, 0.14));
      b.rotation.set(rand(-0.04, 0.04), rand(-0.06, 0.06), rand(-0.05, 0.05));
      w.add(b);
    }
    w.position.set(cx, groundH(cx, cz), cz); w.rotation.y = ry; g.add(w); return w;
  }
  // a column built from stacked drums; broken ones lose their top drums + sprout rebar
  function column(cx, cz, h, broken) {
    const c = new THREE.Group(); let y = 0; const drum = 1.5;
    const segs = Math.max(1, Math.round(h / drum * (broken ? rand(0.4, 0.8) : 1)));
    for (let i = 0; i < segs; i++) { const r = 0.72 + rand(-0.05, 0.05); const s = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.06, drum, 12), rand(0, 1) < 0.25 ? moss : sm()); s.position.y = y + drum / 2; s.rotation.y = rand(0, 6); c.add(s); y += drum * rand(0.96, 1.0); }
    if (broken) for (let k = 0; k < 3; k++) { const rb = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, rand(0.6, 1.4), 5), rust); rb.position.set(rand(-0.3, 0.3), y + 0.3, rand(-0.3, 0.3)); rb.rotation.set(rand(-0.4, 0.4), 0, rand(-0.4, 0.4)); c.add(rb); }
    c.position.set(cx, groundH(cx, cz), cz); g.add(c); return c;
  }
  // a pile of rubble (broken icosahedral chunks)
  function rubble(cx, cz, radius, n) {
    for (let i = 0; i < n; i++) { const a = rand(0, 6.28), d = rand(0, radius), x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d, s = rand(0.3, 1.1); const r = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), rand(0, 1) < 0.35 ? moss : sm()); r.position.set(x, groundH(x, z) + s * 0.4, z); r.rotation.set(rand(0, 3), rand(0, 6), rand(0, 3)); r.scale.y = rand(0.6, 1); g.add(r); }
  }

  // ---- iconic gate (procedural fallback; replaced by a .glb when buildRuinModels runs) ----
  const gateGrp = new THREE.Group(); g.add(gateGrp);
  (function gate() {
    const gx = 0, gz = -56, postH = 11, span = 16;
    for (const sx of [-1, 1]) {
      const px = gx + sx * span / 2;
      // pillar of stacked stone blocks
      let y = 0; for (let i = 0; i < 7; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(2.6 + rand(-0.2, 0.2), 1.6, 2.6 + rand(-0.2, 0.2)), rand(0, 1) < 0.3 ? moss : sm()); b.position.set(px + rand(-0.1, 0.1), groundH(px, gz) + y + 0.8, gz); b.rotation.y = rand(-0.05, 0.05); gateGrp.add(b); y += 1.55; }
      const fl = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.7, 8), torchMat); fl.position.set(px, groundH(px, gz) + postH + 1.0, gz); gateGrp.add(fl);
      const pl = new THREE.PointLight(0xff8a2a, 6, 42, 2); pl.position.copy(fl.position); gateGrp.add(pl);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 3, 1.7, 1.5), rust); beam.position.set(gx, groundH(gx, gz) + postH - 0.4, gz); beam.rotation.z = 0.02; gateGrp.add(beam);
    const cv = document.createElement("canvas"); cv.width = 512; cv.height = 132;
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#160f0a"; ctx.fillRect(0, 0, 512, 132);
    ctx.strokeStyle = "#e0772f"; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 496, 116);
    ctx.fillStyle = "#e0772f"; ctx.font = "bold 60px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("ISLA ALPHA", 256, 66);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.BoxGeometry(span * 0.72, 3.0, 0.4), [rust, rust, rust, rust, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, emissive: 0x2a1505, emissiveIntensity: 0.35 }), rust]);
    sign.position.set(gx, groundH(gx, gz) + postH - 3.4, gz + 0.7); gateGrp.add(sign);
  })();

  // ---- derelict visitor centre (procedural fallback) ----
  const centreGrp = new THREE.Group(); g.add(centreGrp);
  (function centre() {
    const cx = -45, cz = 26, sub = g; ruinsGroup = g;
    brokenWall(cx, cz - 8.5, 26, 9, 0);
    brokenWall(cx - 12.5, cz, 18, 7, Math.PI / 2);
    brokenWall(cx + 12.5, cz + 3, 12, 5, Math.PI / 2);
    for (let i = 0; i < 4; i++) column(cx - 9 + i * 6, cz + 8, 8, rand(0, 1) < 0.5);
    const fallen = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.78, 7, 12), sm()); fallen.rotation.z = Math.PI / 2; fallen.position.set(cx + 4, groundH(cx + 4, cz + 11) + 0.8, cz + 11); g.add(fallen);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(13, 0.8, 11, 3, 1, 3), sm()); roof.position.set(cx - 3, groundH(cx, cz) + 6.4, cz); roof.rotation.set(0.32, 0.2, 0.17); g.add(roof);
    rubble(cx, cz, 13, 26);
  })();

  // ---- derelict watchtower: braced steel frame, sagging deck, broken roof ----
  (function tower() {
    const tx = 50, tz = -14, t = new THREE.Group();
    const legGeo = new THREE.CylinderGeometry(0.35, 0.4, 16, 6);
    const legs = [[-3, -3], [3, -3], [-3, 3], [3, 3]];
    legs.forEach(([dx, dz]) => { const l = new THREE.Mesh(legGeo, rust); l.position.set(dx, 8, dz); l.rotation.set(rand(-0.02, 0.02), 0, rand(-0.02, 0.02)); t.add(l); });
    // X-bracing between legs
    for (let lvl = 4; lvl <= 12; lvl += 4) for (const [a, b] of [[0, 1], [1, 3], [3, 2], [2, 0]]) { const A = legs[a], B = legs[b]; const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2; const br = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, Math.hypot(A[0] - B[0], A[1] - B[1])), rust); br.position.set(mx, lvl, mz); br.lookAt(B[0], lvl + 2, B[1]); t.add(br); }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(9, 0.6, 9), rust); deck.position.y = 15.6; t.add(deck);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 7), moss); cab.position.y = 17.6; t.add(cab);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(6, 2.6, 4), rust); roof.position.y = 20.6; roof.rotation.set(0.12, Math.PI / 4, 0.06); t.add(roof);
    t.position.set(tx, groundH(tx, tz), tz); t.rotation.z = 0.05; g.add(t);
  })();

  // ---- broken electric perimeter fence: leaning posts + three sagging wires ----
  (function fence() {
    const postGeo = new THREE.CylinderGeometry(0.16, 0.2, 6, 6), pts = [];
    for (let i = 0; i < 11; i++) {
      const x = -38 + i * 7.6, z = -46 + Math.sin(i * 0.6) * 7;
      const p = new THREE.Mesh(postGeo, rust); p.position.set(x, groundH(x, z) + 3, z); p.rotation.z = (i % 4 === 0) ? rand(-0.35, 0.35) : rand(-0.05, 0.05); g.add(p);
      pts.push([x, groundH(x, z) + 5, z]);
    }
    const wireMat = new THREE.LineBasicMaterial({ color: 0x3a3f3a });
    for (const yo of [0, -1.6, -3.2]) { const v = []; for (const [x, y, z] of pts) v.push(x, y + yo + Math.sin(x) * 0.3, z); const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(v, 3)); g.add(new THREE.Line(lg, wireMat)); }
  })();

  // ---- abandoned safari ranger truck (gap-free: parts overlap at every joint) ----
  (function truck() {
    const jx = 18, jz = 16, j = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x5b6b46, roughness: 0.82, metalness: 0.18 });   // weathered olive
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x2c2f28, roughness: 0.9, metalness: 0.2 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x1b2a2c, roughness: 0.25, metalness: 0.5, transparent: true, opacity: 0.66 });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x14140f, roughness: 1 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x6a6e6a, roughness: 0.5, metalness: 0.6 });
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.5, 2.0), trimMat); chassis.position.y = 0.72; j.add(chassis);   // ties the wheels together
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.7, 1.05, 2.24), bodyMat); body.position.y = 1.18; j.add(body);          // tub overlaps chassis
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.66, 2.2), bodyMat); hood.position.set(1.75, 1.42, 0); j.add(hood);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 2.2), bodyMat); roof.position.set(-0.45, 2.52, 0); j.add(roof);
    for (const [px, pz] of [[0.55, 1.0], [0.55, -1.0], [-1.45, 1.0], [-1.45, -1.0]]) { const pil = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.3, 0.14), trimMat); pil.position.set(px, 1.92, pz); j.add(pil); }
    const ws = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.15, 2.02), glassMat); ws.position.set(0.6, 1.98, 0); ws.rotation.z = 0.2; j.add(ws);
    for (const sz of [1.04, -1.04]) { const sg = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.05, 0.05), glassMat); sg.position.set(-0.45, 1.98, sz); j.add(sg); }
    const wgeo = new THREE.CylinderGeometry(0.72, 0.72, 0.56, 16);
    for (const [dx, dz] of [[1.62, 1.04], [1.62, -1.04], [-1.62, 1.04], [-1.62, -1.04]]) {
      const w = new THREE.Mesh(wgeo, tyreMat); w.rotation.x = Math.PI / 2; w.position.set(dx, 0.72, dz); j.add(w);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.58, 8), hubMat); hub.rotation.x = Math.PI / 2; hub.position.set(dx, 0.72, dz); j.add(hub);
      const fender = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.34, 0.42), bodyMat); fender.position.set(dx, 1.32, dz > 0 ? 0.98 : -0.98); j.add(fender);   // bridges body→wheel (no gap)
    }
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.4, 2.3), trimMat); bumper.position.set(2.6, 0.95, 0); j.add(bumper);
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 1.9), trimMat); grille.position.set(2.52, 1.4, 0); j.add(grille);
    for (const lz of [0.72, -0.72]) { const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 12), new THREE.MeshStandardMaterial({ color: 0xd8d2b0, roughness: 0.4, emissive: 0x201d12 })); hl.rotation.z = Math.PI / 2; hl.position.set(2.58, 1.48, lz); j.add(hl); }
    // roll cage over the open bed, posts rooted in the body (connected, no floating bars)
    for (const cx of [-1.5, 0.4]) for (const sz of [1, -1]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 8), rust); post.position.set(cx, 2.05, sz * 0.98); j.add(post); }
    for (const cx of [-1.5, 0.4]) { const cb = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.1, 8), rust); cb.rotation.x = Math.PI / 2; cb.position.set(cx, 2.78, 0); j.add(cb); }
    for (const sz of [1, -1]) { const sr = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.0, 8), rust); sr.rotation.z = Math.PI / 2; sr.position.set(-0.55, 2.78, sz * 0.98); j.add(sr); }
    j.position.set(jx, groundH(jx, jz), jz); j.rotation.set(0, 0.6, 0.015); g.add(j);
  })();

  // ---- scattered ruins across the valley: broken columns, wall fragments, rubble ----
  for (let i = 0; i < 9; i++) {
    const x = rand(-half + 16, half - 16), z = rand(-half + 16, half - 16);
    if (Math.hypot(x, z) < 16 || Math.hypot(x, z) > 60) continue;
    const r = rand(0, 1);
    if (r < 0.4) column(x, z, rand(3, 7), true);
    else if (r < 0.7) brokenWall(x, z, rand(5, 11), rand(2.5, 5), rand(0, 6));
    else rubble(x, z, rand(2, 4), 14);
  }

  g.userData.gateGrp = gateGrp; g.userData.centreGrp = centreGrp;
  scene.add(g);
}

// swap the procedural gate/centre for photoreal .glb ruin models once they stream in
function buildRuinModels() {
  if (!ruinsGroup) return;
  for (const [key, grpKey] of [["gate", "gateGrp"], ["centre", "centreGrp"]]) {
    const r = RUINS[key], tmpl = MODELS[r.url];
    if (!tmpl) continue;                                  // model missing/failed -> keep procedural
    const grp = ruinsGroup.userData[grpKey];
    if (grp && grp.parent) grp.parent.remove(grp);        // drop the procedural fallback
    const m = fitModel(tmpl.clone(true), r.h, r.yaw);
    m.position.set(r.x, groundH(r.x, r.z), r.z);
    scene.add(m);
  }
}

// player — real character model if loaded, else amber capsule fallback. Re-callable to swap in the
// model once it finishes streaming (keeps the start screen instant instead of blocking on a 50MB load).
function buildPlayer() {
  if (playerMesh) { scene.remove(playerMesh); }
  playerMixer = null; playerAction = null;
  const PM = curPlayerModel();
  if (MODELS[PM]) {
    playerMesh = new THREE.Group();
    // skinned models must be SkeletonUtils-cloned (clone(true) breaks the skeleton); a fresh clone each
    // rebuild also avoids compounding fitModel's transforms when the player switches role.
    let skinned = false; MODELS[PM].traverse(o => { if (o.isSkinnedMesh) skinned = true; });
    const src = skinned ? skeletonClone(MODELS[PM]) : MODELS[PM].clone(true);
    const fig = fitModel(src, 1.8, PLAYER_MODEL_YAW);
    fig.position.y = -0.9;   // updatePlayer sets group center to ground+0.9; drop feet to ground
    playerMesh.add(fig);
    scene.add(playerMesh);
    addBlob(playerMesh, 0.7);
    const clips = MODEL_ANIMS[PM];
    if (clips && clips.length) {           // play the baked walk clip; speed scaled by gait in frame()
      playerMixer = new THREE.AnimationMixer(src);
      playerAction = playerMixer.clipAction(clips[0]);
      playerAction.play();
    }
  } else {
    const pGeo = new THREE.CapsuleGeometry(0.4, 1.0, 4, 10);
    playerMesh = new THREE.Mesh(pGeo, new THREE.MeshStandardMaterial({ color: 0xe0a24a, roughness: 0.7, flatShading: true, emissive: 0x3a2a08, emissiveIntensity: 0.4 }));
    scene.add(playerMesh);
    const nub = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.4), new THREE.MeshStandardMaterial({ color: 0xfff0c0 }));
    nub.position.set(0, 0.5, 0.45); playerMesh.add(nub);
    addBlob(playerMesh, 0.7);
  }
}
// overcast gradient sky dome with faint procedural cloud banding near the horizon (no asset, not fogged)
function buildSky() {
  const sky = new THREE.Mesh(new THREE.SphereGeometry(380, 32, 18), new THREE.ShaderMaterial({
    side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false,
    uniforms: { top: { value: new THREE.Color(0x8ea298) }, bot: { value: new THREE.Color(0xc6cdc3) } },
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 top; uniform vec3 bot; varying vec3 vDir; void main(){ float t = clamp(vDir.y*0.5+0.5,0.0,1.0); vec3 col = mix(bot, top, smoothstep(0.0,0.7,t)); float c = sin(vDir.x*8.0)*0.5 + sin(vDir.z*6.0+1.3)*0.5 + sin((vDir.x+vDir.z)*11.0)*0.3; c = smoothstep(0.45,1.1,c) * (1.0-t) * 0.55; col = mix(col, vec3(0.87,0.89,0.85), c); gl_FragColor = vec4(col,1.0); }",
  }));
  sky.frustumCulled = false; sky.renderOrder = -1; scene.add(sky);
}
// one dense layer of alpha-cutout cross-quad billboards (the standard cheap way to do thick vegetation)
function billboardLayer(texUrl, count, hMin, hMax, opts) {
  opts = opts || {};
  const half = BIOME.map.size / 2;
  const tex = _texLoader.load(texUrl); tex.colorSpace = THREE.SRGBColorSpace;
  const a = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const b = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0); b.rotateY(Math.PI / 2);
  const geo = mergeGeometries([a, b]);   // X-shaped cross-quad = volume from any angle
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, metalness: 0, color: opts.color || 0xffffff });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const dm = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    let x, z, ok = 0;
    do {
      if (opts.edge) { const ang = rand(0, 6.28), rr = rand(half * 0.62, half - 4); x = Math.cos(ang) * rr; z = Math.sin(ang) * rr; }
      else { x = rand(-half + 4, half - 4); z = rand(-half + 4, half - 4); }
    } while (Math.hypot(x, z) < (opts.minR || 8) && ++ok < 6);
    const h = rand(hMin, hMax), w = h * rand(0.7, 1.05);
    dm.position.set(x, groundH(x, z), z); dm.scale.set(w, h, w); dm.rotation.set(0, rand(0, 6.28), 0); dm.updateMatrix();
    mesh.setMatrixAt(i, dm.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}
// dense instanced jungle: ground grass + understory bushes + tall canopy + a perimeter jungle wall,
// plus a few solid 3D trees for foreground variety. Billboards stream their textures async.
function buildFoliage() {
  const m = BIOME.map, half = m.size / 2;
  if (foliageGroup) scene.remove(foliageGroup);
  foliageGroup = new THREE.Group();
  trees = [];
  reseed(1337);
  if (BILLBOARDS.grass) foliageGroup.add(billboardLayer(BILLBOARDS.grass, 2400, 0.5, 1.5, { minR: 6 }));
  if (BILLBOARDS.bush) {
    foliageGroup.add(billboardLayer(BILLBOARDS.bush, 1000, 1.6, 4.5, { minR: 8 }));                    // understory
    foliageGroup.add(billboardLayer(BILLBOARDS.bush, 380, 7, 14, { minR: 14, color: 0xc2d2c2 }));      // tall canopy
    foliageGroup.add(billboardLayer(BILLBOARDS.bush, 600, 10, 20, { edge: true, minR: 10, color: 0xb6c8b6 })); // perimeter jungle wall
  }
  if (MODELS[FOLIAGE.tree]) for (let i = 0; i < 30; i++) {   // solid 3D trees for close-up variety
    let x, z, ok = 0;
    do { x = rand(-half + 6, half - 6); z = rand(-half + 6, half - 6); } while (Math.hypot(x, z) < 12 && ++ok < 8);
    const t = fitModel(MODELS[FOLIAGE.tree].clone(true), rand(9, 15), rand(0, 6.28));
    t.position.set(x, groundH(x, z), z); foliageGroup.add(t);
    trees.push({ x, z, r: 1.3 });
  }
  scene.add(foliageGroup);
}
function addBlob(parent, r) {
  const blob = new THREE.Mesh(new THREE.CircleGeometry(r, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = -0.88; blob.renderOrder = 1;
  parent.add(blob);
}

/* ============================================ solid-world colliders ====== *
 * Zero-ghosting: a queryable registry of cheap circle proxies for solid props (boulders, ruins,
 * mission buildings). Player + dinos are pushed out — the same technique already used for trees, so
 * no physics engine and no per-frame raycast. Conservative by design: radii sit just inside the
 * visual mesh (you brush past props, no far invisible wall) and radial push-out can never trap you.
 *   · colliders/collGrid  = STATIC world (rocks, ruins), built once in buildWorld → spatial-hashed.
 *   · missionColliders     = per-run set-piece props, rebuilt with the mission (small flat list). */
const colliders = [];
const COLL_CELL = 12;                       // spatial-hash cell size (m)
const collGrid = new Map();
const missionColliders = [];
const _EMPTY = [];
const _cbox = new THREE.Box3(), _csz = new THREE.Vector3(), _cc = new THREE.Vector3();
function clearColliders() { colliders.length = 0; collGrid.clear(); }
function addCollider(x, z, r, meta) {
  const c = Object.assign({ x, z, r }, meta || {}); colliders.push(c);
  const pad = r + 2;                        // register into every cell the proxy (+ entity margin) touches
  for (let cx = Math.floor((x - pad) / COLL_CELL); cx <= Math.floor((x + pad) / COLL_CELL); cx++)
    for (let cz = Math.floor((z - pad) / COLL_CELL); cz <= Math.floor((z + pad) / COLL_CELL); cz++) {
      const k = cx + "," + cz; let a = collGrid.get(k); if (!a) collGrid.set(k, a = []); a.push(c);
    }
  return c;
}
function queryColliders(x, z) { return collGrid.get(Math.floor(x / COLL_CELL) + "," + Math.floor(z / COLL_CELL)) || _EMPTY; }
// Auto-derive circle proxies from a built group's meshes (world AABB handles rotation). Compact meshes
// → one circle; elongated meshes (walls) → a row of circles tiled along the longer axis. `into` lets
// mission set-pieces collect into their own list so they clear with the mission.
function addCollidersFromObject(root, opt) {
  if (!root) return;
  opt = opt || {};
  const minH = opt.minH != null ? opt.minH : 0.7, min = opt.min != null ? opt.min : 0.7, sc = opt.scale != null ? opt.scale : 0.8, into = opt.into;
  const push = into ? (x, z, r, m) => into.push(Object.assign({ x, z, r }, m)) : addCollider;
  root.updateWorldMatrix(true, true);
  root.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh) return;
    if (opt.filter && !opt.filter(o)) return;
    _cbox.setFromObject(o); if (_cbox.isEmpty()) return;
    _cbox.getSize(_csz); _cbox.getCenter(_cc);
    if (_csz.y < minH) return;                              // low/flat (floors, slabs, rings) → walk over
    const top = _cbox.max.y, climb = _csz.y >= 1.6 && _csz.y <= 4.2;
    const rMax = Math.max(_csz.x, _csz.z) * 0.5, rMin = Math.min(_csz.x, _csz.z) * 0.5;
    if (rMax < min) return;                                 // tiny debris
    if (rMax < rMin * 1.8) { push(_cc.x, _cc.z, rMax * sc, { h: _csz.y, top, climb }); return; }   // compact → one circle
    const along = _csz.x >= _csz.z, n = Math.min(8, Math.max(2, Math.round(rMax / rMin))), r = rMin * sc, span = rMax - rMin;
    for (let i = 0; i < n; i++) { const t = (i / (n - 1) - 0.5) * 2 * span; push(along ? _cc.x + t : _cc.x, along ? _cc.z : _cc.z + t, r, { h: _csz.y, top, climb }); }
  });
}
// Push an entity (player/dino) out of every overlapping solid proxy. pr = entity body radius.
// feetY (optional) makes it height-aware: a proxy you've cleared (feet above its top) stops blocking,
// so jumping/vaulting over a low obstacle actually works instead of hitting an invisible 2D wall.
function resolveColliders(e, pr, feetY) {
  let hit = false;
  const near = queryColliders(e.x, e.z);
  for (let i = 0; i < near.length; i++) hit = _pushOut(e, near[i], pr, feetY) || hit;
  for (let i = 0; i < missionColliders.length; i++) hit = _pushOut(e, missionColliders[i], pr, feetY) || hit;
  return hit;
}
function _pushOut(e, c, pr, feetY) {
  if (feetY != null && c.top != null && feetY > c.top + 0.1) return false;   // cleared it (jumped/mantled over)
  const rr = c.r + pr, dx = e.x - c.x, dz = e.z - c.z, d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return false;
  if (d2 > 1e-4) { const d = Math.sqrt(d2), p = (rr - d) / d; e.x += dx * p; e.z += dz * p; }
  else e.x += rr;                            // exact centre → deterministic nudge
  return true;
}

function buildBeacon() {
  const half = BIOME.map.size / 2;
  const [a, b] = BIOME.extraction.beaconPickRingM;
  const ang = rand(0, Math.PI * 2), d = rand(a, Math.min(b, half - 12));
  const bx = Math.cos(ang) * d, bz = Math.sin(ang) * d;
  S.extraction.beacon.x = bx; S.extraction.beacon.z = bz;

  const g = new THREE.Group(); g.position.set(bx, groundH(bx, bz), bz);
  // SAFE ZONE ring on the ground — inside this radius predators disengage and you take no damage
  const safe = new THREE.Mesh(new THREE.RingGeometry(18 - 0.6, 18, 48),
    new THREE.MeshBasicMaterial({ color: 0x6fae6b, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
  safe.rotation.x = -Math.PI / 2; safe.position.y = 0.12; g.add(safe);
  const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 4.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x3a4a3a, roughness: 1, emissive: 0x123512, emissiveIntensity: 0.5, flatShading: true }));
  pylon.position.y = 2.1; g.add(pylon);
  beaconGlow = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x7CFC00 }));
  beaconGlow.position.y = 4.5; g.add(beaconGlow);
  const light = new THREE.PointLight(0x7CFC00, 2.2, 40); light.position.y = 4.5; g.add(light);
  beaconRing = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.12, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0x7CFC00, transparent: true, opacity: 0.8 }));
  beaconRing.rotation.x = -Math.PI / 2; beaconRing.position.y = 0.3; g.add(beaconRing);
  beaconMesh = g; scene.add(g);
  buildFacility(bx, bz);
}

/* ============================================ ranger watchtowers ========= *
 * Climbable hunting towers: a safe elevated vantage to glass with binoculars
 * and tranq from cover (predators can't reach you up top — no damage). Climb
 * the ladder up; ride the ZIPLINE down. Additive — free movement everywhere. */
const TOWERS = [];                 // { x, z, platformY, half, zipX, zipZ }
const ZIP_LEN = 24;
function buildTower(x, z, dir) {
  const baseY = groundH(x, z), H = 7.0, half = 2.4, platformY = baseY + H, c = half - 0.15;
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  const wood = new THREE.MeshStandardMaterial({ color: 0x6f5a3c, roughness: 0.92, metalness: 0.05 });
  const wood2 = new THREE.MeshStandardMaterial({ color: 0x574631, roughness: 0.95 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x7e837f, roughness: 0.55, metalness: 0.6 });
  // 4 box legs — tops meet the deck (overlap, no gap)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.26, H, 0.26), wood); leg.position.set(sx * c, baseY + H / 2, sz * c); g.add(leg); }
  // X cross-braces spanning corner-to-corner on 3 faces (skip +Z = ladder face) — exact fit, no floating bars
  const faceW = 2 * c, L = Math.hypot(faceW, H), th = Math.atan2(faceW, H);
  const brace = () => new THREE.Mesh(new THREE.BoxGeometry(0.12, L, 0.12), wood2);
  for (const sx of [-1, 1]) for (const s of [-1, 1]) { const b = brace(); b.position.set(sx * c, baseY + H / 2, 0); b.rotation.x = s * th; g.add(b); }   // ±X faces
  for (const s of [-1, 1]) { const b = brace(); b.position.set(0, baseY + H / 2, -c); b.rotation.z = s * th; g.add(b); }                                  // -Z face
  // deck — oversized to cap the legs (overlap)
  const deck = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.25, 0.3, half * 2 + 0.25), wood); deck.position.y = platformY; g.add(deck);
  // railing posts + top/mid rails on 3 sides (gap on +Z), overlapping the posts
  for (const [px, pz] of [[-c, -c], [c, -c], [-c, c], [c, c]]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.15, 0.1), wood2); post.position.set(px, platformY + 0.58, pz); g.add(post); }
  for (const [px, pz, w, dpth] of [[0, -c, faceW + 0.1, 0.08], [-c, 0, 0.08, faceW + 0.1], [c, 0, 0.08, faceW + 0.1]]) {
    for (const ry of [0.5, 1.0]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, dpth), wood2); rail.position.set(px, platformY + ry, pz); g.add(rail); }
  }
  // roof: 4 corner posts on the deck + a pitched roof seated on them
  for (const [px, pz] of [[-c, -c], [c, -c], [-c, c], [c, c]]) { const rp = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), wood2); rp.position.set(px, platformY + 1.25, pz); g.add(rp); }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(half * 1.7, 1.3, 4), wood2); roof.position.y = platformY + 2.4; roof.rotation.y = Math.PI / 4; g.add(roof);
  // ladder on +Z — rails reach from the ground up into the deck
  for (const sx of [-0.5, 0.5]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.09, H + 0.3, 0.09), metal); rail.position.set(sx, baseY + (H + 0.3) / 2, half + 0.12); g.add(rail); }
  for (let r = 0; r < 9; r++) { const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6), metal); rung.rotation.z = Math.PI / 2; rung.position.set(0, baseY + 0.5 + r * (H - 0.4) / 8, half + 0.12); g.add(rung); }
  // zipline: cable from a top corner down to a ground anchor
  const zipX = x + Math.sin(dir) * ZIP_LEN, zipZ = z + Math.cos(dir) * ZIP_LEN;
  const aY = groundH(zipX, zipZ) + 0.3;
  const cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, platformY + 0.5, z), new THREE.Vector3(zipX, aY, zipZ)]), new THREE.LineBasicMaterial({ color: 0x20231e }));
  g.add(cable);
  const anchor = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 1.4, 6), wood); anchor.position.set(zipX - x, aY, zipZ - z); g.add(anchor);
  TOWERS.push({ x, z, platformY, half, zipX, zipZ });
}
function buildTowers() {
  if (TOWERS.length) return;
  const spots = [[40, 34], [-46, -16], [14, 62], [-30, 50]];
  for (const [x, z] of spots) buildTower(x, z, Math.atan2(-x, -z) + (rand(-0.5, 0.5)));   // zip aims roughly toward open valley
}

/* ===== mission set-pieces: real structures (+ Maya the survivor) at objective sites ===== *
 * Campaign phases tag a `site` type; these build a believable structure there so an objective
 * is a place you SEE, not a bare beam. Rebuilt per run, cleared on reset. */
let missionSites = [], survivor = null;
// Missions with a survivor to find → (optionally) stabilise → escort. Generalised from Maya.
const SURVIVORS = {
  fallen_outpost: { name: "MAYA", site: "outpost", color: 0x9a5a3c, off: [-2.2, 1.6], escortFrom: 3 },
  ghosts: { name: "SURVEYOR", site: "cave", color: 0x3c6a9a, off: [2.4, 1.8], escortFrom: 5 },
};
function clearMissionSites() { for (const s of missionSites) scene.remove(s); missionSites = []; survivor = null; missionColliders.length = 0; }
function spawnDrawn(species, P) {   // a predator pulled toward the player by noise — spawns mid-range, already hunting
  if (Net.on && !Net.isHost) return null;   // co-op: only the host spawns; clients receive dinos via sync
  if (!SPECIES[species]) return null;
  if (dinos.filter(d => d.alive).length >= BIOME.spawnDirector.maxActiveAI + 6) return null;   // hard cap (no runaway)
  const half = BIOME.map.size / 2 - 6, ang = rand(0, Math.PI * 2), d = rand(40, 60);
  const x = clamp(P.x + Math.cos(ang) * d, -half, half), z = clamp(P.z + Math.sin(ang) * d, -half, half);
  const a = spawnDino(species, x, z);
  a.bb.homeX = P.x; a.bb.homeZ = P.z; a.bb.hasTarget = true; a.bb.lastSeenX = P.x; a.bb.lastSeenZ = P.z;
  dinos.push(a); return a;
}
const _mm = (c, r, m) => new THREE.MeshStandardMaterial({ color: c, roughness: r == null ? 0.9 : r, metalness: m || 0 });
function buildCollapsedTower(g) {                         // a toppled ranger watchtower + ruined cabin + sandbags
  const wood = _mm(0x6f5a3c, 0.92), wood2 = _mm(0x4a3c28, 0.95), metal = _mm(0x6e736f, 0.6, 0.6);
  const l1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 4.4, 0.28), wood); l1.position.set(-1.4, 2.0, 0.7); l1.rotation.z = 0.18; g.add(l1);   // snapped legs, leaning
  const l2 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 3.0, 0.28), wood); l2.position.set(1.1, 1.4, -0.9); l2.rotation.x = -0.22; g.add(l2);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.3, 4.2), wood); deck.position.set(0.6, 1.0, 0.4); deck.rotation.set(0.42, 0.3, 0.24); g.add(deck);   // collapsed deck slab
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.3, 1.4, 4), wood2); roof.position.set(2.8, 0.8, 1.7); roof.rotation.set(1.4, 0.5, 0.3); g.add(roof);   // snapped roof, fallen
  for (let i = 0; i < 6; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(rand(1.4, 3), 0.18, 0.22), wood2); b.position.set(rand(-3.5, 3.5), 0.14, rand(-3.5, 3.5)); b.rotation.set(0, rand(0, 6.28), rand(-0.25, 0.25)); g.add(b); }   // scattered beams
  const cab = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.2, 2.6), _mm(0x55503f, 1)); cab.position.set(-4.2, 1.1, -2); g.add(cab);   // ruined cabin
  const cabRoof = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.2, 3.0), wood2); cabRoof.position.set(-4.2, 2.3, -2); cabRoof.rotation.z = 0.06; g.add(cabRoof);
  for (let i = 0; i < 7; i++) { const sb = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.5, 4, 6), _mm(0x6b6347, 1)); sb.rotation.z = Math.PI / 2; sb.position.set(-2.4 + i * 0.6, 0.3, 3); g.add(sb); }   // sandbag wall
  const flood = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.6, 6), metal); flood.position.set(3.4, 1.3, -2.6); flood.rotation.z = 0.3; g.add(flood);   // toppled floodlight
}
function buildSurvivor(x, z, col) {                       // a survivor — slumped/waving until reached, then follows
  const g = new THREE.Group(); g.position.set(x, groundH(x, z), z);
  const cloth = _mm(col || 0x9a5a3c, 0.9), dark = _mm(0x2a2620, 0.8), skin = _mm(0xb98a6a, 0.7);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.58, 5, 10), cloth); torso.position.y = 1.0; g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), skin); head.position.y = 1.52; g.add(head);
  for (const sx of [-1, 1]) { const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.58, 4, 8), dark); leg.position.set(sx * 0.14, 0.4, 0); g.add(leg); const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.5, 4, 8), cloth); arm.position.set(sx * 0.34, 1.04, 0); g.add(arm); }
  const wound = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), new THREE.MeshStandardMaterial({ color: 0xc23a2a, emissive: 0x5a1206, roughness: 0.6 })); wound.position.set(0.24, 1.0, 0.16); g.add(wound);
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 20), new THREE.MeshBasicMaterial({ color: 0x6fae6b, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })); halo.rotation.x = -Math.PI / 2; halo.position.y = 2.3; g.add(halo);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6, 6), new THREE.MeshBasicMaterial({ color: 0x6fae6b, transparent: true, opacity: 0.25, depthWrite: false })); beam.position.y = 3; g.add(beam);
  addBlob(g, 0.55); scene.add(g);
  g.rotation.x = 0.5;                                     // slumped against the wreckage
  return { mesh: g, x, z, following: false, slumped: true, halo, beam };
}
function buildGenerator(g) {                              // power-station generator (BLACKOUT)
  const metal = _mm(0x6a6e68, 0.6, 0.6), dark = _mm(0x2a2d28, 0.8, 0.4);
  const house = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.0, 2.2), metal); house.position.y = 1.0; g.add(house);
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 1.7), dark), { position: new THREE.Vector3(1.62, 1.1, 0) }));
  for (const px of [-0.8, 0, 0.8]) g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.4, 8), dark), { position: new THREE.Vector3(px, 2.4, 0) }));
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 2.2, 8), dark), { position: new THREE.Vector3(-1.0, 2.6, -0.6) }));
  const warn = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), new THREE.MeshStandardMaterial({ color: 0xc9a23a, emissive: 0x3a2e08, roughness: 0.5 })); warn.position.set(0, 2.25, 1.2); g.add(warn);
  for (let i = 0; i < 4; i++) g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.4, 0.1), dark), { position: new THREE.Vector3(-2.4 + i * 1.6, 0.7, 2.2) }));
}
function buildCave(g) {                                   // cave mouth (GHOSTS — Spinosaurus territory)
  const rock = _mm(0x4a4f4a, 1);
  for (let i = 0; i < 7; i++) { const a = (i / 6) * Math.PI - Math.PI / 2; const r = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(1.3, 2.3), 0), rock); r.position.set(Math.cos(a) * 3.3, 0.4 + Math.sin(a) * 3.2, -1 + Math.sin(a) * 0.4); g.add(r); }
  g.add(Object.assign(new THREE.Mesh(new THREE.CircleGeometry(2.5, 20), new THREE.MeshBasicMaterial({ color: 0x05060a })), { position: new THREE.Vector3(0, 2.0, -1.1) }));
}
function buildBuilding(g, kind) {                         // generic structure: supply / safehouse / facility / command / campsite
  const big = kind === "command" || kind === "facility";
  const wall = _mm(kind === "command" ? 0x555a52 : 0x55503f, 1), wood = _mm(0x4a3c28, 0.95), metal = _mm(0x6e736f, 0.6, 0.6);
  const w = big ? 5 : 3.4, h = big ? 3.0 : 2.2, d = big ? 4 : 2.6;
  const bld = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall); bld.position.y = h / 2; g.add(bld);
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.2, d + 0.4), wood), { position: new THREE.Vector3(0, h + 0.1, 0) }));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.1), _mm(0x20231d, 0.9)), { position: new THREE.Vector3(0, 0.8, d / 2 + 0.02) }));
  const winMat = big ? new THREE.MeshStandardMaterial({ color: 0x1d6b76, emissive: 0x1d6b76, emissiveIntensity: 0.7 }) : _mm(0x3a3026, 1);
  for (const sx of [-1, 1]) g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.06), winMat), { position: new THREE.Vector3(sx * w * 0.28, h * 0.6, d / 2 + 0.03) }));
  if (kind === "command") { const dish = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), metal); dish.rotation.x = -0.7; dish.position.set(1.3, h + 1.0, -1); g.add(dish); g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.0, 6), metal), { position: new THREE.Vector3(1.3, h + 0.5, -1) })); }
  if (kind === "campsite") { for (const c of [[2.6, 1], [-2.6, -1.4]]) { const tent = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.4, 4), _mm(0x4a5236, 0.95)); tent.position.set(c[0], 0.7, c[1]); tent.rotation.y = 0.5; g.add(tent); } const fire = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0xff7e2a, emissive: 0xff5a1e, emissiveIntensity: 1.2 })); fire.position.set(0, 0.25, 2.8); g.add(fire); g.add(Object.assign(new THREE.PointLight(0xff7e2a, 1.0, 10), { position: new THREE.Vector3(0, 0.7, 2.8) })); }
  for (const c of [[w * 0.5 + 0.7, 1], [-w * 0.5 - 0.7, -1]]) g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), wood), { position: new THREE.Vector3(c[0], 0.45, c[1]) }));
  // ---- believable structure dressing (so it reads as a real outpost, not a bare box) ----
  const trim = _mm(0x2c2f28, 0.8, 0.3), glow = c => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.4 });
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.05, w * 0.62, 0.9, 4), wall); roof.rotation.y = Math.PI / 4; roof.position.y = h + 0.55; g.add(roof);   // low pitched/ridged roof
  // entrance: recessed lit doorway + a porch overhang on posts
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.9, 0.12), glow(0xffb86a)), { position: new THREE.Vector3(0, 0.95, d / 2 + 0.04) }));   // warm-lit doorway
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.7, 0.04), _mm(0x14150f, 0.9)), { position: new THREE.Vector3(0, 0.85, d / 2 + 0.07) }));   // door panel
  const porch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.12, 1.2), wood); porch.position.set(0, h * 0.82, d / 2 + 0.6); g.add(porch);
  for (const px of [-w * 0.28, w * 0.28]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, h * 0.8, 6), trim); post.position.set(px, h * 0.4, d / 2 + 1.1); g.add(post); }
  g.add(Object.assign(new THREE.PointLight(0xffb86a, 1.1, 12), { position: new THREE.Vector3(0, 1.9, d / 2 + 0.7) }));   // porch light
  // rooftop comms whip + a blinking locator beacon (also helps you spot the objective)
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.8, 4), trim), { position: new THREE.Vector3(-w * 0.35, h + 1.4, -d * 0.3) }));
  const bcn = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), glow(0xff4030)); bcn.position.set(-w * 0.35, h + 2.3, -d * 0.3); g.add(bcn); g.userData.beaconBlink = bcn;
  // weathered signboard over the door
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.4, 0.08), new THREE.MeshStandardMaterial({ color: 0x1a1d18, emissive: 0x0a3a2e, emissiveIntensity: 0.45 })), { position: new THREE.Vector3(0, h * 0.92, d / 2 + 0.05) }));
}
// Environmental storytelling: scatter readable evidence of what happened here — blood smears,
// dropped gear, spent shells, raked claw-gashes — so a site tells its story without exposition.
function buildSiteStory(g) {
  const blood = new THREE.MeshStandardMaterial({ color: 0x4a0e08, roughness: 0.9 });
  const dark = _mm(0x2a2620, 0.85), khaki = _mm(0x6b6347, 0.9), metal = _mm(0x9a8e5a, 0.4, 0.7);
  for (let i = 0; i < 2; i++) { const bl = new THREE.Mesh(new THREE.CircleGeometry(rand(0.5, 1.1), 12), blood); bl.rotation.x = -Math.PI / 2; bl.position.set(rand(-3.5, 3.5), 0.04, rand(-3.5, 3.5)); bl.scale.z = rand(0.6, 1.5); g.add(bl); }   // blood smears
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), dark); helmet.position.set(rand(-3, 3), 0.18, rand(-3, 3)); helmet.rotation.z = rand(-0.5, 0.5); g.add(helmet);   // dropped helmet
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.3), khaki); pack.position.set(rand(-3, 3), 0.2, rand(-3, 3)); pack.rotation.y = rand(0, 6); g.add(pack);   // abandoned backpack
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.5), khaki); crate.position.set(rand(-3.5, 3.5), 0.25, rand(-3.5, 3.5)); crate.rotation.set(0.4, rand(0, 6), 0.2); g.add(crate);   // toppled supply crate
  for (let i = 0; i < 6; i++) { const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.1, 6), metal); sh.rotation.set(Math.PI / 2, rand(0, 6), 0); sh.position.set(rand(-2, 2), 0.05, rand(-2, 2)); g.add(sh); }   // spent brass — a last stand
  for (let i = 0; i < 3; i++) { const cl = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.02, 0.07), blood); cl.position.set(rand(-2.5, 2.5) + i * 0.18, 0.045, rand(-2, 2)); cl.rotation.y = 0.5; g.add(cl); }   // raked claw gashes
}
function buildSiteProp(type, x, z) {
  const g = new THREE.Group(); g.position.set(x, groundH(x, z), z); g.userData.site = type; scene.add(g); missionSites.push(g);
  if (type === "outpost") buildCollapsedTower(g);
  else if (type === "generator") buildGenerator(g);
  else if (type === "cave") buildCave(g);
  else buildBuilding(g, type);   // command / facility / campsite / safehouse / supply
  if (type !== "generator") buildSiteStory(g);   // human sites carry evidence of the attack that happened here
  // make the set-piece solid (into the per-run list so it clears with the mission). Conservative radii
  // keep the objective console reachable — proximity (< r) still triggers from just outside the wall.
  addCollidersFromObject(g, { min: 0.9, minH: 1.0, scale: 0.72, into: missionColliders });
  return g;
}
function buildMissionSites() {
  const m = activeCampaign(); if (!m) return;
  const seen = new Set();
  for (const ph of m.phases) {
    if (!ph.site || ph.atBeacon || ph.t === "extract") continue;
    const key = ph.x + "," + ph.z; if (seen.has(key)) continue; seen.add(key);
    buildSiteProp(ph.site, ph.x, ph.z);
  }
  const sc = SURVIVORS[m.id];   // place the survivor at their site
  if (sc) { const ph = m.phases.find(p => p.site === sc.site); if (ph) survivor = buildSurvivor(ph.x + sc.off[0], ph.z + sc.off[1], sc.color); }
}
function updateSurvivor(dt) {                             // slumped/waving idle → stands & follows once triggered
  if (!survivor) return;
  const m = survivor.mesh, P = S.player;
  if (survivor.following) {
    if (survivor.slumped) { survivor.slumped = false; m.rotation.x = 0; if (survivor.halo) survivor.halo.material.color.setHex(0x8fb8c4); if (survivor.beam) survivor.beam.material.color.setHex(0x8fb8c4); }
    const dx = P.x - survivor.x, dz = P.z - survivor.z, d = Math.hypot(dx, dz) || 1;
    if (d > 2.6) { const step = Math.min(5.2 * dt, d - 2.4); survivor.x += dx / d * step; survivor.z += dz / d * step; m.rotation.y = Math.atan2(dx, dz); }
    m.position.set(survivor.x, groundH(survivor.x, survivor.z) + 0.02, survivor.z);
  }
  if (survivor.halo) { survivor.halo.rotation.z += dt * 1.5; survivor.halo.position.y = 2.3 + Math.sin(S.t * 3) * 0.08; }
}

/* ================= EXTINCTION PROTOCOL finale: Indominus boss + apex set-pieces + branching endings ===== *
 * A boss ENCOUNTER faithful to the survival design (no DPS race): the Indominus hunts you relentlessly while
 * Pteranodons wheel overhead. You can't out-fight it — you decide how it ends by reaching one of three pads:
 *   CONTAIN (A, "all rescued" — unlocks after you survive 35s) · FLOOD THE LAGOON (B, Mosasaurus takes it,
 *   bittersweet) · RUN (C, escape alone, dark). Death during the hunt = lose. */
let boss = null;
function clearBoss() { if (boss) { for (const p of boss.props) scene.remove(p); boss = null; } }
function buildPterosaur() {
  const g = new THREE.Group(), mat = _mm(0x7a6a55, 0.9);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.9, 4, 8), mat); body.rotation.z = Math.PI / 2; g.add(body);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 8), mat); head.rotation.z = -Math.PI / 2; head.position.set(0.85, 0, 0); g.add(head);
  const crest = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 4), mat); crest.rotation.z = Math.PI / 2; crest.position.set(0.6, 0.18, 0); g.add(crest);
  const wgeo = new THREE.BoxGeometry(0.7, 0.04, 2.6);
  const wl = new THREE.Mesh(wgeo, mat); wl.position.set(0, 0, 1.4); g.add(wl);
  const wr = new THREE.Mesh(wgeo, mat); wr.position.set(0, 0, -1.4); g.add(wr);
  g.userData.wl = wl; g.userData.wr = wr; return g;
}
function buildPteranodonSwarm(cx, cz) {
  const g = new THREE.Group(), birds = [];
  for (let i = 0; i < 6; i++) { const m = buildPterosaur(); const b = { mesh: m, ang: i / 6 * 6.28, r: rand(20, 34), alt: rand(24, 34), spd: rand(0.25, 0.45) * (i % 2 ? 1 : -1), ph: rand(0, 6.28) }; g.add(m); birds.push(b); }
  g.userData.birds = birds; scene.add(g); return g;
}
function updatePteranodons(dt) {
  if (!boss || !boss.ptero) return;
  for (const b of boss.ptero.userData.birds) {
    b.ang += dt * b.spd;
    b.mesh.position.set(boss.cx + Math.cos(b.ang) * b.r, b.alt + Math.sin(S.t * 1.5 + b.ph) * 1.5, boss.cz + Math.sin(b.ang) * b.r);
    b.mesh.rotation.y = -b.ang + Math.PI / 2;
    const flap = Math.sin(S.t * 6 + b.ph) * 0.5; b.mesh.userData.wl.rotation.x = flap; b.mesh.userData.wr.rotation.x = -flap;
  }
}
function buildMosasaurus() {
  const g = new THREE.Group(), mat = _mm(0x37474a, 0.5, 0.2);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 0.5, 9, 12), mat); body.rotation.z = Math.PI / 2; g.add(body);
  const head = new THREE.Mesh(new THREE.ConeGeometry(1.3, 3.2, 12), mat); head.rotation.z = -Math.PI / 2; head.position.set(5.6, 0, 0); g.add(head);
  const jaw = new THREE.Mesh(new THREE.ConeGeometry(1.05, 2.6, 10), mat); jaw.rotation.z = -Math.PI / 2; jaw.position.set(5.3, -0.5, 0); g.add(jaw);
  for (const s of [1, -1]) { const fin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 1.1), mat); fin.position.set(1.4, -0.7, s * 1.5); fin.rotation.y = s * 0.4; g.add(fin); }
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.8, 0.2), mat), { position: new THREE.Vector3(-5, 0, 0) }));   // tail fluke
  scene.add(g); return { group: g };
}
function buildContainmentWalls(cx, cz) {
  const g = new THREE.Group(); g.position.set(cx, -9, cz); scene.add(g);
  const mat = _mm(0x4a4f4a, 0.7, 0.5), R = 13;
  for (const [dx, dz, w, rot] of [[0, R, 2 * R, 0], [0, -R, 2 * R, 0], [R, 0, 2 * R, Math.PI / 2], [-R, 0, 2 * R, Math.PI / 2]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 11, 0.8), mat); wall.position.set(dx, 5.5, dz); wall.rotation.y = rot; g.add(wall);
  }
  return g;
}
function buildEndingPads(cx, cz) {
  const g = new THREE.Group(); scene.add(g);
  const defs = [["contain", cx - 9, cz + 7, 0x6fae6b, "CONTAIN"], ["lagoon", cx, cz + 11, 0x5b9fd6, "FLOOD THE LAGOON"], ["run", cx + 9, cz + 7, 0xc9772f, "RUN FOR THE HELI"]];
  const pads = [];
  for (const [kind, x, z, col, label] of defs) {
    const gy = groundH(x, z);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(2.0, 28), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(x, gy + 0.12, z); g.add(pad);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 10, 8), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, depthWrite: false })); beam.position.set(x, gy + 5, z); g.add(beam);
    const tag = makeNameTag(label); tag.scale.set(3.0, 0.7, 1); tag.position.set(x, gy + 2.7, z); g.add(tag);
    pads.push({ kind, x, z, pad, beam, tag });
  }
  g.userData.pads = pads; return g;
}
function startBoss() {
  if (Net.on && !Net.isHost) return;   // co-op: host runs the finale; the Indominus + waves sync to clients as puppets
  const cx = 0, cz = -86;
  boss = { stage: "arrival", t: 0, cx, cz, chosen: null, outcomeT: 0, outcomeDur: 4, props: [], _cReady: false };
  S.player.noise = 1; spawnTimer = 0; Audio.roar(); flash();
  const half = BIOME.map.size / 2 - 8;
  const rex = spawnDino("indominus", clamp(cx + 34, -half, half), clamp(cz + 30, -half, half));
  rex.bb.hasTarget = true; rex.bb.lastSeenX = S.player.x; rex.bb.lastSeenZ = S.player.z; rex.bb.homeX = S.player.x; rex.bb.homeZ = S.player.z;
  dinos.push(rex); boss.rex = rex;
  boss.ptero = buildPteranodonSwarm(cx, cz); boss.props.push(boss.ptero);
  boss.pads = buildEndingPads(cx, cz); boss.props.push(boss.pads);
  toast("⚠ INDOMINUS REX — CONTAINMENT FAILED");
}
function commitEnding(kind) {
  if (boss.chosen) return;
  boss.chosen = kind; boss.stage = "outcome"; boss.outcomeT = 0;
  if (kind === "contain") { boss.outcomeDur = 4.5; boss.walls = buildContainmentWalls(boss.cx, boss.cz); boss.props.push(boss.walls); Audio.crash(); toast("PADDOCK SEALING — ALL SURVIVORS EVACUATING"); }
  else if (kind === "lagoon") { boss.outcomeDur = 5.2; boss.mosa = buildMosasaurus(); boss.props.push(boss.mosa.group); Audio.roar(); toast("THE LAGOON GATE OPENS…"); }
  else { boss.outcomeDur = 3.4; Audio.beacon(true); toast("YOU RUN FOR THE HELICOPTER — LEAVE IT ALL BEHIND"); }
}
function runOutcome(dt) {
  const k = boss.outcomeT, rex = boss.rex;
  if (boss.chosen === "contain") {
    if (rex && rex.alive) { rex.x += (boss.cx - rex.x) * Math.min(1, dt * 2.2); rex.z += (boss.cz - rex.z) * Math.min(1, dt * 2.2); rex.bb.scared = 99; rex.state = "Retreat"; }
    if (boss.walls) boss.walls.position.y = Math.min(0, -9 + k * 4.5);
  } else if (boss.chosen === "lagoon" && boss.mosa) {
    const g = boss.mosa.group, tx = rex ? rex.x : boss.cx, tz = rex ? rex.z : boss.cz;
    if (k < 2) { g.position.set(tx + 7, -12 + k * 10, tz); g.rotation.y = -Math.PI / 2; }
    else { g.position.x += (tx - g.position.x) * Math.min(1, dt * 3); g.position.z += (tz - g.position.z) * Math.min(1, dt * 3); g.position.y += (-13 - g.position.y) * Math.min(1, dt * 1.6); if (rex && rex.alive) { rex.mesh.position.y -= dt * 6; if (k > 3.4) killDino(rex); } }
  }
}
function updateBoss(dt) {
  if (!boss) return;
  boss.t += dt;
  if (boss.rex && boss.rex.alive && boss.stage !== "outcome") { boss.rex.bb.hasTarget = true; boss.rex.bb.lastSeenX = S.player.x; boss.rex.bb.lastSeenZ = S.player.z; }
  updatePteranodons(dt);
  if (boss.stage === "arrival") { if (boss.t > 3) { boss.stage = "hunt"; toast("SURVIVE — reach a pad to decide how this ends"); } }
  else if (boss.stage === "hunt") {
    const containReady = boss.t > 38;
    if (containReady && !boss._cReady) { boss._cReady = true; toast("CONTAINMENT ONLINE — the CONTAIN pad is live"); }
    if (boss.pads) for (const p of boss.pads.userData.pads) { const locked = p.kind === "contain" && !containReady; p.pad.material.opacity = locked ? 0.12 : (0.45 + Math.abs(Math.sin(S.t * 3)) * 0.3); p.beam.visible = !locked; p.tag.material.opacity = locked ? 0.3 : 1; }
    let chosen = null;
    if (boss.pads) for (const p of boss.pads.userData.pads) { if (p.kind === "contain" && !containReady) continue; if (dist2(S.player.x, S.player.z, p.x, p.z) < 2.4 * 2.4) chosen = p.kind; }
    if (chosen) commitEnding(chosen);
  } else if (boss.stage === "outcome") {
    boss.outcomeT += dt; runOutcome(dt);
    if (boss.outcomeT > boss.outcomeDur) { const map = { contain: "A", lagoon: "B", run: "C" }; endRun(true, map[boss.chosen] || "C"); }
  }
}
function playerFloorY(x, z) {   // player's floor: tower platform / zipline cable / terrain
  const P = S.player;
  if (P.zip) return P.zip.curFloor != null ? P.zip.curFloor : groundH(x, z);
  return P.onTower ? P.onTower.platformY : groundH(x, z);
}
function nearTowerBase(P) {
  for (const t of TOWERS) { if (dist2(P.x, P.z, t.x, t.z + t.half) < 9) return t; }   // within ~3m of the ladder
  return null;
}
function climbTower(t) {
  const P = S.player; P.onTower = t; P.zip = null;
  P.x = t.x; P.z = t.z; P.gait = "idle";   // step onto the centre of the deck
  toast("ON WATCHTOWER · glass (B) & tranq · press E or walk off the front (ladder side) to zip down");
}
function startZip(t) {
  const P = S.player;
  P.zip = { t: 0, dur: 1.7, x0: P.x, z0: P.z, y0: t.platformY, x1: t.zipX, z1: t.zipZ, curFloor: t.platformY };
  P.onTower = null; Audio.step("run"); toast("ZIPLINE!");
}
function updateZip(dt) {
  const P = S.player, z = P.zip; z.t += dt; const k = Math.min(1, z.t / z.dur);
  const ease = k * k * (3 - 2 * k);
  P.x = lerp(z.x0, z.x1, ease); P.z = lerp(z.z0, z.z1, ease);
  const endFloor = groundH(z.x1, z.z1);
  z.curFloor = lerp(z.y0, endFloor, ease) - Math.sin(k * Math.PI) * 0.7;   // cable sag
  P.yaw = Math.atan2(z.x1 - z.x0, z.z1 - z.z0); P.gait = "idle";
  if (playerMesh) { playerMesh.position.set(P.x, z.curFloor + 0.9, P.z); playerMesh.rotation.y = P.yaw; playerMesh.rotation.x = 0.25; }
  if (k >= 1) { P.zip = null; Audio.step("run"); }
}
function interact() {   // context action shared by E / the ACTION button (press actions only — holds are in updateAction)
  const P = S.player;
  if (P.zip) return;
  if (P.onTower) { startZip(P.onTower); return; }
  const t = nearTowerBase(P);
  if (t) { climbTower(t); return; }
  if (missionInteractInRange()) return;      // a hold-to-act objective is here — handled by the HOLD, not a press
  tryCall();   // default: extraction
}

// extraction facility around the beacon: helipad, bunker, comms tower, floodlights, red warning beacons
function buildFacility(bx, bz) {
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8f8c, roughness: 0.9, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x55595a, roughness: 0.9 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 2.4 });
  const red = new THREE.MeshStandardMaterial({ color: 0xff3a2a, emissive: 0xff2a1a, emissiveIntensity: 2.6 });
  const g = new THREE.Group(); g.position.set(bx, groundH(bx, bz), bz);
  // orient the complex to face the valley centre
  g.rotation.y = Math.atan2(-bx, -bz);
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 0.4, 28), concrete); pad.position.y = 0.2; g.add(pad);
  const padRing = new THREE.Mesh(new THREE.TorusGeometry(7, 0.25, 8, 36), new THREE.MeshStandardMaterial({ color: 0xd6a23a, emissive: 0x5a3f0e, emissiveIntensity: 0.5 }));
  padRing.rotation.x = -Math.PI / 2; padRing.position.y = 0.45; g.add(padRing);
  const bld = new THREE.Mesh(new THREE.BoxGeometry(22, 9, 14), concrete); bld.position.set(0, 4.5, -17); g.add(bld);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(24, 1, 16), dark); roof.position.set(0, 9.4, -17); g.add(roof);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(3, 18, 3), concrete); tower.position.set(13, 9, -21); g.add(tower);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 8, 6), dark); antenna.position.set(13, 22, -21); g.add(antenna);
  for (const [px, pz] of [[-11, -3], [11, -3], [-11, -29], [11, -29]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.32, 12, 6), dark); pole.position.set(px, 6, pz); g.add(pole);
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 10), lamp); l.position.set(px, 12, pz); g.add(l);
    const pl = new THREE.PointLight(0xfff2c0, 1.2, 55); pl.position.set(px, 12, pz); g.add(pl);
  }
  for (const [px, pz] of [[-11, -10], [11, -10]]) { const rb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), red); rb.position.set(px, 10.3, pz); g.add(rb); }
  scene.add(g);
}

/* --------------------------------------------------------------- input ---- */
const keys = new Set();
const input = { mx: 0, mz: 0, sprint: false, crouch: false, lookDX: 0, lookDY: 0, action: false };
let pointerLocked = false, isTouch = false;

function initInput() {
  const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
  addEventListener("keydown", e => {
    if (typing(e)) return;   // let text fields (lobby name/room code) receive every key, incl. WASD/E/Space
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyE", "Space"].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.code === "KeyE") interact();   // climb tower / zip down / call extraction (context)
    if (e.code === "KeyM") toggleMap();
    if (e.code === "KeyF") useTool();                                   // use selected defense tool
    if (e.code === "Digit1") selectTool(0);
    if (e.code === "Digit2") selectTool(1);
    if (e.code === "Digit3") selectTool(2);
    if (e.code === "Digit4") selectTool(3);
    if (e.code === "Digit5") selectTool(4);
    if (e.code === "Digit6") selectTool(5);
    if (e.code === "KeyB") toggleBinoc();   // binoculars (zoom + species ID)
    if (binoc && (e.code === "Equal" || e.code === "NumpadAdd")) binocZoom(1);
    if (binoc && (e.code === "Minus" || e.code === "NumpadSubtract")) binocZoom(-1);
    if (e.code === "KeyH" || e.code === "Slash") toggleKeyHelp();          // controls reference (desktop)
    if (intro && (e.code === "Escape" || e.code === "Enter" || e.code === "Space")) { skipIntro(); return; }
    if (e.code === "Space") tryJump();   // jump / vault / climb (mantle onto a ledge you're facing)
    if (e.code === "Escape" && mapOpen) toggleMap();
    if (e.code === "Escape") { const o = $("opts"); if (o && o.classList.contains("on")) o.classList.remove("on"); }   // P-08: Esc closes the options panel
    if (e.code === "Escape") $("keyHelp").classList.remove("on");
  });
  addEventListener("keyup", e => { if (typing(e)) return; keys.delete(e.code); });
  addEventListener("blur", () => keys.clear());

  // mouse look via pointer lock
  canvas.addEventListener("click", () => { if (S.phase === "playing" && !isTouch) canvas.requestPointerLock(); });
  document.addEventListener("pointerlockchange", () => pointerLocked = (document.pointerLockElement === canvas));
  addEventListener("mousemove", e => {
    if (!pointerLocked) return;
    cam.yaw -= e.movementX * 0.0022; cam.pitch = clamp(cam.pitch - e.movementY * 0.0019, -0.95, 0.45);
  });

  // touch — note iPadOS Safari defaults to "desktop mode" where ontouchstart + pointer:coarse are both
  // false; maxTouchPoints stays > 0, so include it to reliably detect iPads (and 2-in-1 touch laptops).
  if (navigator.maxTouchPoints > 0 || "ontouchstart" in window || matchMedia("(pointer:coarse)").matches) { isTouch = true; setupTouch(); }
  $("touch").style.display = isTouch ? "block" : "none";

  // defense tool bar: tap a tool to select it; tap the selected one (or the USE button) to activate
  document.querySelectorAll("#tools .tool").forEach(el => el.addEventListener("click", () => { const i = +el.dataset.i; if (i === selTool) useTool(); else selectTool(i); }));
  const bu = $("btnUse"); if (bu) bu.addEventListener("pointerdown", e => { e.preventDefault(); useTool(); });
  const bn = $("btnBinoc"); if (bn) bn.addEventListener("pointerdown", e => { e.preventDefault(); toggleBinoc(); });
  const bi = $("bnIn"); if (bi) bi.addEventListener("pointerdown", e => { e.preventDefault(); binocZoom(1); });
  const bo = $("bnOut"); if (bo) bo.addEventListener("pointerdown", e => { e.preventDefault(); binocZoom(-1); });
  addEventListener("wheel", e => { if (binoc) { binocZoom(e.deltaY < 0 ? 1 : -1); e.preventDefault(); } }, { passive: false });
  const bm = $("btnMap"); if (bm) bm.addEventListener("pointerdown", e => { e.preventDefault(); toggleMap(); });
  const mc = $("mapClose"); if (mc) mc.addEventListener("click", e => { e.preventDefault(); if (mapOpen) toggleMap(); });
  const ml = $("mapLayers"); if (ml) ml.addEventListener("click", e => {   // toggle threat/territory/ghost overlays
    const b = e.target.closest("button"); if (!b) return; e.preventDefault();
    const k = b.dataset.layer; if (!(k in mapLayers)) return;
    mapLayers[k] = !mapLayers[k]; b.classList.toggle("on", mapLayers[k]);
    try { localStorage.setItem("jws_mapLayers", JSON.stringify(mapLayers)); } catch (e) {}   // remember the overlay choice across sessions
    if (mapOpen) $("mapBigSvg").innerHTML = mapSVG(true);
  });
  const mo = $("mapOverlay"); if (mo) mo.addEventListener("pointerdown", e => { if (e.target === mo && mapOpen) toggleMap(); });   // tap backdrop to close
  const mm = document.querySelector(".minimap"); if (mm) mm.addEventListener("click", () => { if (!mapOpen) toggleMap(); });   // desktop: click minimap to expand
  // explicit ENLARGE button (all platforms). Use click (iOS-reliable, no preventDefault so the tap isn't
  // eaten); stopPropagation so the minimap's own click handler doesn't immediately toggle it back.
  const me = $("mmEnlarge"); if (me) ["click", "pointerup"].forEach(ev => me.addEventListener(ev, e => { e.stopPropagation(); if (!mapOpen) toggleMap(); }));

  // keyboard reference slideout — desktop only (touch users have on-screen labels + the joystick affordance)
  document.body.classList.toggle("is-touch", isTouch);   // CSS swaps the controls panel to touch mappings
  { const kb = $("keyHelpBtn"); if (kb) { kb.style.display = "block"; kb.textContent = isTouch ? "❔" : "⌨ CONTROLS"; kb.addEventListener("click", toggleKeyHelp); } }
  const kc = $("keyHelpClose"); if (kc) kc.addEventListener("click", () => $("keyHelp").classList.remove("on"));
}
function toggleKeyHelp() { const k = $("keyHelp"); if (k) k.classList.toggle("on"); }

function setupTouch() {
  const stick = $("stick"), knob = $("stickKnob"), base = $("stickBase"), look = $("lookpad"), lookHint = $("lookHint");
  const ar = { up: base.querySelector(".up"), dn: base.querySelector(".dn"), lf: base.querySelector(".lf"), rt: base.querySelector(".rt") };
  let sid = null, ox = 0, oy = 0, lid = null, lx = 0, ly = 0;
  const setArrows = (dx, dy) => { const th = 0.28; ar.up.classList.toggle("on", dy < -th); ar.dn.classList.toggle("on", dy > th); ar.lf.classList.toggle("on", dx < -th); ar.rt.classList.toggle("on", dx > th); };
  // park the move pad at an idle "home" spot so players can SEE the stick (with up/down/left/right arrows) before touching
  const parkBase = () => { const hx = Math.round(window.innerWidth * 0.13), hy = Math.round(window.innerHeight - 150); base.classList.add("idle"); base.style.left = knob.style.left = hx + "px"; base.style.top = knob.style.top = hy + "px"; setArrows(0, 0); };
  parkBase(); addEventListener("resize", parkBase);
  stick.addEventListener("pointerdown", e => { sid = e.pointerId; [ox, oy] = [e.clientX, e.clientY]; base.classList.remove("idle"); base.style.left = knob.style.left = ox + "px"; base.style.top = knob.style.top = oy + "px"; stick.setPointerCapture(e.pointerId); });
  stick.addEventListener("pointermove", e => {
    if (e.pointerId !== sid) return;
    let dx = e.clientX - ox, dy = e.clientY - oy; const len = Math.hypot(dx, dy) || 1, max = 52;
    const cl = Math.min(len, max); dx = dx / len * cl; dy = dy / len * cl;
    knob.style.left = (ox + dx) + "px"; knob.style.top = (oy + dy) + "px";
    input.mx = dx / max; input.mz = dy / max; setArrows(input.mx, input.mz);
  });
  const endStick = e => { if (e.pointerId === sid) { sid = null; input.mx = input.mz = 0; parkBase(); } };
  stick.addEventListener("pointerup", endStick); stick.addEventListener("pointercancel", endStick);
  look.addEventListener("pointerdown", e => { lid = e.pointerId; lx = e.clientX; ly = e.clientY; look.setPointerCapture(e.pointerId); if (lookHint) lookHint.style.opacity = "0"; });
  look.addEventListener("pointermove", e => {
    if (e.pointerId !== lid) return;
    cam.yaw -= (e.clientX - lx) * 0.006; cam.pitch = clamp(cam.pitch - (e.clientY - ly) * 0.005, -0.95, 0.45);
    lx = e.clientX; ly = e.clientY;
  });
  const endLook = e => { if (e.pointerId === lid) lid = null; };
  look.addEventListener("pointerup", endLook); look.addEventListener("pointercancel", endLook);

  const hold = (el, on) => { el.addEventListener("pointerdown", () => on(true)); ["pointerup", "pointercancel", "pointerleave"].forEach(ev => el.addEventListener(ev, () => on(false))); };
  hold($("btnSprint"), v => input.sprint = v);
  hold($("btnCrouch"), v => input.crouch = v);
  { const bj = $("btnJump"); if (bj) bj.addEventListener("pointerdown", e => { e.preventDefault(); tryJump(); }); }
  { const ba = $("btnCall");   // ACTION button: hold for hold-to-act objectives, tap for press actions (zip/call)
    ba.addEventListener("pointerdown", e => { e.preventDefault(); input.action = true; interact(); });
    ["pointerup", "pointercancel", "pointerleave"].forEach(ev => ba.addEventListener(ev, () => input.action = false)); }
}

const _pad = {};   // edge-trigger state for gamepad buttons
function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const dz = v => Math.abs(v) < 0.18 ? 0 : v;
    const bp = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const edge = (i, key) => { const p = bp(i); const fired = p && !_pad[key]; _pad[key] = p; return fired; };   // rising edge
    input.mx = dz(gp.axes[0] || 0); input.mz = dz(gp.axes[1] || 0);
    cam.yaw -= dz(gp.axes[2] || 0) * 0.05; cam.pitch = clamp(cam.pitch - dz(gp.axes[3] || 0) * 0.04, -0.95, 0.45);
    input.sprint = bp(0);                              // A
    input.crouch = bp(1);                              // B
    if (bp(2)) tryCall();                              // X
    if (edge(3, "jump")) tryJump();                    // Y → jump/climb
    if (edge(9, "map") || edge(8, "map2")) toggleMap();// Start/Select → map
    if (edge(4, "toolPrev")) selectTool((selTool + TOOLS.length - 1) % TOOLS.length);   // LB → prev tool
    if (edge(5, "toolNext")) selectTool((selTool + 1) % TOOLS.length);                   // RB → next tool
    if (edge(7, "use")) useTool();                     // RT → use selected tool
    if (edge(6, "binoc")) toggleBinoc();               // LT → binoculars
    if (binoc && edge(12, "zin")) binocZoom(1);        // D-pad up → zoom in
    if (binoc && edge(13, "zout")) binocZoom(-1);      // D-pad down → zoom out
    return;
  }
}

/* ===================================================== ground & helpers === */
// terrain height: rolling valley floor (>=~0), perimeter mountain ring, and a winding carved river.
// Everything (ground mesh, foliage, rocks, dinos, player) is placed by this single function.
const RIVER_HALF = 17;                                             // navigable channel half-width (wide enough for the patrol boat)
const WATER_Y = -0.55;                                             // river surface height (boat rides on this)
// terrain pitch along a heading — used to tilt the player + dinos to the slope (foot adaptation)
function terrainPitch(x, z, yaw) {
  const s = Math.sin(yaw), c = Math.cos(yaw), a = 1.3;
  const hF = groundH(x + s * a, z + c * a), hB = groundH(x - s * a, z - c * a);
  return clamp(Math.atan2(hF - hB, a * 2) * 0.6, -0.5, 0.5);
}
function riverCenter(x) { return 48 + Math.sin(x * 0.02) * 28; }   // river centerline z(x)
function riverSlope(x) { return Math.cos(x * 0.02) * 28 * 0.02; }  // d(riverCenter)/dx — used to align the boat to the current
function groundH(x, z) {
  const r = Math.hypot(x, z);
  let h = 1.8 + Math.sin(x * 0.05) * Math.cos(z * 0.045) * 1.3 + Math.sin(x * 0.13 + z * 0.09) * 0.5;  // rolling hills
  const e = Math.max(0, (r - 70) / 48);
  h += e * e * 32 * (0.75 + 0.25 * Math.sin(x * 0.07) * Math.cos(z * 0.06));   // mountains ring the valley
  const dRiver = Math.abs(z - riverCenter(x));
  if (dRiver < RIVER_HALF) { const t = dRiver / RIVER_HALF; h -= (1 - t * t) * 6.0; }   // wide, smooth-banked navigable channel
  return h;
}
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function bearingTo(ax, az, bx, bz) {
  const ang = Math.atan2(bx - ax, -(bz - az)) / DEG; const d = (ang + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(d / 45) % 8];
}

/* ===================================================== traversal layer === *
 * Opt-in vertical movement layered ON TOP of free-walk — when grounded and not jumping, the original
 * horizontal path runs untouched. Jump (gravity arc), auto-vault (hop low obstacles instead of being
 * wall-stopped), and mantle (climb onto a mid-height rock/ledge for vantage; walk off the edge to
 * drop). Height-aware collision lets you actually clear what you jump/climb over. */
const GRAV = 22, JUMP_V = 7.4;            // m/s² · initial jump velocity (apex ≈ 1.25 m)
function tryJump() {
  if (S.phase !== "playing") return;
  const P = S.player;
  if (P.onTower || P.zip || P.swim || P.onProp || P.air > 0.05 || P.vy > 0) return;   // grounded stance only
  const c = climbableAhead(P);            // facing a climbable prop → mantle onto it instead of a plain jump
  if (c) {
    P.onProp = c; P.propTopY = c.top;
    const dx = c.x - P.x, dz = c.z - P.z, d = Math.hypot(dx, dz) || 1; P.x += dx / d * 0.6; P.z += dz / d * 0.6;
    P.air = 0; P.vy = 0; P.stamina = Math.max(0, P.stamina - 14); Audio.step("run"); toast("CLIMB"); return;
  }
  if (P.stamina < 8) return;
  P.vy = JUMP_V; P.air = 0.001; P.stamina -= 8; Audio.step("run");
}
function climbableAhead(P) {               // nearest climbable proxy in front of the camera, within reach
  const fx = Math.sin(cam.yaw), fz = Math.cos(cam.yaw); let best = null;
  const scan = c => { if (!c.climb) return; const dx = c.x - P.x, dz = c.z - P.z, d = Math.hypot(dx, dz) || 1;
    if (d > c.r + 2.0) return; if ((dx / d) * fx + (dz / d) * fz < 0.4) return; best = c; };
  for (const c of queryColliders(P.x, P.z)) scan(c); for (const c of missionColliders) scan(c);
  return best;
}
function lowObstacleAhead(P, wx, wz, feetY) {   // a low solid just ahead in the move direction → auto-vault
  const d2dir = Math.hypot(wx, wz) || 1, fx = wx / d2dir, fz = wz / d2dir; let best = null;
  const scan = c => { if (c.top == null || c.h == null || c.h > 1.3) return; if (feetY > c.top - 0.1) return;
    const dx = c.x - P.x, dz = c.z - P.z, d = Math.hypot(dx, dz) || 1;
    if (d > c.r + 1.4) return; if ((dx / d) * fx + (dz / d) * fz < 0.55) return; best = c; };
  for (const c of queryColliders(P.x, P.z)) scan(c); for (const c of missionColliders) scan(c);
  return best;
}
function updateTraversal(dt, wx, wz, moving) {
  const P = S.player;
  // standing on a prop: hold at its top; the moment you walk past the footprint, step into the air & fall
  if (P.onProp) {
    const c = P.onProp, dx = P.x - c.x, dz = P.z - c.z;
    if (dx * dx + dz * dz > (c.r + 0.4) * (c.r + 0.4)) { P.onProp = null; P.air = Math.max(0, P.propTopY - groundH(P.x, P.z)); P.vy = 0; }
    else { P.air = 0; P.vy = 0; return; }
  }
  // auto-vault: jog into a knee/waist-high obstacle while grounded → assisted hop over it
  if (moving && P.air <= 0.02 && P.vy <= 0) {
    const feetY = groundH(P.x, P.z) + P.air;
    if (lowObstacleAhead(P, wx, wz, feetY)) { P.vy = JUMP_V * 0.8; P.air = 0.001; }
  }
  // airborne: integrate gravity over the ground
  if (P.air > 0 || P.vy !== 0) { P.vy -= GRAV * dt; P.air += P.vy * dt; if (P.air <= 0) { P.air = 0; P.vy = 0; } }
}

/* ======================================================= player update === */
let hitCooldownVisual = 0, stepPhase = 0;
function updatePlayer(dt) {
  const P = S.player, cfg = BIOME.player;
  if (evacCine()) return;   // evac cinematic drives the player (boarding); ignore input
  if (P.zip) { updateZip(dt); return; }   // riding the zipline down (brief, ~1.7s)
  // intent from keyboard + touch/gamepad (input.mx/mz already set for touch/pad)
  let ix = input.mx, iz = input.mz;
  if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
  const sprint = input.sprint || keys.has("ShiftLeft") || keys.has("ShiftRight");
  const crouch = input.crouch || keys.has("ControlLeft") || keys.has("ControlRight");
  let mag = Math.hypot(ix, iz); if (mag > 1) { ix /= mag; iz /= mag; mag = 1; }
  const moving = mag > 0.08;

  // gait + speed + noise (data-driven)
  let gait = "idle", speed = 0;
  if (moving) {
    if (crouch) { gait = "crouch"; speed = cfg.crouchSpeed; }
    else if (sprint && P.stamina > 1) { gait = "run"; speed = cfg.runSpeed; }
    else { gait = "walk"; speed = cfg.walkSpeed; }
  } else if (crouch) gait = "crouch";
  P.gait = gait;
  const rmod = P.role ? P.role.mod : EMPTY_MOD;
  speed *= rmod.speed || 1;                                       // role perk: movement (navigator)
  const inWater = (WATER_Y - groundH(P.x, P.z)) > 1.1 && !P.onTower && !P.onProp;   // deep water → swim drag
  if (inWater) speed *= 0.55;
  speed *= (P.survSpeedMul || 1);   // survival: injury / cold slow you down
  const targetNoise = (cfg.noise[gait] ?? 0) * (rmod.noise || 1); // role perk: stealth/noise (research)
  P.noise = lerp(P.noise, S.extraction.called ? Math.max(targetNoise, 0.6) : targetNoise, 0.15);

  // stamina (fear throttles regen; survival perk slows the drain)
  if (gait === "run" && moving) P.stamina = Math.max(0, P.stamina - cfg.staminaDrainPerS * (rmod.drain || 1) * dt);
  else P.stamina = Math.min(100, P.stamina + cfg.staminaRegenPerS * (1 - P.fear * 0.7) * dt);

  // health slow regen when calm & unhurt (medic perk boosts it)
  hitCooldownVisual = Math.max(0, hitCooldownVisual - dt);
  if (P.fear < 0.3 && hitCooldownVisual <= 0 && P.hp > 0) P.hp = Math.min(100, P.hp + cfg.healthRegenPerS * (rmod.heal || 1) * dt);

  // FREE-LOOK movement: the move direction is LATCHED to the camera yaw at the moment you start moving
  // (or meaningfully change stick direction). After that you can swing the camera/look all the way around
  // to scan for threats WITHOUT curving your travel — you keep walking the same world heading until you
  // push a new direction. (Camera-relative-on-press, then decoupled — the AAA "look around while moving".)
  let wx = 0, wz = 0;
  if (moving) {
    const stickAng = Math.atan2(ix, iz);
    let d = stickAng - (P._lastStick == null ? stickAng : P._lastStick); d = Math.abs(((d + Math.PI) % (Math.PI * 2)) - Math.PI);
    if (!P._moving || d > 0.55 || P.moveYaw == null) P.moveYaw = cam.yaw;   // (re)latch on start / new intended direction
    P._lastStick = stickAng; P._moving = true;
    const fy = P.moveYaw, sin = Math.sin(fy), cos = Math.cos(fy);
    wx = (ix * cos - iz * sin); wz = (ix * sin + iz * cos);
    const slope = (groundH(P.x + wx * 2, P.z + wz * 2) - groundH(P.x, P.z)) * 0.5;
    if (slope > 0.04 && !P.onProp) P.stamina = Math.max(0, P.stamina - slope * 9 * dt);
    P.x += wx * speed * dt; P.z += wz * speed * dt;
    P.yaw = lerp2angle(P.yaw, Math.atan2(wx, wz));   // body faces travel
    stepPhase += speed * dt;
    if (stepPhase > (gait === "run" ? 1.7 : 2.6)) { stepPhase = 0; Audio.step(gait); }
  } else P._moving = false;
  // vertical traversal (jump / auto-vault / mantle) — additive; does nothing while grounded & not jumping
  updateTraversal(dt, wx, wz, moving);
  // water: deep channel → swim (no jump/mantle); hold crouch to dive (oxygen drains); the current
  // pushes you downstream so a crossing is a real "do I risk it?" decision, not free movement.
  const depth = WATER_Y - groundH(P.x, P.z);
  P.swim = inWater;
  const vaulting = P.air > 0.02 || P.vy > 0;   // F-15: mid jump/vault over the water's edge — let the arc finish before swim cancels it
  if (P.swim && !vaulting) {
    P.air = 0; P.vy = 0; P.onProp = null;
    P.dive = crouch && depth > 2.0;
    const sl = riverSlope(P.x), cl = Math.hypot(1, sl), cur = 1.5 * dt;   // gentle downstream drift along the channel
    P.x += (1 / cl) * cur; P.z += (sl / cl) * cur;
    P.stamina = Math.max(0, P.stamina - 4 * dt);
    if (P.dive) { P.oxygen = Math.max(0, (P.oxygen == null ? 100 : P.oxygen) - 14 * dt); if (P.oxygen <= 0) { P.hp = Math.max(0, P.hp - 9 * dt); flash(); if (P.hp <= 0 && P.alive) { P.alive = false; S.killedBy = null; endRun(false); } } }
    else P.oxygen = Math.min(100, (P.oxygen == null ? 100 : P.oxygen) + 24 * dt);
  } else if (!P.swim) { P.dive = false; P.oxygen = Math.min(100, (P.oxygen == null ? 100 : P.oxygen) + 30 * dt); }
  // collide with trees (height-aware: a jump/mantle that clears the canopy base won't be wall-stopped)
  const feetY = (P.onProp ? P.propTopY : playerFloorY(P.x, P.z)) + (P.air || 0);
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i], rr = (t.r + 0.5);
    if (dist2(P.x, P.z, t.x, t.z) < rr * rr) {
      const dx = P.x - t.x, dz = P.z - t.z, d = Math.hypot(dx, dz) || 1;
      P.x = t.x + dx / d * rr; P.z = t.z + dz / d * rr;
    }
  }
  // collide with solid world props (rocks, ruins, mission buildings) — skip while on a tower/zip/prop
  if (!P.onTower && !P.zip && !P.onProp) resolveColliders(P, 0.45, feetY);
  updateSurvival(dt);   // hunger / thirst / temperature / injury
  const lim = BIOME.map.size / 2 - 3;
  P.x = clamp(P.x, -lim, lim); P.z = clamp(P.z, -lim, lim);
  if (P.onTower) {   // railed on 3 sides; step off the FRONT (ladder side, +Z) to ride the zip down (or press E)
    const t = P.onTower, b = t.half - 0.45;
    P.x = clamp(P.x, t.x - b, t.x + b);
    if (P.z > t.z + b) startZip(t);
    else P.z = Math.max(P.z, t.z - b);
  } else if (!P.zip) {   // watchtowers: step onto the ladder to auto-climb; otherwise you can't walk through the structure
    for (const t of TOWERS) {
      if (dist2(P.x, P.z, t.x, t.z + t.half) < 2.4 * 2.4) { climbTower(t); break; }   // at the ladder → go up
      const dx = P.x - t.x, dz = P.z - t.z, d = Math.hypot(dx, dz) || 1, rr = t.half + 0.15;
      if (d < rr) { P.x = t.x + dx / d * rr; P.z = t.z + dz / d * rr; }               // solid: push out of the legs
    }
  }

  // posture per gait: running pitches the torso forward into the stride (the single walk clip sped up
  // reads as a power-walk otherwise); crouch drops + leans; idle adds a breathing sway (clip frozen).
  const crouchDrop = P.gait === "crouch" ? 0.4 : 0;
  const idleBob = P.gait === "idle" ? Math.sin(S.t * 1.8) * 0.02 : 0;
  const runBounce = P.gait === "run" ? Math.abs(Math.sin(S.t * 11)) * 0.05 : 0;   // light foot-strike bob
  let standY = (P.onProp ? P.propTopY : playerFloorY(P.x, P.z)) + (P.air || 0);
  if (P.swim) standY = WATER_Y - (P.dive ? Math.min(3, depth - 0.6) : 0.25) + Math.sin(S.t * 2) * 0.04;   // float / submerge
  P.eyeY = standY;                                                                 // camera follows jumps/climbs/swim
  playerMesh.position.set(P.x, standY + 0.9 - crouchDrop + idleBob + runBounce, P.z);
  playerMesh.rotation.y = P.yaw;
  playerMesh.rotation.x = (P.gait === "run" ? 0.16 : 0) + (P.gait === "crouch" ? 0.22 : 0) + (P.gait === "idle" ? Math.sin(S.t * 1.8) * 0.012 : 0);

  // anti-stuck safeguard: if you're trying to move but wedged between colliders, nudge free toward open ground
  if (moving && !P.onTower && !P.zip) {
    const moved = dist2(P.x, P.z, P._lastX == null ? P.x : P._lastX, P._lastZ == null ? P.z : P._lastZ);
    if (moved < (speed * dt * 0.25) ** 2) { P._stuckT = (P._stuckT || 0) + dt; if (P._stuckT > 0.7) { const c = queryColliders(P.x, P.z)[0]; if (c) { const ux = P.x - c.x, uz = P.z - c.z, ul = Math.hypot(ux, uz) || 1; P.x += ux / ul * 0.6; P.z += uz / ul * 0.6; } else { P.x += wx * 0.4; P.z += wz * 0.4; } P._stuckT = 0; } }
    else P._stuckT = 0;
  } else P._stuckT = 0;
  P._lastX = P.x; P._lastZ = P.z;

  // extraction proximity
  const bd = Math.sqrt(dist2(P.x, P.z, S.extraction.beacon.x, S.extraction.beacon.z));
  const wasIn = S.extraction.inRange;
  S.extraction.inRange = bd < 6.5;
  if (S.extraction.inRange && !wasIn && !S.extraction.called) toast(STR.beaconReached);
  if (S.extraction.inRange) S._everInRange = true;
}
function lerp2angle(a, b, f) { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; return a + d * (f || 0.25); }

let camShake = 0;
function damagePlayer(amount, bySpecies, fromX, fromZ) {
  const P = S.player; if (!P.alive) return;
  if (evacCine() || playerSafe() || P.onTower || P.zip) return;   // safe boarding / in beacon zone / up a watchtower / ziplining
  P.hp = Math.max(0, P.hp - amount);
  hitCooldownVisual = 3.0; flash(); Audio.hit();
  camShake = Math.min(0.6, camShake + 0.35);                       // felt impact
  if (fromX != null) showHitDir(fromX, fromZ);                     // directional damage indicator (which way the bite came from)
  if (P.hp <= 0) { P.alive = false; S.killedBy = bySpecies; endRun(false); }
}
// red chevron at the screen edge pointing toward the attacker, relative to where you're looking
function showHitDir(fromX, fromZ) {
  const el = $("hitDir"); if (!el) return;
  const P = S.player, dx = fromX - P.x, dz = fromZ - P.z, d = Math.hypot(dx, dz) || 1;
  const rel = Math.atan2((dx / d) * Math.cos(cam.yaw) - (dz / d) * Math.sin(cam.yaw), (dx / d) * Math.sin(cam.yaw) + (dz / d) * Math.cos(cam.yaw));
  el.style.transform = `translate(-50%,-50%) rotate(${(rel * 180 / Math.PI).toFixed(0)}deg)`;
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
}

/* ==================================================== survival systems === *
 * A light layer on top of the core loop — gentle drains (minutes to matter), surfaced in the HUD only
 * when something's wrong, with natural refills (water, rations, warmth, the safe zone). */
function nearSite(types, r) {
  for (const g of missionSites) { if (!g.userData || !types.includes(g.userData.site)) continue; if (dist2(S.player.x, S.player.z, g.position.x, g.position.z) < r * r) return true; }
  return false;
}
function updateSurvival(dt) {
  const P = S.player; if (!P.alive) return;
  const wet = (WATER_Y - groundH(P.x, P.z)) > 0.3;
  P.thirst = wet ? Math.min(100, P.thirst + 25 * dt) : Math.max(0, P.thirst - dt * (100 / 420));        // water refills thirst
  P.hunger = nearSite(["supply", "campsite", "safehouse"], 6) ? Math.min(100, P.hunger + 12 * dt) : Math.max(0, P.hunger - dt * (100 / 780));   // rations at sites
  const warming = playerSafe() || nearSite(["campsite"], 7);
  P.temp = P.swim ? Math.max(-100, P.temp - 18 * dt) : Math.min(0, P.temp + (warming ? 16 : 7) * dt);    // wet = cold; dry/fire/safe = warm
  if (!P.injured && P.hp <= 28) P.injured = true;
  if (P.injured && (P.hp >= 48 || playerSafe())) P.injured = false;
  if (P.injured && !playerSafe()) P.hp = Math.max(1, P.hp - 0.9 * dt);                                   // bleed — never lethal by itself
  let mul = 1;
  if (P.injured) mul *= 0.78;
  if (P.temp < -45) { mul *= 0.9; P.stamina = Math.max(0, P.stamina - 2 * dt); }
  if (P.thirst < 25) P.stamina = Math.max(0, P.stamina - 1.5 * dt);
  if (P.hunger < 20 && P.stamina > 60) P.stamina = 60;                                                   // exhaustion cap
  P.survSpeedMul = mul;
}

/* ==================================================== dino AI (pillars) === */
let packBB = { lead: null, frame: 0 };   // shared pack blackboard
function spawnDino(speciesId, x, z) {
  const sp = SPECIES[speciesId];
  const g = buildDinoMesh(sp); g.position.set(x, groundH(x, z), z); scene.add(g);
  return {
    id: speciesId + "_" + (Math.random() * 1e6 | 0), sp, mesh: g,
    mixer: g.userData.mixer || null, walkAction: g.userData.walkAction || null,
    x, z, yaw: rand(0, 6.28), vx: 0, vz: 0, hp: sp.combat.health,
    state: baseStateFor(sp),
    bb: { lastSeenX: 0, lastSeenZ: 0, hasTarget: false, threat: 0, role: "harry", scared: 0, homeX: x, homeZ: z, hue: 0 },
    cd: 0, decideIn: rand(0, 0.25), lod: "full", anim: 0, alive: true, gaitPhase: rand(0, 6.28), roar: 0, roarCd: rand(2, 6),
    sedation: 0, sedated: false, downT: 0, trapped: false, trappedT: 0, drawn: false,   // field-science (tranq/trap/sample)
  };
}
// When a species' .glb finishes streaming, swap any already-spawned grey-box instances
// of that species for the real textured model in place (keeps position/heading/AI state).
function reskinDinos(modelPath) {
  if (!MODELS[modelPath]) return;
  for (const a of dinos) {
    if (!a.alive || a.sp.modelPath !== modelPath || !a.mesh.userData.greybox) continue;
    scene.remove(a.mesh);
    const g = buildDinoMesh(a.sp);
    g.position.set(a.x, groundH(a.x, a.z), a.z);
    g.rotation.y = a.yaw;
    scene.add(g);
    a.mesh = g; a.mixer = g.userData.mixer || null; a.walkAction = g.userData.walkAction || null;
  }
}
// fit a .glb object into a group: scaled to targetH, centered in x/z, feet at y=0, yaw-corrected.
// NOTE: caller passes the object to use. Clone static meshes before passing (dinos, multi-instance);
// pass a rigged/skinned model directly (single instance) — .clone(true) breaks skinned skeletons.
// skeleton-aware world bbox: setFromObject measures bind-pose geometry, which is wrong for
// rigged meshes (the rig can scale the rendered result). Use computeBoundingBox() for skinned.
function measureBox(obj) {
  obj.updateMatrixWorld(true);
  let skinned = null;
  obj.traverse(o => { if (o.isSkinnedMesh && !skinned) skinned = o; });
  if (skinned) {
    skinned.computeBoundingBox();
    if (skinned.boundingBox) return skinned.boundingBox.clone().applyMatrix4(skinned.matrixWorld);
  }
  return new THREE.Box3().setFromObject(obj);
}
function fitModel(model, targetH, yawOffset) {
  const g = new THREE.Group();
  model.scale.setScalar(1); model.updateMatrixWorld(true);   // clear any baked root scale for a clean measure
  let box = measureBox(model);
  const size = new THREE.Vector3(); box.getSize(size);
  model.scale.setScalar(targetH / (size.y || 1));
  model.updateMatrixWorld(true);
  box = measureBox(model);
  const c = new THREE.Vector3(); box.getCenter(c);
  model.position.x -= c.x; model.position.z -= c.z; model.position.y -= box.min.y;  // center + drop feet to 0
  model.rotation.y = yawOffset || 0;     // facing correction (model forward axis vs game +Z)
  g.add(model);
  // GROUND-TRUTH height correction: skinned/armature exports (player, T-Rex use Armature scale 0.01) can
  // bind-pose-mis-measure and come out the wrong size; force the actual rendered world height to targetH.
  g.updateMatrixWorld(true);
  const wb = new THREE.Box3().setFromObject(g), ws = new THREE.Vector3(); wb.getSize(ws);
  if (ws.y > 0.02 && Math.abs(ws.y / targetH - 1) > 0.12) {
    model.scale.multiplyScalar(targetH / ws.y); model.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(model); model.position.y -= b2.min.y;
  }
  return g;
}
// Locate the main rotor hub on a helicopter model: average x/z of the top vertex band.
// (Rotor blades are symmetric about the mast, so averaging the highest points lands on the hub —
//  far more reliable than the bbox origin, which a long tail boom drags rearward.)
function modelRotorXZ(obj) {
  obj.updateMatrixWorld(true);
  const v = new THREE.Vector3(); const meshes = [];
  obj.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) meshes.push(o); });
  let maxY = -Infinity;
  for (const o of meshes) { const p = o.geometry.attributes.position, st = Math.max(1, Math.floor(p.count / 900)); for (let i = 0; i < p.count; i += st) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); if (v.y > maxY) maxY = v.y; } }
  const band = 0.6; let sx = 0, sz = 0, n = 0;
  for (const o of meshes) { const p = o.geometry.attributes.position, st = Math.max(1, Math.floor(p.count / 900)); for (let i = 0; i < p.count; i += st) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); if (v.y >= maxY - band) { sx += v.x; sz += v.z; n++; } } }
  return n ? { x: sx / n, z: sz / n, y: maxY } : { x: 0, z: 0, y: maxY };
}
// real .glb dino instance, scaled to the species' grey-box stand height. Rigged+animated models
// (e.g. hero bipeds with a baked walk clip) are cloned with SkeletonUtils (clone(true) breaks
// skinned skeletons) and get their own AnimationMixer, surfaced on g.userData for the agent to drive.
function buildModelMesh(sp, tmpl) {
  // EVERY dinosaur animates the same way: a procedural, distance-synced body gait (see steer()).
  // Skinned meshes (only the T-Rex auto-rig) are bound correctly via SkeletonUtils and shown at their
  // bind pose, then driven by that same gait — we deliberately DON'T attach the baked skeletal clip,
  // which rendered the T-Rex broken (body missing, just legs + head). frustumCulled is forced off so no
  // part of a skinned mesh ever gets culled away.
  let skinned = false; tmpl.traverse(o => { if (o.isSkinnedMesh) skinned = true; });
  const inst = (skinned ? skeletonClone(tmpl) : tmpl.clone(true));
  inst.traverse(o => { if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false; });
  const g = fitModel(inst, sp.greybox.standH || sp.size.eyeHeightM || 3, sp.modelYaw || 0);
  const blob = new THREE.Mesh(new THREE.CircleGeometry((sp.greybox.bodyL || 1) * 0.9, 14), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.3, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03; g.add(blob);
  return g;
}
function buildDinoMesh(sp) {
  const tmpl = MODELS[sp.modelPath];
  if (tmpl) return buildModelMesh(sp, tmpl);
  const gb = sp.greybox, col = new THREE.Color(gb.color);
  const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 1, flatShading: true });
  const g = new THREE.Group();
  const scale = gb.standH;
  const body = new THREE.Mesh(new THREE.BoxGeometry(gb.bodyW, gb.bodyH, gb.bodyL), mat);
  body.position.y = scale * 0.55; g.add(body);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(gb.bodyW * 0.7, gb.bodyH * 0.7, gb.bodyL * 0.5), mat);
  neck.position.set(0, scale * 0.7, gb.bodyL * 0.55); g.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(gb.bodyW * 0.8, gb.bodyH * 0.6, gb.bodyL * 0.55), mat);
  head.position.set(0, scale * 0.78, gb.bodyL * 0.85); g.add(head); g.userData.head = head;
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(gb.bodyW * 0.7, gb.bodyH * 0.22, gb.bodyL * 0.5), mat);
  jaw.position.set(0, scale * 0.66, gb.bodyL * 0.85); g.add(jaw); g.userData.jaw = jaw;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(gb.bodyW * 0.5, gb.bodyH * 0.5, gb.bodyL * 1.1), mat);
  tail.position.set(0, scale * 0.5, -gb.bodyL * 0.9); g.add(tail);
  const legGeo = new THREE.BoxGeometry(gb.bodyW * 0.32, scale * 0.55, gb.bodyW * 0.4);
  const L1 = new THREE.Mesh(legGeo, mat), L2 = new THREE.Mesh(legGeo, mat);
  L1.position.set(gb.bodyW * 0.45, scale * 0.27, 0); L2.position.set(-gb.bodyW * 0.45, scale * 0.27, 0);
  g.add(L1, L2); g.userData.legs = [L1, L2];
  if (gb.crest) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 1.0), new THREE.MeshStandardMaterial({ color: 0xb98a4a, flatShading: true })); c.position.set(0, scale * 0.95, gb.bodyL * 0.7); c.rotation.x = 0.5; g.add(c); }
  const blob = new THREE.Mesh(new THREE.CircleGeometry(gb.bodyL * 0.9, 14), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.3, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03; g.add(blob);
  // F-16: normalise the greybox to EXACTLY standH (the same height buildModelMesh fits the .glb to),
  // so a dino doesn't visibly resize when its textured model streams in and reskinDinos swaps it.
  g.updateMatrixWorld(true);
  const _gbb = new THREE.Box3().setFromObject(g), _gsz = new THREE.Vector3(); _gbb.getSize(_gsz);
  if (_gsz.y > 0.01) g.scale.multiplyScalar(scale / _gsz.y);
  g.userData.greybox = true;   // flag so we can upgrade to the textured model once it streams in
  return g;
}

// perception: vision cone + hearing (no per-frame raycast; cost-bounded)
// Line-of-sight: false if a tall solid prop (ruin/building/big rock) sits between two points — the
// basis for real cover. Skips low props you can see over. Coarse-sampled, cost-bounded.
function losClear(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1, steps = Math.min(14, Math.ceil(len / 4));
  for (let i = 1; i < steps; i++) {
    const t = i / steps, x = ax + dx * t, z = az + dz * t;
    const near = queryColliders(x, z);
    for (let j = 0; j < near.length; j++) { const c = near[j]; if (c.top != null && c.top < 1.4) continue; if (dist2(x, z, c.x, c.z) < c.r * c.r) return false; }
    for (let j = 0; j < missionColliders.length; j++) { const c = missionColliders[j]; if (c.top != null && c.top < 1.4) continue; if (dist2(x, z, c.x, c.z) < c.r * c.r) return false; }
  }
  return true;
}
function perceive(a, P) {
  const dx = P.x - a.x, dz = P.z - a.z, d = Math.hypot(dx, dz) || 1;
  const s = a.sp.senses;
  // sight: range scaled by crouch (stealth) + fov check
  const effRange = s.sightRangeM * (S.player.gait === "crouch" ? 0.45 : 1) * (P.role && P.role.mod.seen ? P.role.mod.seen : 1);
  let seen = false;
  if (d < effRange) {
    const fwdx = Math.sin(a.yaw), fwdz = Math.cos(a.yaw);
    const dot = (dx / d) * fwdx + (dz / d) * fwdz;
    if (dot > Math.cos(s.sightFovDeg * 0.5 * DEG) && losClear(a.x, a.z, P.x, P.z)) seen = true;   // solid cover breaks the sightline
  }
  // hearing: radius scales with player noise
  const heard = d < s.hearingRangeM * (0.35 + P.noise * 0.9);
  if (seen || heard) { a.bb.lastSeenX = P.x; a.bb.lastSeenZ = P.z; a.bb.hasTarget = true; }
  return { seen, heard, d };
}

// utility scorer (~4 Hz) — picks a state; emergent, not scripted
/* ===================================================== defense toolset === *
 * Deterrence, not action-hero firepower: a flare scares predators off, a thrown
 * decoy lures them away, melee is a risky last resort. The beacon is a SAFE ZONE. */
const SAFE_R = 18;                                  // beacon safe-zone radius (m)
function playerSafe() { const b = S.extraction.beacon; return dist2(S.player.x, S.player.z, b.x, b.z) < SAFE_R * SAFE_R; }
/* ---- world FX so tool use + dino reactions are actually VISIBLE in the scene ---- */
const fxList = [];
function addFx(obj, life, update) { scene.add(obj); fxList.push({ obj, life, t: 0, update }); }
function updateFx(dt) {
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i]; f.t += dt; if (f.update) f.update(f.t);
    if (f.t >= f.life) { scene.remove(f.obj); fxList.splice(i, 1); }
  }
}
function clearFx() { for (const f of fxList) scene.remove(f.obj); fxList.length = 0; if (decoyMesh) decoyMesh.visible = false; }
function fxRing(x, z, color, maxR, life) {            // expanding ground shockwave
  const m = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.7, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, groundH(x, z) + 0.1, z);
  addFx(m, life, t => { const k = t / life, r = 1 + k * maxR; m.scale.set(r, r, r); m.material.opacity = 0.85 * (1 - k); });
}
function fxFlare(x, z) {                              // bright signal flare: rising glow + light + shockwave
  const y = groundH(x, z), grp = new THREE.Group(); grp.position.set(x, y, z);
  const light = new THREE.PointLight(0xff7e2a, 10, 48, 2);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffdd9a, transparent: true }));
  grp.add(light, ball);
  addFx(grp, 5, t => { const k = t / 5, h = 1.2 + k * 6; light.position.y = ball.position.y = h; light.intensity = 10 * (1 - k); ball.material.opacity = 1 - k * 0.7; ball.scale.setScalar(1 - k * 0.3); });
  fxRing(x, z, 0xff7e2a, 24, 1.0);
}
function fxMelee(x, z, yaw) {                         // quick slash arc in front of the player
  const fx = x + Math.sin(yaw) * 1.8, fz = z + Math.cos(yaw) * 1.8;
  const m = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.13, 6, 18, Math.PI), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }));
  m.position.set(fx, groundH(fx, fz) + 1.1, fz); m.rotation.set(Math.PI / 2, 0, -yaw);
  addFx(m, 0.26, t => { const k = t / 0.26; m.material.opacity = 0.95 * (1 - k); m.scale.setScalar(1 + k * 0.7); });
}
function fxReact(a, glyph, color) {                  // floating reaction marker over a dino (e.g. "!" recoil)
  const cv = document.createElement("canvas"); cv.width = cv.height = 64;
  const ctx = cv.getContext("2d"); ctx.font = "bold 50px ui-monospace,monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = color || "#ffce4a"; ctx.shadowColor = "#000"; ctx.shadowBlur = 6; ctx.fillText(glyph, 32, 34);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(1.6, 1.6, 1.6);
  const h = (a.sp.greybox.standH || 3) + 1.3;
  addFx(spr, 1.3, t => { const k = t / 1.3; spr.position.set(a.x, groundH(a.x, a.z) + h + k * 0.9, a.z); spr.material.opacity = 1 - k * k; });
}
let decoyMesh = null;
function showDecoy(x, z) {                            // persistent lure marker while the decoy is active
  if (!decoyMesh) {
    decoyMesh = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.1, 32), new THREE.MeshBasicMaterial({ color: 0x8fb8c4, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.09;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.2, 8), new THREE.MeshBasicMaterial({ color: 0x8fb8c4, transparent: true, opacity: 0.45 })); beam.position.y = 1.6;
    const l = new THREE.PointLight(0x8fb8c4, 3.2, 24); l.position.y = 1.6;
    decoyMesh.add(ring, beam, l); decoyMesh.userData.ring = ring; scene.add(decoyMesh);
  }
  decoyMesh.position.set(x, groundH(x, z), z); decoyMesh.visible = true;
}
const decoy = { x: 0, z: 0, t: 0 };                 // active thrown decoy (lures predators)
const TOOLS = [
  { id: "flare", name: "FLARE", icon: "✸", charges: 3, max: 3, cd: 0, cdMax: 7 },
  { id: "decoy", name: "DECOY", icon: "◓", charges: 6, max: 6, cd: 0, cdMax: 3 },
  { id: "melee", name: "MELEE", icon: "✕", charges: Infinity, max: Infinity, cd: 0, cdMax: 1.1 },
  { id: "tranq", name: "TRANQ", icon: "➶", charges: 8, max: 8, cd: 0, cdMax: 1.1 },   // dart gun — sedate a dino
  { id: "trap", name: "TRAP", icon: "⊓", charges: 3, max: 3, cd: 0, cdMax: 1.0 },     // snare trap — immobilise
  { id: "sample", name: "SAMPLE", icon: "⚗", charges: Infinity, max: Infinity, cd: 0, cdMax: 1.4 },  // syringe — draw DNA
];
let selTool = 0;
function selectTool(i) { if (i >= 0 && i < TOOLS.length) selTool = i; }
/* ---- field-science kit (DNA collection): tranq → sedate, trap → snare, syringe → draw blood ---- */
const traps = [];                 // { mesh, x, z, r, armed }
let dnaSamples = 0;               // collected blood/DNA samples this run
const dnaSpecies = new Set();     // species sampled this run
const identified = new Set();     // species identified through the binoculars
let binoc = false;                // binoculars (zoom + species ID) toggle
const DEFAULT_FOV = 64, BINOC_FOV = 23;
function sedThreshold(sp) {        // darts to drop a dino — bigger / predators resist more
  return clamp(1 + (sp.size.massKg || 200) / 650 + (sp.diet === "carnivore" ? 1.5 : 0), 2, 9);
}
function aimTarget(maxD, needDown) {   // dino nearest the screen-centre within range + front cone (tranq/sample aiming)
  const P = S.player; let best = null, bestScore = 0.55;
  for (const a of dinos) {
    if (!a.alive) continue;
    if (needDown && !(a.sedated || a.trapped)) continue;
    const rx = a.x - P.x, rz = a.z - P.z, d = Math.hypot(rx, rz) || 1;
    if (d > maxD) continue;
    const fwd = (rx * Math.sin(cam.yaw) + rz * Math.cos(cam.yaw)) / d;   // alignment with look direction
    if (fwd > bestScore) { bestScore = fwd; best = a; }
  }
  return best;
}
function scareDinos(x, z, r, secs) {
  let n = 0;
  for (const a of dinos) {
    if (!a.alive || a.sp.diet !== "carnivore") continue;
    if (dist2(a.x, a.z, x, z) < r * r) {
      const was = a.bb.scared;
      a.bb.scared = Math.max(a.bb.scared, secs); a.bb.lastSeenX = x; a.bb.lastSeenZ = z; a.state = "Retreat";
      if (was < 0.2 && n < 6) { fxReact(a, "!", "#ffce4a"); n++; }   // visible recoil over newly-spooked predators
    }
  }
  return n;
}
function useTool() {
  if (S.phase !== "playing" || !S.player.alive) return;
  const t = TOOLS[selTool], P = S.player; if (t.cd > 0 || t.charges <= 0) return;
  if (t.id === "flare") { t.charges--; t.cd = t.cdMax; flash(); fxFlare(P.x, P.z); Audio.beacon(true); P.noise = Math.max(P.noise, 0.8); const n = scareDinos(P.x, P.z, 24, 5); toast(n ? `FLARE · ${n} predator${n > 1 ? "s" : ""} recoil` : "FLARE · no predators near"); }
  else if (t.id === "decoy") { t.charges--; t.cd = t.cdMax; decoy.x = P.x + Math.sin(P.yaw) * 15; decoy.z = P.z + Math.cos(P.yaw) * 15; decoy.t = 6; showDecoy(decoy.x, decoy.z); Audio.step("run"); toast("DECOY thrown · draws them off"); }
  else if (t.id === "melee") {
    t.cd = t.cdMax; let hit = null, hd = 99;
    const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
    for (const a of dinos) { if (!a.alive || a.sp.diet !== "carnivore") continue; const rx = a.x - P.x, rz = a.z - P.z, dd = Math.hypot(rx, rz) || 1; if (dd < 3.6 && (rx * fx + rz * fz) / dd > 0.25 && dd < hd) { hd = dd; hit = a; } }
    fxMelee(P.x, P.z, P.yaw); camShake = Math.min(0.5, camShake + 0.28);
    if (hit) {
      // lethal last resort: heavier on small/wounded predators (a desperate, decisive blow)
      const light = (hit.sp.combat.health || 100) < 140;
      hit.hp -= light ? 40 : 22;
      const kx = (hit.x - P.x), kz = (hit.z - P.z), kl = Math.hypot(kx, kz) || 1, kb = light ? 2.6 : 1.4;   // knockback
      hit.x += kx / kl * kb; hit.z += kz / kl * kb;
      hit.bb.scared = Math.max(hit.bb.scared, 2.2); hit.bb.lastSeenX = P.x; hit.bb.lastSeenZ = P.z; hit.state = "Retreat"; hit.anim = 0.3;
      Audio.hit(); flash(); fxReact(hit, hit.hp <= 0 ? "✕" : "!", "#e8907a");
      if (hit.hp <= 0) { killDino(hit); toast("DOWNED · " + hit.sp.displayName); } else toast("STRUCK · " + hit.sp.displayName + (light ? " — it reels" : " — it shrugs it off"));
    }
    else toast("MELEE · nothing in reach");
  }
  else if (t.id === "tranq") {                                  // fire a sedative dart at whatever you're aiming at
    t.charges--; t.cd = t.cdMax; Audio.hit();
    const a = aimTarget(72, false);
    const oy = groundH(P.x, P.z) + 1.3;
    const tx = a ? a.x : P.x + Math.sin(cam.yaw) * 45, tz = a ? a.z : P.z + Math.cos(cam.yaw) * 45;
    const ty = a ? groundH(a.x, a.z) + (a.sp.greybox.standH || 2) * 0.6 : oy;
    fxDart(P.x, oy, P.z, tx, ty, tz);                           // visible dart projectile + trail (always fires)
    if (!a) { toast("TRANQ · missed — line up the target in the centre"); return; }
    if (a.sedated) { toast(a.sp.displayName + " · already sedated"); return; }
    a.sedation = (a.sedation || 0) + 1;
    const need = sedThreshold(a.sp);
    if (a.sedation >= need) { a.sedated = true; a.downT = 24; a.state = "Down"; a.bb.scared = 0; fxReact(a, "Zz", "#8fb8c4"); toast(a.sp.displayName + " SEDATED — draw a sample"); }
    else { fxReact(a, "✦", "#8fb8c4"); a.bb.scared = Math.max(a.bb.scared, 1.0); toast(`TRANQ · ${a.sp.displayName} ${Math.round(a.sedation / need * 100)}%`); }
  }
  else if (t.id === "trap") {                                   // drop a snare trap a few metres ahead
    t.charges--; t.cd = t.cdMax;
    const tx = P.x + Math.sin(P.yaw) * 4, tz = P.z + Math.cos(P.yaw) * 4;
    traps.push(buildTrap(tx, tz)); Audio.step("run"); toast("TRAP set — lure a dino onto it");
  }
  else if (t.id === "sample") {                                 // draw blood/DNA from a sedated or trapped dino
    const a = aimTarget(4.2, true);
    if (!a) { toast("SAMPLE · get close to a SEDATED or TRAPPED dino"); return; }
    if (a.drawn) { toast(a.sp.displayName + " · already sampled"); return; }
    t.cd = t.cdMax; a.drawn = true; dnaSamples++; dnaSpecies.add(a.sp.id); identified.add(a.sp.id);
    Audio.beacon(false); fxReact(a, "✚", "#9fe08a"); flash();
    if (selectedMission.id === "dna" && dnaSamples >= DNA_GOAL && dnaSamples - 1 < DNA_GOAL) { Audio.win(); toast(`DNA SECURED (${DNA_GOAL}/${DNA_GOAL}) — reach the beacon & extract`); }
    else toast(`DNA SAMPLE · ${a.sp.displayName}  (${dnaSamples}${selectedMission.id === "dna" ? "/" + DNA_GOAL : ""})`);
  }
}
function fxDart(x1, y1, z1, x2, y2, z2) {   // visible tranq dart: muzzle flash → flying dart → impact spark
  const from = new THREE.Vector3(x1, y1, z1), to = new THREE.Vector3(x2, y2, z2), dir = to.clone().sub(from).normalize();
  fxTracer(x1, y1, z1, x2, y2, z2);                                  // faint trail
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff0c0 }));
  flash.position.copy(from); addFx(flash, 0.12, tt => { flash.scale.setScalar(1 + tt * 6); flash.material.opacity = 1 - tt / 0.12; flash.material.transparent = true; });
  const dart = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), new THREE.MeshBasicMaterial({ color: 0xbfe2ea })); dart.add(body);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.18, 6), new THREE.MeshBasicMaterial({ color: 0xe0772f })); tip.position.y = 0.34; dart.add(tip);
  dart.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); dart.position.copy(from);
  const dur = Math.min(0.35, from.distanceTo(to) / 90);
  addFx(dart, dur + 0.26, tt => { dart.position.lerpVectors(from, to, Math.min(1, tt / dur)); dart.visible = tt < dur; });
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), new THREE.MeshBasicMaterial({ color: 0x8fb8c4, transparent: true, opacity: 0 }));   // impact spark at arrival
  spark.position.copy(to); addFx(spark, dur + 0.25, tt => { if (tt < dur) return; const k = (tt - dur) / 0.25; spark.material.opacity = 0.8 * (1 - k); spark.scale.setScalar(1 + k * 3); });
}
function fxTracer(x1, y1, z1, x2, y2, z2) {   // brief dart/round tracer line
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x1, y1, z1), new THREE.Vector3(x2, y2, z2)]);
  const m = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xbfe2ea, transparent: true, opacity: 0.9 }));
  addFx(m, 0.18, tt => { m.material.opacity = 0.9 * (1 - tt / 0.18); });
}
function buildTrap(x, z) {
  const g = new THREE.Group(); g.position.set(x, groundH(x, z) + 0.05, z);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.12, 6, 18), new THREE.MeshStandardMaterial({ color: 0x6b6f4a, roughness: 1, metalness: 0.3 }));
  ring.rotation.x = -Math.PI / 2; g.add(ring);
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.4, 4), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 })); tooth.position.set(Math.cos(a) * 1.0, 0.2, Math.sin(a) * 1.0); g.add(tooth); }
  scene.add(g);
  return { mesh: g, x, z, r: 1.6, armed: true };
}
function updateTools(dt) {
  if (decoy.t > 0) { decoy.t = Math.max(0, decoy.t - dt); if (decoyMesh) { const s = 1 + Math.sin(S.t * 6) * 0.12; decoyMesh.userData.ring.scale.set(s, s, s); decoyMesh.children.forEach(c => { if (c.material) c.material.opacity = (c.isMesh ? (c.geometry.type === "RingGeometry" ? 0.85 : 0.45) : 1) * Math.min(1, decoy.t); }); } }
  else if (decoyMesh) decoyMesh.visible = false;
  for (const t of TOOLS) if (t.cd > 0) t.cd = Math.max(0, t.cd - dt);
}
function updateField(dt) {   // tranq sedation + snare traps lifecycle (DNA collection kit)
  // armed traps snap shut on the first dino to step in
  for (const tr of traps) {
    if (!tr.armed) continue;
    for (const a of dinos) {
      if (!a.alive || a.trapped || a.sedated) continue;
      if (dist2(a.x, a.z, tr.x, tr.z) < tr.r * tr.r) { a.trapped = true; a.trappedT = 18; a.state = "Down"; a.bb.scared = 0; tr.armed = false; Audio.hit(); fxReact(a, "✗", "#c9a23a"); break; }
    }
  }
  for (const a of dinos) {
    if (!a.alive) continue;
    if (a.sedated) { a.downT -= dt; if (a.downT <= 0) { a.sedated = false; a.sedation = 0; } }
    else if (a.sedation > 0) a.sedation = Math.max(0, a.sedation - dt * 0.12);   // partial dose wears off
    if (a.trapped) { a.trappedT -= dt; if (a.trappedT <= 0) a.trapped = false; }
  }
}
const isDown = a => a.sedated || a.trapped;   // immobilised (free to sample); still free-roam for the player

function domScore(sp) { return sp.combat.health + (isApex(sp) ? 400 : 0); }   // who wins a stand-off
function strongerRivalNear(a) {   // a much stronger predator nearby → the weaker one yields its ground
  let best = null, bd = 18 * 18; const my = domScore(a.sp);
  for (const d of dinos) { if (!d.alive || d.sp.diet !== "carnivore" || d === a) continue; if (domScore(d.sp) < my * 1.35) continue; const dd = dist2(a.x, a.z, d.x, d.z); if (dd < bd) { bd = dd; best = d; } }
  return best;
}
function decide(a, P) {
  const sp = a.sp, bb = a.bb;
  if (isDown(a)) { a.state = "Down"; return; }   // sedated / trapped → no AI
  // feeding at a kill / resting — but a close player snaps the predator out of it (stays a threat)
  if (a.feedT > 0 && dist2(P.x, P.z, a.x, a.z) > 18 * 18) { a.state = "Feed"; return; }
  if (a.restT > 0 && dist2(P.x, P.z, a.x, a.z) > 30 * 30) { a.state = "Rest"; return; }
  if (a.feedT > 0 || a.restT > 0) { a.feedT = 0; a.restT = 0; }
  const per = (a.lod === "full") ? perceive(a, P) : { seen: false, heard: false, d: 999 };
  const aggr = sp.behavior.aggression + (S.extraction.called ? (BIOME.spawnDirector.escalation.trexAggroBonus * (isApex(sp) ? 1 : 0.4)) : 0);

  if (isPrey(sp)) {
    // herd prey: flee from nearest predator (and propagate = stampede)
    const pred = nearestPredatorTo(a.x, a.z, 1);
    const predD = pred ? Math.hypot(pred.x - a.x, pred.z - a.z) : 999;
    if (predD < sp.behavior.fleeFromPredatorM || bb.scared > 0) { a.state = "Flee"; bb.fleeFromX = pred ? pred.x : a.x; bb.fleeFromZ = pred ? pred.z : a.z; }
    else a.state = "Graze";
    return;
  }
  // carnivores
  if (a.hp < sp.combat.health * sp.behavior.fleeHealthPct || bb.scared > 0) { a.state = "Retreat"; return; }   // wounded or flared/struck → flee
  if (decoy.t > 0 && dist2(a.x, a.z, decoy.x, decoy.z) < (sp.senses.sightRangeM * 1.3) ** 2) {                  // a thrown decoy pulls them off you
    a.state = "Investigate"; bb.lastSeenX = decoy.x; bb.lastSeenZ = decoy.z; bb.hasTarget = true; bb.preyHunt = null; return;
  }
  if (!playerSafe() && S.t >= GRACE_S) {   // beacon = SAFE ZONE: predators won't engage the player inside it
    if (per.seen && per.d < sp.combat.attackRangeM + 0.5) { a.state = "Attack"; return; }
    if ((per.seen || (bb.hasTarget && rng() < aggr)) && per.d < sp.senses.sightRangeM * 1.4) { a.state = (usesPackTactics(sp) ? "Chase" : (per.seen ? "Chase" : "Stalk")); return; }
    if (bb.hasTarget && (per.heard || rng() < aggr * 0.6)) { a.state = "Investigate"; return; }
  }
  if (playerSafe()) {
    // hysteresis: don't blank the hunt the instant the player crosses the safe line. A predator that was
    // chasing paces the boundary toward where it last saw them for a few seconds, then loses interest —
    // no arcade on/off "sanctuary wall". (decide() runs ~4 Hz, so 6 / 0.25 ≈ 6 s of prowling.)
    if (bb.hasTarget) {
      bb.safeLingerT = (bb.safeLingerT == null ? 6 : bb.safeLingerT) - 0.25;
      if (bb.safeLingerT > 0) { a.state = "Investigate"; return; }
      bb.hasTarget = false; bb.safeLingerT = null;
    }
  } else if (bb.safeLingerT != null) bb.safeLingerT = null;   // left the zone → re-arm the linger timer
  // predator hierarchy: yield ground to a much stronger predator (emergent, not scripted)
  const rival = strongerRivalNear(a);
  if (rival) { a.state = "Retreat"; bb.lastSeenX = rival.x; bb.lastSeenZ = rival.z; bb.preyHunt = null; return; }
  // no player interest → hunt herd prey (predator vs prey), rest, or patrol the home territory
  const prey = nearestPreyTo(a.x, a.z);
  if (prey && Math.hypot(prey.x - a.x, prey.z - a.z) < sp.senses.sightRangeM) { a.state = "Chase"; bb.lastSeenX = prey.x; bb.lastSeenZ = prey.z; bb.preyHunt = prey; }
  else if (rng() < 0.05 && dist2(P.x, P.z, a.x, a.z) > 60 * 60) { a.state = "Rest"; a.restT = rand(3, 7); bb.preyHunt = null; }   // calm & far → lie up
  else { a.state = "Patrol"; bb.preyHunt = null; }
}

function nearestPredatorTo(x, z, _) {
  let best = null, bd = 1e9;
  for (const d of dinos) { if (d.sp.diet !== "carnivore" || !d.alive) continue; const dd = dist2(x, z, d.x, d.z); if (dd < bd) { bd = dd; best = d; } }
  return best;
}
function nearestPreyTo(x, z) {
  let best = null, bd = 1e9;
  for (const d of dinos) { if (!isPrey(d.sp) || !d.alive) continue; const dd = dist2(x, z, d.x, d.z); if (dd < bd) { bd = dd; best = d; } }
  return best;
}
function herdCenter() {
  let n = 0, sx = 0, sz = 0;
  for (const d of dinos) if (isPrey(d.sp) && d.alive) { sx += d.x; sz += d.z; n++; }
  return n ? { x: sx / n, z: sz / n, n } : null;
}

// pack blackboard: assign lead/flank/harry roles around the target each frame
function updatePackRoles() {
  const pack = dinos.filter(d => usesPackTactics(d.sp) && d.alive);
  if (!pack.length) return;
  const P = S.player;
  // lead = closest; flanks alternate sides; rest harry from behind. The species' declared packRoles
  // (species.json) set how many flankers the formation uses (deinonychus = 2-flank pincer).
  const roles = pack[0].sp.behavior.packRoles, maxFlank = roles ? Math.max(1, roles.filter(r => /flank/i.test(r)).length) : 2;
  pack.sort((a, b) => dist2(a.x, a.z, P.x, P.z) - dist2(b.x, b.z, P.x, P.z));
  pack.forEach((d, i) => {
    if (i === 0) d.bb.role = "lead";
    else if (i <= maxFlank) { d.bb.role = "flank"; d.bb.flankSide = (i % 2 === 1) ? 1 : -1; }
    else d.bb.role = "harry";
  });
}

// execute the chosen state via steering → vx,vz
function steer(a, dt, P) {
  const sp = a.sp, bb = a.bb;
  if (isDown(a)) {   // sedated / trapped → frozen in place; sedated dinos slump onto their side
    a.vx = a.vz = 0; a.mesh.position.set(a.x, groundH(a.x, a.z), a.z); a.mesh.rotation.y = a.yaw;
    const body = a.mesh.children[0];
    if (body) body.rotation.z = lerp(body.rotation.z, a.sedated ? 1.35 : 0, Math.min(1, dt * 3));
    if (a.mesh.userData.jaw) a.mesh.userData.jaw.rotation.x = 0;
    return;
  }
  if (bb.scared > 0) bb.scared = Math.max(0, bb.scared - dt);   // flare/melee fear wears off (Flee/Graze re-set it as needed)
  if (a.feedT > 0) a.feedT -= dt; if (a.restT > 0) a.restT -= dt;   // ecosystem timers (feeding/resting)
  let tx = a.x, tz = a.z, run = false, sepW = 1;
  switch (a.state) {
    case "Graze": {
      const social = sp.behavior.social, herds = social === "herd" || social === "flock";   // solitary species don't clump
      const hc = herds ? herdCenter() : null;
      if (hc && Math.hypot(hc.x - a.x, hc.z - a.z) > 14) { tx = hc.x; tz = hc.z; }   // cohesion
      else { const md = S.t * 0.02 + (hc ? 0 : a.x);   // slow herd migration drift across the valley + amble
        tx = a.x + Math.sin(md) * 0.8 + Math.sin(a.yaw + Math.sin(S.t * 0.3 + a.x) * 0.6) * 0.4; tz = a.z + Math.cos(md) * 0.8 + Math.cos(a.yaw + 0.3) * 0.4; }
      bb.scared = Math.max(0, bb.scared - dt);
      break;
    }
    case "Feed": { tx = a.x; tz = a.z; break; }   // stationary at the carcass
    case "Rest": { tx = a.x; tz = a.z; break; }   // lying up
    case "Flee": {
      run = true; bb.scared = 0.8;
      tx = a.x + (a.x - bb.fleeFromX); tz = a.z + (a.z - bb.fleeFromZ);
      // stampede propagation: scare nearby herdmates
      for (const o of dinos) if (isPrey(o.sp) && o.alive && o !== a && dist2(a.x, a.z, o.x, o.z) < 220) o.bb.scared = Math.max(o.bb.scared, 0.6);
      break;
    }
    case "Patrol": {   // hold a home territory: wander within it, but turn back if you've strayed too far
      const terr = sp.behavior.territoryRadiusM, hx = bb.homeX != null ? bb.homeX : a.x, hz = bb.homeZ != null ? bb.homeZ : a.z;
      if (Math.hypot(a.x - hx, a.z - hz) > terr * 1.8) { tx = hx; tz = hz; }
      else { tx = hx + Math.sin(S.t * 0.2 + hx) * terr * 0.5; tz = hz + Math.cos(S.t * 0.17 + hz) * terr * 0.5; }
      break;
    }
    case "Investigate": { tx = bb.lastSeenX; tz = bb.lastSeenZ; run = false; break; }
    case "Stalk": { const dx = bb.lastSeenX - a.x, dz = bb.lastSeenZ - a.z, d = Math.hypot(dx, dz) || 1; tx = a.x + dx / d; tz = a.z + dz / d; break; }
    case "Chase": {
      run = true;
      let gx = bb.preyHunt ? bb.preyHunt.x : (bb.hasTarget ? bb.lastSeenX : P.x);
      let gz = bb.preyHunt ? bb.preyHunt.z : (bb.hasTarget ? bb.lastSeenZ : P.z);
      if (!bb.preyHunt) { gx = P.x; gz = P.z; }
      if (usesPackTactics(sp) && !bb.preyHunt) {  // pack offset → flanking
        const toA = Math.atan2(a.x - P.x, a.z - P.z);
        if (bb.role === "flank") { const ang = toA + (bb.flankSide || 1) * 0.9; gx = P.x + Math.sin(ang) * 7; gz = P.z + Math.cos(ang) * 7; }
        else if (bb.role === "harry") { gx = P.x - Math.sin(P.yaw) * 8; gz = P.z - Math.cos(P.yaw) * 8; }
      }
      tx = gx; tz = gz;
      break;
    }
    case "Attack": {
      run = true; tx = bb.hasTarget ? bb.lastSeenX : P.x; tz = bb.hasTarget ? bb.lastSeenZ : P.z;
      a.cd -= dt;
      const d = Math.hypot(P.x - a.x, P.z - a.z);
      if (d < sp.combat.attackRangeM && a.cd <= 0 && S.player.alive) { a.cd = sp.combat.attackCooldownS; a.anim = 0.4; damagePlayer(sp.combat.damage, sp.displayName, a.x, a.z); }
      // also can kill prey
      if (bb.preyHunt && Math.hypot(bb.preyHunt.x - a.x, bb.preyHunt.z - a.z) < sp.combat.attackRangeM + 1 && a.cd <= 0) { a.cd = 1; bb.preyHunt.hp -= 30; if (bb.preyHunt.hp <= 0) { a.feedT = rand(4, 7); a.state = "Feed"; bb.preyHunt = null; } }   // kill → feed at the carcass
      break;
    }
    case "Retreat": { run = true; tx = a.x + (a.x - (bb.lastSeenX)); tz = a.z + (a.z - (bb.lastSeenZ)); break; }
  }
  // seek
  let dx = tx - a.x, dz = tz - a.z; const dd = Math.hypot(dx, dz) || 1; dx /= dd; dz /= dd;
  // separation from other dinos (cheap, bounded)
  let sx = 0, sz = 0;
  for (const o of dinos) { if (o === a || !o.alive) continue; const od = dist2(a.x, a.z, o.x, o.z); if (od < 9) { const ox = a.x - o.x, oz = a.z - o.z, l = Math.sqrt(od) || 1; sx += ox / l; sz += oz / l; } }
  dx += sx * 0.5; dz += sz * 0.5;
  const nl = Math.hypot(dx, dz) || 1; dx /= nl; dz /= nl;
  const spd = (run ? sp.move.run : sp.move.walk) * (a.lod === "full" ? 1 : 0.4);
  a.vx = lerp(a.vx, dx * spd, 0.12); a.vz = lerp(a.vz, dz * spd, 0.12);
  a.x += a.vx * dt; a.z += a.vz * dt;
  const lim = BIOME.map.size / 2 - 3; a.x = clamp(a.x, -lim, lim); a.z = clamp(a.z, -lim, lim);
  // P-06: turn speed scales with the species' declared agility (move.turnRate, deg/s; 180 = neutral),
  // so a Velociraptor (340) pivots far quicker than a T-Rex (110). Clamped so it stays stable.
  if (Math.hypot(a.vx, a.vz) > 0.2) a.yaw = lerp2angle(a.yaw, Math.atan2(a.vx, a.vz), 0.25 * Math.min(2.2, ((a.sp.move && a.sp.move.turnRate) || 180) / 180));
  animateDino(a, dt);
}
// Drive a dino's mesh placement + procedural animation from its current x/z/yaw/vx/vz/state. Shared by
// the AI path (steer) and the co-op CLIENT puppet path (host-authoritative transforms, no local AI).
function animateDino(a, dt) {
  const sp = a.sp, P = S.player;
  // place + animate (fliers cruise/dive, aquatic species float in the channel)
  a.mesh.position.set(a.x, dinoY(a), a.z);
  a.mesh.rotation.y = a.yaw;
  a.mesh.rotation.x = 0;   // (terrain tilt removed — it lifted long dinos' far feet off the ground & foreshortened them)
  a.anim = Math.max(0, a.anim - dt);
  if (a.roar > 0) a.roar = Math.max(0, a.roar - dt);
  const vmag = Math.hypot(a.vx, a.vz);
  const run = a.state === "Chase" || a.state === "Attack" || a.state === "Flee" || a.state === "Retreat";
  const moveAmt = Math.min(1, vmag / sp.move.run);
  const body = a.mesh.children[0];
  // ---- base locomotion ----
  if (a.mixer) {   // rigged model (T-Rex): baked walk clip, cadence scaled by speed (frozen when idle)
    a.walkAction.timeScale = moveAmt < 0.04 ? 0 : (0.5 + 1.7 * moveAmt);
    a.mixer.update(dt);
  } else {
    const legs = a.mesh.userData.legs;
    if (legs) { const sw = Math.sin(S.t * (run ? 16 : 8) + a.x) * 0.5 * moveAmt; legs[0].rotation.x = sw; legs[1].rotation.x = -sw; }
    else if (body) {   // static .glb: distance-synced body gait (stride bob, footfall pitch, roll, waddle)
      const legLen = sp.greybox.standH || 2;
      a.gaitPhase += vmag * dt * (2.0 / Math.max(1, legLen));        // 2*PI ~ one full L+R stride cycle
      const ph = a.gaitPhase, amp = Math.min(1.25, vmag / (sp.move.walk || 2));
      a.mesh.position.y += Math.abs(Math.sin(ph)) * legLen * 0.05 * amp;
      body.rotation.x = (Math.sin(ph * 2) * 0.05 + Math.sin(ph) * 0.035) * amp;
      body.rotation.z = Math.sin(ph) * 0.11 * amp;
      body.rotation.y = (sp.modelYaw || 0) + Math.cos(ph) * 0.06 * amp;
    }
  }
  // ---- roar: apex / heavy predators bellow periodically while engaged (with a camera-felt audio cue) ----
  if ((isApex(sp) || sp.combat.health >= 300) && a.lod === "full" && (a.state === "Chase" || a.state === "Attack")) {
    a.roarCd -= dt;
    if (a.roarCd <= 0) {
      a.roar = 1.1; a.roarCd = rand(6, 11);
      const dxp = a.x - P.x, dzp = a.z - P.z, dd = Math.hypot(dxp, dzp) || 1;
      if (dd < 130) Audio.roarAt(dd, (dxp / dd) * Math.cos(cam.yaw) - (dzp / dd) * Math.sin(cam.yaw));   // attenuated + panned by bearing
    }
  }
  // heavy-predator footfalls thud through the ground when one is close (positional)
  if (sp.combat.health >= 260 && a.lod === "full" && vmag > 0.5) {
    a.footPhase = (a.footPhase || 0) + vmag * dt;
    if (a.footPhase > 1.5) { a.footPhase = 0; const dxp = a.x - P.x, dzp = a.z - P.z, dd = Math.hypot(dxp, dzp) || 1; if (dd < 45) Audio.thudAt(dd, (dxp / dd) * Math.cos(cam.yaw) - (dzp / dd) * Math.sin(cam.yaw)); }
  }
  // ---- procedural action overlays (additive on top of the gait) ----
  if (body) {
    if (a.anim > 0) {                                   // ATTACK: bite lunge — snap forward + head down
      const snap = Math.sin((1 - a.anim / 0.4) * Math.PI);
      if (!a.mixer) body.rotation.x += snap * 0.45;
      a.mesh.position.x += Math.sin(a.yaw) * snap * 0.5;
      a.mesh.position.z += Math.cos(a.yaw) * snap * 0.5;
    }
    if (a.roar > 0) {                                   // ROAR: rear up + chest swell
      const rp = Math.sin((1 - a.roar / 1.1) * Math.PI);
      if (!a.mixer) body.rotation.x -= rp * 0.3;
      body.scale.setScalar(1 + rp * 0.06);
    } else if (body.scale.x !== 1) body.scale.setScalar(1);
    if (!a.mixer && a.state === "Flee") body.rotation.x += moveAmt * 0.12;   // FLEE: panic forward lean
  }
  if (a.mesh.userData.jaw) a.mesh.userData.jaw.rotation.x = a.anim > 0 ? 0.6 : 0;
}

function updateDinos(dt, P) {
  packBB.frame++;
  if (packBB.frame % 6 === 0) updatePackRoles();
  for (const a of dinos) {
    if (!a.alive) continue;
    a.lod = dist2(a.x, a.z, P.x, P.z) < BIOME.spawnDirector.activeRadiusM ** 2 ? "full" : "background";
    a.decideIn -= dt;
    if (a.decideIn <= 0) {
      a.decideIn = 0.25;
      if (a.lod === "full") { decide(a, P); a.bgSinceT = 0; }
      else {
        // off-LOD: don't blank an active hunt every frame — keep target memory for a short grace so a
        // predator the player out-ran resumes the chase on re-entry, then settle to base behaviour.
        a.bgSinceT = (a.bgSinceT || 0) + 0.25;
        const hunting = a.bb.hasTarget && (a.state === "Chase" || a.state === "Attack" || a.state === "Stalk" || a.state === "Investigate");
        if (!hunting || a.bgSinceT > 2) a.state = baseStateFor(a.sp);
      }
    }
    steer(a, dt, P);
    // dinos obey the same solid world — push out of props (full LOD only; big bodies use bigger radii
    // so they naturally can't squeeze through tight gaps). Downed/sedated dinos are frozen, so skip.
    if (a.lod === "full" && !isDown(a) && resolveColliders(a, dinoBodyR(a))) { a.mesh.position.x = a.x; a.mesh.position.z = a.z; }
    // map intel: a contact is "sighted" while within detection range; stamp its last-seen track
    // so the tactical map can show a decaying ghost once it slips away (binoculars also sight it).
    const seenNow = dist2(a.x, a.z, P.x, P.z) < MAP_SIGHT_R * MAP_SIGHT_R;
    a.mapSeen = seenNow;
    if (seenNow) { a.mapX = a.x; a.mapZ = a.z; a.mapYaw = a.yaw; a.mapT = S.t; }
    if (a.hp <= 0) killDino(a);
  }
}
function killDino(a) { a.alive = false; scene.remove(a.mesh); }
function dinoBodyR(a) {   // collision push-out radius: length-scaled, but never thinner than the actual body width (P-07)
  const byLen = (a.sp.size && a.sp.size.lengthM || 4) * 0.1, gb = a.sp.greybox, byWidth = gb && gb.bodyW ? gb.bodyW * 0.5 : 0;
  return clamp(Math.max(byLen, byWidth), 0.4, 2.0);
}
const isAquatic = sp => sp.archetype === "water";   // semi-/fully-aquatic: floats & swims in the channel
const isFlier = sp => sp.role === "flier";          // wheels overhead, dives to strike
// Per-archetype vertical placement: fliers cruise at altitude (dive when hunting), aquatic species
// float at the surface over deep water, everyone else stands on the terrain.
function dinoY(a) {
  const g = groundH(a.x, a.z);
  if (isFlier(a.sp)) { const tgt = (a.state === "Chase" || a.state === "Attack") ? 2.4 : 9; a.fly = lerp(a.fly == null ? 9 : a.fly, tgt, 0.04); return g + a.fly + Math.sin(S.t * 2 + a.x) * 0.25; }
  if (isAquatic(a.sp) && WATER_Y - g > 1.0) return WATER_Y - 0.4 + Math.sin(S.t * 1.6 + a.z) * 0.08;   // swimming at the surface
  return g;
}

/* ================================================== spawn director ======= */
let spawnTimer = 0;
function updateSpawnDirector(dt, P) {
  if (Net.on && !Net.isHost) return;   // P-10: spawning is host-authoritative — defensive guard against a stale host flag making a client spawn ghosts
  const sd = BIOME.spawnDirector;
  spawnTimer -= dt;
  if (spawnTimer > 0) return;
  spawnTimer = S.extraction.called ? sd.escalation.spawnIntervalS : sd.escalation.spawnIntervalS * 1.4;
  const active = dinos.filter(d => d.alive).length;
  // when the beacon is called (loud), the noise draws the heavy hitters first — order the roster by
  // each species' behavior.noiseDrawWeight so high-weight apexes are prioritised during the hot hold.
  const roster = S.extraction.called
    ? [...sd.roster].sort((x, y) => ((SPECIES[y.species]?.behavior.noiseDrawWeight || 0) - (SPECIES[x.species]?.behavior.noiseDrawWeight || 0)))
    : sd.roster;
  for (const r of roster) {
    let target = r.target;
    if (r.species === "deinonychus" && S.extraction.called) {
      const prog = clamp(S.extraction.hold / S.extraction.holdMax, 0, 1);
      target += Math.round(sd.escalation.deinonychusBonusAtMax * prog);
    }
    const have = dinos.filter(d => d.alive && d.sp.id === r.species).length;
    if (have < target && (r.respawn || have === 0) && active < sd.maxActiveAI) {
      spawnAtEdge(r.species, P);
    }
  }
}
function spawnAtEdge(species, P) {
  if (Net.on && !Net.isHost) return;   // co-op: extract waves are host-authoritative (sync to clients)
  const half = BIOME.map.size / 2 - 6;
  let x, z, tries = 0;
  do { x = rand(-half, half); z = rand(-half, half); tries++; } while (dist2(x, z, P.x, P.z) < 35 * 35 && tries < 12);
  // T-rex prefers spawning toward the player's far side; deino pack clusters
  const a = spawnDino(species, x, z);
  if (species === "deinonychus") { a.bb.homeX = P.x + rand(-30, 30); a.bb.homeZ = P.z + rand(-30, 30); }
  dinos.push(a);
}

/* ================================================== threat + contact ===== */
function updateThreat(dt, P) {
  let near = 0, rexAggro = 0;
  S.contact.active = false; let cd = 1e9, cb = "";
  for (const d of dinos) {
    if (!d.alive || d.sp.diet !== "carnivore") continue;
    const dd = Math.sqrt(dist2(P.x, P.z, d.x, d.z));
    if (dd < 60 && (d.state === "Chase" || d.state === "Attack" || d.state === "Stalk" || d.state === "Investigate")) near++;
    if (isApex(d.sp)) rexAggro = clamp(1 - dd / 120, 0, 1);
    if (dd < cd && (d.state === "Chase" || d.state === "Attack" || d.state === "Stalk")) { cd = dd; cb = d.sp.displayName; S.contact.bearing = bearingTo(P.x, P.z, d.x, d.z); }
  }
  if (cd < 70) { S.contact.active = true; S.contact.dist = cd; S.contact.label = cb; }
  const prog = S.extraction.called ? S.extraction.hold / S.extraction.holdMax : 0;
  const raw = near * 1.6 + rexAggro * 4 + prog * 5 + P.noise * 1.5;
  S.threat = clamp(Math.round(lerp(S.threat, clamp(raw, 0, 10), 0.08)), 0, 10);
  // fear derives from noise + nearby-threat proximity
  const threatProx = clamp(1 - cd / 60, 0, 1);
  P.fear = clamp(P.noise * 0.35 + threatProx * 0.85 + rexAggro * 0.3, 0, 1);
}

/* ================================================== extraction loop ====== */
function tryCall() {
  if (S.phase !== "playing" || S.extraction.called) return;
  const cm = activeCampaign();
  if (cm && MC) { const ph = cm.phases[MC.idx]; if (ph && ph.t !== "extract" && !(ph.t === "interact" && ph.starts === "evac")) { toast("Complete the mission objectives first"); return; } }
  if (selectedMission.id === "dna" && dnaSamples < DNA_GOAL) { toast(`Secure the DNA first · ${dnaSamples}/${DNA_GOAL} samples`); return; }
  if (!S.extraction.inRange) { toast(STR.reachBeaconFirst); return; }
  S.extraction.called = true; S.player.noise = 1; spawnTimer = 0;
  Audio.beacon(true); Audio.roar(); toast(STR.evacIncoming);
  startEvac();   // the chopper flies in and hovers at the beacon for the duration of the hold
}
function updateExtraction(dt) {
  if (!S.extraction.called) return;
  S.extraction.hold += dt;
  if ((S.extraction.hold | 0) !== (S._lastBeep | 0)) { S._lastBeep = S.extraction.hold; if ((S.extraction.hold | 0) % 3 === 0) Audio.beacon(false); }
  if (S.extraction.hold >= S.extraction.holdMax && !S.extraction.won) {
    S.extraction.won = true;
    if (evac) { evac.phase = "boarding"; evac.t = 0; toast("BOARD THE CHOPPER"); }   // walk to the door + climb in
    else endRun(true);
  }
}

/* ============================================ helicopter evac cinematic === *
 * On "call extraction" a real chopper flies in and TOUCHES DOWN beside the
 * beacon (rotors spinning the whole time). You survive the hold next to it,
 * then WALK to the open door and climb aboard; it spools up, lifts off, and
 * the camera rises to an aerial fly-over of the park before the EXTRACTED
 * screen. Phases: incoming → landing → grounded → boarding → climbing → liftoff. */
let evac = null;   // { phase, t, heli:{group,rotor,tailRotor}, hx,hz, lx,lz, groundY, done }

// The helicopter .glb is a SINGLE merged mesh with its main rotor already modelled in, so we leave the
// model PRISTINE (recognisable) and overlay just ONE spinning motion-blur disc at the rotor plane — it
// reads as the turning rotor without adding a second hard set of blades. (The earlier vertex-strip
// mangled the model and is gone.) The fallback chopper has no blades of its own, so it gets hard blades.
let _rotorTex = null;
function rotorBlurTexture() {
  if (_rotorTex) return _rotorTex;
  const SZ = 256, cv = document.createElement("canvas"); cv.width = cv.height = SZ;
  const ctx = cv.getContext("2d"), c = SZ / 2;
  ctx.translate(c, c);
  for (let i = 0; i < 4; i++) { ctx.save(); ctx.rotate(i * Math.PI / 2 + 0.2); ctx.fillStyle = "rgba(22,24,18,0.22)"; ctx.beginPath(); ctx.moveTo(0, -3); ctx.lineTo(c - 8, -1); ctx.lineTo(c - 8, 1); ctx.lineTo(0, 3); ctx.closePath(); ctx.fill(); ctx.restore(); }
  const grd = ctx.createRadialGradient(0, 0, 4, 0, 0, c);
  grd.addColorStop(0, "rgba(30,32,26,0.5)"); grd.addColorStop(0.5, "rgba(25,27,22,0.1)"); grd.addColorStop(1, "rgba(20,22,18,0)");
  ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(0, 0, c, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(15,16,12,0.9)"; ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; _rotorTex = t; return t;
}

// Shared cockpit instrument cluster — an angled dark console with lit dial gauges, a glowing data
// screen and a row of toggle switches, so vehicle interiors read as real operational equipment.
// Gauge face points toward local -X (toward a crew member looking forward over the console).
function buildInstrumentCluster(scale) {
  const g = new THREE.Group();
  const panel = new THREE.MeshStandardMaterial({ color: 0x1c201d, roughness: 0.7, metalness: 0.4 });
  const glow = c => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.5, roughness: 0.4 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.95), panel); base.rotation.z = 0.5; g.add(base);
  for (let i = 0; i < 3; i++) {   // round dial gauges with needles
    const col = i === 0 ? 0x6fae6b : i === 1 ? 0xc9a23a : 0x5b9fd6;
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 16), glow(col)); dial.rotation.z = Math.PI / 2 - 0.5; dial.position.set(-0.08, 0.08, -0.3 + i * 0.22); g.add(dial);
    const ndl = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.06, 0.008), new THREE.MeshStandardMaterial({ color: 0xffffff })); ndl.position.set(-0.085, 0.085, -0.3 + i * 0.22); ndl.rotation.x = (i - 1) * 0.7; g.add(ndl);
  }
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.16), new THREE.MeshStandardMaterial({ color: 0x0a2a2e, emissive: 0x1d6b76, emissiveIntensity: 1.0 })); screen.rotation.y = -Math.PI / 2; screen.rotation.x = 0.5; screen.position.set(-0.09, 0.06, 0.3); g.add(screen);
  for (let i = 0; i < 5; i++) { const sw = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), glow(i % 2 ? 0xd6562f : 0x6fae6b)); sw.position.set(-0.13, -0.04, -0.32 + i * 0.06); g.add(sw); }
  g.scale.setScalar(scale || 1); return g;
}

function buildHeli() {
  const g = new THREE.Group();
  let topY = 3.4, len = 12, tailRotor = null, rotorX = 0, rotorZ = 0;
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x14160f, roughness: 0.95, metalness: 0.05 });
  if (MODELS[HELI_MODEL]) {
    const m = fitModel(MODELS[HELI_MODEL].clone(true), 4.6, 0);   // realistic model, ~4.6m tall, feet at y=0
    g.add(m);
    const bb = measureBox(m); topY = bb.max.y; len = Math.max(bb.max.x - bb.min.x, 7);
    const rc = modelRotorXZ(m); rotorX = rc.x; rotorZ = rc.z; topY = rc.y;   // centre the blur disc on the actual main-rotor hub
  } else {                                                     // procedural fallback (boxy but functional)
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x49513f, roughness: 0.85, metalness: 0.2, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x20231e, roughness: 1 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 3.2, 6, 12), bodyMat); body.rotation.z = Math.PI / 2; body.position.y = 1.5; g.add(body);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 0.5), bodyMat); tail.position.set(-3.8, 2.0, 0); g.add(tail);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.2, 0.4), bodyMat); fin.position.set(-6, 2.4, 0); g.add(fin);
    for (const sx of [-1, 1]) { const sk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.2, 6), dark); sk.rotation.x = Math.PI / 2; sk.position.set(0.3, 0.12, sx * 1.1); g.add(sk); }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 6), dark); mast.position.y = 3.2; g.add(mast);
    topY = 3.4; len = 12;
  }
  const rotor = new THREE.Group(); rotor.position.set(rotorX, topY + 0.1, rotorZ);   // sit on the main-rotor hub, not the bbox origin
  if (MODELS[HELI_MODEL]) {   // realistic model already has modelled blades — ONE spinning blur disc over them (no 2nd blade set)
    const disc = new THREE.Mesh(new THREE.CircleGeometry(7.4, 44), new THREE.MeshBasicMaterial({ map: rotorBlurTexture(), transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2; rotor.add(disc);
  } else {                    // procedural fallback has no rotor — give it hard crossed blades + tail rotor
    rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.42, 8), bladeMat));
    for (let i = 0; i < 2; i++) { const bl = new THREE.Mesh(new THREE.BoxGeometry(13.4, 0.09, 0.52), bladeMat); bl.rotation.y = i * Math.PI / 2; rotor.add(bl); }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(7.0, 36), new THREE.MeshBasicMaterial({ color: 0x0c0e0c, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.14; rotor.add(disc);
    tailRotor = new THREE.Group(); tailRotor.position.set(-len * 0.46, topY * 0.62, 0.45);
    for (let i = 0; i < 2; i++) { const tb = new THREE.Mesh(new THREE.BoxGeometry(0.07, 2.6, 0.24), bladeMat); tb.rotation.z = i * Math.PI / 2; tailRotor.add(tb); }
    g.add(tailRotor);
  }
  g.add(rotor);
  scene.add(g);
  return { group: g, rotor, tailRotor, real: !!MODELS[HELI_MODEL] };
}
function startEvac() {
  if (evac) return;
  const bx = S.extraction.beacon.x, bz = S.extraction.beacon.z;
  const lx = bx + 4.5, lz = bz + 2.5;                      // clear landing pad, inside the beacon safe zone
  const groundY = groundH(lx, lz);
  const heli = buildHeli();
  heli.group.position.set(lx + 50, groundY + 120, lz + 50);   // enters high + far
  heli.group.rotation.y = Math.atan2(bx - lx, bz - lz);       // nose roughly toward the beacon
  evac = { phase: "incoming", t: 0, heli, hx: bx, hz: bz, lx, lz, groundY, hoverY: groundY + 12, done: false };
}
function updateEvac(dt) {
  if (!evac) return;
  const g = evac.heli.group; evac.t += dt;
  const rs = (evac.phase === "grounded" || evac.phase === "boarding") ? 24 : 32;   // idle slightly slower
  if (evac.heli.rotor) evac.heli.rotor.rotation.y += dt * rs;                      // spin main rotor (vertical axis)
  if (evac.heli.tailRotor) evac.heli.tailRotor.rotation.x += dt * rs * 2.4;        // spin tail rotor
  const lx = evac.lx, lz = evac.lz;

  if (evac.phase === "incoming") {                          // descend + close on the landing pad from high/far
    const tgt = tmp.set(lx, evac.hoverY, lz);
    g.position.lerp(tgt, Math.min(1, dt * 0.55));
    if (g.position.distanceTo(tgt) < 2.0) { evac.phase = "landing"; evac.t = 0; }
  } else if (evac.phase === "landing") {                    // settle straight down onto the skids
    g.position.x += (lx - g.position.x) * Math.min(1, dt * 3);
    g.position.z += (lz - g.position.z) * Math.min(1, dt * 3);
    g.position.y += (evac.groundY - g.position.y) * Math.min(1, dt * 1.7);
    if (g.position.y - evac.groundY < 0.1) { g.position.y = evac.groundY; evac.phase = "grounded"; evac.t = 0; Audio.beacon(true); toast("CHOPPER DOWN — HOLD, THEN BOARD"); }
  } else if (evac.phase === "grounded") {                   // sits with rotors running through the hold
    g.position.y = evac.groundY;
  } else if (evac.phase === "boarding") {                   // YOU keep control — walk to the door to climb in
    g.position.y = evac.groundY;
    if (dist2(S.player.x, S.player.z, lx, lz) < 5.0 * 5.0) { evac.phase = "climbing"; evac.t = 0; }
  } else if (evac.phase === "climbing") {                   // brief auto climb-aboard, then hide
    g.position.y = evac.groundY;
    const P = S.player;
    P.x += (lx - P.x) * Math.min(1, dt * 4); P.z += (lz - P.z) * Math.min(1, dt * 4); P.gait = "walk";
    if (playerMesh) playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9 + Math.min(1, evac.t) * 0.9, P.z);
    if (evac.t > 1.2) { if (playerMesh) playerMesh.visible = false; evac.phase = "liftoff"; evac.t = 0; Audio.beacon(true); }
  } else if (evac.phase === "liftoff") {                    // spool up, climb + bank away
    g.position.y += dt * 9; g.position.x += dt * 5; g.position.z -= dt * 2;
    if (evac.t > 5.2 && !evac.done) { evac.done = true; endRun(true); }
  }
}
function clearEvac() { if (evac) { scene.remove(evac.heli.group); evac = null; } }

/* ============================================ opening crash intro ======== *
 * Compressed (~36s) interactive build of OPENING_SEQUENCE.md: deployment flight
 * -> trouble -> MAYDAY -> spin -> crash -> black -> wake at the burning wreck ->
 * mission update -> jungle silence + distant roar -> hand control to the player.
 * Skippable; auto-skips on later runs in the same session (you've seen it). */
let intro = null, wreckMesh = null, introSeen = false, introProp = null, introExtra = [];
function clearIntroProp() { if (introProp) { scene.remove(introProp); introProp = null; } for (const e of introExtra) scene.remove(e); introExtra = []; }   // parked intro vehicle + props (jeep/boat/dock) left in-world
function coopSpread(bx, bz) {   // fan co-op players out from a shared hand-off point so they don't stack on each other
  if (!Net.on) return { x: bx, z: bz };
  const a = (Net.id || 1) * 2.39996;   // golden-angle offset, matches the startRun cluster
  return { x: bx + Math.cos(a) * 3.2, z: bz + Math.sin(a) * 3.2 };
}
const introCine = () => intro !== null;                  // input locked while the intro plays
const INTRO_CAM_END = 21;                                // after the crash the normal (wreck) camera takes over
// ── per-mission insertion intros (data-driven; see design/MISSION_INTROS.md) ──
// default insertion is the helicopter crash ("crash"); a mission id here overrides it.
const INTRO_KIND = { dna: "research", ghosts: "jeep", blackout: "boat", last_sample: "monorail", fallen_outpost: "halo", extinction: "airship" };
const introKind = () => (selectedMission && INTRO_KIND[selectedMission.id]) || "crash";
const INTRO_RADIO = [
  { t: 1.2, h: `<span class="rc">RANGER-6:</span> Entering Alpha airspace. Stay sharp.`, say: "Ranger Six, entering Alpha airspace. Stay sharp.", voice: { rate: 1.0, pitch: 0.98 }, clip: "ranger_enter" },
  { t: 7.0, h: `<span class="rc">RANGER-6:</span> Thermal readings high… lost contact with Outpost Seven.`, say: "Thermal readings are high. We've lost contact with Outpost Seven.", voice: { rate: 1.04, pitch: 1.0 }, clip: "ranger_thermal" },
  { t: 11.5, h: `<span class="rc">PILOT:</span> Mayday — losing navigation, controls unresponsive!`, say: "Mayday! Mayday! We're losing navigation — controls are unresponsive!", voice: { rate: 1.32, pitch: 1.14 }, clip: "pilot_mayday" },
  { t: 15.5, h: `<span class="rc">PILOT:</span> She's spinning — BRACE! BRACE!`, say: "She's going down! Hold on — brace! Brace! Brace!", voice: { rate: 1.5, pitch: 1.22 }, clip: "pilot_brace" },
  { t: 22.8, h: `…ringing… muffled voices… you come to in the wreck.` },
  { t: 32.5, h: `The jungle has gone silent. Something heard the crash.` },
];
const INTRO_RADIO_RESEARCH = [   // DNA SAMPLE COLLECTION — research-heli deployment (calm scientist briefing, no crash)
  { t: 1.0, h: `<span class="rc">DR. SOTO:</span> Research flight, you're cleared over Sector 4 — what's left of it.`, say: "Research flight, you're cleared over Sector four. What's left of it.", voice: { rate: 0.98, pitch: 1.0 }, clip: "soto_cleared" },
  { t: 5.5, h: `<span class="rc">DR. SOTO:</span> The program collapsed weeks ago. We need them <b>alive</b> — tranq or trap, do NOT kill them.`, say: "The program collapsed weeks ago. We need them alive. Tranq or trap — do not kill them.", voice: { rate: 1.0, pitch: 1.0 }, clip: "soto_alive" },
  { t: 9.5, h: `<span class="rc">DR. SOTO:</span> Climb the watchtowers, glass the valley, bring me ${DNA_GOAL} samples. The beacon's hot for your evac.`, say: "Climb the watchtowers, glass the valley, and bring me three samples. The beacon is hot for your evac.", voice: { rate: 1.0, pitch: 1.0 }, clip: "soto_samples" },
  { t: 13.5, h: `<span class="rc">PILOT:</span> Skids down. Good luck — we'll be listening.`, say: "Skids down. Good luck — we'll be listening.", voice: { rate: 1.04, pitch: 0.98 }, clip: "pilot_skids" },
];
const INTRO_RADIO_JEEP = [   // GHOSTS OF SECTOR 9 — ranger jeep-convoy (chatter → unsettling silence)
  { t: 1.0, h: `<span class="rc">CONVOY LEAD:</span> Sector 9 track ahead. Survey team went dark thirty-one hours ago.`, say: "Sector nine track ahead. Survey team went dark thirty-one hours ago.", voice: { rate: 1.0, pitch: 0.97 }, clip: "convoy_sector" },
  { t: 5.0, h: `<span class="rc">RANGER-2:</span> Last ping was the old checkpoint. We're almost on it.`, say: "Last ping was the old checkpoint. We're almost on it.", voice: { rate: 1.04, pitch: 1.02 }, clip: "ranger2_ping" },
  { t: 8.5, h: `<span class="rc">CONVOY LEAD:</span> …checkpoint's wrecked. Gate's torn clean off. Eyes up, everybody.`, say: "The checkpoint's wrecked. Gate's torn clean off — eyes up, everybody!", voice: { rate: 1.18, pitch: 1.08 }, clip: "convoy_wrecked" },
  { t: 12.0, h: `<span class="rc">CONVOY LEAD:</span> Tracks lead into the trees — wheels stop here. On foot from now.`, say: "Tracks lead into the trees. Wheels stop here. On foot from now.", voice: { rate: 1.06, pitch: 1.0 }, clip: "convoy_tracks" },
];
const INTRO_RADIO_BOAT = [   // OPERATION BLACKOUT — armored river-boat insertion (engineer dispatch, dawn mist)
  { t: 1.0, h: `<span class="rc">GRID CONTROL:</span> Patrol boat's the only way in — the roads are gone. Keep it quiet.`, say: "Patrol boat's the only way in — the roads are gone. Dawn approach, keep it quiet.", voice: { rate: 1.0, pitch: 0.97 }, clip: "boat_approach" },
  { t: 5.0, h: `<span class="rc">GRID CONTROL:</span> Three stations — Alpha, Bravo, Charlie. Every generator you wake draws them in.`, say: "Three stations: Alpha, Bravo, and Charlie. Every generator you wake will draw them right to you.", voice: { rate: 1.0, pitch: 0.98 }, clip: "boat_stations" },
  { t: 9.0, h: `<span class="rc">GRID CONTROL:</span> Eyes on the banks — they own this river now. Keep it slow and quiet.`, say: "Eyes on the banks — they own this river now. Keep it slow, and keep it quiet.", voice: { rate: 1.04, pitch: 1.0 }, clip: "boat_tunnel" },
  { t: 13.0, h: `<span class="rc">GRID CONTROL:</span> Dock ahead. Get the grid back online and get out before they reach you.`, say: "Dock ahead. Get the grid back online, and get out before they reach you.", voice: { rate: 1.04, pitch: 0.99 }, clip: "boat_dock" },
];
const INTRO_RADIO_MONO = [   // THE LAST SAMPLE — abandoned monorail arrival (transit VO → power loss → facility under attack)
  { t: 1.0, h: `<span class="rc">TRANSIT:</span> Sector 4 transit. Final service. Please remain seated.`, say: "Sector four transit. Final service. Please remain seated.", voice: { rate: 0.98, pitch: 1.02 }, clip: "mono_transit" },
  { t: 6.0, h: `<span class="rc">TRANSIT:</span> Warning — primary power failure. Switching to emergency cells.`, say: "Warning. Primary power failure. Switching to emergency cells.", voice: { rate: 0.98, pitch: 1.0 }, clip: "mono_power" },
  { t: 8.8, h: `<span class="rc">DR. SOTO:</span> That's the last sample in the cold vault. Restore the car's power, get to the platform.`, say: "That's the last sample, in the cold vault. Restore the car's power and get to the platform.", voice: { rate: 1.0, pitch: 1.0 }, clip: "mono_restore" },
  { t: 12.5, h: `<span class="rc">TRANSIT:</span> Facility under attack. Containment compromised. Doors opening.`, say: "Facility under attack. Containment compromised. Doors opening.", voice: { rate: 1.06, pitch: 1.04 }, clip: "mono_doors" },
];
const INTRO_RADIO_HALO = [   // FALLEN OUTPOST — HALO parachute (bay → countdown); the canopy line fires on the jump
  { t: 1.0, h: `<span class="rc">COMMANDER:</span> Outpost Echo's gone dark. Maya's beacon is still pulsing — she's alive, and she's not alone.`, say: "Outpost Echo's gone dark. Ranger Maya's beacon is still pulsing — she's alive, and she's not alone.", voice: { rate: 1.0, pitch: 0.96 }, clip: "cmd_echo" },
  { t: 4.4, h: `<span class="rc">COMMANDER:</span> We can't land in that. HALO drop — you jump, you steer, you find her.`, say: "We can't land in that. HALO drop — you jump, you steer, you find her.", voice: { rate: 1.04, pitch: 0.98 }, clip: "cmd_halo" },
  { t: 7.0, h: `<span class="rc">COMMANDER:</span> Ramp's open. Thirty seconds to the drop. On my mark.`, say: "Ramp's open. Thirty seconds to the drop. On my mark.", voice: { rate: 1.08, pitch: 1.0 }, clip: "cmd_ramp" },
];
const LINE_HALO_CANOPY = { h: `<span class="rc">COMMANDER:</span> Canopy's good — steer for the beacon, flare before the trees.`, say: "Canopy's good. Steer for the beacon — and flare before you hit the trees.", voice: { rate: 1.04, pitch: 1.0 }, clip: "cmd_canopy" };
const INTRO_RADIO_AIRSHIP = [   // EXTINCTION PROTOCOL — evac airship (deck → breach); the descent line fires on the jump
  { t: 1.0, h: `<span class="rc">COMMANDER:</span> This is the last carrier off the island. Below you, it's already over.`, say: "This is the last carrier off the island. Below you, it's already over.", voice: { rate: 0.98, pitch: 0.95 }, clip: "cmd_lastcarrier" },
  { t: 4.4, h: `<span class="rc">COMMANDER:</span> Apex predators loose, containment's gone. We end this tonight — or no one leaves.`, say: "Multiple apex predators loose, containment's gone. We end this tonight, or no one leaves.", voice: { rate: 1.02, pitch: 0.97 }, clip: "cmd_apex" },
  { t: 7.0, h: `<span class="rc">COMMANDER:</span> Breach on the flight deck! Emergency deployment — go, go, go!`, say: "Breach on the flight deck! Emergency deployment — go, go, go!", voice: { rate: 1.2, pitch: 1.08 }, clip: "cmd_breach" },
];
const LINE_AIRSHIP_DOWN = { h: `<span class="rc">COMMANDER:</span> Ride it down to the Command Center. Everything depends on what you do next.`, say: "Ride it down to the Command Center. Everything depends on what you do next.", voice: { rate: 1.02, pitch: 0.98 }, clip: "cmd_ridedown" };
// Spoken radio via the Web Speech API. Quality is bounded by the OS voices, so we aggressively prefer
// natural / neural / online voices (Chrome's "Google US English", macOS premium) over the built-in
// robotic ones, and drive delivery per-line (frantic pilot vs calm briefing) via {rate,pitch,volume}.
let _radioVoice = null;
function pickRadioVoice() {
  try {
    const ss = window.speechSynthesis; if (!ss) return null;
    const v = ss.getVoices(); if (!v.length) return null;
    const score = x => {
      const n = (x.name || "").toLowerCase(), lang = x.lang || "";
      let s = 0;
      if (/^en[-_]us/i.test(lang)) s += 4; else if (/^en/i.test(lang)) s += 2;
      if (/natural|neural|premium|enhanced/.test(n)) s += 8;            // high-quality engines sound human
      if (/google/.test(n)) s += 5;                                     // Chrome's online voices
      if (x.localService === false) s += 3;                            // network voices beat robotic built-ins
      if (/\b(daniel|alex|aaron|tom|guy|matthew|ryan|eric|christopher|james|arthur)\b/.test(n)) s += 2;
      if (/female|samantha|victoria|karen|tessa|moira|fiona|zira|susan|hazel|allison/.test(n)) s -= 2;
      if (/novelty|whisper|zarvox|bells|cellos|organ|robot|bubbles|trinoids|albert|bad news|boing|jester|wobble|superstar|grandma|grandpa|reed|rocko|sandy|shelley|flo|eddy/.test(n)) s -= 30; // macOS joke voices
      return s;
    };
    return v.slice().sort((a, b) => score(b) - score(a))[0] || null;
  } catch (e) { return null; }
}
function speakRadio(text, opt) {
  try {
    const ss = window.speechSynthesis; if (!ss || !text) return;   // no text (e.g. a clip-only line whose clip failed) → stay silent, never speak "undefined"
    opt = opt || {};
    if (!_radioVoice) _radioVoice = pickRadioVoice();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opt.rate != null ? opt.rate : 1.0;
    u.pitch = opt.pitch != null ? opt.pitch : 1.0;
    u.volume = opt.volume != null ? opt.volume : 1;
    if (_radioVoice) u.voice = _radioVoice;
    ss.speak(u);
  } catch (e) {}
}
try { if (window.speechSynthesis) { window.speechSynthesis.onvoiceschanged = () => { _radioVoice = pickRadioVoice(); }; _radioVoice = pickRadioVoice(); } } catch (e) {}
// Real human VO: bundled Inworld clips per radio line (assets/audio/intro/*.m4a). Prefer the clip;
// fall back to the synthetic voice if a clip is missing or blocked.
const RADIO_DIR = "./assets/audio/intro/";
const _radioClips = {};
// NB: the game defines its own `Audio` object below, which shadows the browser Audio constructor —
// so we must use `window.Audio` here for the HTMLAudioElement, not bare `Audio`.
function radioClip(name) { if (!_radioClips[name]) { const a = new window.Audio(RADIO_DIR + name + ".m4a"); a.preload = "auto"; a.volume = 0.95; _radioClips[name] = a; } return _radioClips[name]; }
function preloadRadio() { try { ["pilot_mayday","pilot_brace","ranger_enter","ranger_thermal","soto_cleared","soto_alive","soto_samples","pilot_skids","convoy_sector","ranger2_ping","convoy_wrecked","convoy_tracks","boat_approach","boat_stations","boat_tunnel","boat_dock","mono_transit","mono_power","mono_restore","mono_doors","cmd_echo","cmd_halo","cmd_ramp","cmd_canopy","cmd_lastcarrier","cmd_apex","cmd_breach","cmd_ridedown"].forEach(radioClip); } catch (e) {} }
function stopRadioClips() { for (const k in _radioClips) { try { _radioClips[k].pause(); _radioClips[k].currentTime = 0; } catch (e) {} } }
/* ===================================================== accessibility ===== */
const OPTS = { cb: "", scale: "1", subs: "0", hc: "0" };
function applyOpts() {
  document.body.classList.remove("cb-deut", "cb-prot", "cb-trit");
  if (OPTS.cb) document.body.classList.add(OPTS.cb);
  document.body.style.setProperty("--hud-zoom", OPTS.scale);
  document.body.classList.toggle("subs-on", OPTS.subs === "1");
  document.body.classList.toggle("hc", OPTS.hc === "1");
}
// iOS Safari ignores user-scalable=no, so block the pinch/double-tap gestures that otherwise zoom the
// page and leave the player stuck zoomed-in. touch-action:manipulation (CSS) kills the double-tap zoom;
// these kill pinch-zoom + any residual double-tap without breaking single taps on buttons.
function blockPageZoom() {
  // Stop pinch zoom at its START only (gesturestart + a 2-finger touchstart) so the page can never get
  // zoomed in the first place. Crucially we do NOT touch touchend / single-finger touchmove — doing so
  // ate button taps (ENLARGE) and trapped the user when already zoomed. touch-action:manipulation (CSS)
  // handles double-tap zoom. If a stale zoom persists, a reload resets to scale 1.
  ["gesturestart", "gesturechange"].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
  document.addEventListener("touchstart", e => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
}
function initOptions() {
  blockPageZoom();
  try { Object.assign(OPTS, JSON.parse(localStorage.getItem("jws_opts") || "{}")); } catch {}
  applyOpts();
  const save = () => { try { localStorage.setItem("jws_opts", JSON.stringify(OPTS)); } catch {} };
  const rows = [["optCB", "cb"], ["optScale", "scale"], ["optSubs", "subs"], ["optHC", "hc"]];
  const refresh = () => rows.forEach(([id, key]) => { const r = $(id); if (r) [...r.children].forEach(b => b.classList.toggle("on", b.dataset[key] === String(OPTS[key]))); });
  rows.forEach(([id, key]) => { const r = $(id); if (r) r.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; OPTS[key] = b.dataset[key]; applyOpts(); refresh(); save(); }); });
  refresh();
  const ob = $("optBtn"); if (ob) { ob.style.display = "block"; if (isTouch) ob.textContent = "⚙"; ob.addEventListener("click", () => $("opts").classList.toggle("on")); }
  const oc = $("optsClose"); if (oc) oc.addEventListener("click", () => $("opts").classList.remove("on"));
}
let _subTimer = null;
function showSubtitle(text) {   // VO/radio caption when subtitles are enabled
  const el = $("subtitle"); if (!el || !text || OPTS.subs !== "1") return;
  el.textContent = text; el.classList.add("show");
  clearTimeout(_subTimer); _subTimer = setTimeout(() => el.classList.remove("show"), 2600 + Math.min(4200, text.length * 45));
}
function playRadio(e) {   // e = { say, voice, clip }
  if (e && e.say) showSubtitle(e.say);
  if (e && e.clip) {
    try { const a = radioClip(e.clip); a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => speakRadio(e.say, e.voice)); return; } catch (err) {}
  }
  speakRadio(e.say, e.voice);
}

function buildWreck(x, z) {
  const heli = buildHeli();                              // reuse the chopper, scorched + canted as wreckage
  const g = heli.group; g.position.set(x, groundH(x, z), z); g.rotation.set(0.32, 2.2, 0.46);
  if (heli.rotor) heli.rotor.rotation.z = 0.5;
  g.traverse(o => { if (o.isMesh && o.material && o.material.color) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.45); } });
  const fire = new THREE.PointLight(0xff5a1e, 4.5, 28, 2); fire.position.set(0, 1.4, 0.4); g.add(fire);
  const smoke = [];
  for (let i = 0; i < 6; i++) { const p = new THREE.Mesh(new THREE.SphereGeometry(0.85, 8, 7), new THREE.MeshBasicMaterial({ color: 0x2a2e30, transparent: true, opacity: 0.4, depthWrite: false })); p.userData.ph = i / 6; g.add(p); smoke.push(p); }
  g.userData.fire = fire; g.userData.smoke = smoke;
  scene.add(g); return g;
}
function updateWreck(dt) {
  if (!wreckMesh) return;
  const fire = wreckMesh.userData.fire; if (fire) fire.intensity = 3.5 + Math.sin(S.t * 17) * 1.1 + Math.random() * 0.6;
  for (const p of wreckMesh.userData.smoke) { p.userData.ph = (p.userData.ph + dt * 0.22) % 1; const k = p.userData.ph; p.position.set(0.2 + k * 0.9, 1.4 + k * 7, 0.3); p.scale.setScalar(0.6 + k * 2.4); p.material.opacity = 0.42 * (1 - k); }
}
function clearWreck() { if (wreckMesh) { scene.remove(wreckMesh); wreckMesh = null; } }

function placeAtWreck() {                                 // stand the survivor next to the wreck, facing it
  const P = S.player; P.yaw = Math.atan2(intro ? intro.wx : 6, intro ? intro.wz : 4);
  cam.yaw = P.yaw; cam.pitch = -0.12; camera.up.set(0, 1, 0);
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9, P.z); playerMesh.rotation.y = P.yaw; }
}
// A believable SEATED squad member — origin at the hips so seat coords place them naturally. Own bucket
// seat (never fused to mid-air), helmet, chest rig, arms resting on the lap, distinct fatigues per member.
function makeTrooper(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23261f, roughness: 0.7 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xb88a66, roughness: 0.72 });
  const vest = new THREE.MeshStandardMaterial({ color: 0x2c322a, roughness: 0.85, metalness: 0.15 });
  // bucket seat (cushion + back) so the figure clearly rests ON something
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.48), dark), { position: new THREE.Vector3(0, -0.06, 0.08) }));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.52, 0.1), dark), { position: new THREE.Vector3(0, 0.2, -0.18) }));
  // seated body
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.4, 4, 8), mat); torso.position.set(0, 0.3, 0.0); torso.rotation.x = 0.1; g.add(torso);
  const rig = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.32, 0.16), vest); rig.position.set(0, 0.32, 0.12); g.add(rig);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 10), skin); head.position.set(0, 0.66, 0.03); g.add(head);
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), dark); helm.position.set(0, 0.69, 0.03); g.add(helm);
  // arms resting forward on the lap
  for (const sx of [-1, 1]) { const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.32, 4, 6), mat); arm.position.set(sx * 0.24, 0.26, 0.16); arm.rotation.x = 1.0; g.add(arm); }
  // thighs forward + shins down (the seated L) + boots
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.15, 0.4), mat), { position: new THREE.Vector3(0, 0.05, 0.24) }));
  for (const sx of [-1, 1]) {
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 6), dark); shin.position.set(sx * 0.11, -0.18, 0.42); g.add(shin);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.24), dark); boot.position.set(sx * 0.11, -0.4, 0.5); g.add(boot);
  }
  return g;
}
function buildRiders(group) {                             // squad seated INSIDE the cabin (within the fuselage volume)
  const n = Math.min(5, Net.on ? (remotePlayers.size + 1) : 1);
  const colors = [0x5a6b3f, 0x4a5236, 0x6b6f4a, 0x47513f, 0x595b40];
  for (let i = 0; i < n; i++) {
    const t = makeTrooper(colors[i % colors.length]);
    const x = n === 1 ? -0.3 : -1.0 + (i / (n - 1)) * 1.5;   // cabin row, well within the body
    t.position.set(x, 1.3, (i % 2 ? 0.32 : -0.32)); t.scale.setScalar(0.82); group.add(t);
  }
  const pilot = makeTrooper(0x3a3f30); pilot.position.set(1.15, 1.35, 0); pilot.scale.setScalar(0.82); group.add(pilot);   // cockpit
}
function upgradeIntroHeli() {                             // swap the boxy fallback for the realistic Huey the instant it loads
  if (!intro || intro.crashed || !intro.heli || intro.heli.real || !MODELS[HELI_MODEL]) return;
  const old = intro.heli.group, pos = old.position.clone(), rot = old.rotation.clone();
  scene.remove(old);
  const heli = buildHeli(); heli.group.position.copy(pos); heli.group.rotation.copy(rot);
  buildRiders(heli.group); intro.heli = heli;
}
function startIntro() {                                   // dispatch to the active mission's insertion cinematic
  const k = introKind();
  if (k === "research") return startIntroResearch();
  if (k === "jeep") return startIntroJeep();
  if (k === "boat") return startIntroBoat();
  if (k === "monorail") return startIntroMonorail();
  if (k === "halo") return startIntroHalo();
  if (k === "airship") return startIntroAirship();
  return startIntroCrash();
}
function startIntroCrash() {
  const wx = 6, wz = 4;
  Audio.rotor(true);
  const heli = buildHeli(); heli.group.position.set(60, 150, 120);
  buildRiders(heli.group);                                // the squad rides in the open door
  intro = { kind: "crash", t: 0, phase: "flight", heli, line: -1, shake: 0, crashed: false, camActive: true, wx, wz };
  if (playerMesh) playerMesh.visible = false;
  ["introTint", "introVig", "introBlack", "introRadio", "introBig"].forEach(k => { const e = $(k); if (e) e.style.opacity = "0"; });
  $("introMission").classList.remove("show");
  $("intro").classList.remove("hidden");
  $("introCap").textContent = "Jurassic Survival · Island Alpha";
  $("introCap").style.opacity = "1";
  $("hud").style.display = "none";
  S.phase = "intro";
}
function updateIntro(dt) {
  if (!intro) return;
  if (intro.kind === "research") return updateIntroResearch(dt);
  if (intro.kind === "jeep") return updateIntroJeep(dt);
  if (intro.kind === "boat") return updateIntroBoat(dt);
  if (intro.kind === "monorail") return updateIntroMonorail(dt);
  if (intro.kind === "halo") return updateIntroHalo(dt);
  if (intro.kind === "airship") return updateIntroAirship(dt);
  return updateIntroCrash(dt);
}
function updateIntroCrash(dt) {
  if (!intro) return;
  upgradeIntroHeli();                                     // promote fallback → realistic Huey the moment it's available
  intro.t += dt; const T = intro.t, g = intro.heli ? intro.heli.group : null;
  const tint = $("introTint"), big = $("introBig"), cap = $("introCap");
  if (intro.line + 1 < INTRO_RADIO.length && T >= INTRO_RADIO[intro.line + 1].t) {
    intro.line++; const e = INTRO_RADIO[intro.line]; const r = $("introRadio"); r.innerHTML = e.h; r.style.opacity = "1";
    if (e.say || e.clip) { Audio.squelch(); playRadio(e); }    // actual spoken radio / mayday
  }
  if (g && !intro.crashed && intro.heli.rotor) { intro.heli.rotor.rotation.y += dt * 30; if (intro.heli.tailRotor) intro.heli.tailRotor.rotation.x += dt * 60; }

  if (T < 6.5) {                          // 1 · deployment flight
    intro.phase = "flight"; intro.shake = 0.04;
    if (g) { g.position.x += (-6 - g.position.x) * dt * 0.4; g.position.z += (-30 - g.position.z) * dt * 0.4; g.position.y += (70 - g.position.y) * dt * 0.5; }
    cap.style.opacity = T > 4.5 ? "0" : "1";
  } else if (T < 11) {                    // 2 · first signs of trouble
    intro.phase = "trouble"; intro.shake = 0.12;
    tint.style.background = "#c9a23a"; tint.style.opacity = "0.22";
    if (g) { g.position.y += (52 - g.position.y) * dt * 0.5; g.position.x += (4 - g.position.x) * dt * 0.4; g.position.z += (-12 - g.position.z) * dt * 0.4; }
  } else if (T < 15) {                    // 3 · something is wrong (mayday)
    intro.phase = "wrong"; intro.shake = 0.32;
    if (!intro._alarm) { intro._alarm = 1; Audio.alarm(); }
    tint.style.background = "#d6562f"; tint.style.opacity = "0.4";
    big.textContent = "MAYDAY"; big.style.opacity = T < 14.4 ? "1" : "0";
    if (g) g.position.y += (40 - g.position.y) * dt * 0.5;
  } else if (T < 19) {                    // 4 · loss of control (spin)
    intro.phase = "spin"; intro.shake = 0.7;
    tint.style.background = "#3a2516"; tint.style.opacity = "0.5";
    big.textContent = "BRACE!"; big.style.opacity = T < 18.4 ? "1" : "0";
    if (g) g.position.y += (24 - g.position.y) * dt * 0.6;
  } else if (T < INTRO_CAM_END) {         // 5 · crash
    intro.phase = "crash"; intro.shake = 1.4;
    if (g && !intro.crashed) { g.position.x += (intro.wx - g.position.x) * dt * 4; g.position.z += (intro.wz - g.position.z) * dt * 4; g.position.y += (groundH(intro.wx, intro.wz) - g.position.y) * dt * 4; }
    if (!intro.crashed && T > 19.4) {
      intro.crashed = true; flash(); Audio.crash(); Audio.rotor(false); big.style.opacity = "0";
      if (intro.heli) scene.remove(intro.heli.group);
      wreckMesh = buildWreck(intro.wx, intro.wz);
      const c = coopSpread(0, 0); S.player.x = c.x; S.player.z = c.z; placeAtWreck();
      $("introBlack").style.opacity = "1"; intro.camActive = false; intro.shake = 0;
    }
  } else if (T < 27) {                    // 6 · awakening at the wreck
    intro.phase = "wake";
    const k = clamp((T - 22.5) / 1.6, 0, 1);
    $("introBlack").style.opacity = String(1 - k);
    $("introVig").style.opacity = String(0.85 - k * 0.4);
    tint.style.opacity = "0";
  } else if (T < 32) {                    // 7 · first objective
    intro.phase = "mission"; $("introMission").classList.add("show");
    $("introRadio").style.opacity = T > 27.4 ? "0" : "1";
  } else if (T < 36) {                    // 8 · silence → roar
    intro.phase = "silence";
    if (!intro._cut) { intro._cut = 1; Audio.ambient(false); $("introMission").classList.remove("show"); }
    if (!intro._roar && T > 32.6) { intro._roar = 1; Audio.roar(); }
  } else { endIntro(); return; }
  if (wreckMesh) updateWreck(dt);
}
function updateIntroCamera() {
  if (!intro) return;
  if (intro.kind === "research") return updateIntroCameraResearch();
  if (intro.kind === "jeep") return updateIntroCameraJeep();
  if (intro.kind === "boat") return updateIntroCameraBoat();
  if (intro.kind === "monorail") return updateIntroCameraMonorail();
  if (intro.kind === "halo") return updateIntroCameraHalo();
  if (intro.kind === "airship") return updateIntroCameraAirship();
  return updateIntroCameraCrash();
}
function updateIntroCameraCrash() {
  const g = intro.heli ? intro.heli.group : null; if (!g) return;
  const T = intro.t;
  if (T < 15) {                           // trailing chase over the valley
    camera.position.lerp(tmp.set(g.position.x - 10, g.position.y + 6, g.position.z + 16), 0.06);
    camera.lookAt(g.position.x, g.position.y - 2, g.position.z - 10);
  } else {                                // spin: orbit + roll the horizon
    const a = T * 2.4;
    camera.position.lerp(tmp.set(g.position.x + Math.sin(a) * 13, g.position.y + 4, g.position.z + Math.cos(a) * 13), 0.12);
    camera.up.set(Math.sin(a * 0.7) * 0.5, 1, 0).normalize();
    camera.lookAt(g.position.x, g.position.y, g.position.z);
  }
  if (intro.shake > 0) { camera.position.x += (Math.random() - 0.5) * intro.shake; camera.position.y += (Math.random() - 0.5) * intro.shake; camera.position.z += (Math.random() - 0.5) * intro.shake; }
}
function finishIntroCommon(msg) {                          // shared hand-off: return control, clear cinematic DOM
  introSeen = true; intro = null;
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  stopRadioClips();
  Audio.rotor(false);
  $("intro").classList.add("hidden"); $("introMission").classList.remove("show");
  ["introTint", "introVig", "introBlack", "introRadio", "introCap", "introBig"].forEach(k => { const e = $(k); if (e) e.style.opacity = "0"; });
  camera.up.set(0, 1, 0); $("hud").style.display = "";
  S.phase = "playing"; Audio.ambient(true);
  if (playerMesh) playerMesh.visible = true;
  if (msg) toast(msg);
  lockPointer();
}
function endIntro() { finishIntroCommon("SURVIVE · find the extraction beacon"); }

/* ── DNA SAMPLE COLLECTION · research-heli deployment (clean landing, no crash) ── */
function startIntroResearch() {
  const lx = 6, lz = 4;                                   // landing zone; player stands at origin on hand-off
  Audio.rotor(true);
  const heli = buildHeli(); heli.group.position.set(86, 128, 150);
  buildRiders(heli.group);
  intro = { kind: "research", t: 0, phase: "approach", heli, line: -1, shake: 0, crashed: false, camActive: true, wx: lx, wz: lz, landed: false };
  if (playerMesh) playerMesh.visible = false;
  ["introTint", "introVig", "introBlack", "introRadio", "introBig"].forEach(k => { const e = $(k); if (e) e.style.opacity = "0"; });
  $("introMission").classList.remove("show");
  $("intro").classList.remove("hidden");
  $("introCap").textContent = "Jurassic Survival · Field Science · Sector 4";
  $("introCap").style.opacity = "1";
  $("hud").style.display = "none";
  S.phase = "intro";
}
function updateIntroResearch(dt) {
  if (!intro) return;
  upgradeIntroHeli();
  intro.t += dt; const T = intro.t, g = intro.heli ? intro.heli.group : null;
  const tint = $("introTint"), cap = $("introCap");
  if (intro.line + 1 < INTRO_RADIO_RESEARCH.length && T >= INTRO_RADIO_RESEARCH[intro.line + 1].t) {
    intro.line++; const e = INTRO_RADIO_RESEARCH[intro.line]; const r = $("introRadio"); r.innerHTML = e.h; r.style.opacity = "1";
    if (e.say || e.clip) { Audio.squelch(); playRadio(e); }
  }
  if (g && intro.heli.rotor) { const rs = intro.landed ? 12 : 30; intro.heli.rotor.rotation.y += dt * rs; if (intro.heli.tailRotor) intro.heli.tailRotor.rotation.x += dt * rs * 2; }

  if (T < 6) {                            // 1 · banking approach over the ruined labs (golden hour)
    intro.phase = "approach"; intro.shake = 0.05;
    if (g) { g.position.x += (24 - g.position.x) * dt * 0.5; g.position.z += (44 - g.position.z) * dt * 0.5; g.position.y += (62 - g.position.y) * dt * 0.5; }
    tint.style.background = "#c98a3a"; tint.style.opacity = "0.16";
    cap.style.opacity = T > 4.5 ? "0" : "1";
  } else if (T < 12) {                    // 2 · descend toward the LZ while the scientist briefs you
    intro.phase = "descend"; intro.shake = 0.06;
    if (g) { g.position.x += (intro.wx - g.position.x) * dt; g.position.z += (intro.wz + 12 - g.position.z) * dt; g.position.y += (18 - g.position.y) * dt * 0.8; }
  } else if (T < 16) {                    // 3 · skids down — controlled landing, no crash
    intro.phase = "landing"; intro.shake = 0.04;
    if (g) { g.position.x += (intro.wx - g.position.x) * dt * 2; g.position.z += (intro.wz + 3 - g.position.z) * dt * 2; g.position.y += (groundH(intro.wx, intro.wz) + 1.5 - g.position.y) * dt * 2; }
    if (T > 14.4) intro.landed = true;
  } else {                                // 4 · continuous hand-off (no fade, no wreck)
    if (intro.heli) scene.remove(intro.heli.group);
    Audio.rotor(false);
    endIntroResearch();
  }
}
function updateIntroCameraResearch() {
  const g = intro.heli ? intro.heli.group : null; if (!g) return;
  camera.position.lerp(tmp.set(g.position.x - 13, g.position.y + 7, g.position.z + 19), 0.05);
  camera.lookAt(g.position.x, g.position.y - 1, g.position.z - 6);
  if (intro.shake > 0) { camera.position.x += (Math.random() - 0.5) * intro.shake; camera.position.y += (Math.random() - 0.5) * intro.shake; }
}
function endIntroResearch() {                             // stand the player at the LZ, facing into the valley
  const P = S.player; P.x = 0; P.z = 0; P.yaw = 0;
  cam.yaw = 0; cam.pitch = -0.06; camera.up.set(0, 1, 0);
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9, P.z); playerMesh.rotation.y = P.yaw; }
  finishIntroCommon(`FIELD SCIENCE · climb a tower, glass (B), tranq (4) & sample (6) · ${DNA_GOAL} needed`);
}

/* ── GHOSTS OF SECTOR 9 · ranger jeep-convoy expedition (ride in, dismount on foot) ── */
function buildJeep() {                                    // ranger Land Rover Defender (front = local +x), headlights for the reveal
  const j = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a5a3c, roughness: 0.85, metalness: 0.15 });   // ranger olive
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xd9ddd2, roughness: 0.82, metalness: 0.05 });   // classic white Defender roof
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x23261f, roughness: 0.9, metalness: 0.2 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1b2a2c, roughness: 0.22, metalness: 0.5, transparent: true, opacity: 0.62 });
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x14140f, roughness: 1 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x8a8e8a, roughness: 0.45, metalness: 0.7 });
  const rackMat = new THREE.MeshStandardMaterial({ color: 0x2f322c, roughness: 0.7, metalness: 0.35 });
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.4, 1.95), trimMat); chassis.position.y = 0.78; j.add(chassis);
  // bonnet (front, low + flat) and the tall boxy cab — the Defender silhouette
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.72, 1.95), bodyMat); hood.position.set(1.55, 1.30, 0); j.add(hood);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.5, 1.95), bodyMat); cab.position.set(-0.55, 1.55, 0); j.add(cab);
  const ws = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.82, 1.82), glassMat); ws.position.set(0.93, 2.12, 0); ws.rotation.z = 0.1; j.add(ws);   // near-vertical windshield
  { const ic = buildInstrumentCluster(0.85); ic.position.set(0.62, 1.55, 0.0); j.add(ic); }   // dashboard instrument cluster under the windshield
  for (const sz of [0.99, -0.99]) { const sg = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.66, 0.04), glassMat); sg.position.set(-0.7, 2.16, sz); j.add(sg); }   // flat upright side glass
  const roof = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.16, 2.0), roofMat); roof.position.set(-0.6, 2.6, 0); j.add(roof);
  // safari roof rack
  const rack = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 1.9), rackMat); rack.position.set(-0.7, 2.76, 0); j.add(rack);
  for (const rx of [-1.8, 0.5]) for (const rz of [0.9, -0.9]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 6), rackMat); leg.position.set(rx, 2.69, rz); j.add(leg); }
  // vertical grille + round headlights (front face = +x) — beams used for the checkpoint reveal
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, 1.5), trimMat); grille.position.set(2.32, 1.18, 0); j.add(grille);
  const lights = [];
  for (const lz of [0.62, -0.62]) {
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 16), new THREE.MeshStandardMaterial({ color: 0xfff1c0, roughness: 0.3, emissive: 0xfff1c0, emissiveIntensity: 1.5 }));
    hl.rotation.z = Math.PI / 2; hl.position.set(2.37, 1.22, lz); j.add(hl);
    const beam = new THREE.SpotLight(0xfff0c4, 6, 38, 0.5, 0.4, 1.4); beam.position.set(2.4, 1.3, lz);
    beam.target.position.set(12, 0.6, lz); j.add(beam); j.add(beam.target); lights.push(beam);
  }
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 1.95), trimMat); bumper.position.set(2.45, 0.78, 0); j.add(bumper);
  // boxy wheel arches + chunky tyres
  const wgeo = new THREE.CylinderGeometry(0.66, 0.66, 0.5, 16);
  for (const dx of [1.45, -1.5]) for (const dz of [1.0, -1.0]) {
    const w = new THREE.Mesh(wgeo, tyreMat); w.rotation.x = Math.PI / 2; w.position.set(dx, 0.66, dz); j.add(w);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.52, 8), hubMat); hub.rotation.x = Math.PI / 2; hub.position.set(dx, 0.66, dz); j.add(hub);
    const arch = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.32, 0.36), bodyMat); arch.position.set(dx, 1.04, dz > 0 ? 0.93 : -0.93); j.add(arch);   // bridges body→wheel (no gap)
  }
  // rear-mounted spare wheel (back face = −x) — classic Defender
  const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.3, 16), tyreMat); spare.rotation.z = Math.PI / 2; spare.position.set(-2.12, 1.55, 0); j.add(spare);
  const spareHub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.32, 8), hubMat); spareHub.rotation.z = Math.PI / 2; spareHub.position.set(-2.16, 1.55, 0); j.add(spareHub);
  // snorkel up the A-pillar
  const snork = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 8), trimMat); snork.position.set(1.12, 1.7, 0.92); j.add(snork);
  // ranger roof light-bar
  const lb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 1.2), rackMat); lb.position.set(0.55, 2.86, 0); j.add(lb);
  for (const lz of [0.4, -0.4]) { const dome = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.14, 0.32), new THREE.MeshStandardMaterial({ color: 0xc94a2a, roughness: 0.4, emissive: 0x3a1206 })); dome.position.set(0.55, 2.96, lz); j.add(dome); }
  j.userData.lights = lights;
  return j;
}
function buildJeepRiders(j) {                             // driver + passenger up front, one in the back — clearly crewed
  const seats = [[0.45, 1.3, 0.55], [0.45, 1.3, -0.55], [-1.2, 1.42, 0.55], [-1.2, 1.42, -0.55]];
  const cols = [0x4a5236, 0x595b40, 0x6b6f4a, 0x47513f];
  const n = Math.min(seats.length, Math.max(2, 1 + (typeof coopCount === "function" ? coopCount() : 2)));
  for (let i = 0; i < n; i++) { const s = seats[i], t = makeTrooper(cols[i]); t.position.set(s[0], s[1], s[2]); t.rotation.y = Math.PI / 2; t.scale.setScalar(0.82); j.add(t); }
}
function startIntroJeep() {
  const j = buildJeep();
  j.position.set(2, groundH(2, 56), 56); j.rotation.y = Math.PI / 2;   // front (+x local) points toward −z = direction of travel
  buildJeepRiders(j); scene.add(j); introProp = j;
  intro = { kind: "jeep", t: 0, phase: "drive", jeep: j, line: -1, shake: 0, camActive: true, stopped: false };
  if (playerMesh) playerMesh.visible = false;
  ["introTint", "introVig", "introBlack", "introRadio", "introBig"].forEach(k => { const e = $(k); if (e) e.style.opacity = "0"; });
  $("introMission").classList.remove("show");
  $("intro").classList.remove("hidden");
  $("introCap").textContent = "Jurassic Survival · Investigation · Sector 9";
  $("introCap").style.opacity = "1";
  $("hud").style.display = "none";
  S.phase = "intro";
}
function updateIntroJeep(dt) {
  if (!intro) return;
  intro.t += dt; const T = intro.t, j = intro.jeep;
  const tint = $("introTint"), cap = $("introCap");
  if (intro.line + 1 < INTRO_RADIO_JEEP.length && T >= INTRO_RADIO_JEEP[intro.line + 1].t) {
    intro.line++; const e = INTRO_RADIO_JEEP[intro.line]; const r = $("introRadio"); r.innerHTML = e.h; r.style.opacity = "1";
    if (e.say || e.clip) { Audio.squelch(); playRadio(e); }
  }
  tint.style.background = "#1f2733"; tint.style.opacity = "0.3";   // last light / dusk
  const driveTo = (tz, rate) => { if (j) { j.position.z += (tz - j.position.z) * dt * rate; j.position.y = groundH(j.position.x, j.position.z); } };

  if (T < 7) {                            // 1 · grind up the track toward the checkpoint
    intro.phase = "drive"; intro.shake = 0.09; driveTo(20, 0.5);
    cap.style.opacity = T > 5 ? "0" : "1";
  } else if (T < 11) {                    // 2 · the team's frequency cuts to silence
    intro.phase = "closing"; intro.shake = 0.06; driveTo(11, 0.6);
    if (!intro._cut && T > 9.5) { intro._cut = 1; Audio.ambient(false); }
  } else if (T < 14.5) {                  // 3 · halt at the wrecked checkpoint, headlights reveal
    intro.phase = "arrive"; intro.shake = T > 12 ? 0.02 : 0.05; driveTo(8, 2.2);
    if (!intro.stopped && T > 13) intro.stopped = true;
  } else {                                // 4 · dismount on foot
    endIntroJeep();
  }
}
function updateIntroCameraJeep() {
  const j = intro.jeep; if (!j) return;
  camera.position.lerp(tmp.set(j.position.x - 1.4, j.position.y + 2.35, j.position.z + 5.2), 0.1);   // over the driver's shoulder
  camera.lookAt(j.position.x + 1.0, j.position.y + 1.5, j.position.z - 10);                          // forward over the hood
  if (intro.shake > 0) { camera.position.x += (Math.random() - 0.5) * intro.shake; camera.position.y += (Math.random() - 0.5) * intro.shake; }
}
function endIntroJeep() {                                 // step out beside the jeep, on foot into Sector 9
  const j = intro.jeep; const P = S.player;
  const c = coopSpread(j ? j.position.x - 2.4 : 0, j ? j.position.z + 1.2 : 0); P.x = c.x; P.z = c.z; P.yaw = 0;   // face forward, into the trees
  cam.yaw = 0; cam.pitch = -0.05; camera.up.set(0, 1, 0);
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9, P.z); playerMesh.rotation.y = P.yaw; }
  finishIntroCommon("INVESTIGATION · follow the tracks — reach the objective marker");
}

/* ── shared intro helpers (used by the boat & monorail cinematics) ── */
function introOpen(cap) {                                 // common DOM setup for a non-crash insertion intro
  if (playerMesh) playerMesh.visible = false;
  ["introTint", "introVig", "introBlack", "introRadio", "introBig"].forEach(k => { const e = $(k); if (e) e.style.opacity = "0"; });
  $("introMission").classList.remove("show");
  $("intro").classList.remove("hidden");
  $("introCap").textContent = cap; $("introCap").style.opacity = "1";
  $("hud").style.display = "none";
  S.phase = "intro";
}
function radioStep(arr) {                                 // advance the radio line for the active intro
  if (intro.line + 1 < arr.length && intro.t >= arr[intro.line + 1].t) {
    intro.line++; const e = arr[intro.line]; const r = $("introRadio"); r.innerHTML = e.h; r.style.opacity = "1";
    if (e.say || e.clip) { Audio.squelch(); playRadio(e); }
  }
}
function seatTroopers(group, seats, faceYaw, scale) {     // place the squad inside any vehicle, clearly crewed
  const cols = [0x4a5236, 0x595b40, 0x6b6f4a, 0x47513f, 0x5a6b3f];
  const n = Math.min(seats.length, Math.max(2, 1 + (typeof coopCount === "function" ? coopCount() : 2)));
  for (let i = 0; i < n; i++) { const s = seats[i], t = makeTrooper(cols[i % cols.length]); t.position.set(s[0], s[1], s[2]); t.rotation.y = faceYaw; t.scale.setScalar(scale || 0.82); group.add(t); }
}
function endIntroAtOrigin(msg) {                          // continuous hand-off: stand the player at the LZ facing forward
  const P = S.player; const c = coopSpread(0, 0); P.x = c.x; P.z = c.z; P.yaw = 0;
  cam.yaw = 0; cam.pitch = -0.05; camera.up.set(0, 1, 0);
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9, P.z); playerMesh.rotation.y = P.yaw; }
  finishIntroCommon(msg);
}

/* ── OPERATION BLACKOUT · armored river-boat insertion (dawn mist → tunnel → dock) ── */
function buildBoat() {                                    // detailed armored riverine patrol boat (bow = local +x, rides on the river)
  const b = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x3a4636, roughness: 0.8, metalness: 0.25 });
  const hullDk = new THREE.MeshStandardMaterial({ color: 0x2b3329, roughness: 0.85, metalness: 0.3 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x4a4f44, roughness: 0.92, metalness: 0.15 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x20231d, roughness: 0.9, metalness: 0.35 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x12201f, roughness: 0.18, metalness: 0.6, transparent: true, opacity: 0.6 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x6a6e68, roughness: 0.5, metalness: 0.7 });
  // hull: topsides + V-bottom meeting at a keel, armored chine rubrails
  const topside = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.7, 2.7), hullMat); topside.position.y = 0.5; b.add(topside);
  for (const s of [1, -1]) { const vb = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.5, 1.5), hullDk); vb.position.set(0, 0.05, s * 0.62); vb.rotation.x = s * 0.5; b.add(vb); }
  const keel = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.22, 0.3), hullDk); keel.position.y = -0.22; b.add(keel);
  for (const s of [1, -1]) { const rb = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.12, 0.14), trimMat); rb.position.set(0, 0.78, s * 1.36); b.add(rb); }
  const prow = new THREE.Mesh(new THREE.ConeGeometry(1.4, 1.9, 4), hullMat); prow.rotation.z = -Math.PI / 2; prow.rotation.y = Math.PI / 4; prow.position.set(4.0, 0.45, 0); b.add(prow);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.16, 2.4), deckMat); deck.position.y = 0.86; b.add(deck);
  for (const s of [1, -1]) { const gw = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.62, 0.18), hullMat); gw.position.set(-0.1, 1.16, s * 1.22); b.add(gw); }
  // pilot house (aft) with wrap windows + roof
  const house = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.4, 2.1), hullMat); house.position.set(-1.7, 1.66, 0); b.add(house);
  const houseRoof = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 2.25), trimMat); houseRoof.position.set(-1.7, 2.42, 0); b.add(houseRoof);
  const wf = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 1.8), glassMat); wf.position.set(-0.72, 1.9, 0); b.add(wf);
  for (const s of [1, -1]) { const ws = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 0.05), glassMat); ws.position.set(-1.7, 1.92, s * 1.02); b.add(ws); }
  { const ic = buildInstrumentCluster(1); ic.position.set(-1.0, 1.44, 0); b.add(ic); }   // helm console under the wrap windows
  // armored bow ramp (raised; drops at the dock)
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.5, 2.1), hullMat); ramp.position.set(2.9, 1.05, 0); ramp.rotation.z = 0.12; b.add(ramp);
  // pintle .50-cal gun mount on the bow deck
  const mount = new THREE.Group();
  mount.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.7, 8), metalMat), { position: new THREE.Vector3(0, 0.35, 0) }));
  mount.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.22), trimMat), { position: new THREE.Vector3(0, 0.72, 0) }));
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 8), trimMat); barrel.rotation.z = Math.PI / 2; barrel.position.set(0.7, 0.72, 0); mount.add(barrel);
  mount.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.7), hullDk), { position: new THREE.Vector3(-0.1, 0.78, 0) }));
  mount.position.set(1.5, 0.94, 0); b.add(mount);
  // searchlight on the house roof (real spot, forward)
  const lampHead = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.18, 14), new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xfff3d0, emissiveIntensity: 1.6, roughness: 0.3 }));
  lampHead.rotation.z = Math.PI / 2; lampHead.position.set(-0.9, 2.6, 0); b.add(lampHead);
  const beam = new THREE.SpotLight(0xfff0c4, 5, 50, 0.45, 0.5, 1.1); beam.position.set(-0.8, 2.6, 0); beam.target.position.set(20, -0.5, 0); b.add(beam); b.add(beam.target);
  // antenna whip, life ring, cleats, stern engine + wake foam
  b.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 2.0, 4), trimMat), { position: new THREE.Vector3(-2.5, 3.0, 0.6) }));
  const lr = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.09, 8, 16), new THREE.MeshStandardMaterial({ color: 0xd6562f, roughness: 0.8 })); lr.position.set(-2.7, 1.3, 1.0); lr.rotation.y = Math.PI / 2; b.add(lr);
  for (const px of [3.0, -3.0]) for (const s of [1, -1]) { const cl = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.22, 6), metalMat); cl.position.set(px, 0.97, s * 1.15); b.add(cl); }
  b.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 1.6), trimMat), { position: new THREE.Vector3(-3.3, 0.9, 0) }));
  const wake = new THREE.Mesh(new THREE.CircleGeometry(3.4, 24, 0, Math.PI), new THREE.MeshBasicMaterial({ color: 0xcfe0dc, transparent: true, opacity: 0.3, depthWrite: false }));
  wake.rotation.x = -Math.PI / 2; wake.rotation.z = -Math.PI / 2; wake.position.set(-5.4, -0.18, 0); b.add(wake); b.userData.wake = wake;
  b.userData.beam = beam;
  return b;
}
function buildDock(dx) {                                  // a proper jetty: planks on posts spanning channel→bank, perpendicular to the river
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x5b4a36, roughness: 0.95 });
  const woodDk = new THREE.MeshStandardMaterial({ color: 0x39302a, roughness: 1 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x4a4f4a, roughness: 0.6, metalness: 0.6 });
  const rc = riverCenter(dx), len = 18, cz = rc + 9.5;     // spans ~rc+0.5 .. rc+18.5
  g.add(new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.28, len), wood));
  for (let i = 0; i < 11; i++) { const pl = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.3, 0.12), woodDk); pl.position.set(0, 0.01, -len / 2 + 0.6 + i * (len - 1.2) / 10); g.add(pl); }
  for (let zz = -len / 2 + 1; zz <= len / 2 - 1; zz += 3) for (const px of [-1.55, 1.55]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 4.2, 8), woodDk); post.position.set(px, -2.0, zz); g.add(post); }
  for (const px of [-1.7, 1.7]) { g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, len), woodDk), { position: new THREE.Vector3(px, 0.7, 0) }));
    for (let zz = -len / 2 + 1; zz <= len / 2 - 1; zz += 2.4) { const rp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.08), woodDk); rp.position.set(px, 0.35, zz); g.add(rp); } }
  for (const px of [-1.3, 1.3]) { const bol = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.7, 8), metal); bol.position.set(px, 0.5, -len / 2 + 0.7); g.add(bol); }
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6), metal), { position: new THREE.Vector3(1.6, 1.3, -len / 2 + 0.7) }));
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffe6a8, emissive: 0xffd070, emissiveIntensity: 1.3 })); lamp.position.set(1.6, 2.5, -len / 2 + 0.7); g.add(lamp);
  g.add(Object.assign(new THREE.PointLight(0xffd9a0, 1.1, 18), { position: new THREE.Vector3(1.6, 2.5, -len / 2 + 0.7) }));
  for (const c of [[-1, 5.5], [1.1, 6.4]]) { const cr = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 1.0), woodDk); cr.position.set(c[0], 0.6, c[1]); g.add(cr); }
  g.position.set(dx, 1.4, cz);
  g.userData.standZ = cz + len / 2 + 1.6;                 // landward end → solid ground
  return g;
}
function positionBoatOnRiver(b, x, y) {                   // sit the boat on the channel centerline, bow aligned to the current
  const slope = riverSlope(x); b.position.set(x, y, riverCenter(x)); b.rotation.y = Math.atan2(-slope, 1);
}
function placeRiverDinos(startX) {                         // stage herbivores on the banks — the Lost World reveal as you motor past
  const herb = dinos.filter(d => d.alive && d.sp && d.sp.diet !== "carnivore");
  const spots = [[-42, 15], [-18, -15], [6, 16], [-56, -14], [-30, 14]];
  for (let i = 0; i < Math.min(herb.length, spots.length); i++) {
    const d = herb[i], sx = spots[i][0], sz = riverCenter(sx) + spots[i][1];
    d.x = sx; d.z = sz; if (d.mesh) d.mesh.position.set(sx, groundH(sx, sz), sz);
  }
}
function startIntroBoat() {
  const b = buildBoat(); const startX = -64;
  positionBoatOnRiver(b, startX, WATER_Y);
  seatTroopers(b, [[-1.7, 1.32, 0.7], [-1.7, 1.32, -0.7], [0.3, 1.38, 0.6], [0.3, 1.38, -0.6]], Math.PI / 2, 0.82);
  scene.add(b); introProp = b;
  intro = { kind: "boat", t: 0, phase: "river", boat: b, bx: startX, dockX: 6, line: -1, shake: 0.04, camActive: true };
  introOpen("Jurassic Survival · Power Restoration · River insertion");
  intro._prevFog = scene.fog; scene.fog = new THREE.FogExp2(new THREE.Color(0x8aa0a4), 0.02);   // thick, mystic Lost World haze
  const dock = buildDock(intro.dockX); scene.add(dock); introExtra.push(dock); intro.dock = dock;
  placeRiverDinos(startX);
}
function updateIntroBoat(dt) {
  if (!intro) return;
  intro.t += dt; const T = intro.t, b = intro.boat, tint = $("introTint"), cap = $("introCap");
  radioStep(INTRO_RADIO_BOAT);
  const near = intro.dockX - intro.bx, speed = near < 10 ? 3.5 : 7.5;     // ease in to the dock
  intro.bx = Math.min(intro.dockX, intro.bx + speed * dt);
  positionBoatOnRiver(b, intro.bx, WATER_Y + Math.sin(T * 1.5) * 0.05);
  b.rotation.z = Math.sin(T * 1.0) * 0.025;
  if (b.userData.wake) b.userData.wake.material.opacity = 0.22 + Math.abs(Math.sin(T * 4)) * 0.12;
  const prog = (intro.bx - (-64)) / (intro.dockX - (-64));
  tint.style.background = "#5a6e72"; tint.style.opacity = (0.34 - prog * 0.12).toFixed(2);   // mist thins as you arrive
  cap.style.opacity = T > 4.5 ? "0" : "1";
  intro.phase = prog > 0.86 ? "dock" : "river";
  if (intro.bx >= intro.dockX - 0.05) { if (intro.boat) scene.remove(intro.boat); endIntroBoat(); }
}
function updateIntroCameraBoat() {
  const b = intro.boat; if (!b) return;
  const slope = riverSlope(intro.bx), inv = 1 / Math.hypot(1, slope), vx = inv, vz = slope * inv;   // unit travel dir
  camera.position.lerp(tmp.set(b.position.x - vx * 8.5, b.position.y + 3.1, b.position.z - vz * 8.5), 0.06);
  camera.lookAt(b.position.x + vx * 6, b.position.y + 1.1, b.position.z + vz * 6);
  if (intro.shake > 0) { camera.position.x += (Math.random() - 0.5) * intro.shake; camera.position.y += (Math.random() - 0.5) * intro.shake; }
}
function endIntroBoat() {
  introProp = null;
  if (intro && intro._prevFog !== undefined) scene.fog = intro._prevFog;
  const dx = intro.dockX, sz = intro.dock ? intro.dock.userData.standZ : riverCenter(dx) + 19;
  const P = S.player; const c = coopSpread(dx, sz); P.x = c.x; P.z = c.z; P.yaw = -Math.PI / 2;   // step off onto the dock, facing the valley/objective
  cam.yaw = -Math.PI / 2; cam.pitch = -0.05; camera.up.set(0, 1, 0);
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9, P.z); playerMesh.rotation.y = P.yaw; }
  finishIntroCommon("POWER RESTORATION · restart the stations — reach the objective marker");
}

/* ── THE LAST SAMPLE · abandoned monorail arrival (transit → power loss → besieged facility) ── */
function buildMonorail() {                                // interior-open tram car (front = local +x)
  const c = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c4, roughness: 0.55, metalness: 0.4, side: THREE.DoubleSide });
  const innerMat = new THREE.MeshStandardMaterial({ color: 0x6d7478, roughness: 0.82, metalness: 0.2, side: THREE.DoubleSide });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x223033, roughness: 0.2, metalness: 0.5, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x2a2e30, roughness: 0.7, metalness: 0.3 });
  const L = 5.2, W = 2.5, H = 2.5;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(L, 0.12, W), innerMat); floor.position.y = 0.76; c.add(floor);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(L, 0.14, W), bodyMat); roof.position.y = 0.76 + H; c.add(roof);
  for (const sz of [W / 2, -W / 2]) {
    const lower = new THREE.Mesh(new THREE.BoxGeometry(L, 0.9, 0.08), bodyMat); lower.position.set(0, 1.25, sz); c.add(lower);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(L - 0.3, 1.0, 0.05), glassMat); glass.position.set(0, 2.1, sz); c.add(glass);
  }
  const rear = new THREE.Mesh(new THREE.BoxGeometry(0.1, H, W), bodyMat); rear.position.set(-L / 2, 0.76 + H / 2, 0); c.add(rear);
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.08, H - 0.7, W - 0.2), glassMat); front.position.set(L / 2, 1.0 + (H - 0.7) / 2, 0); c.add(front);
  const noseTop = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, W), bodyMat); noseTop.position.set(L / 2, 0.76 + H - 0.18, 0); c.add(noseTop);
  const noseBot = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, W), bodyMat); noseBot.position.set(L / 2, 0.98, 0); c.add(noseBot);
  { const ic = buildInstrumentCluster(0.95); ic.position.set(L / 2 - 0.55, 1.06, 0); c.add(ic); }   // driver console at the nose
  const strip = new THREE.Mesh(new THREE.BoxGeometry(L - 0.4, 0.06, 0.1), new THREE.MeshStandardMaterial({ color: 0xdfe7c8, emissive: 0xdfe7c8, emissiveIntensity: 0.8 })); strip.position.set(0, 0.76 + H - 0.1, 0); c.add(strip);
  const cab = new THREE.PointLight(0xcfe0d6, 0.9, 9); cab.position.set(0, 2.3, 0); c.add(cab);
  const under = new THREE.Mesh(new THREE.BoxGeometry(L - 0.4, 0.4, 1.0), trimMat); under.position.set(0, 0.5, 0); c.add(under);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(L + 8, 0.4, 0.6), new THREE.MeshStandardMaterial({ color: 0x3a3e38, roughness: 0.9 })); beam.position.set(0, 0.18, 0); c.add(beam);
  // interior fit-out: side benches the crew sit on, grab poles, and a lit destination sign (believable transit car)
  for (const sz of [W / 2 - 0.22, -(W / 2 - 0.22)]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(L - 1.0, 0.12, 0.42), trimMat); bench.position.set(-0.3, 1.06, sz); c.add(bench);
    const bback = new THREE.Mesh(new THREE.BoxGeometry(L - 1.0, 0.4, 0.08), trimMat); bback.position.set(-0.3, 1.3, sz + (sz > 0 ? 0.18 : -0.18)); c.add(bback);
  }
  for (const px of [-1.6, -0.2, 1.0]) { const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, H - 0.3, 8), new THREE.MeshStandardMaterial({ color: 0xd8a23a, roughness: 0.4, metalness: 0.7 })); pole.position.set(px, 0.76 + (H - 0.3) / 2, 0); c.add(pole); }
  const sign = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 0.04), new THREE.MeshStandardMaterial({ color: 0x0a2a2e, emissive: 0x1d9b76, emissiveIntensity: 0.9 })); sign.position.set(-L / 2 + 0.09, 2.45, 0); sign.rotation.y = Math.PI / 2; c.add(sign);
  c.userData.cabLight = cab; c.userData.strip = strip;
  return c;
}
// Ground-level monorail guideway: the long concrete straddle-beam the car rides, running the length of
// the line, with periodic footings + a moss-grown top so it reads as real, weathered track.
function buildMonorailRail(x, z0, z1) {
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8f8c, roughness: 0.92, metalness: 0.05 });
  const moss = new THREE.MeshStandardMaterial({ color: 0x5a6b46, roughness: 1 });
  const mid = (z0 + z1) / 2, len = Math.abs(z1 - z0), railY = groundH(x, mid) + 0.18;   // straddle-beam under the car body
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, len), concrete); beam.position.set(x, railY, mid); g.add(beam);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.1, len), moss); cap.position.set(x, railY + 0.3, mid); g.add(cap);
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 9) { const gy = groundH(x, z); const foot = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 1.2), concrete); foot.position.set(x, gy + 0.05, z); g.add(foot); }   // ground footings
  return g;
}
// Ruined arrival station beside the track: a low platform at car-floor height, snapped columns, a
// collapsed canopy, vines + rubble — an overgrown Jurassic transit stop.
function buildMonorailStation(x, z) {
  const g = new THREE.Group(); const gy = groundH(x, z); g.position.set(x, gy, z);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8d83, roughness: 0.95, flatShading: true });
  const rust = new THREE.MeshStandardMaterial({ color: 0x6f4630, roughness: 1, metalness: 0.2 });
  const moss = new THREE.MeshStandardMaterial({ color: 0x5a6b46, roughness: 1 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 0.7, 12), concrete); deck.position.set(3.4, 0.55, 0); g.add(deck);          // step-off platform ~car-floor height
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0xd8a23a, roughness: 0.7 })); edge.position.set(0.9, 0.65, 0); g.add(edge);   // yellow platform edge line
  for (const pz of [-4.5, 0.5, 4.5]) { const col = new THREE.Mesh(new THREE.BoxGeometry(0.45, 3.6, 0.45), concrete); col.position.set(5.8, 1.9, pz); col.rotation.z = (pz === 0.5 ? 0.12 : 0); g.add(col); }   // one leaning
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.28, 12), rust); canopy.position.set(3.2, 3.7, 0.5); canopy.rotation.z = -0.12; g.add(canopy);                                  // sagging roof
  for (let i = 0; i < 6; i++) { const r = new THREE.Mesh(new THREE.BoxGeometry(rand(1, 2.4), 0.3, 0.3), i % 2 ? moss : concrete); r.position.set(3 + rand(-2, 2), 0.95, rand(-5, 5)); r.rotation.y = rand(0, 6); g.add(r); }   // rubble on the deck
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, 3.0), [rust, rust, rust, rust, new THREE.MeshStandardMaterial({ color: 0x1a1d18, emissive: 0x0a3a2e, emissiveIntensity: 0.5 }), rust]); sign.position.set(6.05, 3.0, 0); g.add(sign);   // faded SECTOR 4 sign
  return g;
}
function startIntroMonorail() {
  const y0 = groundH(0, 30);
  let c;
  try { c = buildMonorail(); } catch (e) { console.warn("monorail car", e); c = new THREE.Group(); }   // never let a decoration kill the intro
  c.position.set(0, y0, 60); c.rotation.y = Math.PI / 2;   // front (+x) → world −z
  try { seatTroopers(c, [[-1.5, 1.16, 0.78], [-1.5, 1.16, -0.78], [0.1, 1.16, 0.78]], Math.PI / 2, 0.82); } catch (e) { console.warn("monorail crew", e); }
  try { const rail = buildMonorailRail(0, -16, 92), stn = buildMonorailStation(0, 2); scene.add(rail); scene.add(stn); introExtra.push(rail, stn); } catch (e) { console.warn("monorail scene", e); }   // visible guideway + ruined station
  scene.add(c); introProp = c;
  intro = { kind: "monorail", t: 0, phase: "transit", car: c, y0, line: -1, shake: 0, camActive: true };
  introOpen("Jurassic Survival · The Last Sample · Sector 4");
}
function updateIntroMonorail(dt) {
  if (!intro) return;
  intro.t += dt; const T = intro.t, c = intro.car, tint = $("introTint"), cap = $("introCap");
  radioStep(INTRO_RADIO_MONO);
  if (c) c.position.y = intro.y0;
  const driveTo = (tz, rate) => { if (c) c.position.z += (tz - c.position.z) * dt * rate; };
  if (T < 6) {                            // 1 · gliding transit through the dark
    intro.phase = "transit"; intro.shake = 0.035; driveTo(34, 0.5);
    tint.style.background = "#10151a"; tint.style.opacity = "0.34"; cap.style.opacity = T > 4.5 ? "0" : "1";
    if (c && c.userData.cabLight) c.userData.cabLight.intensity = 0.9;
  } else if (T < 9) {                     // 2 · power loss — lights flicker, car coasts
    intro.phase = "stall"; intro.shake = 0.03; driveTo(24, 0.25);
    const fl = Math.abs(Math.sin(T * 11)) > 0.5 ? 1 : 0.15;
    if (c && c.userData.cabLight) c.userData.cabLight.intensity = 0.25 * fl;
    if (c && c.userData.strip) c.userData.strip.material.emissiveIntensity = 0.8 * fl;
    tint.style.background = "#04060a"; tint.style.opacity = "0.62";
  } else if (T < 13) {                    // 3 · limp into the besieged platform (alarm glow)
    intro.phase = "arrive"; intro.shake = 0.05; driveTo(8, 0.8);
    if (c && c.userData.cabLight) c.userData.cabLight.intensity = 0.5;
    if (c && c.userData.strip) c.userData.strip.material.emissiveIntensity = 0.6;
    tint.style.background = "#2a1410"; tint.style.opacity = (0.26 + Math.abs(Math.sin(T * 6)) * 0.12).toFixed(2);
  } else { if (intro.car) scene.remove(intro.car); endIntroMonorail(); }
}
function updateIntroCameraMonorail() {
  const c = intro.car; if (!c) return;
  // RIGID follow (no lerp) so the camera moves exactly with the moving car — a lerping camera trailed
  // the car as it drove, so the car kept sliding out of frame & back ("disappears and reappears").
  camera.position.set(c.position.x + 0.55, c.position.y + 1.5, c.position.z + 1.7);   // inside, just behind the seated crew, looking forward
  camera.lookAt(c.position.x, c.position.y + 1.2, c.position.z - 9);
  if (intro.shake > 0) { camera.position.x += (Math.random() - 0.5) * intro.shake; camera.position.y += (Math.random() - 0.5) * intro.shake * 0.6; }
}
function endIntroMonorail() { introProp = null; endIntroAtOrigin("THE LAST SAMPLE · restore power & retrieve the sample — reach the objective"); }

/* ── Phase 4 · player-steered descent (shared by the HALO parachute & the evac airship) ── *
 * The pre-jump cinematic (transport bay / airship deck) hands off to a CONTROLLABLE canopy:
 * the player steers with the stick / A-D, flares with S (pull back), and lands where they choose.
 * This is real player control inside the intro — not a rail. */
function buildTransportBay() {                            // C-130-style fuselage interior (rear ramp at +x, open to the storm)
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a3f3a, roughness: 0.85, metalness: 0.3, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23261f, roughness: 0.9, metalness: 0.2, side: THREE.DoubleSide });
  const L = 11, W = 3.6, H = 2.8;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(L, 0.2, W), dark); g.add(floor);
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(L, 0.2, W), mat); ceil.position.y = H; g.add(ceil);
  for (const sz of [W / 2, -W / 2]) { const wall = new THREE.Mesh(new THREE.BoxGeometry(L, H, 0.2), mat); wall.position.set(0, H / 2, sz); g.add(wall); }
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.2, H, W), mat); front.position.set(-L / 2, H / 2, 0); g.add(front);   // cockpit bulkhead
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.18, W - 0.2), dark); ramp.position.set(L / 2 + 1.1, -0.5, 0); ramp.rotation.z = 0.5; g.add(ramp);   // lowered rear ramp
  for (let i = -1; i <= 1; i++) { const rib = new THREE.Mesh(new THREE.TorusGeometry(W * 0.52, 0.08, 6, 14, Math.PI), mat); rib.position.set(i * 3, 0.1, 0); rib.rotation.z = -Math.PI / 2; g.add(rib); }
  g.add(Object.assign(new THREE.PointLight(0x9fb0c0, 0.7, 13), { position: new THREE.Vector3(0, H - 0.4, 0) }));
  g.add(Object.assign(new THREE.PointLight(0xbcd0e6, 1.6, 22), { position: new THREE.Vector3(L / 2 + 2, 1, 0) }));   // storm light through the open ramp
  const jl = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), new THREE.MeshStandardMaterial({ color: 0xd6562f, emissive: 0xd6562f, emissiveIntensity: 1.6 }));
  jl.position.set(L / 2 - 0.7, H - 0.5, W / 2 - 0.3); g.add(jl); g.userData.jumpLight = jl;
  return g;
}
function buildAirshipDeck() {                             // open flight deck of the evac carrier (jump edge at +z)
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.8, metalness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.9, metalness: 0.3 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 0.4, 8), mat); g.add(deck);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(14, 3.2, 0.4), mat); wall.position.set(0, 1.6, -3.8); g.add(wall);
  const board = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.4, 0.1), new THREE.MeshStandardMaterial({ color: 0x0c2a30, emissive: 0x1d6b76, emissiveIntensity: 0.9 })); board.position.set(-3.2, 1.9, -3.55); g.add(board);
  for (const px of [-6, -3, 0, 3, 6]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6), dark); post.position.set(px, 0.7, 3.7); g.add(post); }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(13, 0.1, 0.1), dark); rail.position.set(0, 1.2, 3.7); g.add(rail);
  for (const c of [[5, -2], [-5, 1]]) { const cr = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 1.2), dark); cr.position.set(c[0], 0.7, c[1]); g.add(cr); }
  g.add(Object.assign(new THREE.PointLight(0xffb070, 1.3, 26), { position: new THREE.Vector3(0, 1.5, 9) }));   // burning island glow from below the bow
  g.add(Object.assign(new THREE.PointLight(0xcfe0ff, 0.6, 16), { position: new THREE.Vector3(0, 3, -2) }));
  return g;
}
function buildParachute() {
  const g = new THREE.Group();
  const canMat = new THREE.MeshStandardMaterial({ color: 0x46553a, roughness: 0.92, metalness: 0.04, side: THREE.DoubleSide });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xc9772f, roughness: 0.9, side: THREE.DoubleSide });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.8, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), canMat); dome.position.y = 2.8; g.add(dome);
  const band = new THREE.Mesh(new THREE.SphereGeometry(2.83, 18, 6, 0, Math.PI * 2, Math.PI * 0.34, Math.PI * 0.12), stripeMat); band.position.y = 2.8; g.add(band);
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; const ln = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 3.0, 4), new THREE.MeshBasicMaterial({ color: 0x14140e })); ln.position.set(Math.cos(a) * 2.0, 1.35, Math.sin(a) * 2.0); ln.rotation.x = Math.sin(a) * 0.26; ln.rotation.z = -Math.cos(a) * 0.26; g.add(ln); }
  return g;
}
function steerXZ() {   // unified steering intent (touch stick / gamepad already in input.mx/mz, plus WASD/arrows)
  let ix = input.mx, iz = input.mz;
  if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
  return { x: clamp(ix, -1, 1), z: clamp(iz, -1, 1) };
}
// Descent profiles — the airship offers a real choice; HALO is always a parachute.
const DESCENT = {
  chute: { off: 42, alt: 102, fwdN: 8.5, fwdD: 14, fwdF: 3.5, vN: 6, vD: 11, vF: 2.2, steer: 1.25, wind: 1.2, chute: true },
  rope: { off: 9, alt: 72, fwdN: 2, fwdD: 3, fwdF: 1.2, vN: 13, vD: 17, vF: 6.5, steer: 0.5, wind: 0.25, chute: false },   // fast, near-vertical fast-rope
  wing: { off: 62, alt: 118, fwdN: 20, fwdD: 27, fwdF: 10, vN: 6.5, vD: 10, vF: 3.5, steer: 1.7, wind: 1.0, chute: false }, // fast, shallow wingsuit glide
};
function beginCanopy(tx, tz) {   // hand off from the pre-jump cinematic into the controllable descent
  if (introProp) { scene.remove(introProp); introProp = null; }
  intro.bay = null; intro.deck = null;
  const D = DESCENT[intro.descent] || DESCENT.chute;
  intro.tx = tx; intro.tz = tz;
  intro.cx = tx - D.off; intro.cz = tz - D.off; intro.cy = D.alt;          // start high & off-target so you must steer
  intro.heading = Math.atan2(tx - intro.cx, tz - intro.cz);
  intro.vdesc = D.vN; intro.ct = 0; intro.phase = "canopy"; intro.shake = 0.015; intro._canopyLine = false;
  if (D.chute) { intro.chute = buildParachute(); scene.add(intro.chute); }   // wingsuit/fast-rope have no canopy
  const ring = new THREE.Mesh(new THREE.RingGeometry(5.4, 6.0, 40), new THREE.MeshBasicMaterial({ color: 0x8fb8c4, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(tx, groundH(tx, tz) + 0.15, tz); scene.add(ring); intro.ring = ring;
  Audio.squelch();
}
function updateCanopyPhase(dt) {
  if (!intro) return;
  intro.t += dt; intro.ct += dt; const big = $("introBig");
  if (!intro._canopyLine && intro.ct > 1.0) {   // Commander's canopy/descent line
    intro._canopyLine = true; const e = intro.kind === "airship" ? LINE_AIRSHIP_DOWN : LINE_HALO_CANOPY;
    const r = $("introRadio"); r.innerHTML = e.h; r.style.opacity = "1"; Audio.squelch(); playRadio(e);
  }
  const D = DESCENT[intro.descent] || DESCENT.chute, s = steerXZ();
  intro.heading += s.x * dt * D.steer;                    // steer left / right
  const flare = s.z > 0.2, dive = s.z < -0.2;
  const fwd = flare ? D.fwdF : dive ? D.fwdD : D.fwdN;
  intro.vdesc = flare ? D.vF : dive ? D.vD : D.vN;
  intro.cx += (Math.sin(intro.heading) * fwd + D.wind) * dt;   // forward + gentle wind drift
  intro.cz += (Math.cos(intro.heading) * fwd) * dt;
  intro.cy -= intro.vdesc * dt;
  const half = BIOME.map.size / 2 - 6; intro.cx = clamp(intro.cx, -half, half); intro.cz = clamp(intro.cz, -half, half);
  const gy = groundH(intro.cx, intro.cz), py = Math.max(gy + 0.9, intro.cy);
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(intro.cx, py, intro.cz); playerMesh.rotation.y = intro.heading; playerMesh.rotation.x = intro.descent === "wing" ? 0.5 : 0; }
  if (intro.chute) { intro.chute.position.set(intro.cx, py + 2.5, intro.cz); intro.chute.rotation.y = intro.heading; intro.chute.rotation.z = -s.x * 0.32; }
  const near = intro.cy - gy;
  if (near < 20) { big.textContent = "FLARE — PULL BACK ▼"; big.style.opacity = "1"; }
  else if (intro.ct < 5.5) { big.textContent = isTouch ? "STEER WITH THE STICK · HOLD DOWN TO FLARE" : "STEER  A / D  ·  HOLD  S  TO FLARE"; big.style.opacity = "1"; }
  else big.style.opacity = "0";
  if (intro.cy <= gy + 0.95 || intro.ct > 55) { if (playerMesh) playerMesh.rotation.x = 0; landCanopy(intro.vdesc > 7 && !flare && intro.descent !== "rope"); }
}
// ---- free-walk the pre-jump vehicle (transport bay / airship deck) ----
function platformWalk(dt, plat, b, exit) {   // move the player on the platform; returns true at the exit edge
  const s = steerXZ(), spd = 3.4;
  let dx, dz; if (exit === "x") { dx = -s.z; dz = s.x; } else { dz = -s.z; dx = s.x; }   // stick-up → toward the exit
  intro.px = clamp(intro.px + dx * spd * dt, b.xmin, b.xmax);
  intro.pz = clamp(intro.pz + dz * spd * dt, b.zmin, b.zmax);
  if (Math.hypot(dx, dz) > 0.05) intro.pyaw = Math.atan2(dx, dz);
  const wx = plat.position.x + intro.px, wy = plat.position.y + 0.9, wz = plat.position.z + intro.pz;
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(wx, wy, wz); playerMesh.rotation.y = intro.pyaw; }
  intro._pwx = wx; intro._pwy = wy; intro._pwz = wz;
  return exit === "x" ? intro.px >= b.xmax - 0.15 : intro.pz >= b.zmax - 0.15;
}
function platformCam(exit) {
  const wx = intro._pwx, wy = intro._pwy, wz = intro._pwz; if (wx == null) return;
  if (exit === "x") { camera.position.lerp(tmp.set(wx - 4.8, wy + 2.1, wz + 0.2), 0.12); camera.lookAt(wx + 4, wy + 0.7, wz); }
  else { camera.position.lerp(tmp.set(wx + 0.2, wy + 2.2, wz - 4.8), 0.12); camera.lookAt(wx, wy + 0.7, wz + 5); }
}
function placeOnPlatform(plat) {   // static stand during the opening cinematic, before walk control
  const wx = plat.position.x + intro.px, wy = plat.position.y + 0.9, wz = plat.position.z + intro.pz;
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(wx, wy, wz); playerMesh.rotation.y = intro.pyaw; }
  intro._pwx = wx; intro._pwy = wy; intro._pwz = wz;
}
const jumpPressed = () => keys.has("KeyE") || keys.has("Space") || input.action;
function updateCanopyCamera() {
  const a = intro.heading, gy = groundH(intro.cx, intro.cz), py = Math.max(gy + 0.9, intro.cy);
  camera.position.lerp(tmp.set(intro.cx - Math.sin(a) * 10.5, py + 5.2, intro.cz - Math.cos(a) * 10.5), 0.09);
  camera.lookAt(intro.cx + Math.sin(a) * 5, py - 0.8, intro.cz + Math.cos(a) * 5);
  if (intro.shake > 0) { camera.position.x += (Math.random() - 0.5) * intro.shake; camera.position.y += (Math.random() - 0.5) * intro.shake; }
}
function landCanopy(hard) {
  if (intro.chute) scene.remove(intro.chute);
  if (intro.ring) scene.remove(intro.ring);
  const air = intro.kind === "airship";
  const P = S.player; const c = coopSpread(intro.cx, intro.cz); P.x = c.x; P.z = c.z; P.yaw = intro.heading;
  cam.yaw = intro.heading; cam.pitch = -0.05; camera.up.set(0, 1, 0);
  if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9, P.z); playerMesh.rotation.y = P.yaw; }
  if (hard) { P.stamina = Math.max(15, P.stamina - 30); flash(); }
  const base = air ? "EXTINCTION PROTOCOL · reach the Command Center" : "RESCUE · reach Outpost Echo & find Maya";
  finishIntroCommon((hard ? "HARD LANDING · " : "✓ touchdown · ") + base);
}
/* HALO parachute — FALLEN OUTPOST */
function startIntroHalo() {
  const bay = buildTransportBay(); bay.position.set(0, 100, 0);
  seatTroopers(bay, [[-3.6, 0.1, 1.3], [-3.6, 0.1, -1.3], [-1.6, 0.1, 1.3]], Math.PI / 2, 0.85);   // paratroopers along the wall
  scene.add(bay); introProp = bay;
  intro = { kind: "halo", t: 0, phase: "bay", bay, line: -1, shake: 0.05, camActive: true, descent: "chute", px: -2.5, pz: 0, pyaw: Math.PI / 2 };
  introOpen("Jurassic Survival · Rescue · Ranger Outpost Echo");
  placeOnPlatform(bay);   // you, standing in the bay
}
function updateIntroHalo(dt) {
  if (!intro) return;
  if (intro.phase === "canopy") return updateCanopyPhase(dt);
  intro.t += dt; const T = intro.t, tint = $("introTint"), cap = $("introCap"), big = $("introBig");
  radioStep(INTRO_RADIO_HALO);
  tint.style.background = "#1c2630"; tint.style.opacity = (0.34 + (Math.sin(T * 13) > 0.95 ? 0.42 : 0)).toFixed(2);   // storm + lightning flashes
  if (T < 6) { intro.phase = "bay"; cap.style.opacity = T > 4.5 ? "0" : "1"; placeOnPlatform(intro.bay); big.style.opacity = "0"; }
  else {                                  // green light — walk the bay to the open ramp, then step off
    intro.phase = "walk";
    if (intro.bay.userData.jumpLight) { const j = intro.bay.userData.jumpLight.material; j.color.setHex(0x6fae6b); j.emissive.setHex(0x6fae6b); }
    const atRamp = platformWalk(dt, intro.bay, { xmin: -4.7, xmax: 5.0, zmin: -1.3, zmax: 1.3 }, "x");
    big.textContent = atRamp ? "▼ STEP OFF — JUMP" : (isTouch ? "MOVE TO THE OPEN RAMP" : "WALK TO THE RAMP · W A S D"); big.style.opacity = "1";
    if (intro.px >= 4.9 || (atRamp && jumpPressed()) || T >= 24) { big.style.opacity = "0"; intro.descent = "chute"; beginCanopy(70, -70); }
  }
}
function updateIntroCameraHalo() {
  if (intro.phase === "canopy") return updateCanopyCamera();
  if (intro.phase === "walk") return platformCam("x");
  const b = intro.bay; if (!b) return;
  camera.position.lerp(tmp.set(b.position.x - 3.6, b.position.y + 1.7, b.position.z + 0.3), 0.08);
  camera.lookAt(b.position.x + 5, b.position.y + 1.0, b.position.z);
  if (intro.shake > 0) { camera.position.x += (Math.random() - 0.5) * intro.shake; camera.position.y += (Math.random() - 0.5) * intro.shake; }
}
/* Evac airship — EXTINCTION PROTOCOL (walk the deck, pick a descent pad, step off) */
function addDescentPads(deck) {
  const defs = [[-3.5, "rope", 0x5b9fd6, "FAST-ROPE"], [0, "chute", 0x6fae6b, "PARACHUTE"], [3.5, "wing", 0xc9772f, "WINGSUIT"]];
  const pads = [];
  for (const [px, kind, col, label] of defs) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(1.15, 24), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(px, 0.24, 2.8); deck.add(pad);
    const tag = makeNameTag(label); tag.scale.set(2.0, 0.5, 1); tag.position.set(px, 1.5, 2.8); deck.add(tag);
    pads.push({ px, kind, pad });
  }
  deck.userData.pads = pads;
}
function startIntroAirship() {
  const deck = buildAirshipDeck(); deck.position.set(0, 92, 0);
  seatTroopers(deck, [[-4.5, 0.2, -1.6], [4.5, 0.2, -1.6], [-2, 0.2, -2.4]], 0, 0.85);
  addDescentPads(deck);
  scene.add(deck); introProp = deck;
  intro = { kind: "airship", t: 0, phase: "deck", deck, line: -1, shake: 0.06, camActive: true, descent: "chute", px: 0, pz: -2.6, pyaw: 0 };
  introOpen("Jurassic Survival · Extinction Protocol · Final evacuation");
  placeOnPlatform(deck);   // you, on the flight deck
}
function updateIntroAirship(dt) {
  if (!intro) return;
  if (intro.phase === "canopy") return updateCanopyPhase(dt);
  intro.t += dt; const T = intro.t, tint = $("introTint"), cap = $("introCap"), big = $("introBig");
  radioStep(INTRO_RADIO_AIRSHIP);
  tint.style.background = T < 6 ? "#3a1c10" : "#5a1810"; tint.style.opacity = (0.3 + (T > 6 ? Math.abs(Math.sin(T * 8)) * 0.18 : 0)).toFixed(2);   // fiery glow → breach alarm
  if (T < 6) { intro.phase = "deck"; cap.style.opacity = T > 4.5 ? "0" : "1"; placeOnPlatform(intro.deck); big.style.opacity = "0"; }
  else {                                  // breach — walk to a descent pad and step off the edge
    intro.phase = "walk";
    const atEdge = platformWalk(dt, intro.deck, { xmin: -6.3, xmax: 6.3, zmin: -3.0, zmax: 3.4 }, "z");
    intro.descent = intro.px < -1.8 ? "rope" : intro.px > 1.8 ? "wing" : "chute";   // pad under you sets the descent
    const label = intro.descent === "rope" ? "FAST-ROPE" : intro.descent === "wing" ? "WINGSUIT" : "PARACHUTE";
    if (intro.deck.userData.pads) for (const p of intro.deck.userData.pads) p.pad.material.emissiveIntensity = p.kind === intro.descent ? 1.4 : 0.4;
    big.textContent = atEdge ? `▼ STEP OFF — ${label}` : (isTouch ? "PICK A PAD · STEP OFF THE EDGE" : "WALK TO A PAD (ROPE/CHUTE/WING) · STEP OFF"); big.style.opacity = "1";
    if (intro.pz >= 3.3 || (atEdge && jumpPressed()) || T >= 24) { big.style.opacity = "0"; beginCanopy(0, -86); }
  }
}
function updateIntroCameraAirship() {
  if (intro.phase === "canopy") return updateCanopyCamera();
  if (intro.phase === "walk") return platformCam("z");
  const d = intro.deck; if (!d) return;
  camera.position.lerp(tmp.set(d.position.x, d.position.y + 2.3, d.position.z - 3.2), 0.06);
  camera.lookAt(d.position.x, d.position.y + 1.3, d.position.z + 9);
  if (intro.shake > 0) { camera.position.x += (Math.random() - 0.5) * intro.shake; camera.position.y += (Math.random() - 0.5) * intro.shake; }
}
function lockPointer() {   // pointer lock needs a user gesture; the timer-driven auto-end may be rejected — canvas click recovers it
  if (isTouch) return;
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function skipIntro() {
  if (!intro) return;
  if (intro.heli) scene.remove(intro.heli.group);
  if (intro.kind === "jeep") { endIntroJeep(); return; }
  if (intro.kind === "boat") { if (intro.boat) scene.remove(intro.boat); endIntroBoat(); return; }   // endIntroBoat restores fog
  if (intro.kind === "monorail") { if (intro.car) scene.remove(intro.car); endIntroMonorail(); return; }
  if (intro.kind === "halo" || intro.kind === "airship") {
    if (intro.bay) scene.remove(intro.bay); if (intro.deck) scene.remove(intro.deck);
    if (intro.chute) scene.remove(intro.chute); if (intro.ring) scene.remove(intro.ring); introProp = null;
    const air = intro.kind === "airship", tx = intro.tx != null ? intro.tx : (air ? 0 : 70), tz = intro.tz != null ? intro.tz : (air ? -86 : -70);
    const P = S.player; const c = coopSpread(tx, tz); P.x = c.x; P.z = c.z; P.yaw = 0; cam.yaw = 0; cam.pitch = -0.05; camera.up.set(0, 1, 0);
    if (playerMesh) { playerMesh.visible = true; playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9, P.z); playerMesh.rotation.y = 0; }
    finishIntroCommon(air ? "EXTINCTION PROTOCOL · reach the Command Center" : "RESCUE · reach Outpost Echo & find Maya");
    return;
  }
  if (intro.kind === "research") { Audio.rotor(false); endIntroResearch(); return; }
  if (!wreckMesh) wreckMesh = buildWreck(intro.wx, intro.wz);
  const c = coopSpread(0, 0); S.player.x = c.x; S.player.z = c.z; placeAtWreck();
  Audio.rotor(false); endIntro();
}

/* ================================================== run lifecycle ======== */
function startRun() {
  // reset
  for (const d of dinos) scene.remove(d.mesh); dinos = []; dinosByNetId.clear(); _netDinoId = 0;   // P-09: recycle net-ids each run so they don't grow unbounded across replays
  clearRemotes(); clearEvac(); clearFx(); clearWreck(); clearField(); clearIntroProp(); clearMissionSites(); clearBoss(); preloadRadio();
  decoy.t = 0; selTool = 0; TOOLS.forEach(t => { t.charges = t.max; t.cd = 0; });   // fresh kit each run
  applyUnlocks();                                                                     // persistent progression: veteran loadout bonuses
  // co-op: all players seed from the room so terrain/beacon/initial spawns match (dinos drift locally, v2: host sync)
  reseed(Net.on ? (Net.seed >>> 0) : ((Math.random() * 1e9) >>> 0));
  Object.assign(S.player, { x: 0, z: 0, yaw: 0, hp: 100, stamina: 100, noise: 0, fear: 0, gait: "idle", alive: true, role: selectedRole, onTower: null, zip: null, air: 0, vy: 0, onProp: null, eyeY: null, swim: false, dive: false, oxygen: 100, hunger: 100, thirst: 100, temp: 0, injured: false, moveYaw: 0, _moving: false, _lastStick: 0 });
  if (Net.on) {   // co-op: spawn beside each other like a squad — a small cluster, same facing, no overlap
    const a = (Net.id || 1) * 2.39996;   // golden-angle spread → distinct, non-overlapping spots
    S.player.x = Math.cos(a) * 3.0; S.player.z = Math.sin(a) * 3.0; S.player.yaw = 0;
  }
  buildPlayer();   // (re)build the chosen specialist as the player avatar
  S.threat = 0; S.t = 0; S._everInRange = false; S._lastBeep = 0;
  const holdMod = (selectedRole && selectedRole.mod.hold) || 0;   // comms perk: shorter hold
  Object.assign(S.extraction, { called: false, hold: 0, holdMax: Math.max(45, BIOME.extraction.holdSeconds + holdMod), inRange: false, won: false });
  S.killedBy = "";
  // initial roster: expand targets to a flat list, shuffle, then spawn up to maxActiveAI so a
  // 30-species roster yields a varied (but capped) starting population instead of dumping all 48.
  const sd = BIOME.spawnDirector;
  const pool = [];
  for (const r of sd.roster) for (let i = 0; i < r.target; i++) pool.push(r.species);
  for (let i = pool.length - 1; i > 0; i--) { const k = (rand(0, 1) * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[k]; pool[k] = t; }
  const initialN = Math.min(pool.length, sd.maxActiveAI);
  for (let n = 0; n < initialN; n++) {
    const species = pool[n];
    const half = BIOME.map.size / 2 - 8;
    const minR = SPECIES[species].diet === "carnivore" ? 75 : 18;  // predators start well away from the player
    let x, z, tries = 0;
    do { x = rand(-half, half); z = rand(-half, half); tries++; } while (dist2(x, z, 0, 0) < minR * minR && tries < 24);
    dinos.push(spawnDino(species, clamp(x, -half, half), clamp(z, -half, half)));
  }
  $("startScreen").classList.add("hidden"); $("endScreen").classList.add("hidden");
  cam.yaw = 0; cam.pitch = -0.18;
  try { startMission(); } catch (e) { console.error("startMission", e); }   // set up the mission phase chain + objective marker
  try { buildMissionSites(); } catch (e) { console.error("missionSites", e); }   // build the real structures (outpost, generators, Maya…) at objective sites
  // co-op join-in-progress: if the host is already mid-mission (a fresh world tick arrived <2s ago),
  // skip the insertion cinematic, bootstrap to the host's live phase/extraction state, and drop in with the squad.
  const joinLive = Net.on && !Net.isHost && _netWorldLastT && (performance.now() - _netWorldLastT < 2000);
  if (joinLive) {
    try { netApplyWorld(_netWorldLast); } catch (e) {}                        // adopt host phase, extraction timer, survivor pos
    introSeen = true; intro = null; S.phase = "playing"; if (playerMesh) playerMesh.visible = true;
    $("intro").classList.add("hidden"); $("hud").style.display = ""; Audio.ambient(true); if (!isTouch) lockPointer();
    toast("JOINED SQUAD · MISSION IN PROGRESS");
  } else {
    try { startIntro(); }                                                       // play the opening crash cinematic, then hand off to "playing"
    catch (e) { console.error("startIntro", e); S.phase = "playing"; if (playerMesh) playerMesh.visible = true; $("intro").classList.add("hidden"); $("hud").style.display = ""; Audio.ambient(true); if (!isTouch) lockPointer(); }
  }
}
const ENDINGS = {   // EXTINCTION PROTOCOL branching finales
  A: { cls: "win", title: "CONTAINMENT HOLDS", body: "The paddock slammed shut on the Indominus. Every survivor reached the evac. Island Alpha is locked down — for tonight." },
  B: { cls: "win", title: "INTO THE DEEP", body: "You opened the lagoon. The Mosasaurus took the Indominus under in a single strike and the water went still. You flew out alive — but the island belongs to them now." },
  C: { cls: "lose", title: "YOU GOT OUT", body: "You ran. The last helicopter cleared the trees as containment failed behind you. You survived — but nothing else did, and the cargo is loose." },
};
/* ================================================== progression (saved) == *
 * Persistent career across runs (localStorage): extractions, runs, and the species you've cataloged
 * carry over, and wins unlock a veteran loadout (bonus deterrent charges). Fully additive. */
const PROGRESS = { runs: 0, wins: 0, ids: [], bestS: 0 };
function loadProgress() {
  try { Object.assign(PROGRESS, JSON.parse(localStorage.getItem("jws_progress") || "{}")); } catch {}
  (PROGRESS.ids || []).forEach(id => identified.add(id));   // Field Guide remembers what you've seen
}
function saveProgress() {
  PROGRESS.ids = [...identified];
  try { localStorage.setItem("jws_progress", JSON.stringify(PROGRESS)); } catch {}
}
function applyUnlocks() {   // veteran loadout: extra charges earned by extracting
  const w = PROGRESS.wins || 0;
  const flare = TOOLS.find(t => t.id === "flare"), decoy = TOOLS.find(t => t.id === "decoy");
  if (flare && w >= 1) { flare.max = 4; flare.charges = 4; }
  if (decoy && w >= 3) { decoy.max = 8; decoy.charges = 8; }
}
function careerLine() {
  const n = identified.size, total = Object.keys(SPECIES).length;
  return `CAREER · ${PROGRESS.wins || 0} extraction${PROGRESS.wins === 1 ? "" : "s"} · ${PROGRESS.runs || 0} runs · ${n}/${total} species cataloged` +
    (PROGRESS.wins >= 3 ? " · VETERAN loadout" : PROGRESS.wins >= 1 ? " · +1 flare unlocked" : "");
}
function endRun(won, ending) {
  if (S.phase !== "playing") return;
  S.phase = won ? "won" : "lost";
  PROGRESS.runs = (PROGRESS.runs || 0) + 1; if (won) PROGRESS.wins = (PROGRESS.wins || 0) + 1;
  if (won && S.t && (!PROGRESS.bestS || S.t < PROGRESS.bestS)) PROGRESS.bestS = Math.round(S.t);
  saveProgress();
  const cl = $("careerLine"); if (cl) cl.textContent = careerLine();
  Audio.ambient(false); won ? Audio.win() : Audio.lose();
  if (pointerLocked) document.exitPointerLock();
  const t = $("endTitle"), b = $("endBody");
  if (ending && ENDINGS[ending]) { const e = ENDINGS[ending]; t.textContent = e.title; t.className = e.cls; b.textContent = e.body; }
  else { t.textContent = won ? STR.winTitle : STR.loseTitle; t.className = won ? "win" : "lose"; b.textContent = won ? STR.winBody : (STR.loseBody + (S.killedBy ? `  (${STR.caught} ${S.killedBy})` : "")); }
  $("endScreen").classList.remove("hidden");
}

/* ================================================== procedural audio ===== */
const Audio = (() => {
  let ctx = null, ambGain = null, ambOn = false, hbTimer = 0, rotGain = null;
  function ensure() { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } } return ctx; }
  function blip(freq, dur, type, vol, slideTo) {
    if (!ctx) return; const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || "sine"; o.frequency.value = freq;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    g.gain.value = vol; g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur);
  }
  function noise(dur, vol, lp) {
    if (!ctx) return; const n = ctx.createBufferSource(), buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
    n.buffer = buf; const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp || 1200;
    const g = ctx.createGain(); g.gain.value = vol; g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    n.connect(f).connect(g).connect(ctx.destination); n.start(); n.stop(ctx.currentTime + dur);
  }
  return {
    init() { ensure(); if (ctx && ctx.state === "suspended") ctx.resume(); },
    ambient(on) {
      ambOn = on; if (!ctx) return;
      if (on && !ambGain) {
        ambGain = ctx.createGain(); ambGain.gain.value = 0.05; ambGain.connect(ctx.destination);
        const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 380; f.connect(ambGain);
        [55, 58.2].forEach(fr => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = fr; o.connect(f); o.start(); });
      }
      if (ambGain) ambGain.gain.setTargetAtTime(on ? 0.05 : 0.0, ctx.currentTime, 0.5);
    },
    tickHeartbeat(dt, fear) {
      if (!ctx || !ambOn || fear < 0.25) return;
      hbTimer -= dt; const interval = lerp(1.1, 0.42, fear);
      if (hbTimer <= 0) { hbTimer = interval; blip(48, 0.16, "sine", 0.08 + fear * 0.18); setTimeout(() => blip(40, 0.13, "sine", 0.06 + fear * 0.12), 150); }
    },
    step(gait) { noise(0.09, gait === "run" ? 0.10 : 0.045, gait === "run" ? 1600 : 900); },
    roar() { ensure(); blip(110, 1.3, "sawtooth", 0.32, 42); noise(1.2, 0.18, 700); },
    // positional roar: attenuate by distance (~to 130m) + stereo-pan by bearing relative to facing
    roarAt(dist, pan) {
      ensure(); if (!ctx) return;
      const vol = Math.max(0.05, Math.min(1, 1 - dist / 130));
      let out = ctx.destination;
      if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); p.connect(ctx.destination); out = p; }
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sawtooth"; o.frequency.value = 110; o.frequency.exponentialRampToValueAtTime(42, ctx.currentTime + 1.3);
      g.gain.value = 0.32 * vol; g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.3);
      o.connect(g).connect(out); o.start(); o.stop(ctx.currentTime + 1.3);
      const nb = ctx.createBufferSource(), buf = ctx.createBuffer(1, (ctx.sampleRate * 1.2) | 0, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      nb.buffer = buf; const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 700;
      const ng = ctx.createGain(); ng.gain.value = 0.18 * vol; ng.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
      nb.connect(f).connect(ng).connect(out); nb.start(); nb.stop(ctx.currentTime + 1.2);
    },
    // heavy footfall thud, positional — big predators stomping near you
    thudAt(dist, pan) {
      ensure(); if (!ctx) return; const vol = Math.max(0, Math.min(0.5, (1 - dist / 45) * 0.5)); if (vol < 0.03) return;
      let out = ctx.destination;
      if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); p.connect(ctx.destination); out = p; }
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o.frequency.value = 70; o.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 0.18);
      g.gain.value = vol; g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22); o.connect(g).connect(out); o.start(); o.stop(ctx.currentTime + 0.22);
    },
    hit() { noise(0.18, 0.3, 2200); blip(90, 0.18, "square", 0.12, 50); },
    beacon(call) { blip(call ? 880 : 1320, call ? 0.4 : 0.12, "square", 0.12, call ? 660 : null); },
    win() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => blip(f, 0.4, "triangle", 0.18), i * 130)); },
    lose() { [196, 165, 131, 98].forEach((f, i) => setTimeout(() => blip(f, 0.5, "sawtooth", 0.16), i * 160)); },
    // ---- opening crash-intro cues ----
    rotor(on) {   // layered helicopter: engine hum + rhythmic blade-slap "whump" + rotor-wash air
      ensure(); if (!ctx) return;
      if (on && !rotGain) {
        rotGain = ctx.createGain(); rotGain.gain.value = 0.0; rotGain.connect(ctx.destination);
        const pulse = ctx.createGain(); pulse.gain.value = 0.6; pulse.connect(rotGain);              // blade-slap tremolo node
        const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 320; f.connect(pulse);
        [28, 42, 56].forEach(fr => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = fr; o.connect(f); o.start(); });
        const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 11; lg.gain.value = 80; lfo.connect(lg).connect(f.frequency); lfo.start();
        const slap = ctx.createOscillator(), sd = ctx.createGain(); slap.type = "triangle"; slap.frequency.value = 9.5; sd.gain.value = 0.5; slap.connect(sd).connect(pulse.gain); slap.start();  // ~9.5 Hz whump-whump
        const nb = ctx.createBufferSource(); const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; nb.buffer = buf; nb.loop = true; const nf = ctx.createBiquadFilter(); nf.type = "bandpass"; nf.frequency.value = 850; nf.Q.value = 0.7; const ng = ctx.createGain(); ng.gain.value = 0.3; nb.connect(nf).connect(ng).connect(pulse); nb.start();   // rotor-wash air
      }
      if (rotGain) rotGain.gain.setTargetAtTime(on ? 0.16 : 0.0, ctx.currentTime, on ? 0.6 : 0.25);
    },
    squelch() { noise(0.12, 0.12, 2600); blip(1500, 0.05, "square", 0.05); },   // radio crackle before a voice line
    alarm() { blip(1180, 0.16, "square", 0.14); setTimeout(() => blip(1180, 0.16, "square", 0.14), 220); },
    crash() { ensure(); noise(0.7, 0.5, 500); blip(64, 0.9, "sawtooth", 0.34, 28); setTimeout(() => noise(1.4, 0.12, 240), 120); },
  };
})();
function initAudio() { /* ctx created on first gesture (start button) */ }

/* ====================================================== HUD ============== */
const COMPASS_TICKS = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
function buildStaticHUD() {
  $("objTitle").textContent = STR.objMission;
  $("sqTitle").textContent = STR.squadStatus;
  $("thrTitle").textContent = STR.threatLevel;
  $("vHealthL").textContent = STR.vHealth; $("vStaminaL").textContent = S.player.swim ? "SWIM" : STR.vStamina; $("vNoiseL").textContent = STR.vNoise;   // P-11: makes the swim exertion drain legible
  $("mmLabel").textContent = STR.gps;
  $("contactTxt").textContent = "";
  const tm = $("thrMeter"); tm.innerHTML = ""; for (let i = 0; i < 10; i++) tm.appendChild(document.createElement("span"));
  const wv = $("exfilWave"); wv.innerHTML = ""; for (let i = 0; i < 28; i++) wv.appendChild(document.createElement("i"));
  // single-player squad row (seam for co-op roster)
  $("sqRows").innerHTML = `<div class="sq-row" id="sqSelf"><span class="sq-tag" id="sqTag">ALPHA-01</span><div class="sq-bar"><i id="sqSelfBar"></i></div></div>`;
  $("exfilBtn").addEventListener("click", tryCall);
}
function fmtTime(t) { t = Math.max(0, Math.ceil(t)); const m = (t / 60) | 0, s = t % 60; return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); }
function hpColor(hp) { return hp <= 0 ? "var(--hud-dead)" : hp < 35 ? "var(--hud-alert)" : hp < 70 ? "var(--hud-warn)" : "var(--hud-good)"; }

function updateHUD() {
  const P = S.player;
  // objectives — driven by the selected mission
  const M = selectedMission;
  $("objTitle").textContent = M.name;
  // mission progress % — completed phases (campaign) or completed steps (simple)
  let pct = 0;
  if (M.phases && MC) pct = Math.round(clamp(MC.idx / M.phases.length, 0, 1) * 100);
  else if (M.steps) pct = Math.round(M.steps.filter(o => o.done()).length / M.steps.length * 100);
  const op = $("objPct"); if (op) op.textContent = pct + "%";
  if (M.phases && MC) {                                   // campaign mission: phase chain
    const cur = M.phases[MC.idx];
    let sub = cur ? (typeof cur.l === "function" ? cur.l() : cur.l) : "Mission complete — extract";
    if (cur && (cur.t === "reach" || cur.t === "interact" || cur.t === "defend" || cur.t === "boss" || cur.t === "extract")) { const [sx, sz] = cur.t === "extract" ? [S.extraction.beacon.x, S.extraction.beacon.z] : phaseSite(cur); sub += " · " + Math.round(Math.sqrt(dist2(P.x, P.z, sx, sz))) + " " + STR.km; }
    if (cur && cur.t === "defend" && MC.defendT != null && MC.defendT > 0) sub += " · HOLD " + Math.ceil(MC.defendT) + "s";
    $("objSub").textContent = sub;
    $("objList").innerHTML = M.phases.map((p, i) => { const l = typeof p.l === "function" ? p.l() : p.l; const mk = i < MC.idx ? "◆" : (i === MC.idx ? "▸" : "◇"); return `<li class="${i < MC.idx ? "done" : (i === MC.idx ? "cur" : "")}"><span class="obj-check">${mk}</span>${l}</li>`; }).join("");
  } else {                                                // simple mission: steps
    $("objSub").textContent = typeof M.sub === "function" ? M.sub() : M.sub;
    $("objList").innerHTML = M.steps.map(o => { const done = o.done(); const l = typeof o.l === "function" ? o.l() : o.l; return `<li class="${done ? "done" : ""}"><span class="obj-check">${done ? "◆" : "◇"}</span>${l}</li>`; }).join("");
  }

  // compass
  const heading = ((-cam.yaw / DEG) % 360 + 360) % 360;
  $("cmpHeading").textContent = Math.round(heading) + "°";
  const span = 120, strip = $("cmpStrip"); let html = "";
  for (let d = -span / 2; d <= span / 2; d += 15) {
    const deg = ((Math.round(heading / 15) * 15 + d) % 360 + 360) % 360;
    const off = ((deg - heading + 540) % 360) - 180; if (Math.abs(off) > span / 2) continue;
    const x = 50 + (off / span) * 100, named = COMPASS_TICKS[deg];
    html += `<div class="cmp-mark" style="left:${x}%"><div class="cmp-tick" style="opacity:${named ? 1 : .4}"></div>${named ? `<div class="cmp-label">${named}</div>` : (deg % 45 !== 0 ? `<div class="cmp-num">${deg}</div>` : "")}</div>`;
  }
  strip.innerHTML = html;

  // squad (self)
  $("sqCount").textContent = (P.alive ? 1 : 0) + "/1";
  const tg = $("sqTag"); if (tg) tg.textContent = P.role ? P.role.name : "ALPHA-01";
  updateToolHUD();
  const sb = $("sqSelfBar"); if (sb) { sb.style.width = P.hp + "%"; sb.style.background = hpColor(P.hp); }
  $("sqSelf").className = "sq-row" + (P.alive ? "" : " ko");

  // threat
  const cells = $("thrMeter").children;
  for (let i = 0; i < 10; i++) cells[i].className = (i < S.threat ? (S.threat >= 7 ? "on hot" : "on") : "");
  $("thrNum").textContent = S.threat + "/10";

  // contact
  const c = $("contact");
  if (S.contact.active) { c.style.display = "flex"; $("contactTxt").textContent = (S.contact.label || STR.contactPredator).toUpperCase() + " · " + S.contact.bearing; }
  else c.style.display = "none";

  // vitals
  setBar("vHealth", "vHealthN", P.hp, hpColor(P.hp));
  setBar("vStamina", "vStaminaN", P.stamina, "var(--hud-stam)");
  setBar("vNoise", "vNoiseN", P.noise * 100, P.noise > 0.7 ? "var(--hud-alert)" : "var(--hud-accent)");
  // oxygen — only shown while in water (diving drains it; drowning at zero)
  const oxRow = $("vOxyRow");
  if (oxRow) { const inW = !!P.swim; oxRow.style.display = inW ? "" : "none"; if (inW) setBar("vOxy", "vOxyN", P.oxygen == null ? 100 : P.oxygen, (P.oxygen || 0) < 30 ? "var(--hud-alert)" : "var(--hud-water)"); }
  const dt2 = $("diveTint"); if (dt2) dt2.classList.toggle("on", !!P.dive);   // underwater tint while submerged
  // survival status chips — surfaced only when something needs attention (no clutter in normal play)
  const sv = $("survHud");
  if (sv) {
    let chips = "";
    if (P.injured) chips += `<span class="sv alert">⚕ INJURED · BLEEDING</span>`;
    if ((P.thirst ?? 100) < 25) chips += `<span class="sv">💧 THIRSTY</span>`;
    if ((P.hunger ?? 100) < 25) chips += `<span class="sv">🍖 HUNGRY</span>`;
    if ((P.temp ?? 0) < -45) chips += `<span class="sv">❄ COLD</span>`;
    sv.innerHTML = chips; sv.style.display = chips ? "flex" : "none";
  }

  // extraction window
  const ex = $("exfil"), btn = $("exfilBtn");
  if (S.extraction.called) {
    ex.classList.add("live");
    $("exfilLabel").textContent = STR.exfilInbound;
    $("exfilTime").textContent = fmtTime(S.extraction.holdMax - S.extraction.hold);
    btn.style.display = "none"; $("exfilWarn").style.display = "block"; $("exfilWarn").textContent = STR.noiseWarn;
    const w = $("exfilWave").children; for (let i = 0; i < 28; i++) w[i].style.height = (20 + Math.abs(Math.sin(i * 0.7 + S.t * 6) * 70)) + "%";
  } else {
    ex.classList.remove("live");
    $("exfilLabel").textContent = STR.exfilWindow;
    $("exfilTime").textContent = fmtTime(S.extraction.holdMax);
    btn.style.display = ""; btn.textContent = S.extraction.inRange ? STR.callExtraction : STR.reachBeaconFirst;
    btn.disabled = !S.extraction.inRange;
    $("exfilWarn").style.display = "none";
    const w = $("exfilWave").children; for (let i = 0; i < 28; i++) w[i].style.height = "8%";
  }
  // persistent beacon distance — extraction range is survival-critical, so don't hide it behind the map
  const ed = $("exfilDist");
  if (ed) ed.textContent = "BEACON · " + Math.round(Math.hypot(S.extraction.beacon.x - P.x, S.extraction.beacon.z - P.z)) + " " + STR.km;

  // minimap (+ optional fullscreen tactical map, toggled with M)
  $("mmSvg").innerHTML = mapSVG(false);
  if (mapOpen) {
    $("mapBigSvg").innerHTML = mapSVG(true);
    $("mapDist").textContent = "· BEACON " + Math.round(Math.hypot(S.extraction.beacon.x - P.x, S.extraction.beacon.z - P.z)) + STR.km;
  }

  // vignette (fear/threat dread) + contact red push
  const v = $("vig"); const intensity = Math.max(P.fear, S.threat / 10 * 0.7);
  v.style.opacity = intensity.toFixed(2);
  const col = S.threat >= 7 ? "214,86,47" : "120,90,40";
  v.style.boxShadow = `inset 0 0 ${160 + intensity * 120}px ${40 + intensity * 60}px rgba(${col},${0.0 + intensity * 0.55})`;
}
function setBar(barId, numId, v, color) { const b = $(barId); b.style.width = clamp(v, 0, 100) + "%"; b.style.background = color; $(numId).textContent = Math.round(v); }
const _toolEls = () => document.querySelectorAll("#tools .tool");
function updateToolHUD() {
  _toolEls().forEach((el, i) => {
    const t = TOOLS[i]; if (!t) return;
    el.classList.toggle("sel", i === selTool);
    el.classList.toggle("empty", t.max !== Infinity && t.charges <= 0);
    const ch = el.querySelector(".t-ch"); if (ch) ch.textContent = t.max === Infinity ? "∞" : "×" + t.charges;
    const cd = el.querySelector(".t-cd"); if (cd) cd.style.height = (t.cd > 0 ? (t.cd / t.cdMax * 100) : 0).toFixed(0) + "%";
  });
  const dh = $("dnaHud"); if (dh) dh.textContent = `⚗ DNA ${dnaSamples}  ·  ID ${identified.size}/${Object.keys(SPECIES).length}`;
}
let binocFov = BINOC_FOV;
function binocZoom(dir) {   // +1 zoom in, -1 zoom out (scroll / +- keys / on-screen buttons / pinch)
  if (!binoc || !camera) return;
  binocFov = clamp(binocFov - dir * 4, 10, 42);
  camera.fov = binocFov; camera.updateProjectionMatrix();
}
function toggleBinoc() {
  if (S.phase !== "playing" && !binoc) return;   // only glass during play (always allow lowering)
  binoc = !binoc;
  if (binoc) binocFov = BINOC_FOV;
  if (camera) { camera.fov = binoc ? binocFov : DEFAULT_FOV; camera.updateProjectionMatrix(); }
  const ov = $("binoc"); if (ov) ov.classList.toggle("on", binoc);
  const bb = $("btnBinoc"); if (bb) bb.classList.toggle("on", binoc);
  if (!binoc) { const h = $("scan"); if (h) h.innerHTML = ""; const t = $("binocTgt"); if (t) t.textContent = ""; }
}
function updateScan() {   // binoculars: project in-view dinos to screen, label species + log identification
  const host = $("scan"); if (!host) return;
  if (!binoc || S.phase !== "playing") { if (host.childElementCount) host.innerHTML = ""; const t = $("binocTgt"); if (t) t.textContent = ""; return; }
  const P = S.player; let html = "", center = null, cScore = 0.55;
  for (const a of dinos) {
    if (!a.alive) continue;
    const d = Math.hypot(a.x - P.x, a.z - P.z); if (d > 175) continue;
    const wy = groundH(a.x, a.z) + (a.sp.greybox.standH || 2) + 0.7;
    const v = tmp.set(a.x, wy, a.z).project(camera);
    if (v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue;   // behind / off-screen
    identified.add(a.sp.id);
    a.mapSeen = true; a.mapX = a.x; a.mapZ = a.z; a.mapYaw = a.yaw; a.mapT = S.t;   // glassing = recon ping on the map
    const sx = (v.x * 0.5 + 0.5) * 100, sy = (-v.y * 0.5 + 0.5) * 100, carn = a.sp.diet === "carnivore";
    const tag = isDown(a) ? (a.sedated ? "SEDATED" : "TRAPPED") : (carn ? "PREDATOR" : "HERBIVORE");
    html += `<div class="scan-tag ${carn ? "pred" : "herb"}" style="left:${sx.toFixed(1)}%;top:${sy.toFixed(1)}%"><b>${a.sp.displayName}</b><span>${tag} · ${Math.round(d)}m</span></div>`;
    const al = ((a.x - P.x) * Math.sin(cam.yaw) + (a.z - P.z) * Math.cos(cam.yaw)) / (d || 1);
    if (al > cScore) { cScore = al; center = a; }
  }
  host.innerHTML = html;
  const t = $("binocTgt"); if (t) t.textContent = center ? `▶ ${center.sp.displayName.toUpperCase()} · ${center.sp.diet === "carnivore" ? "PREDATOR" : "HERBIVORE"}` : "SCANNING…";
  const zl = $("binocZoom"); if (zl) zl.textContent = "×" + (DEFAULT_FOV / binocFov).toFixed(1);
}
function clearField() {
  for (const tr of traps) scene.remove(tr.mesh); traps.length = 0;
  dnaSamples = 0; dnaSpecies.clear();
  if (binoc) toggleBinoc();   // restore FOV
}

// Build the tactical map as an SVG string (viewBox 0..100). Shared by the corner minimap (big=false)
// and the fullscreen overlay (big=true, which adds species tooltips + bigger markers).
let mapOpen = false;
// === dinosaur intelligence layer ===
// The map is field equipment, not omniscience: a contact is shown live only while SIGHTED
// (within detection range or glassed); once it slips out of sight the map keeps a decaying
// LAST-SEEN ghost instead of tracking it perfectly. Threat-radius + territory + state overlays
// are toggleable layers on the fullscreen map.
const MAP_SIGHT_R = 62;        // player auto-detect radius for live map intel (m)
const MAP_GHOST_TTL = 28;      // last-seen ghost lifetime before it drops off the map (s)
let mapLayers = (() => { try { return Object.assign({ threat: true, territory: false, ghosts: true }, JSON.parse(localStorage.getItem("jws_mapLayers") || "{}")); } catch (e) { return { threat: true, territory: false, ghosts: true }; } })();   // persisted tactical-overlay preference
// Internal AI state -> readable field label for the tactical map.
function dinoMapState(d) {
  if (isDown(d)) return d.sedated ? "SEDATED" : "TRAPPED";
  return ({ Chase: "HUNTING", Attack: "ATTACKING", Stalk: "STALKING", Investigate: "ALERT",
    Flee: "FLEEING", Retreat: "RETREATING", Patrol: "ROAMING", Graze: "GRAZING", Feed: "FEEDING", Rest: "RESTING" })[d.state] || "";
}
function mapThreatRadiusM(d) {  // how far this predator projects danger — drives the threat ring
  const b = d.sp.behavior || {};
  return clamp(8 + (b.aggression || 0.5) * 22 + (isApex(d.sp) ? 14 : 0), 6, 44);
}
function mapSVG(big) {
  const P = S.player, half = BIOME.map.size / 2;
  const toMM = (x, z) => [50 + (x / half) * 46, 50 + (z / half) * 46];
  const tri = (mx, mz, a, sz) => `${(mx + Math.sin(a) * sz).toFixed(1)},${(mz + Math.cos(a) * sz).toFixed(1)} ${(mx + Math.sin(a + 2.5) * sz * 0.7).toFixed(1)},${(mz + Math.cos(a + 2.5) * sz * 0.7).toFixed(1)} ${(mx + Math.sin(a - 2.5) * sz * 0.7).toFixed(1)},${(mz + Math.cos(a - 2.5) * sz * 0.7).toFixed(1)}`;
  let s = "";
  // valley boundary + mountain ring (terrain rises past world r≈70) + winding river
  s += `<circle cx="50" cy="50" r="46.5" fill="none" stroke="#6b7d6e" stroke-width="0.6" opacity="0.5"/>`;
  s += `<circle cx="50" cy="50" r="${((70 / half) * 46).toFixed(1)}" fill="none" stroke="#7d8a72" stroke-width="0.5" stroke-dasharray="2 2" opacity="0.4"/>`;
  let rv = ""; for (let x = -half; x <= half; x += half / 24) { const [mx, mz] = toMM(x, riverCenter(x)); rv += `${mx.toFixed(1)},${mz.toFixed(1)} `; }
  s += `<polyline points="${rv}" fill="none" stroke="#5b9fd6" stroke-width="${big ? 1.6 : 1.2}" opacity="0.5" stroke-linecap="round"/>`;
  // extraction facility + pulsing beacon
  const [bx, bz] = toMM(S.extraction.beacon.x, S.extraction.beacon.z), pulse = 2.4 + Math.sin(S.t * 4) * 0.9;
  s += `<rect x="${(bx - 2.2).toFixed(1)}" y="${(bz - 2.2).toFixed(1)}" width="4.4" height="4.4" fill="none" stroke="var(--hud-accent)" stroke-width="0.6"/>`;
  s += `<circle cx="${bx.toFixed(1)}" cy="${bz.toFixed(1)}" r="${pulse.toFixed(1)}" fill="none" stroke="var(--hud-accent)" stroke-width="0.7" opacity="0.85"/>`;
  s += `<circle cx="${bx.toFixed(1)}" cy="${bz.toFixed(1)}" r="1.1" class="mm-exfil"/>`;
  // SAFE ZONE — predators disengage & you take no damage inside this radius (matches the 3D ground
  // ring at the beacon + the map legend; previously listed in the key but never drawn here).
  const safeR = ((SAFE_R / half) * 46).toFixed(1);
  s += `<circle cx="${bx.toFixed(1)}" cy="${bz.toFixed(1)}" r="${safeR}" fill="rgba(111,174,107,0.06)" stroke="#6fae6b" stroke-width="0.5" stroke-dasharray="1.4 1.2" opacity="0.75"/>`;
  // ranger watchtowers — safe vantage points
  for (const t of TOWERS) { const [tx, tz] = toMM(t.x, t.z); s += `<polygon points="${tx.toFixed(1)},${(tz - 2).toFixed(1)} ${(tx - 1.7).toFixed(1)},${(tz + 1.4).toFixed(1)} ${(tx + 1.7).toFixed(1)},${(tz + 1.4).toFixed(1)}" fill="none" stroke="#8fb8c4" stroke-width="0.6"/>`; }
  // ENLARGED map only: surface the WHOLE objective chain + range rings for complete awareness
  if (big) {
    const [pmx0, pmz0] = toMM(P.x, P.z);
    for (const rm of [40, 80, 120]) { const rr = ((rm / half) * 46).toFixed(1); s += `<circle cx="${pmx0.toFixed(1)}" cy="${pmz0.toFixed(1)}" r="${rr}" fill="none" stroke="#6b7d6e" stroke-width="0.25" stroke-dasharray="0.6 1.4" opacity="0.4"/>`; }
    const cm = activeCampaign();
    if (cm && cm.phases && MC) {
      cm.phases.forEach((ph, i) => {
        if (ph.t === "extract" || ph.atBeacon) return;        // beacon drawn separately
        const site = phaseSite(ph); const [px, pz] = toMM(site[0], site[1]);
        const done = i < MC.idx, cur = i === MC.idx, col = done ? "#6fae6b" : (cur ? "#bfe2ea" : "#9aa6a0");
        s += `<circle cx="${px.toFixed(1)}" cy="${pz.toFixed(1)}" r="1.7" fill="${cur ? "rgba(191,226,234,0.18)" : "none"}" stroke="${col}" stroke-width="0.6" opacity="${done ? 0.6 : 1}"><title>${i + 1}. ${typeof ph.l === "function" ? ph.l() : ph.l}</title></circle>`;
        s += `<text x="${px.toFixed(1)}" y="${(pz + 0.9).toFixed(1)}" fill="${col}" font-size="2.6" font-weight="700" text-anchor="middle" opacity="${done ? 0.6 : 1}">${i + 1}</text>`;
      });
    }
  }
  // active mission objective — tracks the CURRENT step for every mission type (not the fixed beacon)
  const obj = currentObjective();
  if (obj && !obj.roaming) {
    const [omx, omz] = toMM(obj.x, obj.z), [pmx, pmz] = toMM(P.x, P.z), pu = (2.0 + Math.sin(S.t * 4) * 0.7).toFixed(1);
    s += `<line x1="${pmx.toFixed(1)}" y1="${pmz.toFixed(1)}" x2="${omx.toFixed(1)}" y2="${omz.toFixed(1)}" stroke="#8fb8c4" stroke-width="0.4" stroke-dasharray="1.5 1.5" opacity="0.55"/>`;
    s += `<circle cx="${omx.toFixed(1)}" cy="${omz.toFixed(1)}" r="${pu}" fill="none" stroke="#8fb8c4" stroke-width="0.7" opacity="0.9"/>`;
    s += `<polygon points="${omx.toFixed(1)},${(omz - 2).toFixed(1)} ${(omx + 2).toFixed(1)},${omz.toFixed(1)} ${omx.toFixed(1)},${(omz + 2).toFixed(1)} ${(omx - 2).toFixed(1)},${omz.toFixed(1)}" fill="#8fb8c4"${big ? `><title>${obj.label}</title></polygon` : "/"}>`;
    if (big) s += `<text x="${omx.toFixed(1)}" y="${(omz - 3).toFixed(1)}" fill="#bfe2ea" font-size="3" text-anchor="middle">OBJECTIVE</text>`;
  } else if (obj && obj.roaming && big) {   // roaming objective (e.g. DNA hunt) — no fixed point, so post it as a banner
    s += `<text x="50" y="11" fill="#bfe2ea" font-size="3.2" text-anchor="middle">OBJECTIVE · ${obj.label}</text>`;
  }
  // incoming evac helicopter — show its live position + a dashed inbound track to the beacon
  if (evac && evac.heli) {
    const [hx, hz] = toMM(evac.heli.group.position.x, evac.heli.group.position.z);
    s += `<line x1="${hx.toFixed(1)}" y1="${hz.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${bz.toFixed(1)}" stroke="var(--hud-accent)" stroke-width="0.4" stroke-dasharray="1.5 1.5" opacity="0.7"/>`;
    const rot = (S.t * 220) % 360;   // spinning rotor cross
    s += `<g transform="translate(${hx.toFixed(1)},${hz.toFixed(1)}) rotate(${rot.toFixed(0)})"><line x1="-3" y1="0" x2="3" y2="0" stroke="#fff" stroke-width="0.6"/><line x1="0" y1="-3" x2="0" y2="3" stroke="#fff" stroke-width="0.6"/></g>`;
    s += `<circle cx="${hx.toFixed(1)}" cy="${hz.toFixed(1)}" r="1.4" fill="var(--hud-accent)"/>`;
  }
  // contacts (intelligence layer): SIGHTED = live heading triangle (apex outlined) / herbivore dot,
  // plus threat-radius + territory rings + state label on the big map. UNSIGHTED = decaying last-seen
  // ghost. Never-seen dinos aren't drawn (fog of war — the map only knows what you've detected).
  for (const d of dinos) {
    if (!d.alive) continue;
    const carn = d.sp.diet === "carnivore", apex = isApex(d.sp);
    if (!d.mapSeen) {
      if (!d.mapT || !mapLayers.ghosts) continue;
      const age = S.t - d.mapT; if (age > MAP_GHOST_TTL) continue;
      const [gx, gz] = toMM(d.mapX, d.mapZ), op = (0.5 * (1 - age / MAP_GHOST_TTL)).toFixed(2);
      s += `<circle cx="${gx.toFixed(1)}" cy="${gz.toFixed(1)}" r="${big ? 1.8 : 1.5}" fill="none" stroke="${carn ? "var(--hud-alert)" : "var(--hud-stam)"}" stroke-width="0.5" stroke-dasharray="0.8 0.8" opacity="${op}"${big ? `><title>${d.sp.displayName} · LAST SEEN ${Math.round(age)}s AGO</title></circle` : "/"}>`;
      continue;
    }
    const [mx, mz] = toMM(d.x, d.z);
    if (big && carn && mapLayers.territory && d.sp.behavior && d.sp.behavior.territoryRadiusM) {
      const tr = ((d.sp.behavior.territoryRadiusM / half) * 46).toFixed(1);
      s += `<circle cx="${mx.toFixed(1)}" cy="${mz.toFixed(1)}" r="${tr}" fill="none" stroke="#c9a23a" stroke-width="0.3" stroke-dasharray="1 1.4" opacity="0.32"/>`;
    }
    if (big && carn && mapLayers.threat) {
      const thr = ((mapThreatRadiusM(d) / half) * 46).toFixed(1), hot = d.state === "Chase" || d.state === "Attack";
      s += `<circle cx="${mx.toFixed(1)}" cy="${mz.toFixed(1)}" r="${thr}" fill="${hot ? "rgba(214,86,47,0.07)" : "none"}" stroke="var(--hud-alert)" stroke-width="0.3" stroke-dasharray="0.8 1" opacity="${hot ? 0.7 : 0.32}"/>`;
    }
    const st = big ? dinoMapState(d) : "", tt = big ? `><title>${d.sp.displayName}${st ? " · " + st : ""}</title></polygon` : "/";
    if (carn) s += `<polygon points="${tri(mx, mz, d.yaw, apex ? 2.9 : 2.1)}" class="mm-threat${apex ? " mm-apex" : ""}"${tt}>`;
    else s += `<circle cx="${mx.toFixed(1)}" cy="${mz.toFixed(1)}" r="${big ? 1.7 : 1.4}" class="mm-prey"${big ? `><title>${d.sp.displayName}${st ? " · " + st : ""}</title></circle` : "/"}>`;
    if (big && st) s += `<text x="${mx.toFixed(1)}" y="${(mz + 3.5).toFixed(1)}" fill="${carn ? "#e7a08a" : "#9fc6d2"}" font-size="2.2" text-anchor="middle" opacity="0.85">${st}</text>`;
  }
  // player view cone + heading marker + north
  const [sx, sz] = toMM(P.x, P.z), a = P.yaw, cr = big ? 13 : 9;
  s += `<polygon points="${sx.toFixed(1)},${sz.toFixed(1)} ${(sx + Math.sin(a - 0.5) * cr).toFixed(1)},${(sz + Math.cos(a - 0.5) * cr).toFixed(1)} ${(sx + Math.sin(a + 0.5) * cr).toFixed(1)},${(sz + Math.cos(a + 0.5) * cr).toFixed(1)}" fill="var(--hud-good)" opacity="0.13"/>`;
  s += `<polygon points="${tri(sx, sz, a, 3.1)}" class="mm-self"/>`;
  s += `<text x="50" y="5.5" class="mm-n" text-anchor="middle">N</text>`;
  return s;
}

function toggleMap() {
  if (S.phase !== "playing" && !mapOpen) return;
  mapOpen = !mapOpen;
  if (mapOpen) { const ml = $("mapLayers"); if (ml) ml.querySelectorAll("button[data-layer]").forEach(b => { const k = b.dataset.layer; if (k in mapLayers) b.classList.toggle("on", !!mapLayers[k]); }); }   // reflect the persisted overlay choice on the toggle buttons
  $("mapOverlay").classList.toggle("open", mapOpen);
}

let toastTimer = 0;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.opacity = "1"; toastTimer = 2.4; }
function flash() { const f = $("flash"); f.style.transition = "none"; f.style.opacity = "0.5"; requestAnimationFrame(() => { f.style.transition = "opacity .4s"; f.style.opacity = "0"; }); }

/* ====================================================== camera =========== */
function updateCamera() {
  const P = S.player;
  if (intro && intro.camActive) { updateIntroCamera(); return; }   // scripted flight/spin/crash camera
  if (evacCine()) {   // evac: rise high and recentre to keep visual over the whole park while the chopper climbs away
    const g = evac.heli.group, prog = evac.phase === "liftoff" ? Math.min(1, evac.t / 5.2) : 0;
    camera.position.lerp(tmp.set((evac.hx + 18) * (1 - prog), 26 + prog * 112, (evac.hz + 60) * (1 - prog) + 72 * prog), 0.04);
    camera.lookAt(g.position.x * (1 - prog), g.position.y * (1 - prog) + 6 * prog, g.position.z * (1 - prog));
    if (beaconRing) beaconRing.rotation.z += 0.08;
    return;
  }
  // binoculars = FIRST PERSON from the operative's eyes (don't stare at your own back). Hide the avatar
  // so it never blocks the glass; restored the moment you lower them.
  if (binoc) {
    if (playerMesh) playerMesh.visible = false;
    const ey = (P.eyeY != null ? P.eyeY : playerFloorY(P.x, P.z)) + 1.55, cpb = Math.cos(cam.pitch);
    camera.position.set(P.x + Math.sin(cam.yaw) * 0.15, ey, P.z + Math.cos(cam.yaw) * 0.15);
    camera.lookAt(P.x + Math.sin(cam.yaw) * cpb * 12, ey + Math.sin(cam.pitch) * 12, P.z + Math.cos(cam.yaw) * cpb * 12);
    if (beaconRing) beaconRing.rotation.z += (S.extraction.called ? 0.08 : 0.02);
    return;
  }
  if (playerMesh && !playerMesh.visible && S.phase === "playing") playerMesh.visible = true;
  const tx = P.x, ty = (P.eyeY != null ? P.eyeY : playerFloorY(P.x, P.z)) + 1.5, tz = P.z;
  const cp = Math.cos(cam.pitch), d = cam.dist * cp;
  let cx = tx - Math.sin(cam.yaw) * d, cz = tz - Math.cos(cam.yaw) * d, cy = ty + cam.height + Math.sin(cam.pitch) * cam.dist * -1 + cam.dist * cp * 0.0;
  cy = ty + cam.height - Math.sin(cam.pitch) * cam.dist;
  const gh = (P.onTower ? P.onTower.platformY : groundH(cx, cz)) + 0.6; if (cy < gh) cy = gh;
  if (camShake > 0) { cx += (Math.random() - 0.5) * camShake; cy += (Math.random() - 0.5) * camShake; cz += (Math.random() - 0.5) * camShake; camShake = Math.max(0, camShake - 0.045); }
  camera.position.set(cx, cy, cz);
  camera.lookAt(tx, ty, tz);
  // beacon spin + glow pulse
  if (beaconRing) beaconRing.rotation.z += (S.extraction.called ? 0.08 : 0.02);
  if (beaconGlow) { const s = 1 + Math.sin(S.t * 4) * (S.extraction.called ? 0.4 : 0.15); beaconGlow.scale.setScalar(s); }
}

/* ====================================================== loop ============= */
const STEP = 1 / 60; let acc = 0, last = performance.now(), hudAcc = 0;
const dev = new URLSearchParams(location.search).has("dev"); if (dev) $("dev").style.display = "block";
let tickMs = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dtMs = now - last; last = now; if (dtMs > 250) dtMs = 250;
  acc += dtMs / 1000;
  pollGamepad();
  const t0 = performance.now();
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    if (S.phase === "playing") simulate(STEP);
    acc -= STEP; steps++;
  }
  if (S.phase === "intro") { try { updateIntro(Math.min(0.05, dtMs / 1000)); } catch (e) { console.error("intro", e); try { skipIntro(); } catch (_) { S.phase = "playing"; if (playerMesh) playerMesh.visible = true; $("intro").classList.add("hidden"); $("hud").style.display = ""; } } }   // never strand the player on an intro error
  tickMs = performance.now() - t0;
  updateCamera();
  if (binoc) updateScan();   // live species labels track smoothly while glassing
  // HUD ~12 Hz
  hudAcc += dtMs / 1000;
  if (hudAcc > 1 / 12) { hudAcc = 0; if (S.phase !== "menu" && S.phase !== "intro") updateHUD(); }
  // toast fade
  if (toastTimer > 0) { toastTimer -= dtMs / 1000; if (toastTimer <= 0) $("toast").style.opacity = "0"; }
  if (playerMixer) { playerAction.timeScale = GAIT_RATE[S.player.gait] ?? 1; playerMixer.update(dtMs / 1000); }
  composer.render();
  if (dev) {
    devFrames++; if (now - devAt >= 500) { devFps = Math.round(devFrames * 1000 / (now - devAt)); devFrames = 0; devAt = now; }
    $("dev").textContent = `${devFps} fps  tick ${tickMs.toFixed(1)}ms  dinos ${dinos.filter(d => d.alive).length}  draws ${renderer.info.render.calls}  state ${S.phase}`;
  }
}
let devFrames = 0, devAt = performance.now(), devFps = 0;

function simulate(dt) {
  S.t += dt;
  updatePlayer(dt);
  // co-op CLIENT: dinos are host-authoritative — puppet them, don't run a local spawn director or AI
  // (that's what made the world diverge between players). HOST + solo run the full sim.
  const coopClient = Net.on && !Net.isHost;
  if (coopClient) updateNetDinos(dt);
  else { updateDinos(dt, S.player); updateSpawnDirector(dt, S.player); }
  updateThreat(dt, S.player);
  updateExtraction(dt);
  updateEvac(dt);
  updateTools(dt);
  updateField(dt);
  updateMission(dt);
  updateAction(dt);
  updateFx(dt);
  if (wreckMesh) updateWreck(dt);
  Audio.tickHeartbeat(dt, S.player.fear);
  if (Net.on) netTick(dt);
}
const evacCine = () => evac && (evac.phase === "climbing" || evac.phase === "liftoff");   // input/cam locked only once aboard

/* ============================================== co-op multiplayer ======== *
 * Player-sync: shared room + shared world seed; each player sees the others as
 * their chosen specialist avatar. Dinos run locally per client (v2: host sync). */
const remotePlayers = new Map();   // peerId -> { group, mixer, action, tx, tz, tyaw, gait, hp, alive }
let netSendAcc = 0;

function roleModelURL(roleId) { const r = ROLES.find(x => x.id === roleId); return (r && MODELS[r.model]) ? r.model : PLAYER_MODEL; }
function buildCharMesh(roleId) {
  const url = roleModelURL(roleId), g = new THREE.Group();
  let mixer = null, action = null;
  if (MODELS[url]) {
    let skinned = false; MODELS[url].traverse(o => { if (o.isSkinnedMesh) skinned = true; });
    const src = skinned ? skeletonClone(MODELS[url]) : MODELS[url].clone(true);
    const fig = fitModel(src, 1.8, PLAYER_MODEL_YAW); fig.position.y = -0.9; g.add(fig);
    const clips = MODEL_ANIMS[url];
    if (clips && clips.length) { mixer = new THREE.AnimationMixer(src); action = mixer.clipAction(clips[0]); action.play(); }
  } else {
    g.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 10), new THREE.MeshStandardMaterial({ color: 0x6fae6b, roughness: 0.7, emissive: 0x123512, emissiveIntensity: 0.3 })));
  }
  addBlob(g, 0.7); scene.add(g);
  return { group: g, mixer, action };
}
function makeNameTag(name) {   // floating label above a remote teammate so you can confirm who's who
  const cv = document.createElement("canvas"); cv.width = 256; cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "rgba(10,14,13,0.7)"; ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = "rgba(111,174,107,0.8)"; ctx.lineWidth = 3; ctx.strokeRect(2, 2, 252, 60);
  ctx.fillStyle = "#9fe08a"; ctx.font = "bold 30px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(name || "PLAYER").toUpperCase().slice(0, 12), 128, 34);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(2.4, 0.6, 1); spr.position.y = 2.4; spr.renderOrder = 20;
  return spr;
}
function removeRemote(id) { const r = remotePlayers.get(id); if (r) { scene.remove(r.group); remotePlayers.delete(id); } }
function clearRemotes() { for (const id of [...remotePlayers.keys()]) removeRemote(id); }
function netUpsertState(msg) {
  const p = msg.p; if (!p || S.phase !== "playing") return;   // only render peers once you're in-world
  let r = remotePlayers.get(msg.id);
  if (!r) {
    const peer = Net.peers.get(msg.id) || {};
    r = Object.assign(buildCharMesh(peer.role || "navigator"), { tx: p.x, tz: p.z, tyaw: p.yaw || 0, gait: p.gait || "idle", hp: p.hp ?? 100, alive: p.alive !== false, vx: 0, vz: 0, _lastT: performance.now() });
    r.group.add(makeNameTag(peer.name));
    r.group.position.set(p.x, groundH(p.x, p.z) + 0.9, p.z);
    remotePlayers.set(msg.id, r);
  } else {
    const now = performance.now(), dtg = Math.max(0.03, (now - (r._lastT || now)) / 1000);   // velocity between snapshots → lets updateRemotes extrapolate so a ~12 Hz peer doesn't render a frame behind
    r.vx = (p.x - r.tx) / dtg; r.vz = (p.z - r.tz) / dtg; r._lastT = now;
  }
  r.tx = p.x; r.tz = p.z; r.tyaw = p.yaw || 0; r.gait = p.gait || "idle"; r.hp = p.hp ?? 100; r.alive = p.alive !== false;
}
function updateRemotes(dt) {
  const k = Math.min(1, dt * 10);
  for (const r of remotePlayers.values()) {
    r.group.visible = r.alive;
    // P-05: lead the target slightly along last-known velocity (only while moving; clamped) so the puppet
    // tracks where the peer actually is, not where their last packet said. Snapping is avoided by the clamp.
    const lead = r.gait && r.gait !== "idle" ? 0.08 : 0;
    const tx = r.tx + Math.max(-2, Math.min(2, (r.vx || 0) * lead));
    const tz = r.tz + Math.max(-2, Math.min(2, (r.vz || 0) * lead));
    const gy = groundH(tx, tz) + 0.9 - (r.gait === "crouch" ? 0.4 : 0);
    r.group.position.x += (tx - r.group.position.x) * k;
    r.group.position.z += (tz - r.group.position.z) * k;
    r.group.position.y += (gy - r.group.position.y) * k;
    let dy = r.tyaw - r.group.rotation.y; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    r.group.rotation.y += dy * k;
    r.group.rotation.x = r.gait === "run" ? 0.16 : (r.gait === "crouch" ? 0.22 : 0);
    if (r.action) r.action.timeScale = r.gait === "idle" ? 0 : (GAIT_RATE[r.gait] ?? 1);
    if (r.mixer) r.mixer.update(dt);
  }
}
/* ---- host-authoritative world sync (dinos + mission/extraction + survivor) ---- */
let _netDinoId = 0, _netDinoAcc = 0, _netWorldAcc = 0;
let _netWorldLast = null, _netWorldLastT = 0;   // latest host world snapshot (for join-in-progress bootstrap)
function netSendDinos() {           // HOST → clients: compact transform snapshot of every live dino
  const d = [];
  for (const a of dinos) { if (!a.alive) continue; if (a._netId == null) a._netId = ++_netDinoId; d.push({ i: a._netId, s: a.sp.id, x: +a.x.toFixed(1), z: +a.z.toFixed(1), y: +a.yaw.toFixed(2), st: a.state, hp: Math.round(a.hp), an: +(a.anim || 0).toFixed(2) }); }
  Net.send({ t: "dinos", d });
}
function netApplyDinos(m) {          // CLIENT: reconcile puppets to the host snapshot
  if (Net.isHost || !m.d) return;
  const seen = new Set();
  let built = 0;
  for (const e of m.d) {
    seen.add(e.i);
    let a = dinosByNetId.get(e.i);                       // O(1) lookup (no scan over dead puppets)
    if (!a) {
      if (!SPECIES[e.s] || built >= 8) continue;         // F-13: cap new puppet builds per snapshot so a join-burst spreads over a few frames instead of stalling one
      a = spawnDino(e.s, e.x, e.z); a._netId = e.i; a.yaw = e.y; dinos.push(a); dinosByNetId.set(e.i, a); built++;
    }
    a._netX = e.x; a._netZ = e.z; a._netYaw = e.y; a.state = e.st; a.hp = e.hp; if (e.an > 0) a.anim = Math.max(a.anim, e.an); a.alive = true;
  }
  for (let i = dinos.length - 1; i >= 0; i--) {           // host culled it → remove the puppet entirely (compact, so the array can't grow across waves)
    const a = dinos[i];
    if (a._netId != null && !seen.has(a._netId)) { scene.remove(a.mesh); dinos.splice(i, 1); dinosByNetId.delete(a._netId); }
  }
}
function updateNetDinos(dt) {        // CLIENT: interpolate puppets toward host transforms + animate
  const k = Math.min(1, dt * 9), idt = Math.max(dt, 0.016);
  for (const a of dinos) {
    if (!a.alive) continue;
    if (a._netX != null) {
      a.vx = (a._netX - a.x) / idt; a.vz = (a._netZ - a.z) / idt;
      a.x += (a._netX - a.x) * k; a.z += (a._netZ - a.z) * k;
      let dy = a._netYaw - a.yaw; while (dy > Math.PI) dy -= 6.2832; while (dy < -Math.PI) dy += 6.2832; a.yaw += dy * k;
    }
    a.lod = dist2(a.x, a.z, S.player.x, S.player.z) < BIOME.spawnDirector.activeRadiusM ** 2 ? "full" : "background";
    animateDino(a, dt);
    if (a.hp <= 0) killDino(a);
  }
}
function netSendWorld() {            // HOST → clients: mission phase + extraction + survivor (cohesion)
  Net.send({ t: "exfil", idx: MC ? MC.idx : -1, started: MC ? (MC.started ? 1 : 0) : 0,
    called: S.extraction.called ? 1 : 0, hold: +(S.extraction.hold || 0).toFixed(1), threat: S.threat, dna: dnaSamples,
    surv: survivor ? { f: survivor.following ? 1 : 0, x: +survivor.x.toFixed(1), z: +survivor.z.toFixed(1) } : 0 });
}
function netApplyWorld(m) {          // CLIENT: apply host's authoritative mission/extraction/survivor state
  if (Net.isHost) return;
  _netWorldLast = m; _netWorldLastT = performance.now();   // remember it so a late joiner can bootstrap to the live phase
  if (m.idx != null && m.idx >= 0 && MC && m.idx !== MC.idx) {
    MC.idx = m.idx;
    // replay completed-phase deltas so a late joiner's world matches: mark earlier consoles/objectives done
    const cm = activeCampaign();
    if (cm && cm.phases) for (let i = 0; i < m.idx && i < cm.phases.length; i++) cm.phases[i]._done = true;
    try { applyPhaseMarker(); } catch (e) {}
  }
  if (MC && m.started) MC.started = true;
  if (m.dna != null && m.dna > dnaSamples) dnaSamples = m.dna;   // adopt the squad's DNA-collection progress (never drop our own)
  S.extraction.called = !!m.called; if (m.hold != null) S.extraction.hold = m.hold;
  if (m.threat != null) S.threat = m.threat;
  if (m.surv && survivor) { survivor.following = !!m.surv.f; survivor.x = m.surv.x; survivor.z = m.surv.z; }
}
function netTick(dt) {
  netSendAcc += dt;
  if (netSendAcc >= 0.08) {   // ~12 Hz: own avatar
    netSendAcc = 0; const P = S.player;
    Net.sendState({ x: +P.x.toFixed(2), z: +P.z.toFixed(2), yaw: +P.yaw.toFixed(2), gait: P.gait, hp: Math.round(P.hp), alive: P.alive });
  }
  if (Net.isHost) {
    _netDinoAcc += dt; if (_netDinoAcc >= 0.12) { _netDinoAcc = 0; netSendDinos(); }       // ~8 Hz dinos
    _netWorldAcc += dt; if (_netWorldAcc >= 0.3) { _netWorldAcc = 0; netSendWorld(); }      // ~3 Hz world
  }
  updateRemotes(dt);
}
function initLobby() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", code4 = () => { let s = ""; for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0]; return s; };
  const status = $("mpStatus"), peersEl = $("mpPeers"), nameI = $("mpName"), roomI = $("mpRoom");
  const myName = () => (nameI.value.trim() || "PLAYER").toUpperCase().slice(0, 16);
  const show = (hosting) => { $("mpHost").style.display = hosting ? "none" : ""; $("mpJoin").style.display = hosting ? "none" : ""; $("mpLeave").style.display = hosting ? "" : "none"; };
  const renderPeers = () => {
    if (!Net.on) { peersEl.innerHTML = ""; return; }
    const me = `<span class="mp-peer${Net.isHost ? " host" : ""}">${(Net.name || "YOU").toUpperCase()} · YOU</span>`;
    peersEl.innerHTML = me + [...Net.peers.values()].map(p => `<span class="mp-peer">${(p.name || "P").toUpperCase()}</span>`).join("");
  };
  Net.onEvent("welcome", () => {
    // adopt the room's mission so the whole squad runs the same world, objectives & intro (host-authoritative)
    if (Net.mission && MISSIONS[Net.mission] && Net.mission !== selectedMission.id) {
      selectedMission = MISSIONS[Net.mission];
      const ms = $("missionSelect"); if (ms) ms.querySelectorAll(".mission-card").forEach(c => c.classList.toggle("sel", c.dataset.k === Net.mission));
      const b = $("sBlurb"); if (b) b.textContent = selectedMission.blurb;
      tabsDone.mission = true; refreshStart();
    }
    const mn = selectedMission ? ` · mission: ${selectedMission.name}` : "";
    status.innerHTML = `Co-op room <span class="code">${Net.room}</span> · ${Net.isHost ? "hosting" : "joined"}${Net.isHost ? "" : mn} · share the code, then BEGIN`;
    roomI.value = Net.room; show(true); renderPeers();
  });
  Net.onEvent("peers", () => { renderPeers(); if (Net.isHost && S.phase === "playing") { try { netSendWorld(); netSendDinos(); } catch (e) {} } });   // a peer joined mid-run → push live world+dinos at once so they bootstrap instantly
  Net.onEvent("state", netUpsertState);
  Net.onEvent("dinos", netApplyDinos);     // host-authoritative dino transforms
  Net.onEvent("exfil", netApplyWorld);     // host-authoritative mission / extraction / survivor
  Net.onEvent("leave", removeRemote);
  Net.onEvent("full", () => { status.textContent = "That room is full (16 max)"; });
  Net.onEvent("error", () => { status.textContent = "Connection error — playing solo"; });
  Net.onEvent("close", () => { status.textContent = "Playing solo — or host / join a co-op room"; show(false); clearRemotes(); });
  $("mpHost").addEventListener("click", () => { Audio.init(); const c = code4(); roomI.value = c; status.textContent = "Connecting…"; Net.connect(c, myName(), selectedRole.id, (Math.random() * 1e9) >>> 0, selectedMission.id); });
  $("mpJoin").addEventListener("click", () => { Audio.init(); const c = (roomI.value.trim() || "").toUpperCase(); if (!c) { status.textContent = "Enter a room code to join"; return; } status.textContent = "Connecting…"; Net.connect(c, myName(), selectedRole.id, 0, selectedMission.id); });
  $("mpLeave").addEventListener("click", () => { Net.disconnect(); status.textContent = "Playing solo — or host / join a co-op room"; show(false); clearRemotes(); });
}

/* ====================================================== screens ========== */
function showStart() {
  $("sTitle").textContent = STR.title; $("sSub").textContent = STR.subtitle;
  $("sBlurb").textContent = selectedMission.blurb;
  $("sHow").innerHTML = (isTouch ? STR.howto_touch : STR.howto_desktop) + "<br>" + STR.howto_gamepad;
  tabsDone = { mission: false, role: false, coop: false };
  if ($("startTabs")) showTab("mission");   // start on the mission tab, START locked until all three done
}
/* ====================================================== field guide ====== */
let dexBuilt = false, dexMax = null;
// Render a small portrait of a species straight from its loaded .glb (no extra assets/credits).
/* ---- Field Guide: live 3D viewer (drag to rotate · scroll/pinch to zoom) ----
 * The gallery is a fast text name-list (no per-item GL renders — that was the
 * lag). Selecting a species loads its real .glb into ONE persistent, lit, auto-
 * rotating viewer you can spin and zoom. */
let dexR = null, dexScene = null, dexCam = null, dexModel = null, dexLoopOn = false, dexCurrentId = null;
const dexView = { yaw: 0.7, pitch: 0.16, dist: 3.0, radius: 1.5, target: new THREE.Vector3(), drag: false };
function setDexLoading(on) { const e = $("dexLoading"); if (e) e.style.display = on ? "flex" : "none"; }
function dexViewerInit() {
  if (dexR) return;
  const cv = $("dexCanvas"); if (!cv) return;
  const wrap = cv.parentElement;   // a "LOADING MODEL…" overlay so an un-streamed .glb reads as loading, not blank
  if (wrap && !$("dexLoading")) { if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative"; const d = document.createElement("div"); d.id = "dexLoading"; d.textContent = "LOADING MODEL…"; d.style.cssText = "position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#8a978f;font:11px ui-monospace,monospace;letter-spacing:.12em;pointer-events:none;"; wrap.appendChild(d); }
  dexR = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: false });
  dexR.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  dexR.setClearColor(0x0c110d, 1); dexR.outputColorSpace = THREE.SRGBColorSpace;
  dexR.toneMapping = THREE.ACESFilmicToneMapping; dexR.toneMappingExposure = 1.3;
  dexScene = new THREE.Scene();
  dexScene.add(new THREE.HemisphereLight(0xe3eef2, 0x3c4a34, 1.25));   // brighter sky/ground bounce — kills the "dull" look
  const key = new THREE.DirectionalLight(0xfff1de, 2.4); key.position.set(5, 7, 5); dexScene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd4ff, 0.9); fill.position.set(-6, 3, -3); dexScene.add(fill);
  const rim = new THREE.DirectionalLight(0xffce9a, 1.4); rim.position.set(-2, 4, -7); dexScene.add(rim);   // warm backlight separates it from the bg
  if (scene && scene.environment) dexScene.environment = scene.environment;
  const gd = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.MeshStandardMaterial({ color: 0x0e130d, roughness: 1, metalness: 0 }));
  gd.rotation.x = -Math.PI / 2; gd.position.y = -0.02; dexScene.add(gd);
  dexCam = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  // drag to orbit + scroll/pinch to zoom (pointer events cover mouse + touch)
  let px = 0, py = 0, pinch = 0;
  cv.addEventListener("pointerdown", e => { dexView.drag = true; px = e.clientX; py = e.clientY; cv.setPointerCapture && cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", e => { if (!dexView.drag) return; dexView.yaw -= (e.clientX - px) * 0.01; dexView.pitch = Math.max(-0.35, Math.min(0.95, dexView.pitch + (e.clientY - py) * 0.006)); px = e.clientX; py = e.clientY; });
  const end = () => { dexView.drag = false; };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  cv.addEventListener("wheel", e => { dexView.dist = Math.max(1.7, Math.min(7, dexView.dist + Math.sign(e.deltaY) * 0.3)); e.preventDefault(); }, { passive: false });
  cv.addEventListener("touchmove", e => { if (e.touches.length === 2) { const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY, d = Math.hypot(dx, dy); if (pinch) dexView.dist = Math.max(1.7, Math.min(7, dexView.dist - (d - pinch) * 0.012)); pinch = d; e.preventDefault(); } }, { passive: false });
  cv.addEventListener("touchend", () => { pinch = 0; });
}
function dexSetModel(id) {
  if (!dexR) return;
  dexCurrentId = id;
  if (dexModel) { dexScene.remove(dexModel); dexModel = null; }
  const sp = SPECIES[id], tmpl = MODELS[sp.modelPath];
  if (!tmpl) {                                       // not streamed yet — lazy-load on demand, show a spinner, render when it lands
    setDexLoading(true);
    loadModelOnce(sp.modelPath).then(() => { if (dexCurrentId === id && $("codex") && $("codex").classList.contains("on")) dexSetModel(id); });
    return;
  }
  setDexLoading(false);
  let skinned = false; tmpl.traverse(o => { if (o.isSkinnedMesh) skinned = true; });
  const inst = skinned ? skeletonClone(tmpl) : tmpl.clone(true);
  inst.traverse(o => { if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false; });
  // Show every species at its clean BIND POSE (no baked clip) — same as in-game. The auto-rig walk clip
  // mangled the T-Rex (stretched mesh); the viewer just auto-rotates, so a static pose reads best.
  const g = fitModel(inst, 2.2, sp.modelYaw || 0);
  dexScene.add(g); dexModel = g;
  const box = measureBox(g), ctr = new THREE.Vector3(), size = new THREE.Vector3();
  box.getCenter(ctr); box.getSize(size);
  dexView.target.copy(ctr);
  dexView.radius = (Math.max(size.x, size.y, size.z) * 0.5) || 1;
  dexView.yaw = 0.7; dexView.pitch = 0.16; dexView.dist = 3.0;   // reset framing per species
}
function dexLoop() {
  const codex = $("codex");
  if (!codex || !codex.classList.contains("on")) { dexLoopOn = false; return; }   // self-stops when the guide closes
  requestAnimationFrame(dexLoop);
  const cv = dexR.domElement, w = cv.clientWidth || 1, h = cv.clientHeight || 1, pr = dexR.getPixelRatio();
  if (cv.width !== Math.floor(w * pr) || cv.height !== Math.floor(h * pr)) { dexR.setSize(w, h, false); dexCam.aspect = w / h; dexCam.updateProjectionMatrix(); }
  if (!dexView.drag) dexView.yaw += 0.0045;          // gentle auto-spin when idle
  const r = dexView.radius * dexView.dist, cp = Math.cos(dexView.pitch);
  dexCam.position.set(dexView.target.x + Math.sin(dexView.yaw) * r * cp, dexView.target.y + Math.sin(dexView.pitch) * r, dexView.target.z + Math.cos(dexView.yaw) * r * cp);
  dexCam.lookAt(dexView.target);
  if (dexModel && dexModel.userData.mixer) dexModel.userData.mixer.update(0.016);
  dexR.render(dexScene, dexCam);
}
function dexStart() { dexViewerInit(); if (!dexLoopOn) { dexLoopOn = true; requestAnimationFrame(dexLoop); } }
function buildFieldGuide() {
  const grid = $("dexGrid"); if (!grid) return;
  const list = Object.values(SPECIES);
  dexMax = { run: 0, len: 0, mass: 0, hp: 0, dmg: 1, sight: 0 };
  list.forEach(s => { dexMax.run = Math.max(dexMax.run, s.move.run); dexMax.len = Math.max(dexMax.len, s.size.lengthM); dexMax.mass = Math.max(dexMax.mass, s.size.massKg); dexMax.hp = Math.max(dexMax.hp, s.combat.health); dexMax.dmg = Math.max(dexMax.dmg, s.combat.damage); dexMax.sight = Math.max(dexMax.sight, s.senses.sightRangeM); });
  const order = list.slice().sort((a, b) => a.diet === b.diet ? b.size.lengthM - a.size.lengthM : (a.diet === "carnivore" ? -1 : 1));
  grid.innerHTML = order.map(s => `<button class="dex-card ${s.diet === "carnivore" ? "pred" : "herb"}" data-id="${s.id}">
    <span class="dc-name">${s.displayName}</span><span class="dc-tag">${s.diet === "carnivore" ? "PREDATOR" : "HERBIVORE"} · ${s.archetype}</span></button>`).join("");
  grid.querySelectorAll(".dex-card").forEach(c => c.addEventListener("click", () => {
    grid.querySelectorAll(".dex-card").forEach(x => x.classList.toggle("sel", x === c));
    renderDex(c.dataset.id);
  }));
  dexViewerInit();
  if (order[0]) { renderDex(order[0].id); grid.firstElementChild && grid.firstElementChild.classList.add("sel"); }
  dexBuilt = true;
}
function dexBar(label, val, max, unit) {
  const pct = Math.max(3, Math.min(100, (val / (max || 1)) * 100));
  return `<div class="dx-stat"><span>${label}</span><div class="dx-bar"><i style="width:${pct.toFixed(0)}%"></i></div><b>${val}${unit || ""}</b></div>`;
}
function renderDex(id) {
  const s = SPECIES[id], c = CODEX[id] || {}, carn = s.diet === "carnivore";
  $("dexDetail").innerHTML = `
    <div class="dd-head ${carn ? "pred" : "herb"}"><div class="dd-name">${s.displayName}</div>
      <div class="dd-sub">${carn ? "PREDATOR" : "HERBIVORE"} · ${s.archetype} · ${c.era || ""}</div></div>
    <p class="dd-facts">${c.facts || ""}</p>
    <div class="dd-stats">
      ${dexBar("LENGTH", s.size.lengthM, dexMax.len, " m")}
      ${dexBar("MASS", s.size.massKg, dexMax.mass, " kg")}
      ${dexBar("RUN SPEED", s.move.run, dexMax.run, " m/s")}
      ${dexBar("HEALTH", s.combat.health, dexMax.hp, "")}
      ${dexBar("ATTACK", s.combat.damage, dexMax.dmg, "")}
      ${dexBar("SIGHT", s.senses.sightRangeM, dexMax.sight, " m")}
    </div>
    <div class="dd-cols">
      <div class="dd-col str"><h4>STRENGTHS</h4><ul>${(c.strengths || []).map(x => `<li>${x}</li>`).join("")}</ul></div>
      <div class="dd-col weak"><h4>WEAKNESSES</h4><ul>${(c.weaknesses || []).map(x => `<li>${x}</li>`).join("")}</ul></div>
    </div>
    <div class="dd-survive"><h4>${carn ? "HOW TO SURVIVE IT" : "HANDLING"}</h4><p>${c.survival || ""}</p></div>`;
  dexSetModel(id);
}
$("guideBtn").addEventListener("click", () => { $("codex").classList.add("on"); if (!dexBuilt) buildFieldGuide(); dexStart(); });
$("dexClose").addEventListener("click", () => $("codex").classList.remove("on"));

$("startBtn").addEventListener("click", () => { Audio.init(); startRun(); });   // pointer lock acquired at the intro handoff
$("againBtn").addEventListener("click", () => { Audio.init(); startRun(); });
const introSkipBtn = $("introSkip"); if (introSkipBtn) introSkipBtn.addEventListener("click", skipIntro);
$("againBtn").textContent = STR.again;

boot();
