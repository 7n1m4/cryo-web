/**
 * The third-person orbit the exterior camera flies around the hull.
 *
 * A faithful port of `ShipOrbit` from the Rust
 * `src/presentation/ship_scene.rs`, kept as a plain value with no field
 * functions so the arithmetic can be asserted without a renderer.
 *
 * The angles are stored, not recomputed from a quaternion: reading them back out
 * of one every frame would need `to_euler`, a convention for the Euler order,
 * and a round-trip that drifts. Storing them makes the state assertable
 * exactly, which is what makes the orbit one code path rather than two framings
 * that happen to agree.
 *
 * `fromFrame` derives the resting orbit by *reading* the framing functions
 * rather than by re-deriving them: `CAMERA_DISTANCE_HULLS` is already divided by
 * `cos(45°)` and takes no account of the rise above the hull's centre, so a
 * naive `CAMERA_DISTANCE_HULLS * hull_length` is wrong by about 44% here, and a
 * rest state that is silently off is the single most dangerous way to break a
 * framing a player has already praised.
 */

import type { HullPlan } from '../ship/voxel.ts';
import type { Vec3Like } from './frameMath.ts';
import {
 cameraPosition,
 cameraTarget,
 hullBoundingRadius,
 meshedHull,
 modelOrigin,
} from './frameMath.ts';

/** Orbit drag sensitivity, radians per pixel. */
export const ORBIT_RADIANS_PER_PIXEL = 0.005;

/** Orbit zoom factor per wheel line. */
export const ORBIT_ZOOM_PER_LINE = 0.88;

/** Lowest orbit elevation, in radians. */
export const ORBIT_MIN_ELEVATION = (4 * Math.PI) / 180;

/** Highest orbit elevation, in radians. */
export const ORBIT_MAX_ELEVATION = (85 * Math.PI) / 180;

/** Orbit zoom, at the closest hull radii. */
export const ORBIT_NEAR_HULLS = 1.3;

/** Orbit zoom, at the furthest hull radii. */
export const ORBIT_FAR_HULLS = 6.0;

/** The third-person orbit's whole state, in one flat value. */
export interface ShipOrbit {
 /** The point the camera orbits and looks at: the hull's own mid-height. */
 readonly target: Vec3Like;
 /** The framing the orbit rests at, read from `cameraPosition`. */
 readonly restPosition: Vec3Like;
 /** The radius of the sphere, centred on `target`, that contains the hull. */
 readonly radius: number;
 /** Horizontal bearing from the target, in radians. */
 readonly yaw: number;
 /** Height above the target's plane, in radians. */
 readonly elevation: number;
 /** Distance from the target, in world units. */
 readonly distance: number;
}

/** How close to the hull's centre the orbit may come, in world units. */
export function nearestReachableDistance(orbit: ShipOrbit): number {
 return ORBIT_NEAR_HULLS * orbit.radius;
}

/** How far the orbit may back off from the hull's centre, in world units. */
export function farthestReachableDistance(orbit: ShipOrbit): number {
 return ORBIT_FAR_HULLS * orbit.radius;
}

/**
 * Derives the resting orbit for a hull, and the distance clamps with it.
 *
 * The resting angles are `cameraPosition` and `cameraTarget` decomposed into
 * spherical coordinates around the point the camera already looks at.
 *
 * The mesh is read only for its fallback: an empty mesh is a rendering artefact
 * with no useful geometry, and the radius measured over it is zero. That is the
 * module's policy everywhere — an invisible hull rather than a panic.
 */
export function orbitFromPlan(plan: HullPlan): ShipOrbit {
 const hull = meshedHull(plan);
 const rest = cameraPosition(plan, modelOrigin(plan), hull);
 const target = cameraTarget(plan, hull);
 const offset: Vec3Like = {
  x: rest.x - target.x,
  y: rest.y - target.y,
  z: rest.z - target.z,
 };
 return {
  target,
  restPosition: rest,
  radius: hullBoundingRadius(plan, hull),
  yaw: Math.atan2(offset.x, offset.z),
  elevation: Math.atan2(offset.y, Math.hypot(offset.x, offset.z)),
  distance: Math.hypot(offset.x, offset.y, offset.z),
 };
}

/**
 * The camera position this orbit composes, in world units.
 *
 * Exactly the spherical-to-Cartesian conversion `orbitFromPlan` inverts, so
 * `orbitFromPlan(p)` composed through this reproduces `cameraPosition`. That
 * identity is what makes this one code path rather than two.
 */
export function orbitPosition(orbit: ShipOrbit): Vec3Like {
 const sinElevation = Math.sin(orbit.elevation);
 const cosElevation = Math.cos(orbit.elevation);
 const sinYaw = Math.sin(orbit.yaw);
 const cosYaw = Math.cos(orbit.yaw);
 const horizontal = orbit.distance * cosElevation;
 return {
  x: orbit.target.x + horizontal * sinYaw,
  y: orbit.target.y + orbit.distance * sinElevation,
  z: orbit.target.z + horizontal * cosYaw,
 };
}

/**
 * The orbit after a left-button drag of `delta` pixels.
 *
 * `delta` is raw accumulated mouse motion in window pixels; only the magnitude
 * is scaled, by a constant in radians per pixel, so the result does not depend
 * on the frame rate or the window's size.
 *
 * The elevation clamp is applied here, where elevation changes, and only here:
 * an angle's clamp cannot make a later input meaningless, so there is nothing to
 * gain from deferring it.
 */
export function orbitDragged(orbit: ShipOrbit, delta: { readonly x: number; readonly y: number }): ShipOrbit {
 return {
  ...orbit,
  yaw: orbit.yaw + -delta.x * ORBIT_RADIANS_PER_PIXEL,
  elevation: clamp(
   orbit.elevation + delta.y * ORBIT_RADIANS_PER_PIXEL,
   ORBIT_MIN_ELEVATION,
   ORBIT_MAX_ELEVATION,
  ),
 };
}

/**
 * The orbit after `lines` lines of scroll.
 *
 * `lines` is already normalised to line units by the caller, which is what keeps
 * this function free of any dependency on how a platform reports its wheel.
 *
 * The distance clamp is applied here, where distance changes, and the asymmetry
 * against the elevation clamp in `orbitDragged` is deliberate. Multiplicative
 * zoom is invertible — `d *= 0.88^n` then `d /= 0.88^n` returns to `d` exactly —
 * and clamping at write time preserves that. A clamp applied while *composing*
 * the position would leave a clamped output clamped after the input reversed, so
 * the camera would have to be scrolled past the clamp and back before it moved
 * again: zoom that feels sticky at the ends.
 */
export function orbitZoomed(orbit: ShipOrbit, lines: number): ShipOrbit {
 return {
  ...orbit,
  distance: clamp(
   orbit.distance * Math.pow(ORBIT_ZOOM_PER_LINE, lines),
   nearestReachableDistance(orbit),
   farthestReachableDistance(orbit),
  ),
 };
}

/**
 * The orbit occupying `point`, or the closest legal state to it.
 *
 * The three degrees of freedom the orbit clamps — azimuth, elevation, distance
 * — are clamped here exactly as `orbitZoomed` and `orbitDragged` clamp them, so
 * a state built from a point is a state the orbit could have reached by being
 * driven there. That is the property the boarding trigger needs: a trigger
 * position the orbit cannot occupy is a trigger the player can never pull.
 *
 * Nearest, *not* exactly on: the mouth of the hatch sits below the hull's centre
 * by construction, which puts it below `ORBIT_MIN_ELEVATION` — the clamp that
 * keeps the camera out of the ice.
 */
export function orbitNearestTo(orbit: ShipOrbit, point: Vec3Like): ShipOrbit {
 const offset: Vec3Like = {
  x: point.x - orbit.target.x,
  y: point.y - orbit.target.y,
  z: point.z - orbit.target.z,
 };
 if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y) || !Number.isFinite(offset.z)) {
  return orbit;
 }
 const lengthSquared = offset.x * offset.x + offset.y * offset.y + offset.z * offset.z;
 if (lengthSquared <= 0) {
  return orbit;
 }
 return {
  ...orbit,
  yaw: Math.atan2(offset.x, offset.z),
  elevation: clamp(
   Math.atan2(offset.y, Math.hypot(offset.x, offset.z)),
   ORBIT_MIN_ELEVATION,
   ORBIT_MAX_ELEVATION,
  ),
  distance: clamp(Math.sqrt(lengthSquared), nearestReachableDistance(orbit), farthestReachableDistance(orbit)),
 };
}

/**
 * Pixels of drag that make one radian of orbit.
 *
 * The reciprocal of `ORBIT_RADIANS_PER_PIXEL`, exposed so a caller can name an
 * angle it wants the camera to reach and work out the drag that gets there.
 */
export const ORBIT_PIXELS_PER_RADIAN = 1 / ORBIT_RADIANS_PER_PIXEL;

/** `Math.max` and `Math.min` together, the Rust `f32::clamp`. */
export function clamp(value: number, low: number, high: number): number {
 return Math.min(Math.max(value, low), high);
}
