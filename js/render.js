/* Balance Spire — render module (Three.js, ES module).
 * Semantic entity views over immutable rules snapshots. The render layer
 * never mutates rules state. Layers: environment / gameplay / ghosts /
 * effects. Deterministic decor via the seeded STREAM_DECOR stream.
 */
import * as THREE from '../vendor/three.module.min.js';

const MU = 1000;
const SLAB_H = 0.42;           // world units per slab level
const FRAMING = { dist: 13.5, rise: 6.2, lookDrop: 0.9 }; // authored framing constants

let renderer = null, scene = null, camera = null;
let host = null, canvas = null;
let towerGroup = null, movingSlab = null, ghostMarker = null, hintBand = null;
let skyline = null, stars = null, ground = null, keyLight = null, hemi = null;
let debris = [];               // pooled falling trim pieces
let slabMeshes = [];           // one mesh per placed slab (pooled)
let quality = { tier: 'high', dpr: 1, particles: true, shadows: true };
let reducedMotion = false;
let theme = null;
let camY = 2.4, camTargetY = 2.4;   // critically damped spring state
let camVy = 0;
let lastState = null, lastAlpha = 0;
let shakeAmp = 0, shakeT = 0;
let ctxLost = false;
let effectsPool = [];
let visible = true;
let rafHook = null;

const slabGeo = new THREE.BoxGeometry(1, SLAB_H, 1);
const edgeGeo = new THREE.EdgesGeometry(slabGeo);

function makeStoneMaterial(color, glow, emissive) {
  return new THREE.MeshStandardMaterial({
    color: color, roughness: 0.55, metalness: 0.08,
    emissive: emissive || glow, emissiveIntensity: emissive ? 0.55 : 0.12
  });
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
  host.appendChild(canvas);

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
  keyLight.position.set(6, 12, 4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(hemi, keyLight);

  towerGroup = new THREE.Group();
  scene.add(towerGroup);

  // Moving slab: brighter emissive + outline edges (selection language).
  movingSlab = new THREE.Mesh(slabGeo, makeStoneMaterial(0xffffff, 0xffffff, 0xffffff));
  const edges = new THREE.LineSegments(edgeGeo,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
  movingSlab.add(edges);
  scene.add(movingSlab);

  // Grounded ghost marker under the moving slab (never bloom alone).
  ghostMarker = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
  ghostMarker.rotation.x = -Math.PI / 2;
  scene.add(ghostMarker);

  // Hint band: marks the perfect-drop window on the travel axis.
  hintBand = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x9fffd0, transparent: true, opacity: 0.0, depthWrite: false }));
  hintBand.rotation.x = -Math.PI / 2;
  scene.add(hintBand);

  ground = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 11, 0.8, 28),
    new THREE.MeshStandardMaterial({ color: 0x241f2e, roughness: 0.95 }));
  ground.position.y = -0.45;
  ground.receiveShadow = true;
  scene.add(ground);

  buildSkyline(null);
  buildStars(null);
  applySize();
  return true;
}

// ---------- environment (deterministic from decor stream) ----------
function buildSkyline(decorRng) {
  if (skyline) { scene.remove(skyline); disposeTree(skyline); }
  const rng = decorRng || { next: () => 0.5, range: (a, b) => (a + b) >> 1, int: (n) => 0, pick: (a) => a[0] };
  skyline = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a3450, roughness: 0.9 });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const count = quality.tier === 'low' ? 24 : 56;
  const inst = new THREE.InstancedMesh(geo, mat, count);
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
  scene.add(skyline);
}

function buildStars(decorRng) {
  if (stars) { scene.remove(stars); stars.geometry.dispose(); stars.material.dispose(); stars = null; }
  if (!quality.particles) return;
  const rng = decorRng || { next: () => 0.5 };
  const n = quality.tier === 'low' ? 120 : quality.tier === 'medium' ? 300 : 600;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ang = rng.next() * Math.PI * 2, r = 30 + rng.next() * 60;
    pos[i * 3] = Math.cos(ang) * r;
    pos[i * 3 + 1] = 8 + rng.next() * 50;
    pos[i * 3 + 2] = Math.sin(ang) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  stars = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0xcfd8ff, size: 0.14, sizeAttenuation: true, transparent: true, opacity: 0.8 }));
  stars.raycast = function () {}; // cosmetic particles never intercept raycasts
  scene.add(stars);
}

export function setTheme(palette, decorRng) {
  theme = palette;
  if (!scene) return;
  scene.background = new THREE.Color(palette.skyTop);
  scene.fog = new THREE.Fog(palette.fog, 24, 90);
  hemi.color.set(palette.skyBot);
  keyLight.color.set(palette.key);
  ground.material.color.set(palette.ground);
  movingSlab.material.color.set(palette.glow);
  movingSlab.material.emissive.set(palette.glow);
  movingSlab.material.emissiveIntensity = 0.5;
  movingSlab.children[0].material.color.set(palette.glow);
  ghostMarker.material.color.set(palette.glow);
  if (skyline) skyline.children[0].material.color.set(palette.skyline);
  buildSkyline(decorRng);
}

export function setQuality(tier) {
  quality.tier = tier;
  quality.particles = tier !== 'low';
  quality.shadows = tier === 'high';
  if (!renderer) return;
  renderer.shadowMap.enabled = quality.shadows;
  keyLight.castShadow = quality.shadows;
  const cap = tier === 'high' ? 2 : tier === 'medium' ? 1.5 : 1;
  quality.dpr = Math.min(window.devicePixelRatio || 1, cap);
  buildStars(null);
  applySize();
}

export function setReducedMotion(on) { reducedMotion = !!on; }

// ---------- state sync ----------
export function syncState(state, alpha, decorTheme) {
  if (!scene || ctxLost) return;
  lastState = state; lastAlpha = alpha;
  const level = state.slabs.length;

  // Grow the tower mesh pool.
  while (slabMeshes.length < state.slabs.length) {
    const idx = slabMeshes.length;
    const mat = makeStoneMaterial(theme ? theme.stone : 0xbfb4a6,
      theme ? theme.glow : 0xffd9a0);
    const mesh = new THREE.Mesh(slabGeo, mat);
    mesh.castShadow = quality.shadows;
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
      mesh.material.emissiveIntensity = perfect ? 0.45 : 0.12;
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
  updateDebris();
}

export function setHintVisible(on) {
  if (hintBand) hintBand.material.opacity = on ? 0.28 : 0.0;
}

// ---------- event effects (pooled, bounded, event-tiered) ----------
export function playEvents(events) {
  if (!scene) return;
  events.forEach(function (ev) {
    if (ev.type === 'trim' && quality.particles) {
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
    const mat = makeStoneMaterial(theme ? theme.stoneDark : 0x8a8078, 0x000000);
    d = { mesh: new THREE.Mesh(slabGeo, mat), active: false, vx: 0, vy: 0, life: 0 };
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
  renderer.render(scene, camera);
  if (rafHook) rafHook();
}

export function applySize() {
  if (!renderer || !host) return;
  const w = host.clientWidth || 1, h = host.clientHeight || 1;
  renderer.setPixelRatio(quality.dpr || 1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
  });
}

function rebuild() { /* context restored: resources re-upload lazily */ }

export function dispose() {
  if (!renderer) return;
  disposeTree(scene);
  renderer.dispose();
  renderer = null; scene = null;
}

window.BSRender = { init, setTheme, setQuality, setReducedMotion, syncState, playEvents,
  setHintVisible, frame, applySize, setVisible, stats, dispose };
window.dispatchEvent(new CustomEvent('bs-render-ready'));
