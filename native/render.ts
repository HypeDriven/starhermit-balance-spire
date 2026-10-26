// The skyline and the spire on starhermit:scene, ported from the browser
// build's three.js render layer (js/render.js before the port): the tower of
// stone slabs on its plinth, the moving slab with its outline and grounded
// ghost marker, the perfect-window band, trimmed debris, the sky dome,
// skyline, stars and motes, the critically damped camera rise, and the look
// per graphics level from quality.ts. It consumes rules snapshots and never
// mutates rules state.
//
// What changed from three.js, and why:
// - RoundedBoxGeometry (an addon) is rounded.ts; RoomEnvironment +
//   PMREMGenerator.fromScene (not available) is a latitude-longitude room
//   image prefiltered with fromEquirectangular.
// - The EffectComposer chain (GTAO, UnrealBloom, OutputPass, the grade
//   ShaderPass, SMAA / FXAA / canvas MSAA) is renderer.ao / bloom / grade /
//   antialias; the grade's GLSL is the built-in display-space grade with the
//   same curve, tints and vignette.
// - The sky dome's GLSL ShaderMaterial is WGSL. The stars' and motes' point
//   shaders (Points take no shader) are PointsMaterial with a soft round
//   map: the twinkle is the points' vertex colors and the motes' rise their
//   positions, updated per frame.
// - LineSegments (the moving slab's outline) do not exist: twelve thin boxes
//   of one InstancedMesh along the slab's edges.
// - The skyline's per-face material array (lit windows on the sides only) is
//   one material whose WGSL surface hook drops the windows on roofs.
// - The key light's fitted orthographic shadow box is the engine's
//   view-based directional shadow (`shadow.distance`).
// - Light intensities are three.js r160's divided by π (the engine's
//   convention). The window texture is a DataTexture (sRGB bytes, as the
//   CanvasTexture with SRGBColorSpace was).
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, Color,
  CylinderGeometry, DataTexture, DirectionalLight, FloatType, Fog, Group, HemisphereLight, InstancedMesh,
  Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  PMREMGenerator, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, RGBAFormat, RepeatWrapping,
  SRGBColorSpace, ShaderMaterial, SphereGeometry, TextureLoader, TorusGeometry, Vector3, renderer, scene,
} from "starhermit:scene";
import type { Material, MaterialHooks, Texture } from "starhermit:scene";
import { Rules, type RngStream, type RulesEvent, type State } from "./classic.ts";
import { MOTE_MAX, STAR_MAX, moteCount, starCount, type Look } from "./quality.ts";
import { roundedBox } from "./rounded.ts";

export type Palette = Record<string, number>;

const MU = 1000;
const SLAB_H = 0.42; // world units per slab level
const FRAMING = { dist: 13.5, rise: 6.2, lookDrop: 0.9 }; // authored framing constants
const KEY_DIR = new Vector3(6, 12, 4).normalize();
const PI = Math.PI;
/** The hand-built room's brightness against three.js's RoomEnvironment (as timber-grid matched it). */
const ENV_INTENSITY = 0.3;

const camera = new PerspectiveCamera(38, 16 / 9, 0.1, 220);
let look: Look | null = null;
let theme: Palette | null = null;
let decor: RngStream | null = null;
let reducedMotion = false;
let built = false;
let camY = 2.4, camTargetY = 2.4, camVy = 0; // critically damped spring state
let shakeAmp = 0, shakeT = 0;
let time = 0;
let lastState: State | null = null;

const _m = new Matrix4();

// Deterministic cosmetic PRNG (stars, motes, windows), independent of gameplay streams.
function mulberry(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- lights ----------------------------------------------------------------------
const hemi = new HemisphereLight(0xbfd0e0, 0x3a3450, 0.95 / PI);
const keyLight = new DirectionalLight(0xffe0b0, 1.5 / PI);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 1;
keyLight.shadow.radius = 2; // PCFSoftShadowMap's soft edge
keyLight.shadow.distance = 40;
// Cool rim light from behind separates slab silhouettes from the sky.
const rimLight = new DirectionalLight(0x9fc8ff, 0.55 / PI);
rimLight.position.set(-7, 6, -9);

// --- stone -------------------------------------------------------------------------
// Authored limestone grain (assets/slab-stone.webp) multiplies the theme's
// stone colour; materials pick the map up once it decodes, and stay flat if
// it fails.
let stoneTex: Texture | null = null;
const plainGeo = new BoxGeometry(1, SLAB_H, 1);
let roundGeo: BufferGeometry = roundedBox(1, SLAB_H, 1, 2, 0.035);
let roundSegs = 2;
interface Stone { mesh: Mesh; kind: string }
const stones: Stone[] = [];

function stoneKind(): "lambert" | "standard" | "physical" {
  const b = look!.budget;
  if (b.stone === "lambert") return "lambert";
  return look!.detailed ? b.stone : "standard";
}
function newStoneMaterial(color: Color | number, emissive: Color | number, intensity: number): Material {
  const kind = stoneKind();
  if (kind === "lambert") return new MeshLambertMaterial({ color, map: stoneTex, emissive, emissiveIntensity: intensity });
  const opts = {
    color, roughness: look!.detailed ? 0.5 : 0.55, metalness: 0.08, map: stoneTex,
    emissive, emissiveIntensity: intensity, envMapIntensity: 0.35,
  };
  if (kind === "physical") return new MeshPhysicalMaterial({ ...opts, clearcoat: 0.35, clearcoatRoughness: 0.38 });
  return new MeshStandardMaterial(opts);
}
function slabGeometry(): BufferGeometry { return look!.detailed && look!.budget.bevel > 0 ? roundGeo : plainGeo; }
function makeStone(color: number, emissive: number, intensity: number): Mesh {
  const mesh = new Mesh(slabGeometry(), newStoneMaterial(color, emissive, intensity));
  stones.push({ mesh, kind: stoneKind() });
  return mesh;
}
type Lit = MeshStandardMaterial | MeshLambertMaterial;
const lit = (m: Mesh): Lit => m.material as Lit;
/** Every stone mesh on the current tier's geometry and material model, keeping its colours. */
function refreshStone(): void {
  const segs = Math.max(1, look!.budget.bevel);
  if (segs !== roundSegs) {
    const old = roundGeo;
    roundGeo = roundedBox(1, SLAB_H, 1, segs, 0.035);
    roundSegs = segs;
    old.dispose();
  }
  const kind = stoneKind();
  for (const s of stones) {
    s.mesh.geometry = slabGeometry();
    if (s.kind === kind) continue;
    const old = lit(s.mesh);
    s.mesh.material = newStoneMaterial(old.color.clone(), old.emissive.clone(), old.emissiveIntensity);
    s.kind = kind;
    old.dispose();
  }
}

// --- the sky dome (WGSL port of the browser build's SkyShader) ------------------------
const skyUniforms = {
  uTop: { value: new Color(0x2c3a5e) }, uBot: { value: new Color(0xe8a06a) },
  uGlow: { value: new Color(0xffd9a0) }, uSun: { value: KEY_DIR.clone() },
  uTime: { value: 0 }, uBands: { value: 1 },
};
const SKY_FRAGMENT = `
fn fragment(f: Fragment) -> vec4f {
  let d = normalize(f.world - camera_position());
  let h = d.y;
  var col = mix(uniforms.uBot, uniforms.uTop, smoothstep(-0.02, 0.6, h));
  // Below the horizon: fall off into a deep dusk tone so the plinth reads.
  col = mix(col, uniforms.uTop * 0.55, 1.0 - smoothstep(-0.35, 0.0, h));
  // Warm horizon haze and a soft glow toward the key light.
  col = col + uniforms.uBot * 0.3 * exp(-abs(h) * 14.0);
  let sun = max(dot(d, normalize(uniforms.uSun)), 0.0);
  col = col + uniforms.uGlow * (pow(sun, 18.0) * 0.28 + pow(sun, 3.0) * 0.06);
  // Faint drifting cloud bands (static when animation is off).
  let a = atan2(d.z, d.x);
  var band = sin(a * 5.0 + uniforms.uTime * 0.03 + sin(h * 14.0 + a * 2.0) * 1.3) * 0.5 + 0.5;
  band = band * smoothstep(0.02, 0.18, h) * (1.0 - smoothstep(0.25, 0.55, h));
  col = mix(col, col * 1.12 + uniforms.uBot * 0.05, band * 0.5 * uniforms.uBands);
  return vec4f(col, 1.0);
}`;
const skyDome = new Mesh(new SphereGeometry(150, 32, 16), new ShaderMaterial({
  uniforms: skyUniforms, fragmentShader: SKY_FRAGMENT, side: BackSide, depthWrite: false, fog: false,
}));
skyDome.renderOrder = -10;
skyDome.frustumCulled = false;
skyDome.noAO = true;

// --- gameplay objects --------------------------------------------------------------
const towerGroup = new Group();
const slabMeshes: Mesh[] = []; // one mesh per placed slab (pooled, hidden rather than disposed)
let movingSlab: Mesh;
// The moving slab's outline (the browser build's EdgesGeometry lines).
const edgeMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
const edges = new InstancedMesh(new BoxGeometry(1, 1, 1), edgeMat, 12);
edges.noAO = true;
edges.visible = false;
const ghostMarker = new Mesh(new PlaneGeometry(1, 1).rotateX(-PI / 2),
  new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
ghostMarker.visible = false;
ghostMarker.noAO = true;
// Hint band: marks the perfect-drop window on the travel axis.
const hintMat = new MeshBasicMaterial({ color: 0x9fffd0, transparent: true, opacity: 0, depthWrite: false });
const hintBand = new Mesh(new PlaneGeometry(1, 1).rotateX(-PI / 2), hintMat);
hintBand.noAO = true;
let hintOn = false;
const groundMat = new MeshStandardMaterial({ color: 0x241f2e, roughness: 0.92, envMapIntensity: 0.3 });
const ground = new Mesh(new CylinderGeometry(9, 11, 0.8, 48), groundMat);
ground.position.y = -0.45;
ground.receiveShadow = true;
// Luminous inlay ring on the plinth top (detailed tier; blooms softly).
const rimGlowMat = new MeshBasicMaterial({ color: 0xffd9a0 });
const rimGlow = new Mesh(new TorusGeometry(8.6, 0.025, 6, 128), rimGlowMat);
rimGlow.rotation.x = -PI / 2;
rimGlow.position.y = -0.04;
rimGlow.noAO = true;

interface Debris { mesh: Mesh; active: boolean; vx: number; vy: number; vz: number }
const debris: Debris[] = [];
interface Flash { mesh: Mesh; base: number; t: number }
const flashes: Flash[] = [];

// --- skyline -------------------------------------------------------------------------
let skyline: InstancedMesh | null = null;
let skylineKey = "";
let windowTex: DataTexture | null = null;
/** Procedural lit windows (64 × 128, sRGB bytes), deterministic. */
function windowTexture(): DataTexture {
  if (windowTex) return windowTex;
  const w = 64, h = 128;
  const px = new Uint8Array(w * h * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const rnd = mulberry(0x77aa);
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 6; col++) {
      if (rnd() >= 0.3) continue;
      const v = 140 + Math.floor(rnd() * 115);
      for (let y = 4 + row * 8; y < 8 + row * 8; y++) {
        for (let x = 5 + col * 10; x < 10 + col * 10; x++) {
          const o = (y * w + x) * 4;
          px[o] = v; px[o + 1] = Math.floor(v * 0.85); px[o + 2] = Math.floor(v * 0.6);
        }
      }
    }
  }
  windowTex = new DataTexture(px, w, h);
  windowTex.colorSpace = SRGBColorSpace;
  return windowTex;
}
// Windows on the sides only (the browser build gave roofs a material without them).
const ROOF_HOOK: MaterialHooks = {
  surface: `
fn surface(s: Surface) -> Surface {
  var o = s;
  o.emissive = s.emissive * (1.0 - step(0.5, abs(s.normal.y)));
  return o;
}`,
};
function buildSkyline(): void {
  if (!look) return;
  const detailed = look.detailed;
  const count = look.budget.skyline;
  if (skyline) { scene.remove(skyline); skyline.material.dispose(); skyline.geometry.dispose(); }
  const rng = decor ?? { next: mulberry(0x51c7) };
  const color = theme ? theme.skyline! : 0x3a3450;
  const mat = new MeshStandardMaterial({ color, roughness: 0.9 });
  if (detailed) {
    mat.emissiveMap = windowTexture();
    mat.emissive.set(theme ? theme.glow! : 0xffd9a0);
    mat.emissiveIntensity = 0.55;
    mat.hooks = ROOF_HOOK;
  }
  const inst = new InstancedMesh(new BoxGeometry(1, 1, 1), mat, count);
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * PI * 2 + rng.next() * 0.08;
    const r = 16 + rng.next() * 22;
    const h = 1.5 + rng.next() * 7;
    _m.makeScale(1.2 + rng.next() * 2.2, h, 1.2 + rng.next() * 2.2);
    _m.setPosition(Math.cos(ang) * r, h / 2 - 0.1, Math.sin(ang) * r);
    inst.setMatrixAt(i, _m);
  }
  inst.instanceMatrix.needsUpdate = true;
  skyline = inst;
  skylineKey = `${detailed}:${count}`;
  scene.add(inst);
}

// --- stars and motes -----------------------------------------------------------------
let dotTex: DataTexture | null = null;
/** A soft round point (the browser build's smoothstep(0.5, 0.05, d) disc). */
function dotTexture(): DataTexture {
  if (dotTex) return dotTex;
  const n = 32;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5);
      const t = Math.min(1, Math.max(0, (0.5 - d) / 0.45));
      const a = Math.round(t * t * (3 - 2 * t) * 255);
      const o = (y * n + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = 255;
      px[o + 3] = a;
    }
  }
  dotTex = new DataTexture(px, n, n);
  return dotTex;
}
const starBase = new Float32Array(STAR_MAX * 3);
const starPhase = new Float32Array(STAR_MAX);
const starColor = new Float32Array(STAR_MAX * 3);
const moteBase = new Float32Array(MOTE_MAX * 3);
const motePhase = new Float32Array(MOTE_MAX);
const motePos = new Float32Array(MOTE_MAX * 3);
{
  const rnd = mulberry(0x5ba1);
  for (let i = 0; i < STAR_MAX; i++) {
    const ang = rnd() * PI * 2, r = 60 + rnd() * 60;
    starBase[i * 3] = Math.cos(ang) * r;
    starBase[i * 3 + 1] = 12 + Math.pow(rnd(), 0.7) * 70;
    starBase[i * 3 + 2] = Math.sin(ang) * r;
    starPhase[i] = rnd();
  }
  for (let i = 0; i < MOTE_MAX; i++) {
    const ang = rnd() * PI * 2, r = 1.8 + rnd() * 3.5;
    moteBase[i * 3] = Math.cos(ang) * r;
    moteBase[i * 3 + 1] = rnd() * 9;
    moteBase[i * 3 + 2] = Math.sin(ang) * r;
    motePhase[i] = rnd();
  }
  starColor.fill(1);
}
const starGeo = new BufferGeometry();
starGeo.setAttribute("position", new BufferAttribute(starBase, 3));
starGeo.setAttribute("color", new BufferAttribute(starColor, 3));
const starMat = new PointsMaterial({ map: dotTexture(), size: 0.5, color: 0xdfe6ff, opacity: 0.85, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, vertexColors: true });
const stars = new Points(starGeo, starMat);
const moteGeo = new BufferGeometry();
moteGeo.setAttribute("position", new BufferAttribute(motePos, 3));
const moteMat = new PointsMaterial({ map: dotTexture(), size: 0.12, color: 0xffd9a0, opacity: 0.55, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false });
const motes = new Points(moteGeo, moteMat);
stars.frustumCulled = motes.frustumCulled = false;

// --- environment ---------------------------------------------------------------------
let envTex: Texture | null = null;
/** A neutral room (three.js RoomEnvironment's role): a dim interior with bright
 * soft boxes above and to the sides, as linear light, prefiltered once. */
function buildEnvironment(): void {
  if (envTex) return;
  const w = 128, h = 64;
  const px = new Float32Array(w * h * 4);
  const boxes: [number, number, number, number, number][] = [
    [0, 1.25, 0.9, 0.18, 9], [PI, 1.25, 0.9, 0.18, 7], [PI / 2, 0.35, 0.35, 0.3, 6],
    [-PI / 2, 0.35, 0.35, 0.3, 5], [PI * 0.25, 0.7, 0.25, 0.15, 4], [-PI * 0.75, 0.7, 0.25, 0.15, 4],
  ];
  for (let row = 0; row < h; row++) {
    const lat = (0.5 - (row + 0.5) / h) * PI;
    for (let c = 0; c < w; c++) {
      const lon = ((c + 0.5) / w - 0.5) * 2 * PI;
      let v = lat > 0 ? 0.32 + 0.12 * Math.sin(lat) : 0.18 + 0.06 * Math.cos(lat);
      for (const [bl, bt, hw, hh, k] of boxes) {
        let dl = Math.abs(lon - bl);
        if (dl > PI) dl = 2 * PI - dl;
        if (dl < hw && Math.abs(lat - bt) < hh) v = k;
      }
      const o = (row * w + c) * 4;
      px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = 1;
    }
  }
  try {
    envTex = new PMREMGenerator().fromEquirectangular(new DataTexture(px, w, h, RGBAFormat, FloatType)).texture;
  } catch (e) {
    console.warn("environment:", e instanceof Error ? e.message : String(e));
  }
}

// --- building ------------------------------------------------------------------------
function build(): void {
  built = true;
  scene.add(hemi, keyLight, keyLight.target, rimLight, skyDome, towerGroup, edges, ghostMarker, hintBand, ground, rimGlow, stars, motes);
  // Moving slab: brighter emissive + outline edges (selection language).
  movingSlab = makeStone(0xffffff, 0xffffff, 0.55);
  movingSlab.visible = false;
  scene.add(movingSlab);
  renderer.camera = camera;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  new TextureLoader().loadAsync("assets/slab-stone.webp").then((tex) => {
    tex.colorSpace = SRGBColorSpace;
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.anisotropy = 4;
    stoneTex = tex;
    for (const s of stones) lit(s.mesh).map = tex;
  }, () => { /* no texture: the flat stone remains */ });
}

/** The look for the frame's graphics level; cheap when nothing changed. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  if (!built) build();
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  for (const s of stones) { s.mesh.castShadow = shadows; s.mesh.receiveShadow = true; }
  if (next.reflections) {
    buildEnvironment();
    scene.environment = envTex;
    scene.environmentIntensity = ENV_INTENSITY;
    hemi.intensity = 0.6 / PI;
  } else {
    scene.environment = null;
    hemi.intensity = 0.95 / PI;
  }
  refreshStone();
  applyBackground();
  if (skylineKey !== `${next.detailed}:${next.budget.skyline}`) buildSkyline();
  stars.geometry.setDrawRange(0, starCount(next));
  stars.visible = starCount(next) > 0;
  motes.geometry.setDrawRange(0, moteCount(next));
  motes.visible = moteCount(next) > 0;
  // Post effects, as the browser build's composer chain per preset.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only the emissive moving slab, perfect glows and the rim inlay bloom.
  renderer.bloom = next.bloom ? { strength: 0.32, radius: 0.4, threshold: 0.92, resolution: next.budget.bloomRes } : null;
  // The browser build's grade ShaderPass after OutputPass: a gentle S-curve
  // (0.18 of c²(3−2c), a slope of about 1.09 at mid grey), saturation 1.1,
  // cool shadows / warm highlights, and the vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.09, saturation: 1.1,
    shadows: [0.97, 0.98, 1.04], highlights: [1.03, 1.0, 0.97], split: [0.2, 0.8],
    vignette: { amount: 0.24, inner: 0.4, outer: 0.9 },
  } : null;
  renderer.antialias = next.antialias;
}

function applyBackground(): void {
  const detailed = !!look?.detailed;
  skyDome.visible = detailed;
  scene.background = detailed ? null : new Color(theme ? theme.skyTop! : 0x14101e);
  rimGlow.visible = detailed;
  rimLight.visible = detailed;
}

export function setTheme(palette: Palette, decorRng: RngStream | null): void {
  theme = palette;
  decor = decorRng;
  if (!built) return;
  scene.fog = new Fog(palette.fog!, 24, 90);
  hemi.color.set(palette.skyBot!);
  keyLight.color.set(palette.key!);
  rimLight.color.set(palette.skyTop!).lerp(new Color(0xbfd8ff), 0.6);
  groundMat.color.set(palette.ground!);
  const m = lit(movingSlab);
  m.color.set(palette.glow!);
  m.emissive.set(palette.glow!);
  m.emissiveIntensity = 0.5;
  edgeMat.color.set(palette.glow!);
  (ghostMarker.material as MeshBasicMaterial).color.set(palette.glow!);
  rimGlowMat.color.set(palette.glow!).multiplyScalar(1.15);
  skyUniforms.uTop.value.set(palette.skyTop!);
  skyUniforms.uBot.value.set(palette.skyBot!);
  skyUniforms.uGlow.value.set(palette.glow!);
  moteMat.color.set(palette.glow!);
  for (const mesh of slabMeshes) { lit(mesh).color.set(palette.stone!); lit(mesh).emissive.set(palette.glow!); }
  for (const d of debris) lit(d.mesh).color.set(palette.stoneDark!);
  applyBackground();
  buildSkyline();
}

export function setReducedMotion(on: boolean): void { reducedMotion = on; }
export function setHintVisible(on: boolean): void {
  hintOn = on;
  hintMat.opacity = on ? 0.28 : 0;
  hintBand.visible = on;
}

// --- state → scene -----------------------------------------------------------------
/** The tower, the moving slab (closed-form position + interpolation alpha in ticks). */
export function syncState(state: State, alpha: number): void {
  if (!built || !look) return;
  lastState = state;
  const level = state.slabs.length;
  while (slabMeshes.length < level) {
    const mesh = makeStone(theme ? theme.stone! : 0xbfb4a6, theme ? theme.glow! : 0xffd9a0, 0.12);
    mesh.castShadow = look.shadows > 0;
    mesh.receiveShadow = true;
    towerGroup.add(mesh);
    slabMeshes.push(mesh);
  }
  for (let i = 0; i < slabMeshes.length; i++) {
    const mesh = slabMeshes[i]!;
    if (i >= level) { mesh.visible = false; continue; }
    const s = state.slabs[i]!;
    mesh.visible = true;
    mesh.scale.set(s.w / MU, 1, s.d / MU);
    mesh.position.set(s.x / MU, i * SLAB_H + SLAB_H / 2, s.z / MU);
    // Don't stomp an in-flight placement flash.
    if (!flashes.some((fx) => fx.mesh === mesh)) lit(mesh).emissiveIntensity = s.perfect && i > 0 ? 0.45 : 0.12;
  }

  if (state.pending && !state.terminal) {
    const t = state.tick + alpha;
    const pos = Rules.slabPosAt(state.cfg, state.pending, level, Math.floor(t));
    const posN = Rules.slabPosAt(state.cfg, state.pending, level, Math.floor(t) + 1);
    const interp = (pos + (posN - pos) * (t - Math.floor(t))) / MU;
    const top = state.slabs[level - 1]!;
    const w = state.pending.axis === "x" ? top.w : top.d;
    const sx = top.w / MU, sz = top.d / MU;
    const y = level * SLAB_H + SLAB_H / 2 + 0.28;
    movingSlab.visible = true;
    movingSlab.scale.set(sx, 1, sz);
    if (state.pending.axis === "x") movingSlab.position.set(interp, y, top.z / MU);
    else movingSlab.position.set(top.x / MU, y, interp);
    placeEdges(movingSlab.position, sx, sz);

    ghostMarker.visible = true;
    ghostMarker.scale.set(state.pending.axis === "x" ? w / MU : sx, 1, state.pending.axis === "x" ? sz : w / MU);
    ghostMarker.position.set(top.x / MU, level * SLAB_H + 0.02, top.z / MU);

    // Hint band across the travel axis, width = 2 × eps.
    const eps = state.cfg.eps / MU;
    hintBand.scale.set(state.pending.axis === "x" ? eps * 2 : sx, 1, state.pending.axis === "x" ? sz : eps * 2);
    hintBand.position.set(top.x / MU, level * SLAB_H + 0.03, top.z / MU);
    hintBand.visible = hintOn;
  } else {
    movingSlab.visible = false;
    edges.visible = false;
    ghostMarker.visible = false;
    hintBand.visible = false;
  }
  // Camera: rise with the tower via the critically damped spring.
  camTargetY = 2.4 + Math.max(0, level - 4) * SLAB_H;
  keyLight.target.position.set(0, (level * SLAB_H + 1) * 0.5, 0);
  keyLight.position.copy(KEY_DIR).multiplyScalar(30).add(keyLight.target.position);
}

/** No round: hide the round's objects (the title, the menus). */
export function clearRound(): void {
  for (const m of slabMeshes) m.visible = false;
  movingSlab.visible = edges.visible = ghostMarker.visible = hintBand.visible = false;
  for (const d of debris) { d.active = false; d.mesh.visible = false; }
  camTargetY = 2.4;
}

const EDGE_T = 0.014;
function placeEdges(c: Vector3, w: number, d: number): void {
  const h = SLAB_H;
  let i = 0;
  const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    _m.makeScale(sx, sy, sz);
    _m.setPosition(c.x + x, c.y + y, c.z + z);
    edges.setMatrixAt(i++, _m);
  };
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) put(0, (sy * h) / 2, (sz * d) / 2, w + EDGE_T, EDGE_T, EDGE_T);
  for (const sy of [-1, 1]) for (const sx of [-1, 1]) put((sx * w) / 2, (sy * h) / 2, 0, EDGE_T, EDGE_T, d + EDGE_T);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put((sx * w) / 2, 0, (sz * d) / 2, EDGE_T, h + EDGE_T, EDGE_T);
  edges.instanceMatrix.needsUpdate = true;
  edges.visible = true;
}

// --- event effects (pooled, bounded, event-tiered) ----------------------------------------
export function playEvents(events: RulesEvent[]): void {
  if (!built || !look) return;
  for (const ev of events) {
    if (ev.type === "trim" && look.particles !== "off") {
      spawnDebris(ev);
      if (!reducedMotion) shakeAmp = Math.min(0.06, 0.02 + (ev.size ?? 0) / 40000);
    } else if (ev.type === "place" && ev.perfect) {
      flashTop(1.2);
    } else if (ev.type === "miss") {
      if (!reducedMotion) shakeAmp = 0.08;
    } else if (ev.type === "win") {
      shakeAmp = 0;
      flashTop(2.2);
    }
  }
}

function flashTop(strength: number): void {
  const n = lastState ? lastState.slabs.length : 0;
  const mesh = slabMeshes[n - 1];
  if (!mesh || !mesh.visible) return;
  const base = lastState!.slabs[n - 1]!.perfect ? 0.45 : 0.12;
  lit(mesh).emissiveIntensity = strength;
  flashes.push({ mesh, base, t: 0 });
}

function spawnDebris(ev: RulesEvent): void {
  if (!lastState || !look) return;
  let d = debris.find((x) => !x.active);
  if (!d) {
    if (debris.length >= look.budget.debris) return; // pooled cap from the budget
    const mesh = makeStone(theme ? theme.stoneDark! : 0x8a8078, 0x000000, 0);
    mesh.castShadow = look.shadows > 0;
    scene.add(mesh);
    d = { mesh, active: false, vx: 0, vy: 0, vz: 0 };
    debris.push(d);
  }
  const s = lastState.slabs[lastState.slabs.length - 1]!;
  const size = (ev.size ?? 0) / MU;
  const side = ev.side ?? 1;
  d.active = true;
  d.vx = ev.axis === "x" ? side * 1.6 : 0;
  d.vz = ev.axis === "z" ? side * 1.6 : 0;
  d.vy = 0;
  d.mesh.visible = true;
  d.mesh.rotation.set(0, 0, 0);
  if (ev.axis === "x") d.mesh.scale.set(size, 1, s.d / MU);
  else d.mesh.scale.set(s.w / MU, 1, size);
  d.mesh.position.set(ev.axis === "x" ? (ev.center ?? 0) / MU : s.x / MU, (ev.level ?? 0) * SLAB_H + SLAB_H / 2,
    ev.axis === "z" ? (ev.center ?? 0) / MU : s.z / MU);
}

// --- per frame ---------------------------------------------------------------------------
export function frame(dtRaw: number): void {
  if (!built || !look) return;
  const dt = Math.min(0.1, Math.max(0, dtRaw));
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

  // Debris falls under gravity and tumbles; flashes ease back over 0.8 s.
  for (const d of debris) {
    if (!d.active) continue;
    d.vy -= 9.8 * dt;
    d.mesh.position.x += d.vx * dt;
    d.mesh.position.z += d.vz * dt;
    d.mesh.position.y += d.vy * dt;
    if (!reducedMotion) d.mesh.rotation.x += 2.4 * dt;
    if (d.mesh.position.y < -2) { d.active = false; d.mesh.visible = false; }
  }
  const decay = Math.pow(0.9, dt * 60);
  for (let i = flashes.length - 1; i >= 0; i--) {
    const fx = flashes[i]!;
    fx.t += dt;
    const m = lit(fx.mesh);
    m.emissiveIntensity = fx.base + (m.emissiveIntensity - fx.base) * decay;
    if (fx.t > 0.8) { m.emissiveIntensity = fx.base; flashes.splice(i, 1); }
  }

  // Ambient motion: sky bands drift, stars twinkle, motes rise, the moving slab breathes.
  const animate = look.animated && !reducedMotion;
  if (animate) time += dt;
  skyDome.position.copy(camera.position);
  skyUniforms.uTime.value = time;
  skyUniforms.uBands.value = look.animated ? 1 : 0;
  const ns = starCount(look);
  if (ns > 0) {
    for (let i = 0; i < ns; i++) {
      const ph = starPhase[i]!;
      const a = animate ? 1 - 0.55 * (0.5 + 0.5 * Math.sin(time * (1.2 + ph * 2) + ph * 40)) : 1;
      starColor[i * 3] = starColor[i * 3 + 1] = starColor[i * 3 + 2] = a;
    }
    const attr = starGeo.getAttribute("color")!;
    attr.array = starColor;
    attr.needsUpdate = true;
  }
  const nm = moteCount(look);
  if (nm > 0) {
    for (let i = 0; i < nm; i++) {
      const ph = motePhase[i]!;
      const y0 = moteBase[i * 3 + 1]! + time * 0.35 * (0.5 + ph);
      motePos[i * 3] = moteBase[i * 3]! + Math.sin(time * 0.4 + ph * 17) * 0.25;
      motePos[i * 3 + 1] = camY + (y0 % 9) - 4.5;
      motePos[i * 3 + 2] = moteBase[i * 3 + 2]!;
    }
    const attr = moteGeo.getAttribute("position")!;
    attr.array = motePos;
    attr.needsUpdate = true;
  }
  if (movingSlab.visible && !flashes.length) lit(movingSlab).emissiveIntensity = animate ? 0.5 + 0.1 * Math.sin(time * 3.2) : 0.5;
}
