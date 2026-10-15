/**
 * The exterior's fog, and the interior's exemption from it.
 *
 * A faithful port of `fog_band` and the colour it blends toward from the Rust
 * `src/presentation/ship_scene.rs`, plus the one thing the TS port has to do
 * that the Rust did not: keep the interior camera out of the exterior's fog.
 *
 * That exemption is the fix for a gap the Rust did not have. Bevy's fog is a
 * per-*camera* setting, so the Rust's exterior fog simply does not apply to the
 * interior camera that draws over the title screen. Babylon's `Scene.fogMode`
 * is per-*scene* and applies to every mesh in it unless the mesh opts out, so
 * the interior has to be opted out explicitly — mesh by mesh, through
 * `AbstractMesh.applyFog`.
 *
 * The failure this guards is silent and specific: the exterior's fog band is
 * 1.5 to 6 hull lengths, which on the shipped hull is about 1.5 to 6 world
 * units. The interior is 36 cells — 36 metres — deep, so with fog on it would
 * fade the far end of the corridor into the sky colour and a player would read
 * the airlock as "a very long way off" without any way to explain why.
 */

import type { HullPlan } from '../ship/voxel.ts';
import { hullLengthWorld } from './frameMath.ts';

/** Distance, in hull lengths, at which the fog begins. */
export const FOG_START_HULLS = 1.5;

/** Distance, in hull lengths, at which the fog fully hides the ground. */
export const FOG_END_HULLS = 6;

/**
 * The colour of the sky at the horizon, and therefore of the distance fog.
 *
 * A dim-star twilight, matched to the sun and ambient so the horizon reads as
 * atmosphere rather than as a flat wall the plane happens to stop at.
 */
export const FOG_COLOR_LINEAR: readonly [number, number, number] = [0.03, 0.05, 0.09];

/** Half-extent of the visible ice, in world units. */
export const GROUND_HALF_EXTENT = 400;

/**
 * The fog band for a hull plan, in world units.
 *
 * Both ends are proportional to the hull's length, because a fog measured in
 * absolute units would swallow a short hull and fail to hide a long one's far
 * end.
 *
 * The plane is deliberately much larger than the fog's reach: past a few dozen
 * units the ground is entirely fogged out, so a 400-unit plane costs the same to
 * *render* as a 40-unit one (two triangles either way) while guaranteeing the
 * horizon never reveals a visible edge.
 */
export function fogBand(plan: HullPlan): readonly [number, number] {
 const length = hullLengthWorld(plan);
 return [FOG_START_HULLS * length, FOG_END_HULLS * length];
}

/** What the exterior's fog wiring wants, as data. */
export interface ExteriorFogSpec {
 /** Distance the fog begins at, in world units. */
 readonly start: number;
 /** Distance the fog fully hides the ground at, in world units. */
 readonly end: number;
 /** The colour the fog blends toward. */
 readonly color: readonly [number, number, number];
 /** Half-extent of the ground plane, in world units. */
 readonly groundHalfExtent: number;
}

/** The exterior's fog, for a hull. */
export function exteriorFog(plan: HullPlan): ExteriorFogSpec {
 const [start, end] = fogBand(plan);
 return { start, end, color: FOG_COLOR_LINEAR, groundHalfExtent: GROUND_HALF_EXTENT };
}

/**
 * Whether a mesh should be exempt from the exterior's fog.
 *
 * `true` for the interior's own meshes, whose rooms are 36 metres deep against
 * a fog band six units wide. This is the seam the Babylon wiring implements by
 * setting `mesh.applyFog = false`, and keeping the decision here means it is one
 * statement a test can read.
 */
export const INTERIOR_MESHES_ARE_FOG_EXEMPT = true;

/**
 * Whether the interior camera can see the exterior's fog at all.
 *
 * `false`, and this is the invariant the whole module exists for: the interior
 * is a separate scene in the Rust (its own `Scene`, its own layer) but shares
 * the render target here, so nothing stops the scene-level fog from reaching
 * across into it unless the meshes opt out. A test asserting this is `false` is
 * what stops a future "let me just turn fog on for the whole scene" from
 * re-introducing the gap.
 */
export const INTERIOR_SEES_EXTERIOR_FOG = false;
