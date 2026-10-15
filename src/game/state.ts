/**
 * The gameplay state machine, ported from `cryo/src/game/state.rs`.
 *
 * These are the coarse phases of the program. They are deliberately not the
 * same thing as `Activity`, which is a simulation-owned gameplay state that can
 * change many times within one `exterior`.
 *
 * The Rust module's comment is worth keeping verbatim in spirit: the variant
 * set is exhaustive, and adding a variant must force every consumer to be
 * revisited. TypeScript's discriminated unions are weaker than Rust's enums, so
 * the exhaustiveness is bought back with a `Record<GameState, …>` table rather
 * than a `switch`: a missing variant is then a compile error at the table, at
 * every consumer of the table, and nowhere else in the file.
 *
 * Nothing in this module is allowed to become the authoritative source of
 * gameplay state. The simulation is, and this module only schedules it.
 */

import type { GameSystem } from './step.ts';

/**
 * The app-wide game states, in declaration order.
 *
 * The order pins the variant list the way the Rust enum declaration does:
 * `Title` first (it is the `#[default]`), then `Exterior`, `Interior`,
 * `Paused`. It is not a traversal order — no system iterates it.
 */
export const GAME_STATES = ['title', 'exterior', 'interior', 'paused'] as const;

/** One of the coarse phases of the program. */
export type GameState = (typeof GAME_STATES)[number];

/** The state the game opens on, mirroring the Rust `#[default]`. */
export const INITIAL_GAME_STATE: GameState = 'title';

/** What a state's handler knows how to answer. */
export interface GameStateHandler {
 /** Whether the simulation advances while the game is in this state. */
 readonly advancesSimulation: boolean;
 /** The display label, the port of `presentation::state_label`. */
 readonly label: string;
 /** The systems this state runs, in the order the Rust registers them. */
 readonly systems: readonly GameSystem[];
}

/**
 * The exhaustive answer to every question a state has to answer.
 *
 * Every entry is required, so a new variant cannot be added to `GameState`
 * without this table failing to typecheck — which is the whole reason this is a
 * record rather than a `switch` spread across the module.
 */
export const GAME_STATE_HANDLERS: Readonly<Record<GameState, GameStateHandler>> = {
 // Title: the game has built everything and waits for the player. The clock is
 // inert, so a player who reads the title has not spent suit charge.
 title: { advancesSimulation: false, label: 'title', systems: ['start'] },

 // Exterior gameplay: the simulation is advancing, one fixed step per frame.
 exterior: {
  advancesSimulation: true,
  label: 'exterior',
  systems: ['advance-simulation', 'board-the-hull'],
 },

 // Interior. Like `paused`, the simulation does not advance here: the player
 // steps out of the flow of time while inside, so a clock running in the dark
 // would spend suit charge and survey time with no frame loop to justify it.
 // That is a settled decision, not a placeholder — the variant is labelled and
 // fully reachable, it simply does not drive the clock.
 interior: {
  advancesSimulation: false,
  label: 'interior',
  systems: ['inspect-console', 'close-readout', 'airlock-transition'],
 },

 // Paused. The simulation is frozen but still inspectable. No system requests
 // this state — the Rust architecture records it as declared and unreachable,
 // so reaching it is an explicit transition request, which is what
 // `GameFlow.request` and `GameFlow.togglePause` exist for.
 paused: { advancesSimulation: false, label: 'paused', systems: [] },
};

/**
 * Whether the simulation should advance in this state.
 *
 * Port of `GameState::advances_simulation`, which is `matches!(self,
 * Self::Exterior)`. Exactly one state drives the clock, and the answer is read
 * out of the table above rather than written a second time here.
 */
export function advancesSimulation(state: GameState): boolean {
 return GAME_STATE_HANDLERS[state].advancesSimulation;
}

/**
 * The display label, the port of `presentation::state_label`.
 *
 * It lives here rather than beside the HUD because it is a property of the
 * state, not of the rendering: the Rust function borrows `&State<GameState>`
 * precisely so a system and a test can both ask.
 */
export function stateLabel(state: GameState): string {
 return GAME_STATE_HANDLERS[state].label;
}

/**
 * Guards a `switch` that must have handled every state already.
 *
 * The escape hatch for the few places a `switch` reads better than a table
 * lookup — `consoleDamageState`-style dispatch over a plan, for instance. The
 * parameter is `never`, so the call only typechecks once every variant has been
 * narrowed away, and a later variant makes this file stop compiling.
 */
export function assertNever(state: never): never {
 throw new Error(`unhandled game state: ${String(state)}`);
}
