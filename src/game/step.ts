/**
 * The declared frame order, ported from the Rust's plugin wiring.
 *
 * A Bevy frame is a schedule: `Update` runs the gameplay systems in the order
 * they were registered, and `StateTransition` runs afterwards and applies any
 * `NextState` a system queued. That ordering is not a detail — it is the reason
 * a transition takes **zero steps on the request frame and one on the next**,
 * and it is what `docs/testing.md` calls "transition frame semantics".
 *
 * This module is that schedule, spelled out. `stepFrame` is a pure function of
 * its arguments: it takes the state the frame enters with, the input for this
 * frame, the two inbound view ports and the phase length, and it returns what
 * changed. Nothing reads a clock, nothing allocates a frame's worth of state it
 * did not ask for, and no system can run twice because there is no duplicate
 * schedule label to run it.
 *
 * The four phases, in order:
 *
 * 1. **input** — turn `pressed` into edges. A key held across two frames is
 *    `pressed` on only the first, which is the whole one-shot behaviour. The
 *    presentation layer's `InputTracker` owns the edge detection; this phase
 *    only asks what the edges mean.
 * 2. **transitions** — the `StateTransition` schedule: apply the request the
 *    *previous* frame's systems queued, before this frame's systems run.
 * 3. **systems** — the `Update` schedule, in the Rust's own registration order.
 * 4. **render-sync** — the `PostUpdate` schedule: the frame's camera placement.
 *    Nothing here can request a transition, exactly as in Bevy.
 */

import type { InteriorPlan } from '../ship/interior.ts';
import { INSPECT_RANGE, INSPECT_CONE_COS, BOARDING_RANGE, distance } from './sceneView.ts';
import type { SceneViews } from './sceneView.ts';
import { HIDDEN_READOUT } from './interiorProgress.ts';
import type { ReadoutState } from './interiorProgress.ts';
import { InteriorProgress } from './interiorProgress.ts';
import { advancesSimulation, GAME_STATE_HANDLERS } from './state.ts';
import type { GameState } from './state.ts';
import { resolveTransition, START_KEYS } from './transitions.ts';
import { nearestConsoleInView, inAirlock } from '../ship/interior.ts';

/** The phases of one frame, in the order they run. */
export const FRAME_PHASES = ['input', 'transitions', 'systems', 'render-sync'] as const;

/** One phase of a frame. */
export type FramePhase = (typeof FRAME_PHASES)[number];

/**
 * Every system the game layer runs, in the Rust's own registration order.
 *
 * The Rust registers `advance_simulation_system` from the game plugin, and then
 * the presentation systems in this order:
 * `update_status_text` (Exterior), `start_game_system` (Title),
 * `walk_player`, `inspect_console`, `update_readout`, `recapture_if_defocused`,
 * `close_readout`, `release_grab_on_escape`, `airlock_transition`,
 * `board_the_hull` (Exterior), `capture_hint`.
 *
 * The walking, camera, cursor and hint systems all render or own the body, so
 * they are the presentation layer's; the ones that *decide* something the state
 * machine or the session changes are here, in the order they run.
 */
export const SYSTEM_ORDER = [
 'advance-simulation',
 'inspect-console',
 'close-readout',
 'airlock-transition',
 'board-the-hull',
 'start',
] as const;

/** One system the game layer runs. */
export type GameSystem = (typeof SYSTEM_ORDER)[number];

/** A frame of input: what is held, what went down this frame, and how long it is. */
export interface FrameInput {
 /** The keys that went down this frame. One-shot edges. */
 readonly pressed: readonly string[];
 /** The keys currently held down. A per-frame snapshot, not an edge. */
 readonly held: readonly string[];
 /** How long this frame is, in seconds. Always supplied, never read from anywhere. */
 readonly dt: number;
}

/** Everything one frame of the game layer can change. */
export interface FrameEffects {
 /** The state the game is in after this frame. */
 readonly state: GameState;
 /** The transition this frame's systems requested, applied next frame. */
 readonly requested: GameState | null;
 /** The readout after this frame. */
 readonly readout: ReadoutState;
 /** The console progress after this frame. */
 readonly progress: InteriorProgress;
}

/** The live game: a state, a simulation handle, progress, and the scenes. */
export interface GameFlow {
 /** The state the game is in right now. */
 state: GameState;
 /** The transition queued for the next frame. */
 requested: GameState | null;
 /** Which consoles the player has read. */
 readonly progress: InteriorProgress;
 /** Whether the readout is up, and on what. */
 readout: ReadoutState;
}

/** Whether `keys` contains a start key, as one intent. */
function wantsStart(pressed: readonly string[]): boolean {
 return pressed.some((key) => START_KEYS[key] === true);
}

/**
 * The one step per frame the exterior takes.
 *
 * Port of `advance_simulation_system`, which is gated `in_state(Exterior)` and
 * calls `advance_single_step` once. It is the *only* place where the simulation
 * clock is driven by the frame loop, and it takes a fixed step rather than a
 * frame delta — absorbing frame-rate variation here, rather than in every rule,
 * is what makes the simulation's behaviour frame-rate independent. `advance` is
 * passed in rather than reached for, so the step count a test observes is the
 * step count this function asked for.
 */
function advanceSimulationSystem(advance: () => void, state: GameState): void {
 if (advancesSimulation(state)) {
  advance();
 }
}

/**
 * `KeyE` reads the console in front of the player.
 *
 * Port of `inspect_console`. `just_pressed` rather than `pressed`: a press held
 * for a second must not open a hundred readouts, and the input state is cleared
 * by the engine once per frame.
 *
 * The miss case is the interesting one. Nothing in view: the press is spent and
 * the readout is **hidden**, because leaving the panel open would keep showing
 * the *last* console the player read rather than closing, which is
 * indistinguishable from a readout that never updated.
 */
function inspectConsoleSystem(
 flow: GameFlow,
 input: FrameInput,
 plan: InteriorPlan,
 views: SceneViews,
): void {
 if (!input.pressed.includes('KeyE')) {
  return;
 }
 const interior = views.interior;
 if (interior === null) {
  return;
 }
 const cell = interior.getPlayerCell();
 const forward = interior.getPlayerForward();
 const id = nearestConsoleInView(plan, cell, forward, INSPECT_RANGE, INSPECT_CONE_COS);
 if (id === null) {
  flow.readout = HIDDEN_READOUT;
  return;
 }
 flow.progress.inspect(id);
 flow.readout = { visible: true, consoleId: id };
}

/**
 * `Escape` closes the readout. Nothing else.
 *
 * Port of `close_readout`. It is deliberately *not* the way out of the interior:
 * the airlock is, and a second exit on a key the player already uses for "close
 * this panel" would make leaving the hull an accident. The asymmetry is the
 * point — "get this out of my way" and "get me out of here" are different
 * requests.
 */
function closeReadoutSystem(flow: GameFlow, input: FrameInput): void {
 if (!input.pressed.includes('Escape')) {
  return;
 }
 flow.readout = HIDDEN_READOUT;
}

/**
 * One `KeyE` in the airlock leaves the hull for the exterior.
 *
 * Port of `airlock_transition`. The guard is a distance/place test, not "some
 * other system already handled this", because "the transition is refused while a
 * console is in view" is a rule a test can state, while "whichever system ran
 * first wins" is not a rule at all.
 *
 * The one interaction with `inspect_console` is resolved by the console *not*
 * being reachable from the airlock: the shipped plan puts no console in that
 * room, so `nearest_console_in_view` returns `null` from anywhere `in_airlock`
 * is true. The belt to that plan's braces is written anyway, here, as the
 * console-in-view test.
 */
function airlockTransitionSystem(
 flow: GameFlow,
 input: FrameInput,
 plan: InteriorPlan,
 views: SceneViews,
): void {
 if (!input.pressed.includes('KeyE')) {
  return;
 }
 const interior = views.interior;
 if (interior === null) {
  return;
 }
 const cell = interior.getPlayerCell();
 if (!inAirlock(plan, cell)) {
  return;
 }
 const forward = interior.getPlayerForward();
 if (nearestConsoleInView(plan, cell, forward, INSPECT_RANGE, INSPECT_CONE_COS) !== null) {
  return;
 }
 flow.requested = resolveTransition('interior', 'exit-hull');
}

/**
 * One `KeyE` at the hull's own hatch, from outside, goes back inside.
 *
 * Port of `board_the_hull`. Measured from the camera and not from a player body
 * because the exterior has no player entity — the orbit camera is the only thing
 * in the exterior that stands somewhere, and its position is the closest thing
 * the exterior has to a viewpoint worth boarding from.
 *
 * The band is a radius around the boarding station rather than a distance to a
 * plane, because the exterior's only input is a drag and a zoom: a player
 * orbiting the hull can approach the hatch from any bearing, and a sphere around
 * the station admits every one of them while a band along one axis would admit
 * one. Its width is a tolerance around a point the orbit can already stand on,
 * not a substitute for standing on it.
 */
function boardTheHullSystem(
 flow: GameFlow,
 input: FrameInput,
 views: SceneViews,
): void {
 if (!input.pressed.includes('KeyE')) {
  return;
 }
 const exterior = views.exterior;
 if (exterior === null) {
  return;
 }
 const station = exterior.getBoardingStation();
 if (station === null) {
  return;
 }
 if (distance(exterior.getCameraPosition(), station) > BOARDING_RANGE) {
  return;
 }
 flow.requested = resolveTransition('exterior', 'board');
}

/**
 * The title screen's only system.
 *
 * Port of `start_game_system`. Both inputs are observed in one place on purpose:
 * two systems that both wrote a transition would make "was a start requested?"
 * depend on system ordering, and a single system that observes both makes the
 * rule explicit — any of these inputs, at most once per frame.
 *
 * The primary guard against a second transition is the run condition: the
 * system does not run outside `title`. `set_if_different` — here
 * `resolveTransition`, which also drops a request for the state the game is
 * already in — is the belt to that braces.
 */
function startSystem(flow: GameFlow, input: FrameInput): void {
 if (!wantsStart(input.pressed)) {
  return;
 }
 flow.requested = resolveTransition('title', 'start');
}

/**
 * Pauses and resumes.
 *
 * The Rust has no such system: `Paused` is declared and unreachable, which the
 * architecture records as deliberate. This module keeps that declaration, keeps
 * the state ordered and labelled, and keeps the clock inert in it — and then
 * makes it reachable, because the port's requirement is that pause works.
 * Nothing but this function requests it, and the only key that can is `KeyP`,
 * since `Escape` is the readout's and `KeyE` is the hull's.
 */
function pauseSystem(flow: GameFlow, input: FrameInput): void {
 if (!input.pressed.includes('KeyP')) {
  return;
 }
 flow.requested = flow.state === 'paused' ? resolveTransition('paused', 'resume') : resolveTransition(flow.state, 'pause');
}

/**
 * Runs one frame.
 *
 * The four phases, in order, against the state the frame enters with. Returns
 * the resulting state and the transition the *next* frame will apply — the
 * caller owns both, because the frame boundary is where they are written.
 */
export function stepFrame(
 flow: GameFlow,
 input: FrameInput,
 plan: InteriorPlan,
 views: SceneViews,
 advance: () => void,
): FrameEffects {
 // (2) transitions, before anything else in the frame can look at the state.
 flow.state = flow.requested ?? flow.state;
 flow.requested = null;

 // (3) systems, in the registration order above, but only the state's own.
 for (const system of GAME_STATE_HANDLERS[flow.state].systems) {
  switch (system) {
   case 'advance-simulation':
    advanceSimulationSystem(advance, flow.state);
    break;
   case 'inspect-console':
    inspectConsoleSystem(flow, input, plan, views);
    break;
   case 'close-readout':
    closeReadoutSystem(flow, input);
    break;
   case 'airlock-transition':
    airlockTransitionSystem(flow, input, plan, views);
    break;
   case 'board-the-hull':
    boardTheHullSystem(flow, input, views);
    break;
   case 'start':
    startSystem(flow, input);
    break;
  }
 }

 // Pause is a cross-state key that no state's own system list owns, so it runs
 // after them: the order among the state's systems is the Rust's, and this
 // cannot preempt one of them because no state's system list contains it.
 pauseSystem(flow, input);

 // (4) render-sync. The game layer produces no geometry; the frame's camera
 // placement is the presentation layer's read of `flow.state`, which is why
 // this phase is declared and empty here rather than absent.

 return {
  state: flow.state,
  requested: flow.requested,
  readout: flow.readout,
  progress: flow.progress,
 };
}
