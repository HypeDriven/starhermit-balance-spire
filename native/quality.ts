// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (slab material and bevel, skyline, particles, reflections,
// detail, motion) is the browser build's four presets and budgets (js/gfx.js
// TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU it was
// given) keyed by the level's quality tier, with the star and mote budgets
// scaled within the tier by the level's particle budget against the tier's
// anchor level (quantum, molecular, terrestrial, galactic), at most twice.
// The runtime owns the rest of what the old Graphics panel did: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution,
// the frame-rate limit and the frame-rate readout.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Look {
  preset: Preset;
  /** Key-light shadow map: the level's size, 0 when the level draws no shadows. */
  shadows: number;
  /** GTAO contact darkening between slabs: the level's (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** Glow on the moving slab, perfect slabs and the plinth inlay: the level's bloom resolution (null: off). */
  bloom: number | null;
  /** Colour grade + vignette. */
  grade: boolean;
  antialias: AntialiasMode;
  /** Stars and trim debris; "high" adds the rising motes. */
  particles: "off" | "low" | "high";
  /** Image-based lighting. */
  reflections: boolean;
  /** Gradient sky, bevelled glossy slabs, lit skyline, rim light, plinth inlay. */
  detailed: boolean;
  /** Drifting sky bands, twinkling stars, rising motes, the breathing slab. */
  animated: boolean;
  budget: Budget;
}
export interface Budget {
  /** Slab material: Lambert, standard PBR or clearcoat physical. */
  stone: "lambert" | "standard" | "physical";
  /** Rounded-slab bevel segments with detail on (0 = plain boxes). */
  bevel: number;
  /** Instanced skyline buildings. */
  skyline: number;
  /** Star points (particles high; low uses 40 %). */
  stars: number;
  /** Rising motes around the tower top (particles high). */
  motes: number;
  /** Pooled falling trim pieces. */
  debris: number;
}

type Art = Pick<Look, "particles" | "reflections" | "detailed" | "animated">;
const ART: Record<Preset, Art> = {
  low: { particles: "off", reflections: false, detailed: false, animated: false },
  balanced: { particles: "low", reflections: true, detailed: true, animated: true },
  high: { particles: "high", reflections: true, detailed: true, animated: true },
  ultra: { particles: "high", reflections: true, detailed: true, animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { stone: "lambert", bevel: 0, skyline: 16, stars: 250, motes: 0, debris: 4 },
  balanced: { stone: "standard", bevel: 2, skyline: 40, stars: 400, motes: 30, debris: 8 },
  high: { stone: "physical", bevel: 2, skyline: 56, stars: 600, motes: 70, debris: 12 },
  ultra: { stone: "physical", bevel: 4, skyline: 96, stars: 1200, motes: 140, debris: 16 },
};
export const STAR_MAX = 2400;
export const MOTE_MAX = 280;
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  // Stars and motes grow with the level's particle budget above the tier's anchor, at most twice the tier's budget.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const b = { ...BUDGETS[preset] };
  b.stars = Math.min(STAR_MAX, Math.round(b.stars * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    // Engine issue (1.36.1, reported 2026-11-04; fix due in 1.36.2): antialias "off" recolours fog,
    // haze and translucent overlays, so Low keeps the MSAA it always had until that release.
    antialias: s.antialias === "off" ? "msaa" : s.antialias,
    budget: b,
  };
}

/** Stars drawn: the budget with particles high, 40 % low, none off. */
export function starCount(look: Look): number {
  return look.particles === "high" ? look.budget.stars : look.particles === "low" ? Math.round(look.budget.stars * 0.4) : 0;
}
/** Motes drawn (particles high only). */
export function moteCount(look: Look): number {
  return look.particles === "high" ? look.budget.motes : 0;
}
