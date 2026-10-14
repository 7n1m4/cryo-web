/**
 * One-shot key intents.
 *
 * The Rust reads raw input and edges it: a key is an intent for exactly one
 * frame, so a held key produces one action and not one per frame. That is what
 * `justPressed` means here — the frame a key goes down, and never again until it
 * is released and pressed again.
 *
 * `endFrame` is the seam that makes it a one-shot: without it, "press start"
 * would fire every frame the key is held, which boots the survey sixty times a
 * second.
 */

import type { InputFrame, InputState } from './inputTypes.ts';

/** Which keys mean "start", on the title screen. */
export const START_KEYS: Readonly<Record<string, true>> = {
  Enter: true,
  ' ': true,
  Space: true,
};

/** Whether this frame's edge list contains a start key. */
export function frameWantsStart(frame: InputFrame): boolean {
  return frame.pressed.some((key) => START_KEYS[key] === true);
}

/** A frame of input, as the walking code consumes it. */
export interface WalkFrame {
  /** Forward/back, -1..=1. */
  readonly forward: number;
  /** Strafe right/left, -1..=1. */
  readonly strafe: number;
  /** Whether the sprint modifier is held. */
  readonly sprinting: boolean;
  /** Seconds since the previous frame, passed in rather than read. */
  readonly dt: number;
}

/** The keys the walking code reads, as a static lookup. */
export const WALK_KEYS: Readonly<Record<string, readonly [forward: number, strafe: number]>> = {
  KeyW: [1, 0],
  ArrowUp: [1, 0],
  KeyS: [-1, 0],
  ArrowDown: [-1, 0],
  KeyA: [0, -1],
  ArrowLeft: [0, -1],
  KeyD: [0, 1],
  ArrowRight: [0, 1],
};

/** Builds a walk frame from the keys currently held down. */
export function walkFrame(state: InputState, dt: number): WalkFrame {
  let forward = 0;
  let strafe = 0;
  for (const key of state.held) {
    const binding = WALK_KEYS[key];
    if (binding === undefined) {
      continue;
    }
    forward += binding[0];
    strafe += binding[1];
  }
  const sprinting = state.held.some((key) => key === 'ShiftLeft' || key === 'ShiftRight');
  return {
    forward: Math.max(-1, Math.min(1, forward)),
    strafe: Math.max(-1, Math.min(1, strafe)),
    sprinting,
    dt,
  };
}
