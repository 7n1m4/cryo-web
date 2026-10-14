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

import type { AbstractEngine, Scene } from 'babylonjs';

import { crashedShip } from './ship/interior.ts';
import type { InteriorPlan } from './ship/interior.ts';
import { hullConfigDamagedOpening, HullPlan, meshHull } from './ship/voxel.ts';
import type { ShipMesh } from './ship/voxel.ts';
import { Seed, Simulation } from './sim/simulation.ts';
import type { InputState } from './presentation/inputTypes.ts';
import { frameWantsStart } from './presentation/input.ts';
import { formatHudStatus, setHudText, setTitleVisible } from './presentation/hud.ts';

/** What a platform supplies. A renderer, and nothing else. */
export interface Platform {
  /** The engine, or `null` in a test. */
  readonly engine: AbstractEngine | null;
  /** The scene, or `null` in a test. */
  readonly scene: Scene | null;
}

/** Which screen the game is showing. */
export type GameState = 'title' | 'exterior' | 'interior';

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
  /** Advances the simulation by `steps`, returning any error. */
  advanceSimulation(steps: bigint): ReturnType<Simulation['advance']>;
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
 */
export function build(platform: Platform, initialState: InitialState = {}): CryoApp {
  const seed = initialState.seed ?? Seed.default().getValue();
  const simulation = Simulation.genesis(Seed.new(seed));
  let state: GameState = initialState.state ?? 'title';

  const hull = HullPlan.generate(hullConfigDamagedOpening());
  const hullMesh = meshHull(hull);

  const app: CryoApp = {
    simulation,
    state,
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
      if (state === 'title' && frameWantsStart({ pressed: input.pressedThisFrame })) {
        state = 'exterior';
      }
      app.state = state;
      return state;
    },
  };

  if (platform.scene !== null) {
    setTitleVisible(state === 'title');
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
