/**
 * The hull's frame: the plan-to-world arithmetic the exterior camera, the fog
 * and the boarding hatch all read from.
 *
 * This is a faithful port of the *private* half of the Rust
 * `src/presentation/ship_scene.rs` — `model_origin`, `contact_point`,
 * `lowest_heave`, `model_transform`, `resting_height`, `camera_position`,
 * `camera_target`, `hull_centreline_x`, `hull_length` and `hull_bounding_radius`
 * — kept Babylon-free on purpose. Every one of them is pure arithmetic over a
 * `HullPlan` and a `ShipMesh`, and the numbers they produce are the framing a
 * player has already seen, so each is asserted against the Rust's own test
 * names in `tests/frame_math.test.ts`.
 *
 * Nothing here reads a clock, and nothing here depends on an engine: the same
 * module runs in a test with no renderer, which is the only way an exact
 * assertion on a rotation is possible at all.
 */

import type { HullConfig, HullPlan, ShipMesh } from '../ship/voxel.ts';
import { hullConfigDamagedOpening, VoxelId } from '../ship/voxel.ts';

/** A point, in whatever frame the caller says it is. */
export interface Vec3Like {
 readonly x: number;
 readonly y: number;
 readonly z: number;
}

/** The hull's resting attitude: pitch about `x`, then bank about `z`. */
export interface FrameRotation {
 /** Nose-up rotation about the world `x` axis, in radians. */
 readonly pitch: number;
 /** Wingtip-down rotation about the world `z` axis, in radians. */
 readonly bank: number;
}

/**
 * The model transform: centered, heeled about its landing gear, and lifted
 * clear of the ice.
 *
 * The rotation is carried as the two named angles rather than as a quaternion,
 * exactly as the Rust does, and the scale is the single `VOXEL_SCALE` the
 * lattice becomes. A Babylon consumer multiplies them together itself; the
 * arithmetic that decides *where* the hull lands is here, where it can be
 * asserted.
 */
export interface ModelFrame {
 /** The resting attitude's two angles. */
 readonly rotation: FrameRotation;
 /** The lattice-to-world scale, one per axis in the Rust. */
 readonly scale: number;
 /** Where the model's own origin sits in the world. */
 readonly translation: Vec3Like;
}

/**
 * One lattice cell is one decimetre of the exterior's world.
 *
 * The interior is authored in one-metre cells on the *same* lattice — the ship
 * module says so — so this is the one number the two scenes disagree about and
 * `frameMath` is where they meet.
 */
export const MODEL_VOXEL_SCALE = 0.1;

/**
 * How far the nose rises above the tail, in radians.
 *
 * Six degrees: enough that the hull's underside and the gear below it are both
 * in view from a slightly elevated camera, and too little to disturb the
 * silhouette the voxel module generated.
 */
export const LANDING_PITCH = (6 * Math.PI) / 180;

/**
 * How far one wingtip drops below the other, in radians.
 *
 * Four degrees, about the ship's long axis. Enough to break the symmetry of a
 * level three-quarter view; small enough that the ship still reads as landed
 * rather than as turning.
 */
export const LANDING_BANK = (4 * Math.PI) / 180;

/**
 * A hair rather than nothing: how far above the ice the ship's lowest point
 * sits, in world units.
 *
 * Exactly zero would let a rounding wobble put a pad's corner through the plane,
 * and z-fight with it.
 */
export const PAD_TOUCH_CLEARANCE = 0.02;

/** The hull's resting attitude, as the two named angles it is built from. */
export function landingAttitude(): FrameRotation {
 return { pitch: LANDING_PITCH, bank: LANDING_BANK };
}

/**
 * Applies the resting attitude to `point`.
 *
 * The composition is bank about `z` first, then pitch about `x` — the order
 * `Quat::from_rotation_x(PITCH).mul_quat(Quat::from_rotation_z(BANK))` gives,
 * and the order verified against Babylon's
 * `Quaternion.RotationAxis(...).multiply(...)` in the repo's probe. It is
 * written out as the six multiplies it is rather than through a quaternion
 * object, so the arithmetic can be asserted exactly.
 */
export function rotateByAttitude(point: Vec3Like, rotation: FrameRotation): Vec3Like {
 const cosBank = Math.cos(rotation.bank);
 const sinBank = Math.sin(rotation.bank);
 const cosPitch = Math.cos(rotation.pitch);
 const sinPitch = Math.sin(rotation.pitch);

 const bankedX = point.x * cosBank - point.y * sinBank;
 const bankedY = point.x * sinBank + point.y * cosBank;

 return {
  x: bankedX,
  y: bankedY * cosPitch - point.z * sinPitch,
  z: bankedY * sinPitch + point.z * cosPitch,
 };
}

/**
 * The model's own transform of a ship-local point: scale, rotate, translate.
 *
 * Exactly `Transform::transform_point` in the Rust, in that order, so a
 * `lattice` point lands where the hull entity's own transform puts it.
 */
export function transformPoint(frame: ModelFrame, point: Vec3Like): Vec3Like {
 const scaled: Vec3Like = {
  x: point.x * frame.scale,
  y: point.y * frame.scale,
  z: point.z * frame.scale,
 };
 const rotated = rotateByAttitude(scaled, frame.rotation);
 return {
  x: rotated.x + frame.translation.x,
  y: rotated.y + frame.translation.y,
  z: rotated.z + frame.translation.z,
 };
}

/** The `x`/`y`/`z` components of a `readonly [number, number, number]`. */
export function toVec3(triple: readonly [number, number, number]): Vec3Like {
 return { x: triple[0], y: triple[1], z: triple[2] };
}

/** The distance between two points. */
export function distance(a: Vec3Like, b: Vec3Like): number {
 return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Where the ship's origin sits in the world, in world units.
 *
 * The hull is generated with its nose at low`z`, its tail at high`z`, its
 * keel at low`y`, and`x = 0` at the left wall.This pivots the model so the
  * ** keel sits above the ground plane **, the ship is centred on the world's `x`,
   * and`z` is centred on the hull's own length.
    *
 * It is computed from the plan rather than hardcoded, so a wider hull
 * re - centres itself.Height is * not * set here: it is derived from the gear once
  * the landing attitude has been applied, by[`modelTransform`].
 */
export function modelOrigin(plan: HullPlan): Vec3Like {
 return {
  x: -plan.centreX() * MODEL_VOXEL_SCALE,
  y: 0,
  z: -(plan.noseTipZ() + plan.hullTailZ()) * 0.5 * MODEL_VOXEL_SCALE,
 };
}

/**
 * The hull's length along `z`, nose tip to tail, in world units.
 *
 * Measured from the plan's own `nose_tip_z`/`hull_tail_z` rather than from the
 * meshed positions, because the engine housings project past the hull's tail and
 * the camera's standing distance is a statement about the *hull*, not about the
 * engines bolted behind it. `hullUpload.hullLength` is the mesh measure and is a
 * different quantity on purpose.
 */
export function hullLengthWorld(plan: HullPlan): number {
 return (plan.hullTailZ() - plan.noseTipZ() + 1) * MODEL_VOXEL_SCALE;
}

/**
 * The `x` that puts the world's origin under the plan's centreline.
 *
 * `modelOrigin` translates the hull by `-centre_x`, so the corrected centreline
 * is `2 * centre_x` away from the origin rather than under it.
 */
export function hullCentrelineX(plan: HullPlan): number {
 return plan.centreX() * 2.0 * MODEL_VOXEL_SCALE;
}

/**
 * The ship-local point the landing gear touches the ice with, in voxel units.
 *
 * The midpoint under the two pads: the mean of their x columns, their own row,
 * and the midpoint of their z span. Heeling the ship about here means a change
 * of attitude *rolls* the ship on its own feet instead of swinging it about a
 * corner of its bounding box.
 */
export function contactPoint(plan: HullPlan): Vec3Like {
 const pads: { readonly x: number; readonly y: number; readonly z: number }[] = [];
 for (const voxel of plan.grid.iterOccupied()) {
  if (voxel.id === VoxelId.LANDING_PAD) {
   pads.push(voxel);
  }
 }
 if (pads.length === 0) {
  return { x: 0, y: 0, z: 0 };
 }
 // Deterministic order, so the result does not depend on storage order.
 pads.sort((left, right) => left.x - right.x || left.z - right.z);
 const first = pads[0];
 const last = pads[pads.length - 1];
 if (first === undefined || last === undefined) {
  return { x: 0, y: 0, z: 0 };
 }
 let minZ = Number.POSITIVE_INFINITY;
 let maxZ = Number.NEGATIVE_INFINITY;
 for (const pad of pads) {
  if (pad.z < minZ) {
   minZ = pad.z;
  }
  if (pad.z > maxZ) {
   maxZ = pad.z;
  }
 }
 return {
  x: (first.x + last.x) * 0.5,
  y: first.y,
  z: (minZ + maxZ) * 0.5,
 };
}

/**
 * The lowest height, in world units, that any part of the ship reaches once the
 * landing attitude has been applied.
 *
 * This is the number the resting height is measured from. Heeling the ship
 * moves *everything* in it — the pads included — around the contact point, so a
 * clearance derived from the unheled lattice would surge once the pitch and bank
 * are applied, and the corner that swings down is exactly the corner a player
 * sees.
 *
 * The extras are measured as well as the hull, because they are the ship's
 * rendered extent too: the landing-pad boxes reach lower than the hull's own
 * mesh does, and it is their corners the ice is closest to.
 *
 * An empty mesh returns `PIVOT_TO_ICE` — the unmeasured fallback, which is what
 * the Rust's `ShipMesh::default()` gives it.
 */
export function lowestHeave(plan: HullPlan, hull: ShipMesh, rotation: FrameRotation): number {
 let result = Number.POSITIVE_INFINITY;
 for (const position of hull.positions) {
  const rotated = rotateByAttitude(
   { x: position[0] * MODEL_VOXEL_SCALE, y: position[1] * MODEL_VOXEL_SCALE, z: position[2] * MODEL_VOXEL_SCALE },
   rotation,
  );
  result = Math.min(result, rotated.y);
 }
 for (const extra of plan.extras) {
  const corners = extraCorners(extra);
  for (const corner of corners) {
   const rotated = rotateByAttitude(
    {
     x: corner.x * MODEL_VOXEL_SCALE,
     y: corner.y * MODEL_VOXEL_SCALE,
     z: corner.z * MODEL_VOXEL_SCALE,
    },
    rotation,
   );
   result = Math.min(result, rotated.y);
  }
 }
 if (!Number.isFinite(result)) {
  // The unmeasured fallback: an empty mesh has no extent to measure, and the
  // Rust's `ShipMesh::default()` gives exactly this height term.
  return 0;
 }
 return result;
}

/** The eight corners of an extra detail's box, in voxel units. */
export function extraCorners(extra: {
 readonly center: readonly [number, number, number];
 readonly halfExtents: readonly [number, number, number];
}): readonly Vec3Like[] {
 const center = toVec3(extra.center);
 const half = toVec3(extra.halfExtents);
 const corners: Vec3Like[] = [];
 for (const sx of [-1, 1]) {
  for (const sy of [-1, 1]) {
   for (const sz of [-1, 1]) {
    corners.push({
     x: center.x + sx * half.x,
     y: center.y + sy * half.y,
     z: center.z + sz * half.z,
    });
   }
  }
 }
 return corners;
}

/**
 * The model transform: place the ship centred, heel it about the pads it rests
 * on, and set the height that actually clears the gear.
 *
 * The three steps are separate rather than chained because they answer
 * different questions: placement centring comes from the plan, the heel is the
 * attitude, and the height is a consequence of both, *measured* by
 * [`lowestHeave]` rather than guessed. Chaining them would hide the fact that
 * the height depends on the rotation, which is precisely the dependency that
 * put a landing pad through the ice.
 */
export function modelTransform(plan: HullPlan, hull: ShipMesh): ModelFrame {
 const rotation = landingAttitude();
 // Heeling about the point the gear touches with — rather than about the
 // lattice's low-near corner or the world's origin — is what keeps the pitch
 // from swinging the nose away from the ice and the pads into it.
 const pivot: Vec3Like = {
  x: contactPoint(plan).x * MODEL_VOXEL_SCALE,
  y: contactPoint(plan).y * MODEL_VOXEL_SCALE,
  z: contactPoint(plan).z * MODEL_VOXEL_SCALE,
 };
 const rotatedPivot = rotateByAttitude(pivot, rotation);
 const origin = modelOrigin(plan);

 return {
  rotation,
  scale: MODEL_VOXEL_SCALE,
  translation: {
   x: origin.x + pivot.x - rotatedPivot.x,
   y: PAD_TOUCH_CLEARANCE - lowestHeave(plan, hull, rotation),
   z: origin.z + pivot.z - rotatedPivot.z,
  },
 };
}

/**
 * Where a hull-lattice point sits in the world, under the model's own
 * transform.
 *
 * The interior is authored in the hull's own lattice — "the airlock is at the
 * tail" is a statement about the plan, not about world units — but the exterior
 * has no lattice of its own, only the model that was rendered. A transition
 * *between* the two has to translate one into the other, and doing it here
 * rather than at the call site means the conversion cannot drift from the
 * transform the hull was actually spawned with.
 *
 * The mesh is only read for its fallback, which is what every other call site
 * does: an empty mesh is a rendering artefact with no useful geometry, and the
 * transform's height term falls back to the unmeasured extent.
 */
export function latticeToWorld(plan: HullPlan, point: Vec3Like): Vec3Like {
 const frame = modelTransform(plan, meshedHull(plan));
 return transformPoint(frame, point);
}

/** The hull's mesh, or an empty one when it refuses to mesh. */
export function meshedHull(plan: HullPlan): ShipMesh {
 try {
  return plan.mesh();
 } catch {
  // The one place the scene can fail to produce a hull is the voxel module's
  // documented `u16` vertex ceiling. An empty mesh rather than a panic is what
  // keeps a run alive: an invisible hull is a bug somebody can file.
  return { positions: [], normals: [], colors: [], voxelIds: [], indices: [], extras: [] };
 }
}

/**
 * The keel's height above the ice once the landing attitude has been applied,
 * in world units.
 *
 * The model's resting height is `lowest extent` plus the touch clearance, so the
 * keel sits however far above the ice the ship's own footprint requires. This is
 * the number both the camera and the framing reason from, so they agree with
 * what was actually placed.
 */
export function restingHeight(plan: HullPlan, hull: ShipMesh): number {
 const rotation = landingAttitude();
 const keelCorner = rotateByAttitude(
  {
   x: plan.centreX() * MODEL_VOXEL_SCALE,
   y: plan.keelY() * MODEL_VOXEL_SCALE,
   z: 0,
  },
  rotation,
 );
 return keelCorner.y - lowestHeave(plan, hull, rotation) + PAD_TOUCH_CLEARANCE;
}

/**
 * The point the gameplay camera looks at, in world units.
 *
 * Mid-ship and at the hull's own mid-height, which is what makes the horizon sit
 * behind the hull rather than through the middle of it — the framing a player
 * reads as "exterior establishing shot".
 */
export function cameraTarget(plan: HullPlan, hull: ShipMesh): Vec3Like {
 return {
  x: 0,
  y: (plan.keelY() + plan.spineY()) * 0.5 * MODEL_VOXEL_SCALE - restingHeight(plan, hull),
  z: 0,
 };
}

/** How many grid heights the standing exterior camera rises, in grid units. */
export const CAMERA_RISE_GRID_HEIGHTS = 1.35;

/** How many hull lengths the standing exterior camera sits back, on the ground. */
export const CAMERA_DISTANCE_HULLS = 1.9;

/** The standing exterior camera's azimuth, in radians. */
export const CAMERA_AZIMUTH = Math.PI / 4;

/**
 * Where the gameplay camera sits, in world units.
 *
 * Derived from the hull plan on the same lines [`modelOrigin`] is, and for the
 * same reason: a hull with different proportions re-frames itself instead of
 * silently cropping. The camera is placed `CAMERA_DISTANCE_HULLS` hull-lengths
 * of ground distance away on a `CAMERA_AZIMUTH` bearing, and
 * `CAMERA_RISE_GRID_HEIGHTS` grid-height rows above the hull's centre.
 *
 * The azimuth matters as much as the distance: port-and-forward on 45° puts the
 * flight deck, the whole length of the hull, and the port-side breach the
 * opening damage chews out in one three-quarter view.
 */
export function cameraPosition(plan: HullPlan, origin: Vec3Like, hull: ShipMesh): Vec3Like {
 const rise = CAMERA_RISE_GRID_HEIGHTS * plan.grid.height * MODEL_VOXEL_SCALE;
 const groundDistance = (CAMERA_DISTANCE_HULLS * hullLengthWorld(plan)) / Math.cos(CAMERA_AZIMUTH);
 const target = cameraTarget(plan, hull);
 return {
  // From `modelOrigin` directly, not from the model's full transform: the
  // transform's x/z pin the contact point where the origin put it, so deriving
  // the camera from the transform would shift the framing off the plan's own
  // centreline by the rotated pad offset.
  x: origin.x + hullCentrelineX(plan),
  y: target.y + rise,
  z: origin.z + groundDistance,
 };
}

/**
 * The radius of the sphere, centred on [`cameraTarget`], that contains every
 * point of the rendered hull.
 *
 * The iteration mirrors [`lowestHeave`] on purpose, including its reason: the
 * hull's *surface* is the mesh's positions, and the details the voxel module
 * adds — the canopy ahead of the nose, the engine glows behind the tail, the
 * pads under the legs — are part of what is rendered and therefore part of what
 * the camera has to stay outside of. A radius measured over the voxel surface
 * alone would let the near clamp put a pad or the canopy through the near plane,
 * which reads as "the camera is inside the ship" rather than as a visible clamp
 * failure.
 *
 * The points are brought to world space through [`modelTransform`], which is the
 * transform the hull entity itself is spawned with, rather than through
 * `VOXEL_SCALE` alone. That is not decoration: the mesh is in *lattice* space
 * and `camera_target` is in *world* space, so measuring the lattice against the
 * world mixes two frames and reports a radius that is wrong by about a factor of
 * two.
 */
export function hullBoundingRadius(plan: HullPlan, hull: ShipMesh): number {
 const centre = cameraTarget(plan, hull);
 const frame = modelTransform(plan, hull);
 let radius = 0;

 for (const position of hull.positions) {
  radius = Math.max(radius, distance(transformPoint(frame, toVec3(position)), centre));
 }

 // The eight corners of each extra box, visited the same way `lowest_heave`
 // visits them, so the two functions agree about where the rendered hull ends.
 for (const extra of plan.extras) {
  for (const corner of extraCorners(extra)) {
   radius = Math.max(radius, distance(transformPoint(frame, corner), centre));
  }
 }

 return radius;
}

/** The hull the game opens with: default proportions, opening-scene damage. */
export const OPENING_HULL_CONFIG: HullConfig = hullConfigDamagedOpening();
