/**
 * The interior walker: where the player is, which way they are looking, and
 * which console they can reach.
 *
 * A faithful port of the walk half of the Rust
 * `src/presentation/interior_scene.rs` — `wish_direction`, `Player`,
 * `walk_player`'s arithmetic, `player_cell` and `inspection_forward` — kept
 * Babylon-free so a null-renderer test can exercise boarding and console
 * selection with no canvas at all.
 *
 * Every number below is either one the ship layer already owns (so this file
 * imports it rather than redeclaring it and drifting) or one the Rust's interior
 * scene owns as a private constant and it quotes.
 *
 * Nothing here reads a clock and nothing here reads a held-key singleton: the
 * key snapshot is a parameter, which is what makes the walker's frame-rate
 * independence a testable property rather than a hope.
 */

import type { CollisionResult } from '../ship/interior.ts';
import {
 integrateMovement,
 nearestConsoleInView,
 resolveCollision,
 type Console,
 type InteriorPlan,
} from '../ship/interior.ts';
import type { Vec3Like } from './frameMath.ts';
import { latticeToWorld } from './frameMath.ts';
import type { ShipOrbit } from './orbit.ts';
import { orbitNearestTo, orbitPosition } from './orbit.ts';
import { INSPECT_CONE_COS, INSPECT_RANGE } from '../game/sceneView.ts';

/** How far above the player's centre the eye sits, in world units. */
export const EYE_HEIGHT = 0.65;

/** How far the body is held off the deck plane, in world units. */
export const DECK_CLEARANCE = 0.1;

/** Half the body's height: the distance from the box's centre to its soles. */
export const BODY_HALF_HEIGHT = 0.9;

/** The cell the player starts in: the cockpit, behind the nav table. */
export const PLAYER_SPAWN_CELL: readonly [number, number, number] = [2, 1, 3];

/** Where the player starts, in world units. */
export const PLAYER_SPAWN: readonly [number, number, number] = [
 PLAYER_SPAWN_CELL[0] + 0.5,
 BODY_HALF_HEIGHT + DECK_CLEARANCE,
 PLAYER_SPAWN_CELL[2] + 0.5,
];

/** How fast a drag turns the view, in radians per pixel. */
export const LOOK_RADIANS_PER_PIXEL = 0.005;

/** How far the view can tilt up or down, in radians. */
export const MAX_PITCH = (85 * Math.PI) / 180;

/** Held-key snapshot the walker consumes. Keystroke events are not its input. */
export interface HeldKeys {
 readonly forward: boolean;
 readonly back: boolean;
 readonly left: boolean;
 readonly right: boolean;
 readonly sprint: boolean;
}

/** No keys held: the neutral snapshot every rest test is written against. */
export const NO_KEYS: HeldKeys = {
 forward: false,
 back: false,
 left: false,
 right: false,
 sprint: false,
};

/** The player's whole state: box centre, velocity, and the view's two angles. */
export interface PlayerBody {
 /** The centre of the player's collision box, in world units. */
 readonly position: Vec3Like;
 /** The player's velocity, in world units per second. */
 readonly velocity: Vec3Like;
 /** The view's heading, in radians. Zero faces the nose. */
 readonly yaw: number;
 /** The view's tilt, in radians. Positive looks up. */
 readonly pitch: number;
}

/** A player standing at `position`, at rest, facing the nose. */
export function spawnPlayer(position?: Vec3Like): PlayerBody {
 return {
  position: position ?? { x: PLAYER_SPAWN[0], y: PLAYER_SPAWN[1], z: PLAYER_SPAWN[2] },
  velocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
 };
}

/**
 * The held keys, as a normalised horizontal wish.
 *
 * The `wish` indices are the world axes — `wish[0]` is x, `wish[2]` is z — and
 * the Rust's signs are kept: `W` *decrements* z and `A` *decrements* x, so with
 * yaw zero the player walks toward the nose along −Z with starboard to +X. That
 * is the convention the Rust's `Player::direction` is written against
 * (`forward = [-sin, 0, -cos]`), and this function is the one that has to agree
 * with it.
 *
 * Normalised, so a diagonal is one speed rather than `sqrt(2)` of one.
 */
export function wishDirection(keys: HeldKeys): readonly [number, number, number] {
 const wish: [number, number, number] = [0, 0, 0];
 if (keys.forward) {
  wish[2] -= 1;
 }
 if (keys.back) {
  wish[2] += 1;
 }
 if (keys.left) {
  wish[0] -= 1;
 }
 if (keys.right) {
  wish[0] += 1;
 }

 // Only the horizontal axes carry a wish: the player cannot fly, so the
 // vertical component of the velocity is what `integrate_movement` damps to
 // zero and what `resolve_collision` never displaces.
 const length = Math.hypot(wish[0], wish[2]);
 if (length > 1) {
  wish[0] /= length;
  wish[2] /= length;
 }
 return wish;
}

/**
 * The view direction for a yaw and a pitch.
 *
 * Written out as the three trig lines it is rather than assembled from a
 * quaternion, exactly as the Rust does it, so a test can compare the forward
 * with an exact expected vector and so the two cannot drift apart.
 */
export function lookDirection(yaw: number, pitch: number): Vec3Like {
 const sin = Math.sin(yaw);
 const cos = Math.cos(yaw);
 const pitchSin = Math.sin(pitch);
 const pitchCos = Math.cos(pitch);
 return { x: -pitchCos * sin, y: pitchSin, z: -pitchCos * cos };
}

/**
 * The player after `dt` seconds of held-key walking and looking.
 *
 * The order is the Rust's, and every step of it is load-bearing:
 *
 * 1. The view is dragged by `look`, with the pitch clamped short of vertical.
 *    `looking_at` needs a forward that is not parallel to the world's up axis,
 *    and a view past vertical is one the player cannot recover with the gesture
 *    that got them there.
 * 2. The ship layer integrates the wish into the velocity. `dt` is handed in,
 *    which is what keeps the walk frame-rate independent.
 * 3. The ship layer resolves the whole frame's displacement against the wall
 *    boxes at once, and hands back the velocity with the blocked axis zeroed.
 * 4. Only a *horizontal* input claims the yaw, and it claims it from the wish
 *    rather than from the drag. Standing still and dragging is a look; the two
 *    are not in conflict because only one of them can be asking for a facing.
 */
export function stepPlayer(
 world: WalkableWorld,
 player: PlayerBody,
 keys: HeldKeys,
 look: { readonly x: number; readonly y: number },
 dt: number,
): PlayerBody {
 const dragged = dragLook(player, look);
 const wish = wishDirection(keys);

 // The ship module's own integration, with the dt handed to it.
 const velocity = integrateMovement(toTriple(dragged.velocity), wish, keys.sprint, dt);

 // Then the ship module's own collision, resolving the *whole* frame's
 // displacement at once rather than a step per axis.
 const step: readonly [number, number, number] = [velocity[0] * dt, velocity[1] * dt, velocity[2] * dt];
 const resolved: CollisionResult = resolveCollision(
  toTriple(dragged.position),
  step,
  velocity,
  world.walls,
 );

 const stepped: PlayerBody = {
  position: { x: resolved.position[0], y: resolved.position[1], z: resolved.position[2] },
  velocity: { x: resolved.velocity[0], y: resolved.velocity[1], z: resolved.velocity[2] },
  yaw: dragged.yaw,
  pitch: dragged.pitch,
 };

 if (wish[0] !== 0 || wish[2] !== 0) {
  return { ...stepped, yaw: Math.atan2(-wish[0], -wish[2]) };
 }
 return stepped;
}

/** The view angles after a drag of `look` pixels. */
function dragLook(player: PlayerBody, look: { readonly x: number; readonly y: number }): PlayerBody {
 return {
  ...player,
  yaw: player.yaw - look.x * LOOK_RADIANS_PER_PIXEL,
  // Clamped short of vertical, as the Rust does, and for the same two
  // reasons: `looking_at` needs a forward that is not parallel to the world's
  // up axis, and a view past vertical is one the player cannot recover from
  // with the same gesture that got them there.
  pitch: Math.min(Math.max(player.pitch - look.y * LOOK_RADIANS_PER_PIXEL, -MAX_PITCH), MAX_PITCH),
 };
}

/** The lattice cell the player's body occupies. */
export function playerCell(position: Vec3Like): readonly [number, number, number] {
 // The player's position is the *centre* of its collision box, and the ship
 // module's own tests are written against cells, so the two are bridged here:
 // the cell a player stands in is the box centre floored onto the lattice. A
 // body at rest on the deck is centred `BODY_HALF_HEIGHT + DECK_CLEARANCE`
 // above it, which floors to the deck's own row.
 //
 // `Math.max(0, ...)` then a truncation, which is exactly the Rust's
 // `max(0.0) as u32`: clamp-then-truncate, not truncate-then-clamp. The order
 // matters for a coordinate between -1 and 0, where truncating first would
 // give cell zero from a body below the deck.
 return [
  Math.max(0, Math.trunc(position.x)),
  Math.max(0, Math.trunc(position.y)),
  Math.max(0, Math.trunc(position.z)),
 ];
}

/**
 * The console the player is looking at, or null when none is in view.
 *
 * The ship layer owns the cone arithmetic and this adds nothing to it: the
 * `forward` carries the pitch, because a console low on a wall is looked down
 * at, and a cone that ignored the tilt would insist the player look at the
 * horizon to read something at chest height.
 */
export function inspectedConsole(plan: InteriorPlan, position: Vec3Like, forward: Vec3Like): Console | null {
 if (
  !Number.isFinite(forward.x) ||
  !Number.isFinite(forward.y) ||
  !Number.isFinite(forward.z) ||
  Math.hypot(forward.x, forward.y, forward.z) <= 0
 ) {
  // No direction, no cone: nothing is in view.
  return null;
 }
 const cell = playerCell(position);
 const id = nearestConsoleInView(
  plan,
  [cell[0], cell[1], cell[2]],
  [forward.x, forward.y, forward.z],
  INSPECT_RANGE,
  INSPECT_CONE_COS,
 );
 return plan.consoles.find((console) => console.id === id) ?? null;
}

/** The eye's position: the box centre plus a neck and a head. */
export function eyePosition(position: Vec3Like): Vec3Like {
 return { x: position.x, y: position.y + EYE_HEIGHT, z: position.z };
}

/** The wall boxes the interior is built from, as the ship layer measures them. */
export interface WalkableWorld {
 /** Axis-separated boxes, in the ship layer's own `[low, high]` pairs. */
 readonly walls: readonly (readonly [readonly [number, number, number], readonly [number, number, number]])[];
}

/** A `Vec3Like` as the triple the ship layer's functions take. */
function toTriple(value: Vec3Like): [number, number, number] {
 return [value.x, value.y, value.z];
}

/** The cell the player must stand in to board: the inside of the airlock hatch. */
export function boardingCell(plan: InteriorPlan): readonly [number, number, number] | null {
 return hatchInteriorCell(plan);
}

/**
 * The lattice cell on the inside of the hull's own hatch.
 *
 * Every part of it is derived from the plan rather than chosen, exactly as in
 * the Rust: which room is the airlock, which axis its hatch pierces, and the
 * opening that pierces it with. The `y` is `min[1] + PASSAGE_CLEARANCE` because
 * a body in a boundary row is a body inside the wall, not in the room; the
 * hatch's own axis takes the airlock's last cell because that is the last cell
 * a player can walk to inside the hull.
 */
export function hatchInteriorCell(plan: InteriorPlan): readonly [number, number, number] | null {
 const airlock = plan.rooms.find((room) => room.name === 'Airlock');
 const hatch = plan.portals.find((portal) => portal.from === 'exterior' || portal.to === 'exterior');
 if (airlock === undefined || hatch === undefined) {
  return null;
 }

 // The one axis on which the airlock stands clear of every other room. The
 // portal's own `from`/`to` names say nothing about direction — the exterior
 // has no box — so the airlock's position in the plan is the only thing that
 // does.
 const others = plan.rooms.filter((room) => room.name !== 'Airlock');
 const axis = [0, 1, 2].find((axis) => {
  const airlockMin = airlock.min[axis];
  const airlockMax = airlock.max[axis];
  if (airlockMin === undefined || airlockMax === undefined) {
   return false;
  }
  const beyondMax = others.every((room) => airlockMax > (room.max[axis] ?? 0));
  const beyondMin = others.every((room) => airlockMin < (room.min[axis] ?? 0));
  return beyondMax || beyondMin;
 });
 if (axis === undefined) {
  return null;
 }

 // The opening's own coordinates on the two axes the wall does not sit on, in
 // ascending order — the same pair `Portal::opening_axes` returns. The hatch
 // spans its width on `u` and its height on `v`, so the threshold cell is the
 // middle of the `u` span and the wall's own cell. For this plan the hatch axis
 // is `z`, so `u` is `x`.
 const u = axis === 2 ? 0 : 1;
 const uMid = Math.floor(((hatch.opening[0] ?? 0) + (hatch.opening[2] ?? 0)) / 2);
 const cell: [number, number, number] = [0, 0, 0];
 cell[u] = uMid;
 cell[1] = (airlock.min[1] ?? 0) + 1;
 cell[axis] = airlock.max[axis] ?? 0;
 return cell;
}

/** Whether the player stands in the one cell the airlock transition is keyed on. */
export function boardingIntent(plan: InteriorPlan, position: Vec3Like): boolean {
 const cell = boardingCell(plan);
 if (cell === null) {
  return false;
 }
 const standing = playerCell(position);
 return standing[0] === cell[0] && standing[1] === cell[1] && standing[2] === cell[2];
}

/**
 * The hatch mouth's world position, as a *direction* from the hull's centre.
 *
 * Kept separate from [`boardingStation`] because the two answer different
 * questions: this is where the airlock is, which is a fact about the plan and
 * is what the hull's own geometry says; that is where the camera has to stand
 * to board it, which is a fact about the orbit. The direction comes from the
 * airlock's own cell, one cell further out along the hatch's own axis, lifted
 * to the mid-height of the opening so a player standing there is looking at the
 * hatch rather than at the ice under it.
 */
export function hatchDirection(plan: InteriorPlan, hullPlan: { readonly mesh: () => unknown }): Vec3Like | null {
 const airlock = plan.rooms.find((room) => room.name === 'Airlock');
 const hatch = plan.portals.find((portal) => portal.from === 'exterior' || portal.to === 'exterior');
 const inner = hatchInteriorCell(plan);
 if (airlock === undefined || hatch === undefined || inner === null) {
  return null;
 }

 // The same axis test as `hatchInteriorCell`, and for the same reason: the
 // exterior has no box, so the airlock's own position in the plan is what says
 // which way the hatch faces.
 const others = plan.rooms.filter((room) => room.name !== 'Airlock');
 const axis = [0, 1, 2].find((axis) => {
  const airlockMin = airlock.min[axis];
  const airlockMax = airlock.max[axis];
  if (airlockMin === undefined || airlockMax === undefined) {
   return false;
  }
  const beyondMax = others.every((room) => airlockMax > (room.max[axis] ?? 0));
  const beyondMin = others.every((room) => airlockMin < (room.min[axis] ?? 0));
  return beyondMax || beyondMin;
 });
 if (axis === undefined) {
  return null;
 }

 // One cell past the wall on the hatch's own axis: the first cell of vacuum,
 // at the height and the width the opening was written at. For this plan the
 // hatch axis is `z`, so `u` is `x`.
 const u = axis === 2 ? 0 : 1;
 const cell: [number, number, number] = [inner[0] ?? 0, inner[1] ?? 0, inner[2] ?? 0];
 cell[axis] = (cell[axis] ?? 0) + 1;
 cell[u] = Math.floor((hatch.opening[0] + hatch.opening[2]) / 2);

 // The interior lattice and the hull's are the same lattice, so a cell in one
 // is a cell in the other, and the world position comes from the hull's own
 // model transform.
 return latticeToWorld(hullPlan as Parameters<typeof latticeToWorld>[0], { x: cell[0], y: cell[1], z: cell[2] });
}

/**
 * Where the exterior camera has to stand to board, in world units.
 *
 * The mouth's direction with the orbit's own clamps applied on top: the station
 * is where the orbit *may* stand, not where the geometry would put it.
 * `nearest_to` keeps the mouth's own bearing and merely pulls it in to the
 * closest legal position.
 *
 * `null` when the plan has no hatch, which the ship layer's own `validate`
 * rejects; the caller treats that as "boarding is unavailable" rather than as an
 * error, because a scene with no hatch is one the player cannot enter through
 * this path and there is nothing useful to panic about.
 */
export function boardingStation(
 plan: InteriorPlan,
 orbit: ShipOrbit,
 hullPlan: { readonly mesh: () => unknown },
): Vec3Like | null {
 const mouth = hatchDirection(plan, hullPlan);
 if (mouth === null) {
  return null;
 }
 const nearest = orbitNearestTo(orbit, mouth);
 const composed = orbitPosition(nearest);
 if (!Number.isFinite(composed.x) || !Number.isFinite(composed.y) || !Number.isFinite(composed.z)) {
  return null;
 }
 return composed;
}
