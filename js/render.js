/* Balance Spire — render module (Three.js r160, ES module).
 * Semantic entity views over immutable rules snapshots. The render layer
 * never mutates rules state. Layers: environment / gameplay / ghosts /
 * effects. Deterministic decor via the seeded STREAM_DECOR stream.
 * Graphics quality comes from js/gfx.js (window.BSGfx): presets and
 * per-category overrides are applied live by setGraphics().
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const Gfx = window.BSGfx;
const MU = 1000;
const SLAB_H = 0.42;           // world units per slab level
const FRAMING = { dist: 13.5, rise: 6.2, lookDrop: 0.9 }; // authored framing constants
const KEY_DIR = new THREE.Vector3(6, 12, 4).normalize();

let renderer = null, scene = null, camera = null;
let host = null, canvas = null;
let towerGroup = null, movingSlab = null, ghostMarker = null, hintBand = null;
let skyline = null, stars = null, motes = null, ground = null, rimGlow = null;
let keyLight = null, rimLight = null, hemi = null, skyDome = null;
let debris = [];               // pooled falling trim pieces
let slabMeshes = [];           // one mesh per placed slab (pooled)
let reducedMotion = false;
let theme = null;
let camY = 2.4, camTargetY = 2.4;   // critically damped spring state
let camVy = 0;
let lastState = null;
let shakeAmp = 0, shakeT = 0;
let ctxLost = false;
let effectsPool = [];
let visible = true;
let rafHook = null;
let shadowLevel = -1;

// Graphics state (see setGraphics / graphicsInfo).
let q = Gfx.resolve({}, 'balanced');
let gpu = '', detected = 'balanced';
let composer = null, gradePass = null, postKey = null, postFailed = false;
let pixelRatio = 1, sizeW = 0, sizeH = 0;
let adaptiveScale = 1, frameTimes = [], fps = 0;
let envTex = null, pmrem = null;
let time = 0;

const slabGeo = new THREE.BoxGeometry(1, SLAB_H, 1);
const roundGeo = new RoundedBoxGeometry(1, SLAB_H, 1, 2, 0.035);
const edgeGeo = new THREE.EdgesGeometry(slabGeo);

// Deterministic cosmetic PRNG (stars/motes), independent of gameplay streams.
function mulberry(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------- stone materials ----------
// Authored limestone grain (assets/slab-stone.webp) multiplies the theme's
// stone colour. Materials start untextured and pick the map up once it
// decodes; if the fetch fails the flat procedural stone simply stays.
// Detailed tier: bevelled geometry + clearcoat physical stone; plain tier:
// the original box + standard material (cheapest).
let stoneTex = null;
const stoneMeshes = [];
function loadStoneTexture() {
  new THREE.TextureLoader().load('assets/slab-stone.webp', function (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = Math.min(4, renderer ? renderer.capabilities.getMaxAnisotropy() : 1);
    stoneTex = tex;
    stoneMeshes.forEach(function (m) { m.material.map = tex; m.material.needsUpdate = true; });
  }, undefined, function () { /* no texture: procedural stone remains */ });
}

function newStoneMaterial(color, emissive, intensity) {
  const detailed = q.detail === 'detailed';
  const opts = {
    color: color, roughness: detailed ? 0.5 : 0.55, metalness: 0.08, map: stoneTex,
    emissive: emissive, emissiveIntensity: intensity,
    envMapIntensity: 0.35
  };
  if (detailed) {
    opts.clearcoat = 0.35; opts.clearcoatRoughness = 0.38;
    return new THREE.MeshPhysicalMaterial(opts);
  }
  return new THREE.MeshStandardMaterial(opts);
}

function makeStoneMesh(color, glow, emissive) {
  const mat = newStoneMaterial(color, emissive || glow, emissive ? 0.55 : 0.12);
  const mesh = new THREE.Mesh(q.detail === 'detailed' ? roundGeo : slabGeo, mat);
  stoneMeshes.push(mesh);
  return mesh;
}

// Swap every stone mesh to the current detail tier, keeping its colours.
function refreshStone() {
  const detailed = q.detail === 'detailed';
  stoneMeshes.forEach(function (mesh) {
    const old = mesh.material;
    const isPhys = !!old.isMeshPhysicalMaterial;
    mesh.geometry = detailed ? roundGeo : slabGeo;
    if (isPhys === detailed) { old.needsUpdate = true; return; }
    const m = newStoneMaterial(old.color.getHex(), old.emissive.getHex(), old.emissiveIntensity);
    mesh.material = m;
    old.dispose();
  });
}

// ---------- sky dome ----------
const SkyShader = {
  uniforms: {
    uTop: { value: new THREE.Color(0x2c3a5e) }, uBot: { value: new THREE.Color(0xe8a06a) },
    uGlow: { value: new THREE.Color(0xffd9a0) }, uSun: { value: KEY_DIR.clone() },
    uTime: { value: 0 }, uBands: { value: 1 }
  },
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = p.xyww;
    }`,
  fragmentShader: `
    uniform vec3 uTop; uniform vec3 uBot; uniform vec3 uGlow; uniform vec3 uSun;
    uniform float uTime; uniform float uBands;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 col = mix(uBot, uTop, smoothstep(-0.02, 0.6, h));
      // Below the horizon: fall off into a deep dusk tone so the plinth reads.
      col = mix(col, uTop * 0.55, smoothstep(0.0, -0.35, h));
      // Warm horizon haze and a soft glow toward the key light.
      col += uBot * 0.3 * exp(-abs(h) * 14.0);
      float sun = max(dot(d, normalize(uSun)), 0.0);
      col += uGlow * (pow(sun, 18.0) * 0.28 + pow(sun, 3.0) * 0.06);
      // Faint drifting cloud bands (static when animation is off).
      float a = atan(d.z, d.x);
      float band = sin(a * 5.0 + uTime * 0.03 + sin(h * 14.0 + a * 2.0) * 1.3) * 0.5 + 0.5;
      band *= smoothstep(0.02, 0.18, h) * (1.0 - smoothstep(0.25, 0.55, h));
      col = mix(col, col * 1.12 + uBot * 0.05, band * 0.5 * uBands);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
};

function buildSkyDome() {
  skyDome = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
      vertexShader: SkyShader.vertexShader, fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide, depthWrite: false, fog: false
    }));
  skyDome.renderOrder = -10;
  skyDome.frustumCulled = false;
  skyDome.raycast = function () {};
  scene.add(skyDome);
}

// ---------- points: stars + motes ----------
const POINT_VERT = `
  attribute float aPhase;
  uniform float uTime; uniform float uTwinkle; uniform float uSize; uniform float uScale;
  uniform float uRise; uniform float uBaseY;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    if (uRise > 0.0) {
      // Motes: drift upward in a 9-unit column around the tower top, wrapping.
      p.y = uBaseY + mod(p.y + uTime * uRise * (0.5 + aPhase), 9.0) - 4.5;
      p.x += sin(uTime * 0.4 + aPhase * 17.0) * 0.25;
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vAlpha = 1.0 - uTwinkle * 0.55 * (0.5 + 0.5 * sin(uTime * (1.2 + aPhase * 2.0) + aPhase * 40.0));
    gl_PointSize = uSize * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const POINT_FRAG = `
  uniform vec3 uColor; uniform float uOpacity;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d) * vAlpha * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }`;

function pointsMaterial(color, size, opacity, rise) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uTwinkle: { value: 0 }, uSize: { value: size },
      uScale: { value: 400 }, uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity }, uRise: { value: rise || 0 }, uBaseY: { value: 0 }
    },
    vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false
  });
}

function disposePoints(p) {
  if (!p) return;
  scene.remove(p); p.geometry.dispose(); p.material.dispose();
}

function buildStars() {
  disposePoints(stars); stars = null;
  disposePoints(motes); motes = null;
  if (q.particles === 'off') return;
  const rnd = mulberry(0x5ba1);
  const n = q.particles === 'high' ? 600 : 250;
  const pos = new Float32Array(n * 3), ph = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ang = rnd() * Math.PI * 2, r = 60 + rnd() * 60;
    pos[i * 3] = Math.cos(ang) * r;
    pos[i * 3 + 1] = 12 + Math.pow(rnd(), 0.7) * 70;
    pos[i * 3 + 2] = Math.sin(ang) * r;
    ph[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  stars = new THREE.Points(g, pointsMaterial(0xdfe6ff, 0.5, 0.85, 0));
  stars.raycast = function () {}; // cosmetic particles never intercept raycasts
  stars.frustumCulled = false;
  scene.add(stars);

  if (q.particles === 'high') {
    const m = 70;
    const mp = new Float32Array(m * 3), mph = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const ang = rnd() * Math.PI * 2, r = 1.8 + rnd() * 3.5;
      mp[i * 3] = Math.cos(ang) * r;
      mp[i * 3 + 1] = rnd() * 9;
      mp[i * 3 + 2] = Math.sin(ang) * r;
      mph[i] = rnd();
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    mg.setAttribute('aPhase', new THREE.BufferAttribute(mph, 1));
    motes = new THREE.Points(mg, pointsMaterial(theme ? theme.glow : 0xffd9a0, 0.12, 0.55, 0.35));
    motes.raycast = function () {};
    motes.frustumCulled = false;
    scene.add(motes);
  }
  updatePointScale();
}

function updatePointScale() {
  const s = (sizeH || 400) * pixelRatio / 2;
  if (stars) stars.material.uniforms.uScale.value = s;
  if (motes) motes.material.uniforms.uScale.value = s;
}

// ---------- skyline windows (procedural, deterministic) ----------
let windowTex = null;
function getWindowTexture() {
  if (windowTex) return windowTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, 64, 128);
  const rnd = mulberry(0x77aa);
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 6; col++) {
      if (rnd() < 0.3) {
        const v = 140 + Math.floor(rnd() * 115);
        x.fillStyle = 'rgb(' + v + ',' + Math.floor(v * 0.85) + ',' + Math.floor(v * 0.6) + ')';
        x.fillRect(5 + col * 10, 4 + row * 8, 5, 4);
      }
    }
  }
  windowTex = new THREE.CanvasTexture(c);
  windowTex.colorSpace = THREE.SRGBColorSpace;
  return windowTex;
}

export function init(hostEl) {
  host = hostEl;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    return false;
  }
  canvas = renderer.domElement;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(canvas);
  detectGpu();
  loadStoneTexture();

  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault(); ctxLost = true;
    window.dispatchEvent(new CustomEvent('bs-gl-lost'));
  });
  canvas.addEventListener('webglcontextrestored', function () {
    ctxLost = false; rebuild();
    window.dispatchEvent(new CustomEvent('bs-gl-restored'));
  });

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);

  hemi = new THREE.HemisphereLight(0xbfd0e0, 0x3a3450, 0.95);
  keyLight = new THREE.DirectionalLight(0xffe0b0, 1.5);
  keyLight.position.copy(KEY_DIR).multiplyScalar(20);
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight.target);
  // Cool rim light from behind separates slab silhouettes from the sky.
  rimLight = new THREE.DirectionalLight(0x9fc8ff, 0.55);
  rimLight.position.set(-7, 6, -9);
  scene.add(hemi, keyLight, rimLight);

  buildSkyDome();

  towerGroup = new THREE.Group();
  scene.add(towerGroup);

  // Moving slab: brighter emissive + outline edges (selection language).
  movingSlab = makeStoneMesh(0xffffff, 0xffffff, 0xffffff);
  const edges = new THREE.LineSegments(edgeGeo,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
  movingSlab.add(edges);
  movingSlab.visible = false; // shown once a round has a pending slab
  scene.add(movingSlab);

  // Grounded ghost marker under the moving slab (never bloom alone).
  ghostMarker = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
  ghostMarker.rotation.x = -Math.PI / 2;
  ghostMarker.visible = false;
  scene.add(ghostMarker);

  // Hint band: marks the perfect-drop window on the travel axis.
  hintBand = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x9fffd0, transparent: true, opacity: 0.0, depthWrite: false }));
  hintBand.rotation.x = -Math.PI / 2;
  scene.add(hintBand);

  ground = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 11, 0.8, 48),
    new THREE.MeshStandardMaterial({ color: 0x241f2e, roughness: 0.92, envMapIntensity: 0.3 }));
  ground.position.y = -0.45;
  ground.receiveShadow = true;
  scene.add(ground);

  // Luminous inlay ring on the plinth top (detailed tier; blooms softly).
  rimGlow = new THREE.Mesh(new THREE.TorusGeometry(8.6, 0.025, 6, 128),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
  rimGlow.rotation.x = -Math.PI / 2;
  rimGlow.position.y = -0.04;
  scene.add(rimGlow);

  buildSkyline(null);
  setGraphics({});
  fitShadow(0);
  applySize();
  return true;
}

function detectGpu() {
  try {
    const gl = renderer.getContext();
    // Firefox exposes the unmasked name through RENDERER and warns on the debug extension.
    const ff = /firefox/i.test(navigator.userAgent);
    const ext = ff ? null : gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
  } catch (e) { gpu = ''; }
  const mobile = (window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  detected = Gfx.detectPreset(gpu, { mobile: mobile });
}

// ---------- environment (deterministic from decor stream) ----------
function buildSkyline(decorRng) {
  if (skyline) { scene.remove(skyline); disposeTree(skyline); }
  const rng = decorRng || mulberryRng(0x51c7);
  skyline = new THREE.Group();
  const detailed = q.detail === 'detailed';
  const color = theme ? theme.skyline : 0x3a3450;
  const side = new THREE.MeshStandardMaterial({ color: color, roughness: 0.9 });
  let mats = side;
  if (detailed) {
    side.emissiveMap = getWindowTexture();
    side.emissive = new THREE.Color(theme ? theme.glow : 0xffd9a0);
    side.emissiveIntensity = 0.55;
    const roof = new THREE.MeshStandardMaterial({ color: color, roughness: 0.9 });
    mats = [side, side, roof, roof, side, side];
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const count = detailed ? 56 : 24;
  const inst = new THREE.InstancedMesh(geo, mats, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rng.next() * 0.08;
    const r = 16 + rng.next() * 22;
    const h = 1.5 + rng.next() * 7;
    m.makeScale(1.2 + rng.next() * 2.2, h, 1.2 + rng.next() * 2.2);
    m.setPosition(Math.cos(ang) * r, h / 2 - 0.1, Math.sin(ang) * r);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  skyline.add(inst);
  skyline.userData.rng = decorRng || null;
  scene.add(skyline);
}
function mulberryRng(seed) { const f = mulberry(seed); return { next: f }; }

export function setTheme(palette, decorRng) {
  theme = palette;
  if (!scene) return;
  scene.fog = new THREE.Fog(palette.fog, 24, 90);
  hemi.color.set(palette.skyBot);
  keyLight.color.set(palette.key);
  rimLight.color.set(palette.skyTop).lerp(new THREE.Color(0xbfd8ff), 0.6);
  ground.material.color.set(palette.ground);
  movingSlab.material.color.set(palette.glow);
  movingSlab.material.emissive.set(palette.glow);
  movingSlab.material.emissiveIntensity = 0.5;
  movingSlab.children[0].material.color.set(palette.glow);
  ghostMarker.material.color.set(palette.glow);
  rimGlow.material.color.set(palette.glow).multiplyScalar(1.15);
  const u = skyDome.material.uniforms;
  u.uTop.value.set(palette.skyTop); u.uBot.value.set(palette.skyBot); u.uGlow.value.set(palette.glow);
  if (motes) motes.material.uniforms.uColor.value.set(palette.glow);
  applyBackground();
  buildSkyline(decorRng);
}

function applyBackground() {
  const detailed = q.detail === 'detailed';
  skyDome.visible = detailed;
  scene.background = detailed ? null : new THREE.Color(theme ? theme.skyTop : 0x14101e);
  rimGlow.visible = detailed;
  rimLight.visible = detailed;
}

// ---------- graphics settings ----------
/** Apply saved graphics settings (object from the Graphics panel; {} = auto). */
let gfxJson = null;
export function setGraphics(saved) {
  const json = JSON.stringify(saved || {});
  if (json === gfxJson && renderer) return; // unrelated settings changed
  q = Gfx.resolve(saved || {}, detected);
  if (!renderer) return;
  gfxJson = json;
  const size = Gfx.SHADOW_MAP[q.shadows];
  renderer.shadowMap.enabled = size > 0;
  keyLight.castShadow = size > 0;
  if (size > 0 && keyLight.shadow.mapSize.x !== size) {
    keyLight.shadow.mapSize.set(size, size);
    if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
  }
  shadowLevel = -1;
  slabMeshes.forEach(function (m) { m.castShadow = size > 0; });
  movingSlab.castShadow = size > 0;
  debris.forEach(function (d) { d.mesh.castShadow = size > 0; });

  // Image-based lighting: RoomEnvironment through PMREM, generated once.
  if (q.reflections === 'on') {
    if (!envTex) {
      pmrem = pmrem || new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment(renderer);
      envTex = pmrem.fromScene(room, 0.04).texture;
      room.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    scene.environment = envTex;
    hemi.intensity = 0.6;
  } else {
    scene.environment = null;
    hemi.intensity = 0.95;
  }

  const wasDetailed = skyline && skyline.children[0] && Array.isArray(skyline.children[0].material);
  refreshStone();
  applyBackground();
  if (wasDetailed !== (q.detail === 'detailed')) buildSkyline(skyline ? skyline.userData.rng : null);
  buildStars();
  // Materials pick up shadow-map / environment changes on recompile.
  scene.traverse(function (o) {
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.needsUpdate = true; });
  });

  adaptiveScale = 1;
  frameTimes = [];
  postKey = null; // rebuild the post chain on the next frame
  fpsVisible(q.showFps);
  if (canvas) canvas.dataset.gfxPreset = q.preset;
  document.body.dataset.gfxPreset = q.preset;
  applySize();
}

// Legacy tier API (auto/high/medium/low) mapped onto presets.
export function setQuality(tier) {
  const map = { high: 'high', medium: 'balanced', low: 'low' };
  setGraphics(map[tier] ? { preset: map[tier] } : {});
}

/** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
export function graphicsInfo() {
  const px = [Math.round(sizeW * pixelRatio), Math.round(sizeH * pixelRatio)];
  return {
    gpu: gpu || 'unknown GPU', detected: detected, resolved: q,
    summary: Gfx.describe(q, px), pixels: px, fps: Math.round(fps),
    adaptiveScale: Math.round(adaptiveScale * 100) / 100, postFailed: postFailed
  };
}

function fpsVisible(on) {
  let el = document.getElementById('fps-meter');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'fps-meter';
    el.className = 'fps-meter';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  if (el) { el.hidden = !on; if (on && !el.textContent) el.textContent = '… fps'; }
}

// Colour grade + vignette (display-space colours in and out; runs after OutputPass).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.24 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve contrast, a touch more saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.03, 1.0, 0.97), smoothstep(0.2, 0.8, l));
      c = mix(c, s, uAmount);
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.4, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`
};

function currentPostKey(w, h) {
  return q.post ? [q.ao, q.bloom, q.grade, q.antialias, w, h, pixelRatio].join('|') : 'none';
}

function buildPost(w, h) {
  if (composer) { composer.dispose(); composer = null; }
  gradePass = null;
  if (!q.post) return;
  const pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
  try {
    const target = new THREE.WebGLRenderTarget(pw, ph, {
      type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0
    });
    const c = new EffectComposer(renderer, target);
    c.setPixelRatio(pixelRatio);
    c.setSize(w, h);
    c.addPass(new RenderPass(scene, camera));
    if (q.ao !== 'off') {
      const ao = new GTAOPass(scene, camera, pw, ph);
      ao.output = GTAOPass.OUTPUT.Default;
      ao.blendIntensity = 0.7;
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0,
        samples: q.ao === 'high' ? 16 : 8 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: q.ao === 'high' ? 6 : 4,
        rings: 2, samples: q.ao === 'high' ? 16 : 8 });
      c.addPass(ao);
    }
    if (q.bloom === 'on') {
      // High threshold: only the emissive moving slab, perfect glows and the rim inlay bloom.
      c.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.32, 0.4, 0.92));
    }
    c.addPass(new OutputPass());
    if (q.grade === 'on') {
      gradePass = new ShaderPass(GradeShader);
      c.addPass(gradePass);
    }
    if (q.antialias === 'smaa') c.addPass(new SMAAPass(pw, ph));
    if (q.antialias === 'fxaa') {
      const fxaa = new ShaderPass(FXAAShader);
      fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
      c.addPass(fxaa);
    }
    composer = c;
    postFailed = false;
  } catch (e) {
    // Post-processing is an enhancement: render directly if the chain cannot be built.
    postFailed = true;
    composer = null;
  }
}

// Adaptive resolution: step the render scale down when frames are slow, back up when fast.
function adapt(ms) {
  frameTimes.push(ms);
  if (frameTimes.length < 90) return false;
  let sum = 0;
  for (let i = 0; i < frameTimes.length; i++) sum += frameTimes[i];
  const avg = sum / frameTimes.length;
  frameTimes.length = 0;
  fps = 1000 / avg;
  const el = document.getElementById('fps-meter');
  if (el && !el.hidden) el.textContent = Math.round(fps) + ' fps · ' + (Math.round(pixelRatio * 100) / 100) + '×';
  if (!q.adaptive) return false;
  const before = adaptiveScale;
  if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
  else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
  return before !== adaptiveScale;
}

// ---------- state sync ----------
export function syncState(state, alpha) {
  if (!scene || ctxLost) return;
  lastState = state;
  const level = state.slabs.length;

  // Grow the tower mesh pool.
  while (slabMeshes.length < state.slabs.length) {
    const mesh = makeStoneMesh(theme ? theme.stone : 0xbfb4a6, theme ? theme.glow : 0xffd9a0);
    mesh.castShadow = q.shadows !== 'off';
    mesh.receiveShadow = true;
    towerGroup.add(mesh);
    slabMeshes.push(mesh);
  }
  for (let i = 0; i < slabMeshes.length; i++) {
    const mesh = slabMeshes[i];
    if (i < state.slabs.length) {
      const s = state.slabs[i];
      mesh.visible = true;
      mesh.scale.set(s.w / MU, 1, s.d / MU);
      mesh.position.set(s.x / MU, i * SLAB_H + SLAB_H / 2, s.z / MU);
      const perfect = s.perfect && i > 0;
      // Don't stomp an in-flight placement flash; syncState runs every frame.
      if (!effectsPool.some(function (fx) { return fx.mesh === mesh; })) {
        mesh.material.emissiveIntensity = perfect ? 0.45 : 0.12;
      }
    } else {
      mesh.visible = false;
    }
  }

  // Moving slab from closed-form position + interpolation alpha.
  if (state.pending && !state.terminal) {
    const lvl = state.slabs.length;
    const t = state.tick + alpha;
    const pos = BSRules.slabPosAt(state.cfg, state.pending, lvl, Math.floor(t));
    const posN = BSRules.slabPosAt(state.cfg, state.pending, lvl, Math.floor(t) + 1);
    const frac = t - Math.floor(t);
    const interp = (pos + (posN - pos) * frac) / MU;
    const top = state.slabs[state.slabs.length - 1];
    const w = state.pending.axis === 'x' ? top.w : top.d;
    movingSlab.visible = true;
    movingSlab.scale.set(top.w / MU, 1, top.d / MU);
    const y = level * SLAB_H + SLAB_H / 2 + 0.28;
    if (state.pending.axis === 'x') movingSlab.position.set(interp, y, top.z / MU);
    else movingSlab.position.set(top.x / MU, y, interp);

    ghostMarker.visible = true;
    ghostMarker.scale.set(state.pending.axis === 'x' ? w / MU : top.w / MU, 1,
      state.pending.axis === 'x' ? top.d / MU : w / MU);
    ghostMarker.position.set(top.x / MU, level * SLAB_H + 0.02, top.z / MU);

    // Hint band across the travel axis, width = 2*eps.
    const eps = state.cfg.eps / MU;
    hintBand.scale.set(state.pending.axis === 'x' ? eps * 2 : top.w / MU, 1,
      state.pending.axis === 'x' ? top.d / MU : eps * 2);
    hintBand.position.set(top.x / MU, level * SLAB_H + 0.03, top.z / MU);
  } else {
    movingSlab.visible = false;
    ghostMarker.visible = false;
  }

  // Camera: rise with the tower via critically damped spring (no cumulative lerp).
  camTargetY = 2.4 + Math.max(0, level - 4) * SLAB_H;
  if (level !== shadowLevel) fitShadow(level);
  updateDebris();
}

// Key-light shadow box fitted to the tower (base to moving slab) and the plinth near it.
function fitShadow(level) {
  shadowLevel = level;
  const top = level * SLAB_H + 1;
  const cy = top * 0.5;
  const ext = Math.max(4.5, top * 0.55 + 2.5);
  keyLight.target.position.set(0, cy, 0);
  keyLight.position.copy(KEY_DIR).multiplyScalar(ext + 20).add(keyLight.target.position);
  const sc = keyLight.shadow.camera;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
  sc.near = 1; sc.far = ext * 2 + 40;
  sc.updateProjectionMatrix();
}

export function setHintVisible(on) {
  if (hintBand) hintBand.material.opacity = on ? 0.28 : 0.0;
}

// ---------- event effects (pooled, bounded, event-tiered) ----------
export function playEvents(events) {
  if (!scene) return;
  events.forEach(function (ev) {
    if (ev.type === 'trim' && q.particles !== 'off') {
      spawnDebris(ev);
      if (!reducedMotion) shakeAmp = Math.min(0.06, 0.02 + ev.size / 40000);
    } else if (ev.type === 'place' && ev.perfect) {
      flashTop();
    } else if (ev.type === 'miss') {
      if (!reducedMotion) shakeAmp = 0.08;
    } else if (ev.type === 'win') {
      if (!reducedMotion) { shakeAmp = 0; }
      flashTop(2.2);
    }
  });
}

function flashTop(strength) {
  if (!slabMeshes.length) return;
  const mesh = slabMeshes[slabMeshes.length - 1];
  if (!mesh.visible) return;
  const base = mesh.material.emissiveIntensity;
  mesh.material.emissiveIntensity = (strength || 1.2);
  effectsPool.push({ mesh: mesh, base: base, t: 0 });
}

function spawnDebris(ev) {
  if (debris.length > 12) return; // pooled cap
  let d = debris.find(function (x) { return !x.active; });
  if (!d) {
    const mesh = makeStoneMesh(theme ? theme.stoneDark : 0x8a8078, 0x000000);
    mesh.castShadow = q.shadows !== 'off';
    d = { mesh: mesh, active: false, vx: 0, vy: 0, life: 0 };
    scene.add(d.mesh);
    debris.push(d);
  }
  const s = lastState.slabs[lastState.slabs.length - 1];
  const size = ev.size / MU;
  d.active = true; d.life = 0;
  d.vx = ev.axis === 'x' ? ev.side * 1.6 : 0;
  d.vz = ev.axis === 'z' ? ev.side * 1.6 : 0;
  d.vy = 0;
  d.mesh.visible = true;
  if (ev.axis === 'x') d.mesh.scale.set(size, 1, s.d / MU);
  else d.mesh.scale.set(s.w / MU, 1, size);
  d.mesh.position.set(ev.axis === 'x' ? ev.center / MU : s.x / MU,
    ev.level * SLAB_H + SLAB_H / 2,
    ev.axis === 'z' ? ev.center / MU : s.z / MU);
}

function updateDebris() {
  debris.forEach(function (d) {
    if (!d.active) return;
    d.life += 1 / 60;
    d.vy -= 9.8 / 60;
    d.mesh.position.x += (d.vx || 0) / 60;
    d.mesh.position.z += (d.vz || 0) / 60;
    d.mesh.position.y += d.vy / 60;
    if (!reducedMotion) d.mesh.rotation.x += 0.04;
    if (d.mesh.position.y < -2) { d.active = false; d.mesh.visible = false; }
  });
  for (let i = effectsPool.length - 1; i >= 0; i--) {
    const fx = effectsPool[i];
    fx.t += 1 / 60;
    fx.mesh.material.emissiveIntensity = fx.base + (fx.mesh.material.emissiveIntensity - fx.base) * 0.9;
    if (fx.t > 0.8) { fx.mesh.material.emissiveIntensity = fx.base; effectsPool.splice(i, 1); }
  }
}

const prefersReduced = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export function setReducedMotion(on) { reducedMotion = !!on; }

// ---------- frame ----------
export function frame(dt) {
  if (!renderer || ctxLost || !visible) return;
  // Critically damped spring toward camTargetY (interruptible, dt-based).
  const k = 10, c = 2 * Math.sqrt(k);
  const f = -k * (camY - camTargetY) - c * camVy;
  camVy += f * dt; camY += camVy * dt;
  if (reducedMotion) { camY = camTargetY; camVy = 0; }

  let sx = 0, sz = 0;
  if (shakeAmp > 0.0005 && !reducedMotion) {
    shakeT += dt * 40;
    sx = Math.sin(shakeT * 1.3) * shakeAmp;
    sz = Math.cos(shakeT * 1.7) * shakeAmp;
    shakeAmp *= Math.pow(0.02, dt); // fast decay
  }
  camera.position.set(sx, camY + FRAMING.rise, FRAMING.dist + sz);
  camera.lookAt(0, camY - FRAMING.lookDrop, 0);

  // Ambient motion: sky bands drift, stars twinkle, motes rise, moving slab breathes.
  const animate = q.background === 'animated' && !reducedMotion && !(prefersReduced && prefersReduced.matches);
  if (animate) time += dt;
  skyDome.position.copy(camera.position);
  skyDome.material.uniforms.uTime.value = time;
  skyDome.material.uniforms.uBands.value = q.background === 'animated' ? 1 : 0;
  [stars, motes].forEach(function (p) {
    if (!p) return;
    p.material.uniforms.uTime.value = time;
    p.material.uniforms.uTwinkle.value = animate ? 1 : 0;
    p.material.uniforms.uBaseY.value = camY;
  });
  if (movingSlab.visible && !effectsPool.length) {
    movingSlab.material.emissiveIntensity = animate ? 0.5 + 0.1 * Math.sin(time * 3.2) : 0.5;
  }

  // Resolution: device ratio (capped per preset) × render scale × adaptive scale.
  const rescale = dt > 0 ? adapt(dt * 1000) : false;
  const w = host.clientWidth || 1, h = host.clientHeight || 1;
  const ratio = Math.min(window.devicePixelRatio || 1, q.dprCap) * q.scale * adaptiveScale;
  if (w !== sizeW || h !== sizeH || ratio !== pixelRatio || rescale) resize(w, h, ratio);
  const key = currentPostKey(w, h);
  if (key !== postKey) {
    postKey = key;
    buildPost(w, h);
  }
  if (composer) composer.render(dt);
  else renderer.render(scene, camera);
  if (rafHook) rafHook();
}

function resize(w, h, ratio) {
  sizeW = w; sizeH = h; pixelRatio = ratio;
  renderer.setPixelRatio(ratio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  updatePointScale();
}

export function applySize() {
  if (!renderer || !host) return;
  const w = host.clientWidth || 1, h = host.clientHeight || 1;
  resize(w, h, Math.min(window.devicePixelRatio || 1, q.dprCap) * q.scale * adaptiveScale);
}

export function setVisible(v) {
  visible = v;
  if (renderer) renderer.setAnimationLoop(null);
}

export function onFrameStats(cb) { rafHook = cb; }

export function stats() {
  if (!renderer) return null;
  const i = renderer.info;
  return { drawCalls: i.render.calls, triangles: i.render.triangles };
}

function disposeTree(root) {
  root.traverse(function (o) {
    if (o.geometry && o.geometry !== slabGeo && o.geometry !== roundGeo && o.geometry !== edgeGeo) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
  });
}

function rebuild() { /* context restored: resources re-upload lazily */ postKey = null; }

export function dispose() {
  if (!renderer) return;
  if (composer) composer.dispose();
  disposeTree(scene);
  renderer.dispose();
  renderer = null; scene = null;
}

window.BSRender = { init, setTheme, setQuality, setGraphics, graphicsInfo, setReducedMotion, syncState,
  playEvents, setHintVisible, frame, applySize, setVisible, stats, dispose };
window.dispatchEvent(new CustomEvent('bs-render-ready'));
