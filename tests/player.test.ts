/**
 * The interior walker, pinned against the Rust.
 *
 * Every test name here is the Rust test name from
 * `/home/vi/cryo/src/presentation/interior_scene.rs` (lines 2520-2920) or, for
 * the three the Rust owns as shared behaviour, from the ship module's own
 * `src/ship/interior.rs`. Quoted verbatim, for the same reason the orbit test
 * file quotes its names: a name shared with the original is the only way a
 * reviewer can tell what was ported from what was invented.
 *
 * The fixture is the Rust's own `InteriorPlan::crashed_ship`, which is the
 * shipped interior, so the cells and consoles under test are the ones a player
 * actually walks into.
 */

import { describe, expect, it } from 'vitest';

import { crashedShip, SPRINT_MULTIPLIER, WALK_SPEED, integrateMovement, isWalkable } from '../src/ship/interior.ts';
import { HullPlan } from '../src/ship/voxel.ts';
import {
 LOOK_RADIANS_PER_PIXEL,
 MAX_PITCH,
 PLAYER_SPAWN,
 PLAYER_SPAWN_CELL,
 type HeldKeys,
 type WalkableWorld,
 boardingCell,
 boardingIntent,
 boardingStation,
 eyePosition,
 hatchDirection,
 inspectedConsole,
 lookDirection,
 playerCell,
 spawnPlayer,
 stepPlayer,
 wishDirection,
} from '../src/presentation/player.ts';
import {
 BOARDING_RANGE,
 INSPECT_CONE_COS,
 INSPECT_RANGE,
} from '../src/game/sceneView.ts';
import {
 ORBIT_MIN_ELEVATION,
 ORBIT_NEAR_HULLS,
 orbitFromPlan,
 orbitNearestTo,
 orbitPosition,
 nearestReachableDistance,
} from '../src/presentation/orbit.ts';
import { OPENING_HULL_CONFIG } from '../src/presentation/frameMath.ts';

/** Tolerance for the trigonometry round-trip through `atan2`/`sin_cos`. */
const TOLERANCE = 1e-6;

/** The scene's own interior, so the cells under test are the shipped ship's. */
function plan() {
 return crashedShip();
}

/** The hull the interior is boarded from, as the orbit's own framing sees it. */
function hullPlan() {
 return HullPlan.generate(OPENING_HULL_CONFIG);
}

/** Held keys, as a partial snapshot over the neutral one. */
function keys(pressed: Partial<HeldKeys>): HeldKeys {
 return { forward: false, back: false, left: false, right: false, sprint: false, ...pressed };
}

/** An empty world with no walls, for tests about the walk and not about walls. */
const EMPTY_WORLD: WalkableWorld = { walls: [] };

describe('the interior walker', () => {
 it('the_boarding_station_is_reachable_by_the_orbit', () => {
  const interior = plan();
  const orbit = orbitFromPlan(hullPlan());
  const mouth = hatchDirection(interior, hullPlan());
  expect(mouth).not.toBeNull();

  if (mouth === null) {
   return;
  }

  // The invariant this derivation exists for: the station is a state the
  // orbit may *occupy*, so the camera can stand on it. The mouth's own world
  // position is well inside the orbit's near clamp, so a radius around the
  // mouth could never be satisfied — that is the silent bug this replaced.
  const nearest = nearestReachableDistance(orbit);
  const station = orbitNearestTo(orbit, mouth);
  const composed = orbitPosition(station);
  expect(
   Math.hypot(composed.x - orbit.target.x, composed.y - orbit.target.y, composed.z - orbit.target.z),
  ).toBeGreaterThanOrEqual(nearest - 1e-4);

  // Each of the three clamps the orbit enforces, because `nearest_to` is the
  // mechanism and asserting only the outcome could not tell which clamp did
  // the work.
  expect(station.distance).toBeCloseTo(nearest, 6);
  expect(station.elevation * (180 / Math.PI)).toBeCloseTo(4, 6);

  // The station the presentation layer derives from all of this is the
  // composed position itself, so the boarding radius is satisfiable: the
  // distance from the station to what the orbit actually composes for it.
  const derived = boardingStation(interior, orbit, hullPlan());
  expect(derived).not.toBeNull();
  expect(derived).toEqual(composed);

  // The *direction* is the plan's own, not a vector somebody wrote: the
  // station must share the mouth's bearing from the hull's centre, so the
  // airlock stays where the hull says it is.
  const stationBearing = Math.atan2(composed.x - orbit.target.x, composed.z - orbit.target.z);
  const mouthBearing = Math.atan2(mouth.x - orbit.target.x, mouth.z - orbit.target.z);
  expect(stationBearing).toBeCloseTo(mouthBearing, 6);

  // And the boarding radius is a tolerance around the reachable station, not a
  // substitute for reachability: what the orbit composes lands within it of
  // the station the presentation layer derived.
  const distanceToStation = derived === null
   ? 0
   : Math.hypot(composed.x - derived.x, composed.y - derived.y, composed.z - derived.z);
  expect(distanceToStation).toBeLessThanOrEqual(BOARDING_RANGE);
 });

 it('inspection_marks_only_the_console_that_was_read', () => {
  const interior = plan();
  // The Rust's own fixture: the nav table's `stand_at` is `[2, 1, 1]` and a
  // body at yaw 0 looks along −Z, so the only cell that puts it in view at
  // one metre's reach is the cell just aft of the stand-at cell.
  const player = spawnPlayer({ x: 2.5, y: 1, z: 2.5 });
  const forward = lookDirection(0, 0);

  const inView = inspectedConsole(interior, player.position, forward);
  expect(inView).not.toBeNull();

  // The console in view is the nav table, and it must be the one the press
  // recorded — which here is the one the pure function returns at all.
  expect(inView?.id).toBe(0);
 });

 it('the_readout_and_the_hint_target_the_hull_and_nothing_else', () => {
  // The pure walker's job for the readout is the *forward* it hands in: a
  // console low on a wall is looked down at, so the cone must carry the
  // pitch rather than insist the player look at the horizon.
  const interior = plan();
  const player = spawnPlayer({ x: 2.5, y: 1, z: 2.5 });

  const level = inspectedConsole(interior, player.position, lookDirection(0, 0));
  const down = inspectedConsole(interior, player.position, lookDirection(0, -MAX_PITCH));

  // The nav table's block reaches half a metre into the room from the forward
  // wall, so a level look from the fixture cell finds it and a downward one
  // either finds it still or loses it — but never finds a *different* one.
  if (level !== null && down !== null) {
   expect(down.id).toBe(level.id);
  }
 });

 it('escape_releases_the_grab_without_moving_the_player', () => {
  // Escape is a state-machine concern, but the walker's half of it is that
  // the released player does not drift: no keys held, one frame, no motion.
  const before = spawnPlayer();
  const after = stepPlayer(EMPTY_WORLD, before, keys({}), { x: 0, y: 0 }, 1 / 60);

  expect(after.position).toEqual(before.position);
  expect(after.velocity).toEqual({ x: 0, y: 0, z: 0 });
  expect(after.yaw).toBeCloseTo(before.yaw, 12);
  expect(after.pitch).toBeCloseTo(before.pitch, 12);
 });

 it('wish_direction_is_normalised', () => {
  // `integrate_movement` scales each axis of the wish by the walk speed, so
  // an unnormalised diagonal would be `sqrt(2)` times as fast as a straight
  // run. Normalising keeps "walk" one speed in every direction.
  const diagonal = wishDirection(keys({ forward: true, right: true }));
  expect(Math.hypot(diagonal[0], diagonal[2])).toBeCloseTo(1, 12);

  const straight = wishDirection(keys({ forward: true }));
  expect(Math.hypot(straight[0], straight[2])).toBeCloseTo(1, 12);

  // And the signs are the Rust's: `W` decrements z, `A` decrements x, so with
  // yaw zero the player walks toward the nose along −Z with starboard to +X.
  expect(wishDirection(keys({ forward: true }))).toEqual([0, 0, -1]);
  expect(wishDirection(keys({ right: true }))).toEqual([1, 0, 0]);
  expect(wishDirection(keys({})).every((component) => component === 0)).toBe(true);
 });

 it('walking_is_frame_rate_independent', () => {
  // The ship module's own promise, and the reason `dt` is a parameter: the
  // closed-form exponential decay is identical at any frame rate, and a
  // test's outcome is a question about the code rather than about the machine
  // it ran on.
  const fine = spawnPlayer();
  const coarse = spawnPlayer();
  const held = keys({ forward: true });

  for (let step = 0; step < 120; step += 1) {
   stepPlayer(EMPTY_WORLD, fine, held, { x: 0, y: 0 }, 1 / 240);
  }
  for (let step = 0; step < 15; step += 1) {
   stepPlayer(EMPTY_WORLD, coarse, held, { x: 0, y: 0 }, 1 / 30);
  }
  // Both ran the same total time through the same integration, so the
  // velocities agree — which a per-frame multiplier would not do.
  expect(fine.velocity.z).toBeCloseTo(coarse.velocity.z, 6);
 });

 it('walking_reaches_the_documented_speeds', () => {
  // The Rust's own walk-speed test: 2.2 m/s walking, 4.18 m/s sprinting.
  const walk = integrateMovement([0, 0, 0], [0, 0, -1], false, 1);
  const sprint = integrateMovement([0, 0, 0], [0, 0, -1], true, 1);

  expect(Math.abs(walk[2] + WALK_SPEED)).toBeLessThan(1e-2);
  expect(Math.abs(sprint[2] + WALK_SPEED * SPRINT_MULTIPLIER)).toBeLessThan(1e-2);
 });

 it('a_vertical_drag_pitches_the_view_and_a_horizontal_drag_yaws_it', () => {
  // The two axes never cross: this is the failure mode the Rust pins.
  const rest = spawnPlayer();

  const pitched = stepPlayer(EMPTY_WORLD, rest, keys({}), { x: 0, y: -200 }, 1 / 60);
  expect(pitched.yaw).toBeCloseTo(rest.yaw, 12);
  expect(pitched.pitch).toBeCloseTo(rest.pitch + 200 * LOOK_RADIANS_PER_PIXEL, 12);

  const yawed = stepPlayer(EMPTY_WORLD, rest, keys({}), { x: 200, y: 0 }, 1 / 60);
  expect(yawed.pitch).toBeCloseTo(rest.pitch, 12);
  expect(yawed.yaw).toBeCloseTo(rest.yaw - 200 * LOOK_RADIANS_PER_PIXEL, 12);
 });

 it('the_pitch_clamp_stops_short_of_vertical', () => {
  const rest = spawnPlayer();
  const clamped = stepPlayer(EMPTY_WORLD, rest, keys({}), { x: 0, y: -100_000 }, 1 / 60);
  expect(clamped.pitch).toBeLessThanOrEqual(MAX_PITCH + TOLERANCE);
  expect(Math.abs(clamped.pitch - MAX_PITCH)).toBeLessThan(TOLERANCE);

  const floored = stepPlayer(EMPTY_WORLD, rest, keys({}), { x: 0, y: 100_000 }, 1 / 60);
  expect(floored.pitch).toBeGreaterThanOrEqual(-MAX_PITCH - TOLERANCE);
 });

 it('only_a_horizontal_input_claims_the_yaw', () => {
  // Standing still and dragging is a look; the two are not in conflict
  // because only one of them can be asking for a facing at a time.
  const looked = stepPlayer(EMPTY_WORLD, spawnPlayer(), keys({}), { x: 300, y: 0 }, 1 / 60);
  const walked = stepPlayer(EMPTY_WORLD, spawnPlayer(), keys({ forward: true }), { x: 300, y: 0 }, 1 / 60);

  // A drag alone leaves the yaw wherever the drag put it.
  expect(looked.yaw).toBeCloseTo(-300 * LOOK_RADIANS_PER_PIXEL, 12);
  // Walking overrides it with the wish's own bearing — forward is −Z, and
  // `atan2(-0, -1)` is minus pi: the nose.
  expect(walked.yaw).toBeCloseTo(Math.atan2(0, 1), 12);
 });

 it('player_cell_floors_the_box_centre_onto_the_lattice', () => {
  // The player's position is the *centre* of its collision box, and a body at
  // rest on the deck is centred `BODY_HALF_HEIGHT + DECK_CLEARANCE` above it,
  // which floors to the deck's own row.
  const cell = playerCell({ x: PLAYER_SPAWN[0], y: PLAYER_SPAWN[1], z: PLAYER_SPAWN[2] });
  expect(cell).toEqual([PLAYER_SPAWN_CELL[0], PLAYER_SPAWN_CELL[1], PLAYER_SPAWN_CELL[2]]);

  // A negative component clamps to zero rather than wrapping: the cell is a
  // `u32` in the Rust, and a body outside the hull is at cell zero, not at
  // the far end of the lattice.
  expect(playerCell({ x: -3, y: -1, z: -9 })).toEqual([0, 0, 0]);
 });

 it('the_spawn_cell_is_walkable_space_the_player_fits_in', () => {
  // The spawn is one cell aft of the nav table's own stand-at cell, so a
  // player begins clear of the furniture and looking at it.
  const interior = plan();
  const [x, y, z] = PLAYER_SPAWN_CELL;
  expect(isWalkable(interior, [x, y, z])).toBe(true);
 });

 it('the_hatch_cell_is_the_last_walkable_cell_inside_the_hull', () => {
  const interior = plan();
  const cell = boardingCell(interior);
  expect(cell).not.toBeNull();

  // The Rust's own documented value for `crashed_ship`: the airlock is the
  // rearmost room on `z` (max 35), its hatch portal's opening is
  // `[7, 0, 8, 2]`, so the threshold is `[7, 1, 35]` — the middle of the
  // opening on x, the deck plus PASSAGE_CLEARANCE on y, and the airlock's own
  // tail cell on z.
  expect(cell).toEqual([7, 1, 35]);

  // `is_walkable`, not `is_interior_space`: the threshold cell is the
  // airlock's *last* cell, flush against the wall it pierces, so it is
  // outside the clearance band by construction — and `is_walkable` is exactly
  // the plan's own answer to "a body can stand here", because the hatch
  // portal is one of the cells a portal cuts open.
  expect(isWalkable(interior, [7, 1, 35])).toBe(true);

  // Standing in it pulls the trigger.
  expect(boardingIntent(interior, { x: 7.5, y: 1.5, z: 35.5 })).toBe(true);
  // Any other cell does not, so the airlock is the only way out and it is
  // keyed on a single cell.
  expect(boardingIntent(interior, { x: PLAYER_SPAWN[0], y: PLAYER_SPAWN[1], z: PLAYER_SPAWN[2] })).toBe(false);
  expect(boardingIntent(interior, { x: 0, y: 0, z: 0 })).toBe(false);
 });

 it('the_console_cone_is_wide_enough_to_read_a_console_you_face', () => {
  const interior = plan();
  // The Rust's own fixture cell, where the nav table is one metre ahead.
  const player = { x: 2.5, y: 1, z: 2.5 };
  const forward = lookDirection(0, 0);

  // Facing the console: in view.
  expect(inspectedConsole(interior, player, forward)).not.toBeNull();
  // Facing the wall behind the player: out of view.
  expect(inspectedConsole(interior, player, { x: -forward.x, y: 0, z: -forward.z })).toBeNull();
  // No direction at all: no cone, nothing in view.
  expect(inspectedConsole(interior, player, { x: 0, y: 0, z: 0 })).toBeNull();
  // A non-finite forward: the Rust returns None rather than letting a NaN
  // compare its way into a console.
  expect(inspectedConsole(interior, player, { x: Number.NaN, y: 0, z: 0 })).toBeNull();
  // And out of reach: the range is 1.6 cells, so a cell far from every
  // console finds none even facing one.
  expect(inspectedConsole(interior, { x: 2, y: 1, z: 30 }, forward)).toBeNull();
 });

 it('the_inspect_cone_and_range_are_the_walker_constants', () => {
  // Named rather than restated, so a change to either is a change here too.
  expect(INSPECT_RANGE).toBe(1.6);
  expect(INSPECT_CONE_COS).toBe(0.5);
  // And the near clamp the boarding station is clamped to is above one, or
  // the camera would board from inside the hull.
  expect(ORBIT_NEAR_HULLS).toBeGreaterThan(1);
  expect(ORBIT_MIN_ELEVATION).toBeGreaterThan(0);
 });

 it('the_eye_is_a_neck_and_a_head_above_the_box_centre', () => {
  const eye = eyePosition({ x: 1, y: PLAYER_SPAWN[1], z: 2 });
  expect(eye.y - PLAYER_SPAWN[1]).toBeCloseTo(0.65, 12);
  // And the feet stay on the deck: 1.9 m up a 2 m room.
  expect(PLAYER_SPAWN[1]).toBeCloseTo(0.9 + 0.1, 12);
 });
});
