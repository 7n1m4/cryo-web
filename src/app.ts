/**
 * The startup seam.
 *
 * `build(platform, initialState)` is the only entry point a platform calls, and
 * the only place an engine is touched. It exists so the same code builds the
 * game in a browser, in a headless test, and in the dev harness, with the
 * renderer passed in rather than reached for — so a test that has no canvas
 * gets a working game rather than a crash on a null engine.
 *
 * The pure layers are constructed here and never import anything from
 * Babylon; the presentation layer is constructed here and never runs in a test.
 */

import type { AbstractEngine, Scene } from '@babylonjs/core/pure.js';

import { crashedShip } from './ship/interior.ts';
import type { InteriorPlan } from './ship/interior.ts';
import { hullConfigDamagedOpening, HullPlan, meshHull } from './ship/voxel.ts';
import type { ShipMesh } from './ship/voxel.ts';
import { Seed, Simulation } from './sim/simulation.ts';
import type { TransitionError } from './sim/simulation.ts';
import type { InputState } from './presentation/inputTypes.ts';
import { registerBabylon } from './presentation/babylon.ts';
import { formatHudStatus, setHudText } from './presentation/hud.ts';
import { InteriorProgress } from './game/interiorProgress.ts';
import { stepFrame } from './game/step.ts';
import type { FrameInput, GameFlow } from './game/step.ts';
import { INITIAL_GAME_STATE } from './game/state.ts';
import type { GameState as FlowGameState } from './game/state.ts';
import { NO_VIEWS } from './game/sceneView.ts';
import type { SceneViews } from './game/sceneView.ts';
import { mountTitle, setTitleVisible } from './title.ts';
import { consumeStartClick } from './title.ts';

/** What a platform supplies. A renderer, and nothing else. */
export interface Platform {
 /** The engine, or `null` in a test. */
 readonly engine: AbstractEngine | null;
 /** The scene, or `null` in a test. */
 readonly scene: Scene | null;
}

/** Which screen the game is showing. */
export type GameState = Exclude<FlowGameState, 'paused'>;

/**
 * The flow state, as the display surface names it.
 *
 * `paused` is the exterior's own frozen clock — the same scene is drawn, the same
 * camera stands where it stood — so the screen a paused game shows is the
 * exterior's. The projection says so rather than inventing a fourth display
 * label the HUD does not have; `flow.state` remains the authoritative answer and
 * names `paused` for anything that needs it.
 */
function displayState(state: FlowGameState): GameState {
 return state === 'paused' ? 'exterior' : state;
}

/** The state the game opens with. */
export interface InitialState {
 /** The seed the simulation starts from. Default: `Seed.default()`. */
 readonly seed?: bigint;
 /** The state the game opens on. Default: `title`. */
 readonly state?: GameState;
}

/** The built application. */
export interface CryoApp {
 /** The simulation, pure and engine-free. */
 readonly simulation: Simulation;
 /** Which screen the game is showing. */
 state: GameState;
 /**
  * The game flow: the four-state machine, the consoles read and the readout.
  *
  * `flow.state` is the authoritative state, including `paused`, which the
  * exported `GameState` above deliberately does not name — that union is the
  * display surface the HUD's own label function is written against, and
  * widening it would break the HUD rather than the game. Everything that needs
  * the paused state reads it here.
  */
 readonly flow: GameFlow;
 /** Advances the simulation by `steps`, returning any error. */
 advanceSimulation(steps: bigint): TransitionError | null;
 /** Consumes one frame of input, returning the new state. */
 handleFrame(input: InputState): GameState;
 /** The HUD line for the current state. */
 hudText(): string;
 /** The hull mesh, meshed once and reused. */
 readonly hullMesh: ShipMesh;
}

/**
 * Builds the game.
 *
 * Returns a fully usable app with or without a renderer. The presentation half is
 * skipped when `platform.scene` is null, which is the headless case; the
 * simulation half is identical either way.
 *
 * `views` is the seam to the scenes the game drives: the exterior's orbit camera
 * and the interior's player body. It defaults to `NO_VIEWS` so a headless build
 * and the dev harness pass nothing, and a build with no views still runs every
 * system — the boarding and inspect triggers simply find no scene to ask.
 */
export function build(
 platform: Platform,
 initialState: InitialState = {},
 views: SceneViews = NO_VIEWS,
): CryoApp {
 // The engine extensions are installed before anything builds a scene, and
 // here rather than in `main.ts` because a headless `build` still constructs
 // scenes and would otherwise run on an engine whose prototype methods are not
 // attached yet. See `presentation/babylon.ts` for why that is the one call the
 // `/pure` import path demands.
 registerBabylon();

 const seed = initialState.seed ?? Seed.default().getValue();
 const simulation = Simulation.genesis(Seed.new(seed));

 const hull = HullPlan.generate(hullConfigDamagedOpening());
 const hullMesh = meshHull(hull);

 // The flow owns the state machine, the reading progress and the readout. It is
 // created once and lives for the app's lifetime, which is what makes
 // `walk_inspect_step_outside_and_return_with_progress_intact` true: re-creating
 // it on entry to the interior would clear a session's reading on the way
 // through the airlock.
 const flow: GameFlow = {
  state: (initialState.state as FlowGameState | undefined) ?? INITIAL_GAME_STATE,
  requested: null,
  progress: new InteriorProgress(),
  readout: { visible: false, consoleId: null },
 };

 const app: CryoApp = {
  simulation,
  state: displayState(flow.state),
  flow,
  hullMesh,
  advanceSimulation(steps: bigint) {
   return simulation.advance(steps);
  },
  hudText(): string {
   const snapshot = simulation.snapshot();
   return formatHudStatus({
    clock: `t${snapshot.time.getTicks()}`,
    activity: snapshot.activity,
    suitCharge: snapshot.suitCharge,
   });
  },
  handleFrame(input: InputState): GameState {
   const frame: FrameInput = {
    pressed: input.pressedThisFrame,
    held: input.held,
    dt: 0,
   };
   // The button is the keyboard's twin: `start_game_system` observes both in
   // one place, so "was a start requested?" never depends on system ordering.
   const pressed = consumeStartClick() ? [...frame.pressed, 'Space'] : frame.pressed;
   stepFrame(flow, { ...frame, pressed }, openingPlan(), views, () => {
    simulation.advanceSingleStep();
   });
   app.state = displayState(flow.state);
   setTitleVisible(flow.state === 'title');
   setHudText(app.hudText());
   return app.state;
  },
 };

 if (platform.scene !== null) {
  mountTitle();
  setTitleVisible(flow.state === 'title');
  setHudText(app.hudText());
 }

 return app;
}

/** The state a `build` call with no renderer is in. */
export const HEADLESS_STATE: InitialState = { seed: 0n, state: 'title' };

/** The interior plan the game opens with. */
export function openingPlan(): InteriorPlan {
 return crashedShip();
}
