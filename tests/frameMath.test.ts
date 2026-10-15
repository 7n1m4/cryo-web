/**
 * The hull's frame and the orbit around it, pinned against the Rust.
 *
 * Every test name here is the Rust test name from
 * `/home/vi/cryo/src/presentation/ship_scene.rs` (lines 1452-1803), quoted
 * verbatim. The Rust has twelve; this file has those twelve and nothing else.
 * The point of quoting them is that a name shared with the original is the only
 * way a reviewer can tell what was actually ported from what was invented.
 *
 * The fixture is the Rust's own: `HullConfig::damaged_opening()`, exposed here
 * as `OPENING_HULL_CONFIG` so this file does not redeclare the config and drift
 * away from what the game opens with.
 */

import { describe, expect, it } from 'vitest';

import {
 OPENING_HULL_CONFIG,
 cameraPosition,
 hullBoundingRadius,
 hullLengthWorld,
 meshedHull,
 modelOrigin,
 modelTransform,
 distance,
 transformPoint,
} from '../src/presentation/frameMath.ts';
import {
 ORBIT_FAR_HULLS,
 ORBIT_MAX_ELEVATION,
 ORBIT_MIN_ELEVATION,
 ORBIT_NEAR_HULLS,
 ORBIT_PIXELS_PER_RADIAN,
 orbitDragged,
 orbitFromPlan,
 orbitNearestTo,
 orbitPosition,
 orbitZoomed,
} from '../src/presentation/orbit.ts';
import { HullPlan } from '../src/ship/voxel.ts';

/** Tolerance for the trigonometry round-trip through `atan2`/`sin_cos`. */
const TOLERANCE = 1e-6;

/** The scene's own hull, so the numbers under test are the shipped ship's. */
function plan(): HullPlan {
 return HullPlan.generate(OPENING_HULL_CONFIG);
}

describe('the third-person orbit', () => {
 it('the_resting_orbit_is_the_camera_position_it_replaces', () => {
  const p = plan();
  const orbit = orbitFromPlan(p);
  const composed = orbitPosition(orbit);
  const direct = cameraPosition(p, modelOrigin(p), meshedHull(p));

  // The orbit must compose to the framing it was derived from; a difference
  // means the angles were re-derived rather than read.
  expect(composed.x).toBeCloseTo(direct.x, 12);
  expect(composed.y).toBeCloseTo(direct.y, 12);
  expect(composed.z).toBeCloseTo(direct.z, 12);

  // And the orbit's stored target must be `camera_target`, or the camera
  // would drift off the framing it rests at. `camera_target` is mid-ship on
  // x and z by construction, and its y is the hull's own mid-height lifted
  // by the gear clearance — which is exactly the height the composed
  // position sits above.
  expect(orbit.target.x).toBeCloseTo(0, 12);
  expect(orbit.target.z).toBeCloseTo(0, 12);
  // The y term is pinned through the composition rather than restated: the
  // rest position's height above the target is the orbit's own rise, so a
  // target that shifted down without the angles following would show here.
  const rise = composed.y - orbit.target.y;
  expect(rise).toBeGreaterThan(0);
  expect(orbitPosition({ ...orbit, distance: 0 })).toMatchObject({ x: orbit.target.x, z: orbit.target.z });
  // A degenerate distance of zero must place the camera exactly on the
  // target, which is the identity that makes `position` a real inverse.
  expect(orbitPosition({ ...orbit, distance: 0 }).y).toBeCloseTo(orbit.target.y, 12);
 });

 it('orbit_drag_moves_the_camera_by_the_drag_vector', () => {
  const rest = orbitFromPlan(plan());
  const dragged = orbitDragged(rest, { x: -160, y: 0 });

  expect(dragged.elevation).toBeCloseTo(rest.elevation, 12);
  expect(dragged.distance).toBeCloseTo(rest.distance, 12);
  expect(dragged.target).toBe(rest.target);
  expect(dragged.yaw).toBeCloseTo(rest.yaw + 160 * 0.005, 12);

  // The vertical axis uses the same constant, which is the property that
  // makes the drag a rotation of the input rather than a shear. Equal
  // constants, one multiplication, both axes.
  const raised = orbitDragged(rest, { x: 0, y: 40 });
  expect(raised.yaw).toBeCloseTo(rest.yaw, 12);
  expect(raised.elevation).toBeCloseTo(rest.elevation + 40 * 0.005, 12);

  // A drag of one radian's worth of pixels is exactly one radian. This is
  // the Rust's own reason for exposing `pixels_per_radian`: the only honest
  // way for a caller to name an angle and drive the orbit to it.
  const oneRadian = orbitDragged(rest, { x: -ORBIT_PIXELS_PER_RADIAN, y: 0 });
  expect(oneRadian.yaw - rest.yaw).toBeCloseTo(1, 12);
 });

 it('orbit_drag_raising_the_camera_stops_at_the_ceiling', () => {
  const rest = orbitFromPlan(plan());

  const dragged = orbitDragged(rest, { x: 0, y: 10_000 });

  expect(dragged.elevation).toBeLessThanOrEqual(ORBIT_MAX_ELEVATION + TOLERANCE);
  expect(Math.abs(dragged.elevation - ORBIT_MAX_ELEVATION)).toBeLessThan(TOLERANCE);
 });

 it('orbit_drag_lowering_the_camera_stops_at_the_ice', () => {
  const rest = orbitFromPlan(plan());

  const dragged = orbitDragged(rest, { x: 0, y: -10_000 });

  expect(dragged.elevation).toBeGreaterThanOrEqual(ORBIT_MIN_ELEVATION - TOLERANCE);
  expect(Math.abs(dragged.elevation - ORBIT_MIN_ELEVATION)).toBeLessThan(TOLERANCE);

  // The clamp exists to keep the camera above the ice, which is a claim
  // about the composed position rather than about the angle.
  const composed = orbitPosition(dragged);
  expect(composed.y).toBeGreaterThan(0);
 });

 it('orbit_wheel_snaps_in_and_out_in_steps', () => {
  const rest = orbitFromPlan(plan());

  const closer = orbitZoomed(rest, 1);

  expect(closer.distance).toBeLessThan(rest.distance);
  expect(closer.distance).toBeCloseTo(rest.distance * 0.88, 12);
  expect(closer.yaw).toBeCloseTo(rest.yaw, 12);
  expect(closer.elevation).toBeCloseTo(rest.elevation, 12);
  expect(closer.target).toBe(rest.target);

  // Multiplicative zoom is invertible, and the distance clamp is applied
  // on write rather than on read precisely so that this stays true.
  expect(Math.abs(orbitZoomed(closer, -1).distance - rest.distance)).toBeLessThan(TOLERANCE);
 });

 it('orbit_wheel_cannot_enter_the_hull', () => {
  const rest = orbitFromPlan(plan());
  const radius = hullBoundingRadius(plan(), meshedHull(plan()));

  const closer = orbitZoomed(rest, 8);

  const composed = orbitPosition(closer);
  expect(distance(composed, closer.target)).toBeGreaterThanOrEqual(radius - TOLERANCE);
  expect(closer.distance).toBeLessThan(rest.distance);
 });

 it('orbit_wheel_cannot_lose_the_ship', () => {
  const rest = orbitFromPlan(plan());

  const farther = orbitZoomed(rest, -40);

  expect(farther.distance).toBeLessThanOrEqual(ORBIT_FAR_HULLS * rest.radius + TOLERANCE);
  expect(Math.abs(farther.distance - ORBIT_FAR_HULLS * rest.radius)).toBeLessThan(TOLERANCE);
 });

 it('the_hull_bounding_radius_contains_every_rendered_point', () => {
  const p = plan();
  const mesh = meshedHull(p);
  const radius = hullBoundingRadius(p, mesh);
  const centre = orbitFromPlan(p).target;
  // The hull entity's own transform, which is the space `camera_target`
  // lives in and therefore the only one a radius in world units can mean.
  const model = modelTransform(p, mesh);

  for (const at of mesh.positions) {
   const point = transformPoint(model, { x: at[0], y: at[1], z: at[2] });
   expect(distance(point, centre)).toBeLessThanOrEqual(radius + TOLERANCE);
  }

  // The extras are the part a surface-only radius misses: the canopy sits
  // ahead of the nose and the pads hang under the legs, so both reach
  // further than the voxel hull in the direction the camera actually visits.
  let corners = 0;
  for (const extra of p.extras) {
   for (const corner of [
    { x: extra.center[0] - extra.halfExtents[0], y: extra.center[1] - extra.halfExtents[1], z: extra.center[2] - extra.halfExtents[2] },
    { x: extra.center[0] + extra.halfExtents[0], y: extra.center[1] - extra.halfExtents[1], z: extra.center[2] - extra.halfExtents[2] },
    { x: extra.center[0] - extra.halfExtents[0], y: extra.center[1] + extra.halfExtents[1], z: extra.center[2] - extra.halfExtents[2] },
    { x: extra.center[0] + extra.halfExtents[0], y: extra.center[1] + extra.halfExtents[1], z: extra.center[2] - extra.halfExtents[2] },
    { x: extra.center[0] - extra.halfExtents[0], y: extra.center[1] - extra.halfExtents[1], z: extra.center[2] + extra.halfExtents[2] },
    { x: extra.center[0] + extra.halfExtents[0], y: extra.center[1] - extra.halfExtents[1], z: extra.center[2] + extra.halfExtents[2] },
    { x: extra.center[0] - extra.halfExtents[0], y: extra.center[1] + extra.halfExtents[1], z: extra.center[2] + extra.halfExtents[2] },
    { x: extra.center[0] + extra.halfExtents[0], y: extra.center[1] + extra.halfExtents[1], z: extra.center[2] + extra.halfExtents[2] },
   ]) {
    corners += 1;
    const point = transformPoint(model, corner);
    expect(distance(point, centre)).toBeLessThanOrEqual(radius + TOLERANCE);
   }
  }
  expect(corners).toBeGreaterThan(0);

  // Tightness, measured in the frame the radius lives in. A radius well past
  // twice the hull's length is the signature of mixing the lattice frame
  // with the world frame.
  expect(radius).toBeGreaterThan(0);
  expect(radius).toBeLessThan(2 * hullLengthWorld(p));
 });

 it('the_radius_is_measured_in_the_world_frame_the_target_lives_in', () => {
  const p = plan();
  const mesh = meshedHull(p);
  const model = modelTransform(p, mesh);
  const radius = hullBoundingRadius(p, mesh);
  const centre = orbitFromPlan(p).target;

  // The same statement as above, but made against `modelTransform` directly
  // so the transform's role is visible at the call site.
  for (const at of mesh.positions) {
   const point = transformPoint(model, { x: at[0], y: at[1], z: at[2] });
   expect(distance(point, centre)).toBeLessThanOrEqual(radius + TOLERANCE);
  }
 });

 it('the_near_clamp_keeps_the_camera_outside_the_hull', () => {
  // `ORBIT_NEAR_HULLS` is a multiple of the hull's bounding radius, and a
  // multiple below one hands the camera a distance inside the sphere that
  // contains the ship.
  expect(ORBIT_NEAR_HULLS).toBeGreaterThan(1);

  const rest = orbitFromPlan(plan());
  expect(ORBIT_NEAR_HULLS * rest.radius).toBeGreaterThan(rest.radius);
 });

 it('the_resting_distance_is_inside_the_clamp_band', () => {
  const rest = orbitFromPlan(plan());

  expect(rest.distance).toBeGreaterThan(ORBIT_NEAR_HULLS * rest.radius);
  expect(rest.distance).toBeLessThan(ORBIT_FAR_HULLS * rest.radius);
 });

 it('no_input_leaves_the_orbit_alone', () => {
  const rest = orbitFromPlan(plan());

  expect(orbitDragged(rest, { x: 0, y: 0 })).toEqual(rest);
  expect(orbitZoomed(rest, 0)).toEqual(rest);
  // `nearest_to` on the orbit's own camera position is likewise a no-op:
  // the state is already the one that point composes from.
  expect(orbitNearestTo(rest, orbitPosition(rest))).toEqual(rest);
 });
});
