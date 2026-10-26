// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// it was given) keyed by the runtime's quality tier (frame().quality), with
// the star and mote budgets scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level. The runtime owns the rest of what the old Graphics panel did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and the frame-rate readout, and the
// shadow-map size and MSAA samples it holds to the level.
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Look {
  preset: Preset;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  /** GTAO contact darkening between slabs. */
  ao: "off" | "on" | "high";
  /** Glow on the moving slab, perfect slabs and the plinth inlay. */
  bloom: boolean;
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
  /** Bloom resolution as a fraction of the frame. */
  bloomRes: number;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", particles: "off", reflections: false, detailed: false, animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", particles: "low", reflections: true, detailed: true, animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", particles: "high", reflections: true, detailed: true, animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", particles: "high", reflections: true, detailed: true, animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { stone: "lambert", bevel: 0, skyline: 16, stars: 250, motes: 0, debris: 4, bloomRes: 0.5 },
  balanced: { stone: "standard", bevel: 2, skyline: 40, stars: 400, motes: 30, debris: 8, bloomRes: 0.5 },
  high: { stone: "physical", bevel: 2, skyline: 56, stars: 600, motes: 70, debris: 12, bloomRes: 0.75 },
  ultra: { stone: "physical", bevel: 4, skyline: 96, stars: 1200, motes: 140, debris: 16, bloomRes: 1 },
};
export const STAR_MAX = 2400;
export const MOTE_MAX = 280;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: stars and motes grow with
  // the level above the tier's first, at most twice the tier's budget.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.stars = Math.min(STAR_MAX, Math.round(b.stars * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}

/** Stars drawn: the budget with particles high, 40 % low, none off. */
export function starCount(look: Look): number {
  return look.particles === "high" ? look.budget.stars : look.particles === "low" ? Math.round(look.budget.stars * 0.4) : 0;
}
/** Motes drawn (particles high only). */
export function moteCount(look: Look): number {
  return look.particles === "high" ? look.budget.motes : 0;
}
