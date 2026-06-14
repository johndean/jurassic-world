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
  }));
}
const GRACE_S = 7;   // predators ignore the player for the first seconds of a run (anti-spawn-camp)
const _gltfLoader = new GLTFLoader();
function loadModel(path) {
  return new Promise(res => _gltfLoader.load(path,
    gltf => { gltf.scene.traverse(o => { if (o.isMesh) o.frustumCulled = true; }); MODEL_ANIMS[path] = gltf.animations || []; res(gltf.scene); },
    undefined,
    () => res(null)));            // missing/failed model -> null -> grey-box fallback
}
// Load creatures FIRST (player + every species) so dinos are textured ASAP; each species
// re-skins its already-spawned grey-box instances the instant it lands. The big foliage-tree
// .glb files (~30 MB) load last so they never gate the creature skins behind them.
async function preloadModels() {
  const creatures = [...new Set([PLAYER_MODEL, ...ROLES.map(r => r.model), ...Object.values(SPECIES).map(s => s.modelPath)].filter(Boolean))];
  await Promise.all(creatures.map(async p => { MODELS[p] = await loadModel(p); reskinDinos(p); }));
  if (!playerMixer) buildPlayer();
  const foliage = [...new Set([FOLIAGE.tree, FOLIAGE.fern, HELI_MODEL].filter(Boolean))];
  await Promise.all(foliage.map(async p => { MODELS[p] = await loadModel(p); }));
  buildFoliage();
  // hero ruin structures (photoreal .glb) — replace the procedural gate/centre once they land
  const ruins = [...new Set([RUINS.gate.url, RUINS.centre.url].filter(Boolean))];
  await Promise.all(ruins.map(async p => { MODELS[p] = await loadModel(p); }));
  buildRuinModels();
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
let blobPool = [];
let beaconMesh, beaconRing, beaconGlow, playerMesh;

// camera orbit
const cam = { yaw: 0, pitch: -0.18, dist: 7.2, height: 2.4 };

/* ---------------------------------------------------------------- boot ---- */
async function boot() {
  const [sp, bi, ar] = await Promise.all([
    fetch("./data/species.json").then(r => r.json()),
    fetch("./data/biome.alpha.json").then(r => r.json()),
    fetch("./data/archetypes.json").then(r => r.json()).catch(() => ({ archetypes: {} })),
  ]);
  ARCHETYPES = ar.archetypes || {};
  sp.species.forEach(s => { s.arch = resolveArchetype(s); SPECIES[s.id] = s; });
  BIOME = bi;

  initRenderer();
  buildWorld();
  initInput();
  initAudio();
  buildStaticHUD();
  showStart();
  initCharSelect();
  initLobby();
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
    new THREE.MeshStandardMaterial({ color: 0x2f5358, roughness: 0.22, metalness: 0.25, transparent: true, opacity: 0.85 }));
  water.rotation.x = -Math.PI / 2; water.position.y = -1.1; scene.add(water);

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
  const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x5b615f, roughness: 1, flatShading: true }), NR);
  for (let i = 0; i < NR; i++) {
    let x, z;
    if (i % 3 === 0) { x = rand(-half + 10, half - 10); z = 48 + Math.sin(x * 0.02) * 28 + rand(-13, 13); }  // riverside
    else { x = rand(-half + 4, half - 4); z = rand(-half + 4, half - 4); }
    const s = rand(0.7, 3.6) * (i % 3 === 0 ? 1.4 : 1);
    dm.position.set(x, groundH(x, z) + s * 0.25, z); dm.rotation.set(rand(0, 3), rand(0, 6), rand(0, 3)); dm.scale.set(s, s * 0.7, s); dm.updateMatrix();
    rocks.setMatrixAt(i, dm.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  scene.add(rocks);

  buildRuins();
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

  // ---- abandoned tour jeep ----
  (function jeep() {
    const jx = 18, jz = 16, j = new THREE.Group();
    j.add(new THREE.Mesh(new THREE.BoxGeometry(5, 1.5, 2.4), new THREE.MeshStandardMaterial({ color: 0xa7a48f, roughness: 0.95, flatShading: true })));
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.3, 2.2), new THREE.MeshStandardMaterial({ color: 0x8a322c, roughness: 0.95, flatShading: true })); cab.position.set(-0.4, 1.25, 0); j.add(cab);
    // roll bars
    const bar = new THREE.CylinderGeometry(0.08, 0.08, 2.4, 6);
    for (const bx of [-0.6, 0.8]) { const b = new THREE.Mesh(bar, rust); b.rotation.x = Math.PI / 2; b.position.set(bx, 2.1, 0); j.add(b); }
    const wgeo = new THREE.CylinderGeometry(0.72, 0.72, 0.5, 14), wm = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 1 });
    for (const [dx, dz] of [[-1.8, -1.1], [1.8, -1.1], [-1.8, 1.1], [1.8, 1.1]]) { const w = new THREE.Mesh(wgeo, wm); w.rotation.x = Math.PI / 2; w.position.set(dx, -0.5, dz); j.add(w); }
    j.position.set(jx, groundH(jx, jz) + 1.15, jz); j.rotation.set(0.04, 0.6, 0.05); g.add(j);
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

function buildBeacon() {
  const half = BIOME.map.size / 2;
  const [a, b] = BIOME.extraction.beaconPickRingM;
  const ang = rand(0, Math.PI * 2), d = rand(a, Math.min(b, half - 12));
  const bx = Math.cos(ang) * d, bz = Math.sin(ang) * d;
  S.extraction.beacon.x = bx; S.extraction.beacon.z = bz;

  const g = new THREE.Group(); g.position.set(bx, groundH(bx, bz), bz);
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
const input = { mx: 0, mz: 0, sprint: false, crouch: false, lookDX: 0, lookDY: 0 };
let pointerLocked = false, isTouch = false;

function initInput() {
  const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
  addEventListener("keydown", e => {
    if (typing(e)) return;   // let text fields (lobby name/room code) receive every key, incl. WASD/E/Space
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyE", "Space"].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.code === "KeyE") tryCall();
    if (e.code === "KeyM") toggleMap();
    if (e.code === "Escape" && mapOpen) toggleMap();
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

  // touch
  if (matchMedia("(pointer:coarse)").matches || "ontouchstart" in window) { isTouch = true; setupTouch(); }
  $("touch").style.display = isTouch ? "block" : "none";
}

function setupTouch() {
  const stick = $("stick"), knob = $("stickKnob"), look = $("lookpad");
  let sid = null, ox = 0, oy = 0, lid = null, lx = 0, ly = 0;
  const t = (e, el) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  stick.addEventListener("pointerdown", e => { sid = e.pointerId; [ox, oy] = [e.clientX, e.clientY]; knob.style.left = e.clientX + "px"; knob.style.top = e.clientY + "px"; stick.setPointerCapture(e.pointerId); });
  stick.addEventListener("pointermove", e => {
    if (e.pointerId !== sid) return;
    let dx = e.clientX - ox, dy = e.clientY - oy; const len = Math.hypot(dx, dy) || 1, max = 52;
    const cl = Math.min(len, max); dx = dx / len * cl; dy = dy / len * cl;
    knob.style.left = (ox + dx) + "px"; knob.style.top = (oy + dy) + "px";
    input.mx = dx / max; input.mz = dy / max;
  });
  const endStick = e => { if (e.pointerId === sid) { sid = null; input.mx = input.mz = 0; knob.style.left = "-200px"; } };
  stick.addEventListener("pointerup", endStick); stick.addEventListener("pointercancel", endStick);
  look.addEventListener("pointerdown", e => { lid = e.pointerId; lx = e.clientX; ly = e.clientY; look.setPointerCapture(e.pointerId); });
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
  $("btnCall").addEventListener("pointerdown", e => { e.preventDefault(); tryCall(); });
}

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const dz = v => Math.abs(v) < 0.18 ? 0 : v;
    input.mx = dz(gp.axes[0] || 0); input.mz = dz(gp.axes[1] || 0);
    cam.yaw -= dz(gp.axes[2] || 0) * 0.05; cam.pitch = clamp(cam.pitch - dz(gp.axes[3] || 0) * 0.04, -0.95, 0.45);
    input.sprint = gp.buttons[0]?.pressed || false;   // A
    input.crouch = gp.buttons[1]?.pressed || false;   // B
    if (gp.buttons[2]?.pressed) tryCall();             // X
    return;
  }
}

/* ===================================================== ground & helpers === */
// terrain height: rolling valley floor (>=~0), perimeter mountain ring, and a winding carved river.
// Everything (ground mesh, foliage, rocks, dinos, player) is placed by this single function.
function riverCenter(x) { return 48 + Math.sin(x * 0.02) * 28; }   // river centerline z(x)
function groundH(x, z) {
  const r = Math.hypot(x, z);
  let h = 1.8 + Math.sin(x * 0.05) * Math.cos(z * 0.045) * 1.3 + Math.sin(x * 0.13 + z * 0.09) * 0.5;  // rolling hills
  const e = Math.max(0, (r - 70) / 48);
  h += e * e * 32 * (0.75 + 0.25 * Math.sin(x * 0.07) * Math.cos(z * 0.06));   // mountains ring the valley
  const dRiver = Math.abs(z - riverCenter(x));
  if (dRiver < 11) h -= (1 - dRiver / 11) * 4.0;   // carve the riverbed
  return h;
}
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function bearingTo(ax, az, bx, bz) {
  const ang = Math.atan2(bx - ax, -(bz - az)) / DEG; const d = (ang + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(d / 45) % 8];
}

/* ======================================================= player update === */
let hitCooldownVisual = 0, stepPhase = 0;
function updatePlayer(dt) {
  const P = S.player, cfg = BIOME.player;
  if (evacCine()) return;   // evac cinematic drives the player (boarding); ignore input
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
  const targetNoise = (cfg.noise[gait] ?? 0) * (rmod.noise || 1); // role perk: stealth/noise (research)
  P.noise = lerp(P.noise, S.extraction.called ? Math.max(targetNoise, 0.6) : targetNoise, 0.15);

  // stamina (fear throttles regen; survival perk slows the drain)
  if (gait === "run" && moving) P.stamina = Math.max(0, P.stamina - cfg.staminaDrainPerS * (rmod.drain || 1) * dt);
  else P.stamina = Math.min(100, P.stamina + cfg.staminaRegenPerS * (1 - P.fear * 0.7) * dt);

  // health slow regen when calm & unhurt (medic perk boosts it)
  hitCooldownVisual = Math.max(0, hitCooldownVisual - dt);
  if (P.fear < 0.3 && hitCooldownVisual <= 0 && P.hp > 0) P.hp = Math.min(100, P.hp + cfg.healthRegenPerS * (rmod.heal || 1) * dt);

  // move relative to camera yaw
  if (moving) {
    const sin = Math.sin(cam.yaw), cos = Math.cos(cam.yaw);
    const wx = (ix * cos - iz * sin), wz = (ix * sin + iz * cos);
    const nx = P.x + wx * speed * dt, nz = P.z + wz * speed * dt;
    P.x = nx; P.z = nz;
    P.yaw = lerp2angle(P.yaw, Math.atan2(wx, wz));
    // footstep audio cadence
    stepPhase += speed * dt;
    if (stepPhase > (gait === "run" ? 1.7 : 2.6)) { stepPhase = 0; Audio.step(gait); }
  }
  // collide with trees
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i], rr = (t.r + 0.5);
    if (dist2(P.x, P.z, t.x, t.z) < rr * rr) {
      const dx = P.x - t.x, dz = P.z - t.z, d = Math.hypot(dx, dz) || 1;
      P.x = t.x + dx / d * rr; P.z = t.z + dz / d * rr;
    }
  }
  const lim = BIOME.map.size / 2 - 3;
  P.x = clamp(P.x, -lim, lim); P.z = clamp(P.z, -lim, lim);

  // posture per gait: running pitches the torso forward into the stride (the single walk clip sped up
  // reads as a power-walk otherwise); crouch drops + leans; idle adds a breathing sway (clip frozen).
  const crouchDrop = P.gait === "crouch" ? 0.4 : 0;
  const idleBob = P.gait === "idle" ? Math.sin(S.t * 1.8) * 0.02 : 0;
  const runBounce = P.gait === "run" ? Math.abs(Math.sin(S.t * 11)) * 0.05 : 0;   // light foot-strike bob
  playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9 - crouchDrop + idleBob + runBounce, P.z);
  playerMesh.rotation.y = P.yaw;
  playerMesh.rotation.x = (P.gait === "run" ? 0.16 : 0) + (P.gait === "crouch" ? 0.22 : 0) + (P.gait === "idle" ? Math.sin(S.t * 1.8) * 0.012 : 0);

  // extraction proximity
  const bd = Math.sqrt(dist2(P.x, P.z, S.extraction.beacon.x, S.extraction.beacon.z));
  const wasIn = S.extraction.inRange;
  S.extraction.inRange = bd < 6.5;
  if (S.extraction.inRange && !wasIn && !S.extraction.called) toast(STR.beaconReached);
  if (S.extraction.inRange) S._everInRange = true;
}
function lerp2angle(a, b) { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; return a + d * 0.25; }

function damagePlayer(amount, bySpecies) {
  const P = S.player; if (!P.alive) return;
  if (evacCine()) return;   // invulnerable once boarding the chopper / lifting off
  P.hp = Math.max(0, P.hp - amount);
  hitCooldownVisual = 3.0; flash(); Audio.hit();
  if (P.hp <= 0) { P.alive = false; S.killedBy = bySpecies; endRun(false); }
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
  let box = measureBox(model);
  const size = new THREE.Vector3(); box.getSize(size);
  model.scale.setScalar(targetH / (size.y || 1));
  box = measureBox(model);
  const c = new THREE.Vector3(); box.getCenter(c);
  model.position.x -= c.x; model.position.z -= c.z; model.position.y -= box.min.y;  // center + drop feet to 0
  model.rotation.y = yawOffset || 0;     // facing correction (model forward axis vs game +Z)
  g.add(model);
  return g;
}
// real .glb dino instance, scaled to the species' grey-box stand height. Rigged+animated models
// (e.g. hero bipeds with a baked walk clip) are cloned with SkeletonUtils (clone(true) breaks
// skinned skeletons) and get their own AnimationMixer, surfaced on g.userData for the agent to drive.
function buildModelMesh(sp, tmpl) {
  const anims = MODEL_ANIMS[sp.modelPath] || [];
  let skinned = false; tmpl.traverse(o => { if (o.isSkinnedMesh) skinned = true; });
  const inst = (skinned ? skeletonClone(tmpl) : tmpl.clone(true));
  const g = fitModel(inst, sp.greybox.standH || sp.size.eyeHeightM || 3, sp.modelYaw || 0);
  if (skinned && anims.length) {
    const mixer = new THREE.AnimationMixer(inst);
    const action = mixer.clipAction(anims[0]); action.play();
    g.userData.mixer = mixer; g.userData.walkAction = action;
  }
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
  g.userData.greybox = true;   // flag so we can upgrade to the textured model once it streams in
  return g;
}

// perception: vision cone + hearing (no per-frame raycast; cost-bounded)
function perceive(a, P) {
  const dx = P.x - a.x, dz = P.z - a.z, d = Math.hypot(dx, dz) || 1;
  const s = a.sp.senses;
  // sight: range scaled by crouch (stealth) + fov check
  const effRange = s.sightRangeM * (S.player.gait === "crouch" ? 0.45 : 1) * (P.role && P.role.mod.seen ? P.role.mod.seen : 1);
  let seen = false;
  if (d < effRange) {
    const fwdx = Math.sin(a.yaw), fwdz = Math.cos(a.yaw);
    const dot = (dx / d) * fwdx + (dz / d) * fwdz;
    if (dot > Math.cos(s.sightFovDeg * 0.5 * DEG)) seen = true;
  }
  // hearing: radius scales with player noise
  const heard = d < s.hearingRangeM * (0.35 + P.noise * 0.9);
  if (seen || heard) { a.bb.lastSeenX = P.x; a.bb.lastSeenZ = P.z; a.bb.hasTarget = true; }
  return { seen, heard, d };
}

// utility scorer (~4 Hz) — picks a state; emergent, not scripted
function decide(a, P) {
  const sp = a.sp, bb = a.bb;
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
  if (a.hp < sp.combat.health * sp.behavior.fleeHealthPct) { a.state = "Retreat"; return; }
  if (S.t >= GRACE_S) {   // spawn grace: ignore the player for the first seconds so you can orient/move
    if (per.seen && per.d < sp.combat.attackRangeM + 0.5) { a.state = "Attack"; return; }
    if ((per.seen || (bb.hasTarget && rng() < aggr)) && per.d < sp.senses.sightRangeM * 1.4) { a.state = (usesPackTactics(sp) ? "Chase" : (per.seen ? "Chase" : "Stalk")); return; }
    if (bb.hasTarget && (per.heard || rng() < aggr * 0.6)) { a.state = "Investigate"; return; }
  }
  // no player interest → hunt herd prey (predator vs prey) or patrol
  const prey = nearestPreyTo(a.x, a.z);
  if (prey && Math.hypot(prey.x - a.x, prey.z - a.z) < sp.senses.sightRangeM) { a.state = "Chase"; bb.lastSeenX = prey.x; bb.lastSeenZ = prey.z; bb.preyHunt = prey; }
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
  // lead = closest; flanks alternate sides; rest harry from behind
  pack.sort((a, b) => dist2(a.x, a.z, P.x, P.z) - dist2(b.x, b.z, P.x, P.z));
  pack.forEach((d, i) => {
    if (i === 0) d.bb.role = "lead";
    else if (i <= 2) { d.bb.role = "flank"; d.bb.flankSide = (i % 2 === 1) ? 1 : -1; }
    else d.bb.role = "harry";
  });
}

// execute the chosen state via steering → vx,vz
function steer(a, dt, P) {
  const sp = a.sp, bb = a.bb;
  let tx = a.x, tz = a.z, run = false, sepW = 1;
  switch (a.state) {
    case "Graze": {
      const hc = herdCenter();
      if (hc && Math.hypot(hc.x - a.x, hc.z - a.z) > 14) { tx = hc.x; tz = hc.z; }   // cohesion
      else { tx = a.x + Math.sin(a.yaw + Math.sin(S.t * 0.3 + a.x) * 0.6); tz = a.z + Math.cos(a.yaw + 0.3); } // amble
      bb.scared = Math.max(0, bb.scared - dt);
      break;
    }
    case "Flee": {
      run = true; bb.scared = 0.8;
      tx = a.x + (a.x - bb.fleeFromX); tz = a.z + (a.z - bb.fleeFromZ);
      // stampede propagation: scare nearby herdmates
      for (const o of dinos) if (isPrey(o.sp) && o.alive && o !== a && dist2(a.x, a.z, o.x, o.z) < 220) o.bb.scared = Math.max(o.bb.scared, 0.6);
      break;
    }
    case "Patrol": { tx = bb.homeX + Math.sin(S.t * 0.2 + bb.homeX) * sp.behavior.territoryRadiusM * 0.5; tz = bb.homeZ + Math.cos(S.t * 0.17 + bb.homeZ) * sp.behavior.territoryRadiusM * 0.5; break; }
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
      if (d < sp.combat.attackRangeM && a.cd <= 0 && S.player.alive) { a.cd = sp.combat.attackCooldownS; a.anim = 0.4; damagePlayer(sp.combat.damage, sp.displayName); }
      // also can kill prey
      if (bb.preyHunt && Math.hypot(bb.preyHunt.x - a.x, bb.preyHunt.z - a.z) < sp.combat.attackRangeM + 1 && a.cd <= 0) { a.cd = 1; bb.preyHunt.hp -= 30; }
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
  if (Math.hypot(a.vx, a.vz) > 0.2) a.yaw = lerp2angle(a.yaw, Math.atan2(a.vx, a.vz));
  // place + animate
  a.mesh.position.set(a.x, groundH(a.x, a.z), a.z);
  a.mesh.rotation.y = a.yaw;
  a.anim = Math.max(0, a.anim - dt);
  if (a.roar > 0) a.roar = Math.max(0, a.roar - dt);
  const vmag = Math.hypot(a.vx, a.vz);
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
    if (a.roarCd <= 0) { a.roar = 1.1; a.roarCd = rand(6, 11); if (dist2(a.x, a.z, P.x, P.z) < 62 * 62) Audio.roar(); }
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
    if (a.decideIn <= 0) { a.decideIn = 0.25; if (a.lod === "full") decide(a, P); else { a.state = baseStateFor(a.sp); } }
    steer(a, dt, P);
    if (a.hp <= 0) killDino(a);
  }
}
function killDino(a) { a.alive = false; scene.remove(a.mesh); }

/* ================================================== spawn director ======= */
let spawnTimer = 0;
function updateSpawnDirector(dt, P) {
  const sd = BIOME.spawnDirector;
  spawnTimer -= dt;
  if (spawnTimer > 0) return;
  spawnTimer = S.extraction.called ? sd.escalation.spawnIntervalS : sd.escalation.spawnIntervalS * 1.4;
  const active = dinos.filter(d => d.alive).length;
  for (const r of sd.roster) {
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
    if (evac) { evac.phase = "boarding"; evac.t = 0; }   // board the hovering chopper, then lift off (cinematic)
    else endRun(true);
  }
}

/* ============================================ helicopter evac cinematic === *
 * On "call extraction" a real chopper flies in and hovers at the beacon. On a
 * successful hold the player boards, it lifts off, and the camera rises to an
 * aerial fly-over of the whole park before the EXTRACTED screen. */
let evac = null;   // { phase: incoming|hover|boarding|liftoff, t, heli:{group,rotor}, hx, hz, hoverY, done }

function buildHeli() {
  const g = new THREE.Group();
  let rotor = null;
  if (MODELS[HELI_MODEL]) {
    g.add(fitModel(MODELS[HELI_MODEL].clone(true), 4.6, 0));   // realistic model, ~4.6m tall
  } else {                                                     // procedural fallback (boxy but functional)
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x49513f, roughness: 0.85, metalness: 0.2, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x20231e, roughness: 1 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 3.2, 6, 12), bodyMat); body.rotation.z = Math.PI / 2; body.position.y = 0.6; g.add(body);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 0.5), bodyMat); tail.position.set(-3.8, 1.1, 0); g.add(tail);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.2, 0.4), bodyMat); fin.position.set(-6, 1.5, 0); g.add(fin);
    for (const sx of [-1, 1]) { const sk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.2, 6), dark); sk.rotation.x = Math.PI / 2; sk.position.set(0.3, -0.9, sx * 1.1); g.add(sk); }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 6), dark); mast.position.y = 2.4; g.add(mast);
  }
  // spinning rotor disc (motion-blur look) — sells a running chopper for model + fallback alike
  rotor = new THREE.Mesh(new THREE.CircleGeometry(6.8, 36), new THREE.MeshBasicMaterial({ color: 0x0c0e0c, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  rotor.rotation.x = -Math.PI / 2; rotor.position.y = 2.7; g.add(rotor);
  scene.add(g);
  return { group: g, rotor };
}
function startEvac() {
  if (evac) return;
  const bx = S.extraction.beacon.x, bz = S.extraction.beacon.z;
  const heli = buildHeli();
  heli.group.position.set(bx + 45, 115, bz + 45);          // enters high + far
  evac = { phase: "incoming", t: 0, heli, hx: bx, hz: bz, hoverY: groundH(bx, bz) + 9, done: false };
}
function updateEvac(dt) {
  if (!evac) return;
  const g = evac.heli.group; evac.t += dt;
  if (evac.heli.rotor) evac.heli.rotor.rotation.z += dt * 42;            // spin rotor
  const bx = evac.hx, bz = evac.hz;
  if (evac.phase === "incoming") {
    g.position.lerp(tmp.set(bx + 7, evac.hoverY, bz + 7), Math.min(1, dt * 0.6));
    if (g.position.distanceTo(tmp.set(bx + 7, evac.hoverY, bz + 7)) < 1.5) evac.phase = "hover";
  } else if (evac.phase === "hover") {
    g.position.y = evac.hoverY + Math.sin(evac.t * 1.5) * 0.3;
  } else if (evac.phase === "boarding") {
    g.position.y = evac.hoverY + Math.sin(evac.t * 1.5) * 0.3;
    const P = S.player;                                                   // walk under the chopper, then board
    P.x += (bx - P.x) * Math.min(1, dt * 2); P.z += (bz - P.z) * Math.min(1, dt * 2); P.gait = "walk";
    if (playerMesh) playerMesh.position.set(P.x, groundH(P.x, P.z) + 0.9, P.z);
    if (evac.t > 1.6) { if (playerMesh) playerMesh.visible = false; evac.phase = "liftoff"; evac.t = 0; Audio.beacon(true); }
  } else if (evac.phase === "liftoff") {
    g.position.y += dt * 9; g.position.x += dt * 5; g.position.z -= dt * 2;   // climb + fly away
    if (evac.t > 5.2 && !evac.done) { evac.done = true; endRun(true); }
  }
}
function clearEvac() { if (evac) { scene.remove(evac.heli.group); evac = null; } }

/* ================================================== run lifecycle ======== */
function startRun() {
  // reset
  for (const d of dinos) scene.remove(d.mesh); dinos = [];
  clearRemotes(); clearEvac();
  // co-op: all players seed from the room so terrain/beacon/initial spawns match (dinos drift locally, v2: host sync)
  reseed(Net.on ? (Net.seed >>> 0) : ((Math.random() * 1e9) >>> 0));
  Object.assign(S.player, { x: 0, z: 0, yaw: 0, hp: 100, stamina: 100, noise: 0, fear: 0, gait: "idle", alive: true, role: selectedRole });
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
  S.phase = "playing";
  $("startScreen").classList.add("hidden"); $("endScreen").classList.add("hidden");
  cam.yaw = 0; cam.pitch = -0.18;
  Audio.ambient(true);
}
function endRun(won) {
  if (S.phase !== "playing") return;
  S.phase = won ? "won" : "lost";
  Audio.ambient(false); won ? Audio.win() : Audio.lose();
  if (pointerLocked) document.exitPointerLock();
  const t = $("endTitle"), b = $("endBody");
  t.textContent = won ? STR.winTitle : STR.loseTitle; t.className = won ? "win" : "lose";
  b.textContent = won ? STR.winBody : (STR.loseBody + (S.killedBy ? `  (${STR.caught} ${S.killedBy})` : ""));
  $("endScreen").classList.remove("hidden");
}

/* ================================================== procedural audio ===== */
const Audio = (() => {
  let ctx = null, ambGain = null, ambOn = false, hbTimer = 0;
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
    hit() { noise(0.18, 0.3, 2200); blip(90, 0.18, "square", 0.12, 50); },
    beacon(call) { blip(call ? 880 : 1320, call ? 0.4 : 0.12, "square", 0.12, call ? 660 : null); },
    win() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => blip(f, 0.4, "triangle", 0.18), i * 130)); },
    lose() { [196, 165, 131, 98].forEach((f, i) => setTimeout(() => blip(f, 0.5, "sawtooth", 0.16), i * 160)); },
  };
})();
function initAudio() { /* ctx created on first gesture (start button) */ }

/* ====================================================== HUD ============== */
const COMPASS_TICKS = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
function buildStaticHUD() {
  $("objTitle").textContent = STR.objMission;
  $("sqTitle").textContent = STR.squadStatus;
  $("thrTitle").textContent = STR.threatLevel;
  $("vHealthL").textContent = STR.vHealth; $("vStaminaL").textContent = STR.vStamina; $("vNoiseL").textContent = STR.vNoise;
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
  // objectives
  $("objSub").textContent = STR.objReach + " · " + Math.round(Math.sqrt(dist2(P.x, P.z, S.extraction.beacon.x, S.extraction.beacon.z))) + " " + STR.km;
  const objs = [
    { l: STR.objLocate, done: S._everInRange },
    { l: STR.objCall, done: S.extraction.won },
  ];
  $("objList").innerHTML = objs.map(o => `<li class="${o.done ? "done" : ""}"><span class="obj-check">${o.done ? "◆" : "◇"}</span>${o.l}</li>`).join("");

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

// Build the tactical map as an SVG string (viewBox 0..100). Shared by the corner minimap (big=false)
// and the fullscreen overlay (big=true, which adds species tooltips + bigger markers).
let mapOpen = false;
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
  // contacts: predators = heading triangles (apex outlined), herbivores = dots
  for (const d of dinos) {
    if (!d.alive) continue;
    const [mx, mz] = toMM(d.x, d.z), apex = d.sp.role === "apex", tt = big ? `><title>${d.sp.displayName}</title></polygon` : "/";
    if (d.sp.diet === "carnivore") s += `<polygon points="${tri(mx, mz, d.yaw, apex ? 2.9 : 2.1)}" class="mm-threat${apex ? " mm-apex" : ""}"${tt}>`;
    else s += `<circle cx="${mx.toFixed(1)}" cy="${mz.toFixed(1)}" r="${big ? 1.7 : 1.4}" class="mm-prey"${big ? `><title>${d.sp.displayName}</title></circle` : "/"}>`;
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
  $("mapOverlay").classList.toggle("open", mapOpen);
}

let toastTimer = 0;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.opacity = "1"; toastTimer = 2.4; }
function flash() { const f = $("flash"); f.style.transition = "none"; f.style.opacity = "0.5"; requestAnimationFrame(() => { f.style.transition = "opacity .4s"; f.style.opacity = "0"; }); }

/* ====================================================== camera =========== */
function updateCamera() {
  const P = S.player;
  if (evacCine()) {   // evac: rise high and recentre to keep visual over the whole park while the chopper climbs away
    const g = evac.heli.group, prog = evac.phase === "liftoff" ? Math.min(1, evac.t / 5.2) : 0;
    camera.position.lerp(tmp.set((evac.hx + 18) * (1 - prog), 26 + prog * 112, (evac.hz + 60) * (1 - prog) + 72 * prog), 0.04);
    camera.lookAt(g.position.x * (1 - prog), g.position.y * (1 - prog) + 6 * prog, g.position.z * (1 - prog));
    if (beaconRing) beaconRing.rotation.z += 0.08;
    return;
  }
  const tx = P.x, ty = groundH(P.x, P.z) + 1.5, tz = P.z;
  const cp = Math.cos(cam.pitch), d = cam.dist * cp;
  let cx = tx - Math.sin(cam.yaw) * d, cz = tz - Math.cos(cam.yaw) * d, cy = ty + cam.height + Math.sin(cam.pitch) * cam.dist * -1 + cam.dist * cp * 0.0;
  cy = ty + cam.height - Math.sin(cam.pitch) * cam.dist;
  const gh = groundH(cx, cz) + 0.6; if (cy < gh) cy = gh;
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
  tickMs = performance.now() - t0;
  updateCamera();
  // HUD ~12 Hz
  hudAcc += dtMs / 1000;
  if (hudAcc > 1 / 12) { hudAcc = 0; if (S.phase !== "menu") updateHUD(); }
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
  updateDinos(dt, S.player);
  updateSpawnDirector(dt, S.player);
  updateThreat(dt, S.player);
  updateExtraction(dt);
  updateEvac(dt);
  Audio.tickHeartbeat(dt, S.player.fear);
  if (Net.on) netTick(dt);
}
const evacCine = () => evac && (evac.phase === "boarding" || evac.phase === "liftoff");

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
    r = Object.assign(buildCharMesh(peer.role || "navigator"), { tx: p.x, tz: p.z, tyaw: p.yaw || 0, gait: p.gait || "idle", hp: p.hp ?? 100, alive: p.alive !== false });
    r.group.add(makeNameTag(peer.name));
    r.group.position.set(p.x, groundH(p.x, p.z) + 0.9, p.z);
    remotePlayers.set(msg.id, r);
  }
  r.tx = p.x; r.tz = p.z; r.tyaw = p.yaw || 0; r.gait = p.gait || "idle"; r.hp = p.hp ?? 100; r.alive = p.alive !== false;
}
function updateRemotes(dt) {
  const k = Math.min(1, dt * 10);
  for (const r of remotePlayers.values()) {
    r.group.visible = r.alive;
    const gy = groundH(r.tx, r.tz) + 0.9 - (r.gait === "crouch" ? 0.4 : 0);
    r.group.position.x += (r.tx - r.group.position.x) * k;
    r.group.position.z += (r.tz - r.group.position.z) * k;
    r.group.position.y += (gy - r.group.position.y) * k;
    let dy = r.tyaw - r.group.rotation.y; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    r.group.rotation.y += dy * k;
    r.group.rotation.x = r.gait === "run" ? 0.16 : (r.gait === "crouch" ? 0.22 : 0);
    if (r.action) r.action.timeScale = r.gait === "idle" ? 0 : (GAIT_RATE[r.gait] ?? 1);
    if (r.mixer) r.mixer.update(dt);
  }
}
function netTick(dt) {
  netSendAcc += dt;
  if (netSendAcc >= 0.08) {   // ~12 Hz
    netSendAcc = 0; const P = S.player;
    Net.sendState({ x: +P.x.toFixed(2), z: +P.z.toFixed(2), yaw: +P.yaw.toFixed(2), gait: P.gait, hp: Math.round(P.hp), alive: P.alive });
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
  Net.onEvent("welcome", () => { status.innerHTML = `Co-op room <span class="code">${Net.room}</span> · ${Net.isHost ? "hosting" : "joined"} · share the code, then BEGIN`; roomI.value = Net.room; show(true); renderPeers(); });
  Net.onEvent("peers", renderPeers);
  Net.onEvent("state", netUpsertState);
  Net.onEvent("leave", removeRemote);
  Net.onEvent("full", () => { status.textContent = "That room is full (16 max)"; });
  Net.onEvent("error", () => { status.textContent = "Connection error — playing solo"; });
  Net.onEvent("close", () => { status.textContent = "Playing solo — or host / join a co-op room"; show(false); clearRemotes(); });
  $("mpHost").addEventListener("click", () => { Audio.init(); const c = code4(); roomI.value = c; status.textContent = "Connecting…"; Net.connect(c, myName(), selectedRole.id, (Math.random() * 1e9) >>> 0); });
  $("mpJoin").addEventListener("click", () => { Audio.init(); const c = (roomI.value.trim() || "").toUpperCase(); if (!c) { status.textContent = "Enter a room code to join"; return; } status.textContent = "Connecting…"; Net.connect(c, myName(), selectedRole.id, 0); });
  $("mpLeave").addEventListener("click", () => { Net.disconnect(); status.textContent = "Playing solo — or host / join a co-op room"; show(false); clearRemotes(); });
}

/* ====================================================== screens ========== */
function showStart() {
  $("sTitle").textContent = STR.title; $("sSub").textContent = STR.subtitle;
  $("sBlurb").textContent = "One survivor. A foggy valley that hears every step. Reach the beacon, call the evac, and live through the hold while the apex closes in.";
  $("sHow").innerHTML = (isTouch ? STR.howto_touch : STR.howto_desktop) + "<br>" + STR.howto_gamepad;
  $("startBtn").textContent = STR.start;
}
$("startBtn").addEventListener("click", () => { Audio.init(); startRun(); if (!isTouch) canvas.requestPointerLock(); });
$("againBtn").addEventListener("click", () => { startRun(); if (!isTouch) canvas.requestPointerLock(); });
$("againBtn").textContent = STR.again;

boot();
