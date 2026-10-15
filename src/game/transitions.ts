/**
 * The transition table, ported from the Rust's `NextState` writes.
 *
 * In Bevy a system requests a transition and the `StateTransition` schedule
 * applies it on the *next* frame, which is what makes the frame semantics
 * below observable rather than incidental. There is no second schedule here, so
 * the same two-phase structure is spelled out instead: `stepFrame` reads the
 * requests a system wrote this frame and applies them at the boundary, and only
 * the *following* frame's systems see the new state.
 *
 * Every write in the Rust is `set_if_different`, so every entry here is too. A
 * request for the state the game is already in is dropped, which is what keeps
 * `once_playing_start_inputs_have_no_power_left` true: repeated start input
 * mid-game cannot re-queue a transition the game is already in.
 */

import type { GameState } from './state.ts';

/**
 * What a frame's input can ask the state machine for.
 *
 * Each intent is one key doing one thing in one place, exactly as the Rust
 * splits `KeyE` into two systems that ask different questions. None of them is
 * "the transition happened" — a request is a request, and whether it is legal is
 * this module's answer.
 */
export const TRANSITION_INTENTS = [
 'start',
 'board',
 'exit-hull',
 'pause',
 'resume',
] as const;

/** Something a frame's input can ask for. */
export type TransitionIntent = (typeof TRANSITION_INTENTS)[number];

/**
 * What the start keys mean, as one intent.
 *
 * The Rust's `START_KEYS` is `[KeyCode::Space, KeyCode::Enter,
 * KeyCode::NumpadEnter]` consumed through `any_just_pressed`, so the three keys
 * are one input to the state machine and never three. Written here as a set
 * rather than three comparisons so the game layer owns its own copy: the
 * presentation layer's copy is a walking-code concern that is being removed.
 */
export const START_KEYS: Readonly<Record<string, true>> = {
 Space: true,
 Enter: true,
 NumpadEnter: true,
};

/**
 * What a request for `intent` means while in `state`, or `null` for "illegal
 * here".
 *
 * Read as `TRANSITIONS[state][intent]`. The shape is a full matrix rather than a
 * list of edges so a missing combination is a compile error rather than a
 * silently dropped request.
 */
export const TRANSITIONS: Readonly<Record<GameState, Readonly<Record<TransitionIntent, GameState | null>>>> = {
 // The title screen has exactly one purpose: leaving. A start intent is the
 // only thing it answers, and it answers it the same way for every start key
 // and for the button, because the Rust observes both in one system rather
 // than two that would make "was a start requested?" depend on ordering.
 title: {
  start: 'exterior',
  board: null,
  'exit-hull': null,
  pause: null,
  resume: null,
 },

 // The exterior can board, and it can pause. It cannot resume, because
 // resuming is what leaving `paused` is called and only `paused` needs it.
 exterior: {
  start: null,
  board: 'interior',
  'exit-hull': null,
  pause: 'paused',
  resume: null,
 },

 // The interior can leave through the airlock. It cannot pause: `paused` is the
 // exterior's frozen clock, and the interior is already clock-inert, so pausing
 // in there would only teleport the player outside.
 interior: {
  start: null,
  board: null,
  'exit-hull': 'exterior',
  pause: null,
  resume: null,
 },

 // Paused can only resume, and it resumes into the exterior that paused.
 paused: {
  start: null,
  board: null,
  'exit-hull': null,
  pause: null,
  resume: 'exterior',
 },
};

/**
 * The state a request for `intent` means, with the `set_if_different` rule
 * applied.
 *
 * `null` for two different reasons — the request is illegal in this state, or it
 * asks for the state the game is already in — and the caller cannot tell them
 * apart, which is exactly the point: neither one applies a transition.
 */
export function resolveTransition(state: GameState, intent: TransitionIntent): GameState | null {
 const target = TRANSITIONS[state][intent];
 if (target === null || target === state) {
  return null;
 }
 return target;
}

/**
 * Applies a queued transition request at the frame boundary.
 *
 * The second half of `set_if_different`: `requested` is what the previous
 * frame's systems asked for, and it is applied only once, against the state the
 * new frame is entering with. Returns the state the game is now in.
 */
export function applyRequested(state: GameState, requested: GameState | null): GameState {
 return requested ?? state;
}
