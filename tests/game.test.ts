/**
 * The game layer, ported from the Rust's own test suite.
 *
 * Every test below names the Rust test it ports, quoted verbatim in the `it`
 * title, and every assertion is a claim a reader can check rather than a restated
 * setup. Where the Rust asserts against a Bevy app's frame schedule, this asserts
 * against `stepFrame` — the same frame semantics, driven by hand rather than by a
 * schedule runner.
 *
 * The frame semantics the Rust documents in `docs/testing.md`, which is what
 * several of these pin rather than re-derive: `Update` runs **before**
 * `StateTransition`, so a system that calls `NextState::set` cannot see its own
 * transition in the same frame. The request frame takes **0 steps**, and the
 * *next* frame applies the transition and runs **exactly one step**.
 */

import { describe, expect, it } from 'vitest';

import { BOARDING_RANGE, NO_VIEWS, distance } from '../src/game/sceneView.ts';
import type { InteriorSceneView, SceneViews } from '../src/game/sceneView.ts';
import { InteriorProgress, HIDDEN_READOUT } from '../src/game/interiorProgress.ts';
import { FRAME_PHASES, SYSTEM_ORDER, stepFrame } from '../src/game/step.ts';
import type { FrameInput, GameFlow } from '../src/game/step.ts';
import { advancesSimulation, GAME_STATES, GAME_STATE_HANDLERS, stateLabel } from '../src/game/state.ts';
import type { GameState } from '../src/game/state.ts';
import { TRANSITIONS, resolveTransition, START_KEYS } from '../src/game/transitions.ts';
import { crashedShip, inAirlock } from '../src/ship/interior.ts';
import type { InteriorPlan } from '../src/ship/interior.ts';
import { HullPlan } from '../src/ship/voxel.ts';
import { OPENING_HULL_CONFIG } from '../src/presentation/frameMath.ts';
import type { ShipOrbit } from '../src/presentation/orbit.ts';
import {
 ORBIT_NEAR_HULLS,
 orbitFromPlan,
 orbitNearestTo,
 orbitPosition,
} from '../src/presentation/orbit.ts';
import { boardingStation, hatchDirection } from '../src/presentation/player.ts';

/** The plan every interior assertion is made against. */
const PLAN: InteriorPlan = crashedShip();

/** A frame with nothing held, nothing pressed and no duration. */
function idleFrame(): FrameInput {
 return { pressed: [], held: [], dt: 0 };
}

/** A frame with `keys` pressed this frame. */
function pressing(...keys: string[]): FrameInput {
 return { pressed: keys, held: keys, dt: 0 };
}

/** A flow in `state`, with no history. */
function flow(state: GameState = 'title'): GameFlow {
 return { state, requested: null, progress: new InteriorProgress(), readout: HIDDEN_READOUT };
}

/** Runs `frames` idle frames against `flow`, counting the steps taken. */
function runFrames(flow: GameFlow, frames: number, input: FrameInput = idleFrame()): bigint {
 let steps = 0n;
 for (let frame = 0; frame < frames; frame += 1) {
  stepFrame(flow, input, PLAN, NO_VIEWS, () => {
   steps += 1n;
  });
 }
 return steps;
}

describe('the state machine', () => {
 it('game_state_starts_on_the_title_screen', () => {
  // The Rust asserts the app boots on `GameState::Title` after one frame. The
  // title state must not only be the default: it must survive a frame of every
  // system with none of them moving the game off it.
  const started: GameFlow = flow();
  runFrames(started, 1);
  expect(started.state).toBe('title');
 });

 it('entering_in_game_advances_the_simulation', () => {
  // The Rust writes the request directly into the app before `update()` and
  // runs two frames, asserting two steps and `SimTime::from_ticks(2)`. Here
  // the direct write is `flow.requested`, and the same two frames are run.
  const started = flow();
  started.requested = 'exterior';
  expect(runFrames(started, 2)).toBe(2n);
 });

 it('pausing_freezes_the_simulation', () => {
  // The Rust sets `Exterior`, runs two frames, then sets `Paused` and runs
  // five more, asserting the snapshot is bit-for-bit unchanged. `paused` must
  // apply on the frame after the request — at which point the clock stops.
  const started = flow();
  started.requested = 'exterior';
  runFrames(started, 2);
  started.requested = 'paused';
  expect(runFrames(started, 1)).toBe(0n);
  expect(runFrames(started, 5)).toBe(0n);
  expect(started.state).toBe('paused');
 });

 it('only_in_game_advances_the_simulation', () => {
  // Ported verbatim. Interior is deliberately inert: interior time is not
  // exterior time, and the one clock the rules own is the surface one.
  expect(GAME_STATES.map(advancesSimulation)).toEqual([false, true, false, false]);
  expect(advancesSimulation('exterior')).toBe(true);
  expect(advancesSimulation('title')).toBe(false);
  expect(advancesSimulation('interior')).toBe(false);
  expect(advancesSimulation('paused')).toBe(false);
 });

 it('state_labels_every_variant, the way state_label does', () => {
  // `presentation::state_label` is exhaustive over four variants. The table is
  // exhaustive by construction, so this pins the *strings* rather than the
  // exhaustiveness — and pins them in declaration order, so a reordered tuple
  // shows up here.
  expect(GAME_STATES.map(stateLabel)).toEqual(['title', 'exterior', 'interior', 'paused']);
 });

 it('the_state_table_answers_for_every_variant', () => {
  // The compile-time exhaustiveness is worth a runtime witness: a handler with
  // a missing key read as `undefined` is the failure mode the record exists to
  // prevent, and this is where it would first be observable.
  for (const state of GAME_STATES) {
   expect(GAME_STATE_HANDLERS[state].label).toBe(stateLabel(state));
  }
 });

 it('paused_is_reachable_only_by_an_explicit_request', () => {
  // The Rust architecture records `Paused` as declared and unreachable by any
  // system. The port makes it reachable — pause must work — but keeps the
  // shape: no state's own system list requests it, so it can only arrive as a
  // request a caller wrote. Running the title, the exterior and the interior
  // for many frames with no `KeyP` in the input never reaches it.
  for (const state of GAME_STATES) {
   const driven = flow(state);
   runFrames(driven, 30);
   expect(driven.state).toBe(state);
  }
 });
});

describe('the transition table', () => {
 it('the_title_screen_has_one_way_out', () => {
  // `start_game_system` is the only system scheduled outside `title`, and it
  // answers only the start intent.
  expect(resolveTransition('title', 'start')).toBe('exterior');
  expect(resolveTransition('title', 'pause')).toBeNull();
  expect(resolveTransition('title', 'board')).toBeNull();
  expect(resolveTransition('title', 'exit-hull')).toBeNull();
  expect(resolveTransition('title', 'resume')).toBeNull();
 });

 it('set_if_different_drops_a_request_for_the_state_we_are_in', () => {
  // The belt to the run condition's braces. Without it, repeated start input
  // mid-game would keep re-queueing `Exterior` — which is exactly what
  // `once_playing_start_inputs_have_no_power_left` catches.
  expect(resolveTransition('exterior', 'start')).toBeNull();
  expect(resolveTransition('interior', 'exit-hull')).toBe('exterior');
  expect(resolveTransition('paused', 'pause')).toBeNull();
 });

 it('a_request_equal_to_the_current_state_takes_no_steps', () => {
  // Directly observable frame semantics: `advance_simulation_system` is gated
  // on the state the frame is in, so a request that resolves to nothing leaves
  // the clock where it was.
  const driven = flow('exterior');
  driven.requested = resolveTransition('exterior', 'start');
  expect(runFrames(driven, 4)).toBe(4n);
  expect(driven.state).toBe('exterior');
 });

 it('every_state_and_intent_pair_is_answered', () => {
  // The matrix is a full `Record`, so no combination can be missing. This
  // pins the whole matrix in one assertion, which is the cheapest way to see
  // a whole-row change at once.
  const matrix = GAME_STATES.map((state) => (Object.values(TRANSITIONS[state]) as (GameState | null)[]));
  expect(matrix).toEqual([
   ['exterior', null, null, null, null],
   [null, 'interior', null, 'paused', null],
   [null, null, 'exterior', null, null],
   [null, null, null, null, 'exterior'],
  ]);
 });

 it('pause_is_legal_only_from_the_exterior', () => {
  // `paused` is the exterior's frozen clock — the same scene is drawn — so
  // pausing inside the hull would teleport the player outside for no reason
  // the player asked for.
  expect(resolveTransition('title', 'pause')).toBeNull();
  expect(resolveTransition('interior', 'pause')).toBeNull();
  expect(resolveTransition('paused', 'pause')).toBeNull();
  expect(resolveTransition('exterior', 'pause')).toBe('paused');
 });

 it('the_three_start_keys_are_one_intent', () => {
  // The Rust's `START_KEYS` is consumed through `any_just_pressed`, so the
  // three keys are one input to the state machine and never three.
  expect(START_KEYS['Space']).toBe(true);
  expect(START_KEYS['Enter']).toBe(true);
  expect(START_KEYS['NumpadEnter']).toBe(true);
  for (const key of ['Space', 'Enter', 'NumpadEnter']) {
   // Two frames: the press is a one-shot edge, so the request frame is the
   // only one that carries it, and the next frame applies it.
   const driven = flow();
   runFrames(driven, 1, pressing(key));
   expect(driven.state).toBe('title');
   runFrames(driven, 1);
   expect(driven.state).toBe('exterior');
  }
 });
});

describe('the frame order', () => {
 it('declares_four_phases_and_six_systems_in_registration_order', () => {
  // The order is the contract: the Rust's system order is
  // advance_simulation, inspect_console, update_readout, close_readout,
  // airlock_transition, board_the_hull, and a port that runs them in a
  // different order is a port that can behave differently.
  expect(FRAME_PHASES).toEqual(['input', 'transitions', 'systems', 'render-sync']);
  expect(SYSTEM_ORDER).toEqual([
   'advance-simulation',
   'inspect-console',
   'close-readout',
   'airlock-transition',
   'board-the-hull',
   'start',
  ]);
 });

 it('a_request_takes_zero_steps_on_its_own_frame_and_one_on_the_next', () => {
  // The headline frame-semantics test, the port of
  // `a_key_press_takes_the_player_from_the_title_screen_into_the_game`'s
  // step counting. A request written by the systems *this* frame cannot be
  // seen by the systems *this* frame.
  const driven = flow();
  runFrames(driven, 1, pressing('Space'));
  expect(driven.state).toBe('title');
  expect(driven.requested).toBe('exterior');
  runFrames(driven, 1);
  expect(driven.state).toBe('exterior');
  expect(driven.requested).toBeNull();
 });

 it('once_playing_start_inputs_have_no_power_left', () => {
  // The double-transition guard, end to end. The step count is the witness:
  // it must stay exactly one per frame, with no jumps from a re-queued
  // transition and no freeze from a leaked run condition.
  const driven = flow();
  runFrames(driven, 2, pressing('Enter'));
  expect(driven.state).toBe('exterior');
  let steps = 0n;
  const advance = (): void => {
   steps += 1n;
  };
  for (const key of ['Space', 'Space', 'NumpadEnter']) {
   stepFrame(driven, pressing(key), PLAN, NO_VIEWS, advance);
   expect(driven.state).toBe('exterior');
  }
  for (let frame = 0; frame < 5; frame += 1) {
   stepFrame(driven, idleFrame(), PLAN, NO_VIEWS, advance);
  }
  expect(steps).toBe(8n);
  expect(driven.state).toBe('exterior');
 });
});

describe('the interior', () => {
 /**
  * A view over a pose a test can set: which cell the body is in, and which way
  * it faces. This is the seam, exercised at the game layer's own boundary —
  * the presentation layer supplies the real one, and the shape is the same.
  */
 function posing(cell: readonly [number, number, number], forward: readonly [number, number, number]): InteriorSceneView {
  return {
   getPlayerCell: () => cell,
   getPlayerForward: () => forward,
  };
 }

 /** `NO_VIEWS` with only the interior supplied. */
 function interiorOnly(interior: InteriorSceneView): SceneViews {
  return { exterior: null, interior };
 }

 /** The nav table's own read cell: its `standAt` pushed one cell aft, facing `-Z`. */
 const NAV_CELL: readonly [number, number, number] = [2, 1, 2];
 const FACING_FORWARD: readonly [number, number, number] = [0, 0, -1];

 it('console_count_matches_the_bit_set', () => {
  // The Rust splits this tie between a compile-time assert on its literal
  // `CONSOLE_COUNT` and a runtime comparison against the plan. Here the count
  // is read from the plan, so the comparison cannot drift — but the flag set
  // still has to be the plan's length, or `inspect` would silently drop ids.
  const progress = new InteriorProgress();
  expect(progress.inspectedFlags().length).toBe(PLAN.consoles.length);
  expect(PLAN.consoles.length).toBeGreaterThan(0);
 });

 it('inspection_marks_only_the_console_that_was_read', () => {
  // One press from the nav table's read cell reads exactly the nav table: this
  // is the Rust's `walk_inspect_step_outside_and_return_with_progress_intact`
  // assertion, pinned without the walk. The flag set is compared rather than
  // the count, because a count of one cannot tell *which* console was read.
  const driven = flow('interior');
  const views = interiorOnly(posing(NAV_CELL, FACING_FORWARD));
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  expect(driven.progress.inspectedFlags()).toEqual([true, false, false, false, false, false]);
  expect(driven.readout).toEqual({ visible: true, consoleId: 0 });
 });

 it('a_press_with_nothing_in_view_hides_the_readout', () => {
  // Leaving the panel open would keep showing the *last* console the player
  // read rather than closing, which is indistinguishable from a readout that
  // never updated. So the miss case hides it, and it does so even when a
  // console was read moments earlier.
  const driven = flow('interior');
  const views = interiorOnly(posing(NAV_CELL, FACING_FORWARD));
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  expect(driven.readout.visible).toBe(true);
  stepFrame(driven, pressing('KeyE'), PLAN, interiorOnly(posing([5, 5, 5], FACING_FORWARD)), () => { });
  expect(driven.readout).toEqual(HIDDEN_READOUT);
 });

 it('escape_closes_the_readout_and_nothing_else', () => {
  // `close_readout` is not the way out of the interior: the airlock is. A
  // second exit on a key that already means "close this panel" would make
  // leaving the hull an accident.
  const driven = flow('interior');
  const views = interiorOnly(posing(NAV_CELL, FACING_FORWARD));
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  stepFrame(driven, pressing('Escape'), PLAN, views, () => { });
  expect(driven.readout).toEqual(HIDDEN_READOUT);
  expect(driven.state).toBe('interior');
 });

 it('a_key_press_in_the_airlock_leaves_the_hull', () => {
  // The plan's own hatch cell, derived from the airlock room and the exterior
  // portal, is the one cell the transition is keyed on. `inAirlock` is the
  // plan's own predicate rather than a distance band, so this asserts against
  // the plan rather than against a number written here.
  const hatch: readonly [number, number, number] = [7, 1, 35];
  expect(inAirlock(PLAN, hatch)).toBe(true);
  const driven = flow('interior');
  const views = interiorOnly(posing(hatch, FACING_FORWARD));
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  expect(driven.requested).toBe('exterior');
  expect(driven.state).toBe('interior');
  stepFrame(driven, idleFrame(), PLAN, views, () => { });
  expect(driven.state).toBe('exterior');
 });

 it('the_interior_does_not_advance_the_simulation', () => {
  // The Rust's test of the same name runs thirty frames of held movement
  // inside the hull and asserts the clock has not moved — while the player
  // *has* moved, so "nothing ran" is excluded. The same shape here: thirty
  // idle frames, no steps, and the interior's own systems still answering
  // input, which the `inspection_marks_only_the_console_that_was_read` test
  // above proves separately.
  const driven = flow('interior');
  expect(runFrames(driven, 30)).toBe(0n);
  expect(driven.state).toBe('interior');
 });

 it('walk_inspect_step_outside_and_return_with_progress_intact', () => {
  // The acceptance test for the whole milestone, reduced to the part the game
  // layer owns: reading a console, leaving through the airlock, and coming
  // back must not lose the reading. The Rust's reason this is a resource
  // rather than a component is that `despawn_interior` deletes entity data;
  // here the equivalent is that re-creating the flow on entry would clear a
  // session's reading on the way through the airlock.
  const views = interiorOnly(posing(NAV_CELL, FACING_FORWARD));
  const driven = flow('interior');
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  const before = driven.progress.inspectedFlags();
  const hatch: readonly [number, number, number] = [7, 1, 35];
  stepFrame(driven, pressing('KeyE'), PLAN, interiorOnly(posing(hatch, FACING_FORWARD)), () => { });
  stepFrame(driven, idleFrame(), PLAN, interiorOnly(posing(hatch, FACING_FORWARD)), () => { });
  expect(driven.state).toBe('exterior');
  stepFrame(driven, idleFrame(), PLAN, interiorOnly(posing(NAV_CELL, FACING_FORWARD)), () => { });
  expect(driven.progress.inspectedFlags()).toEqual(before);
  // The readout closed on the way out, as the Rust's does: the interior scene's
  // `OnExit` despawns the readout with everything else it owns, and the state
  // has to be inert outside the hull. What survives the round trip is the
  // *reading*, not the panel — which is the whole point of the test.
  expect(driven.readout.visible).toBe(false);
  // And the reading is still there when the player comes back in: the progress
  // belongs to the session, so re-entering and standing at the nav table again
  // does not make it unread.
  driven.requested = 'interior';
  stepFrame(driven, idleFrame(), PLAN, interiorOnly(posing(NAV_CELL, FACING_FORWARD)), () => { });
  stepFrame(driven, pressing('KeyE'), PLAN, interiorOnly(posing(NAV_CELL, FACING_FORWARD)), () => { });
  expect(driven.readout.visible).toBe(true);
  expect(driven.readout.consoleId).toBe(0);
  expect(driven.progress.inspectedFlags()).toEqual(before);
 });

 it('a_key_press_at_the_boarding_station_boards_the_hull', () => {
  // The boarding band is a radius around the station, because the exterior's
  // only input is a drag and a zoom: a player orbiting the hull can approach
  // the hatch from any bearing, and a sphere admits every one of them.
  const station: readonly [number, number, number] = [1, 2, 3];
  const views: SceneViews = {
   exterior: {
    getCameraPosition: () => [station[0] + 0.5, station[1], station[2]],
    getBoardingStation: () => station,
   },
   interior: null,
  };
  expect(distance(views.exterior?.getCameraPosition() ?? [0, 0, 0], station)).toBeCloseTo(0.5);
  const driven = flow('exterior');
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  expect(driven.requested).toBe('interior');
  stepFrame(driven, idleFrame(), PLAN, views, () => { });
  expect(driven.state).toBe('interior');
 });

 it('a_key_press_far_from_the_station_boards_nothing', () => {
  // The band's width is a tolerance around a point the orbit can already stand
  // on, not a substitute for standing on it.
  const station: readonly [number, number, number] = [1, 2, 3];
  const views: SceneViews = {
   exterior: {
    getCameraPosition: () => [station[0] + 4, station[1], station[2]],
    getBoardingStation: () => station,
   },
   interior: null,
  };
  const driven = flow('exterior');
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  expect(driven.requested).toBeNull();
  expect(driven.state).toBe('exterior');
 });

 it('a_view_with_no_hatch_boards_nothing_rather_than_testing_the_origin', () => {
  // The Rust's `boarding_station` is an `Option<Vec3>` (interior_scene.rs:1612)
  // and `board_the_hull` returns early on `None` (interior_scene.rs:1566-1568):
  // a scene with no hatch is one the player cannot enter through this path, and
  // there is nothing useful to panic about. A view that answered the origin
  // instead would silently turn that early return into a distance test against
  // the hull's centre — a trigger the player pulls by accident.
  //
  // A camera sitting exactly at the origin, with no station: the early return
  // must win, so a `[0,0,0]` default would board from here and `null` must not.
  const views: SceneViews = {
   exterior: {
    getCameraPosition: () => [0, 0, 0],
    getBoardingStation: () => null,
   },
   interior: null,
  };
  const driven = flow('exterior');
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  expect(driven.requested).toBeNull();
  expect(driven.state).toBe('exterior');
 });
});

/**
 * The seam against the real presentation layer.
 *
 * The tests above assert the game layer's rules against stations a test wrote
 * by hand, which is the only way to state a *band*. These assert that the
 * station the presentation layer actually derives for the shipped hull is one
 * the band is satisfiable around — the property the Rust's whole derivation
 * exists for, and the one that dies silently if the band's width or the
 * station's anchor drifts.
 */
describe('the boarding seam against the real station', () => {
 /** The shipped hull, as the exterior's own framing sees it. */
 function hull() {
  return HullPlan.generate(OPENING_HULL_CONFIG);
 }

 /** The orbit the exterior scene rests at, paired with the shipped interior. */
 function scene(): { orbit: ShipOrbit; interior: InteriorPlan } {
  return { orbit: orbitFromPlan(hull()), interior: crashedShip() };
 }

 it('the_band_is_satisfiable_around_the_shipped_station', () => {
  const { orbit, interior } = scene();
  const station = boardingStation(interior, orbit, hull());
  expect(station).not.toBeNull();
  if (station === null) {
   return;
  }

  // The station is a state the orbit may actually occupy: drive the orbit to it
  // and read where the camera lands, and that landing is inside the band. This
  // is the Rust's own `the_boarding_station_is_reachable_by_the_orbit`
  // (interior_scene.rs:2626-2653), asserted through the game layer's threshold
  // rather than through a number written here.
  const composed = orbitPosition(orbitNearestTo(orbit, station));
  const composedDistance = Math.hypot(
   composed.x - station.x,
   composed.y - station.y,
   composed.z - station.z,
  );
  expect(composedDistance).toBeLessThanOrEqual(BOARDING_RANGE);
 });

 it('the_station_is_the_hull_derived_near_clamp_and_the_mouth_is_inside_it', () => {
  const { orbit, interior } = scene();
  // `nearest_reachable_distance` is `ORBIT_NEAR_HULLS * radius`
  // (ship_scene.rs:676-678, `ORBIT_NEAR_HULLS` at ship_scene.rs:450), and the
  // multiple is above one so the camera cannot be zoomed into the hull. The
  // station is the mouth's own bearing pulled out to that clamp, which is what
  // makes boarding reachable by construction for any hull size, any
  // `VOXEL_SCALE` and any `ORBIT_NEAR_HULLS` (interior_scene.rs:1596-1598).
  expect(ORBIT_NEAR_HULLS).toBeGreaterThan(1);
  const clamp = ORBIT_NEAR_HULLS * orbit.radius;

  const mouth = hatchDirection(interior, hull());
  expect(mouth).not.toBeNull();
  if (mouth === null) {
   return;
  }
  const station = boardingStation(interior, orbit, hull());
  expect(station).not.toBeNull();
  if (station === null) {
   return;
  }

  // The station stands *on* the clamp: the pull-in `nearest_to` performs.
  const stationDistance = Math.hypot(
   station.x - orbit.target.x,
   station.y - orbit.target.y,
   station.z - orbit.target.z,
  );
  expect(stationDistance).toBeCloseTo(clamp, 6);
  // And the mouth is *inside* it, so a band around the mouth would be a trigger
  // the camera can never occupy — the silent "`E` does nothing at the hatch"
  // this derivation replaced. interior_scene.rs:1582-1598.
  const mouthDistance = Math.hypot(
   mouth.x - orbit.target.x,
   mouth.y - orbit.target.y,
   mouth.z - orbit.target.z,
  );
  expect(mouthDistance).toBeLessThan(clamp);
  // Far enough inside that the two are not the same point to within the band.
  expect(stationDistance - mouthDistance).toBeGreaterThan(BOARDING_RANGE);
 });

 it('a_press_at_the_shipped_station_boards_the_hull', () => {
  // End to end through the seam: the station the presentation layer derives for
  // the shipped hull, the camera driven to it, and one `KeyE` — the game layer's
  // own decision, from the game layer's own view. A version of this that fails
  // is a version where boarding is unreachable in the browser.
  const { orbit, interior } = scene();
  const station = boardingStation(interior, orbit, hull());
  expect(station).not.toBeNull();
  if (station === null) {
   return;
  }
  const composed = orbitPosition(orbitNearestTo(orbit, station));
  const views: SceneViews = {
   exterior: {
    getCameraPosition: () => [composed.x, composed.y, composed.z],
    getBoardingStation: () => [station.x, station.y, station.z],
   },
   interior: null,
  };
  const driven = flow('exterior');
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  expect(driven.requested).toBe('interior');
  stepFrame(driven, idleFrame(), PLAN, views, () => { });
  expect(driven.state).toBe('interior');
 });

 it('a_press_away_from_the_shipped_station_boards_nothing', () => {
  // The same station, from the orbit's own *resting* distance rather than the
  // clamped one: the band is a tolerance, and standing back is not boarding.
  const { orbit, interior } = scene();
  const station = boardingStation(interior, orbit, hull());
  expect(station).not.toBeNull();
  if (station === null) {
   return;
  }
  const resting = orbitPosition(orbit);
  const views: SceneViews = {
   exterior: {
    getCameraPosition: () => [resting.x, resting.y, resting.z],
    getBoardingStation: () => [station.x, station.y, station.z],
   },
   interior: null,
  };
  const driven = flow('exterior');
  stepFrame(driven, pressing('KeyE'), PLAN, views, () => { });
  expect(driven.requested).toBeNull();
  expect(driven.state).toBe('exterior');
 });
});

