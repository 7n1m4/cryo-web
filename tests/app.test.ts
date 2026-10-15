/**
 * The startup seam: `build(platform, initialState)` must work with no renderer.
 *
 * This is the test that keeps the seam honest. If it ever needs a canvas, an
 * engine, or a browser global, every simulation test becomes a browser test and
 * the whole reason for the port is gone.
 */

import { describe, expect, it } from 'vitest';

import { build, openingPlan, HEADLESS_STATE } from '../src/app.ts';
import type { Platform } from '../src/app.ts';
import { Activity, Seed, SimTime } from '../src/sim/simulation.ts';
import { InputTracker } from '../src/presentation/inputTypes.ts';

/** The no-renderer platform every test here uses. */
const HEADLESS: Platform = { engine: null, scene: null };

/** A built, headless app. */
function app(): ReturnType<typeof build> {
 return build(HEADLESS, HEADLESS_STATE);
}

describe('build', () => {
 it('builds with no renderer at all', () => {
  const built = app();
  expect(built.simulation.getTime().getTicks()).toBe(0n);
  expect(built.state).toBe('title');
  expect(built.simulation.getSeed().getValue()).toBe(0n);
 });

 it('exposes a meshed hull, meshed once', () => {
  const built = app();
  expect(built.hullMesh.positions.length).toBeGreaterThan(0);
  // Meshed once and reused: the same mesh object every time it is read.
  expect(built.hullMesh).toBe(built.hullMesh);
  expect(built.hullMesh.indices.length).toBe(built.hullMesh.positions.length / 4 * 6);
 });

 it('opens on the interior plan a player could walk around in', () => {
  const plan = openingPlan();
  expect(plan.rooms.length).toBeGreaterThan(0);
 });

 it('honours a seed and a start state', () => {
  const built = build(HEADLESS, { seed: 7n, state: 'exterior' });
  expect(built.simulation.getSeed().getValue()).toBe(7n);
  expect(built.state).toBe('exterior');
 });

 it('defaults to the default seed and the title screen', () => {
  const built = build(HEADLESS);
  expect(built.simulation.getSeed().getValue()).toBe(Seed.default().getValue());
  expect(built.state).toBe('title');
 });

 it('advances the simulation and reports errors, not throwing them', () => {
  const built = app();
  expect(built.advanceSimulation(10n)).toBeNull();
  expect(built.simulation.getTime().getTicks()).toBe(10n);
 });

 it('moves the title screen to the exterior on a start key, exactly once', () => {
  // The one-shot behaviour that makes the seam real: a start key held for
  // sixty frames must boot the exterior once, not sixty times.
  //
  // Two frames, because that is Bevy's frame semantics: `Update` runs before
  // `StateTransition`, so the frame that sees the press is still in `title`
  // when its systems run and takes no step, and the *next* frame applies the
  // request. The Rust's own test states it as "the request frame must not
  // advance the clock; the next frame must run exactly one step".
  const built = app();
  const input = new InputTracker();
  input.press('Enter');
  expect(built.handleFrame(input.state())).toBe('title');
  expect(built.simulation.getStepsCompleted()).toBe(0n);
  expect(built.handleFrame(input.state())).toBe('exterior');
  expect(built.simulation.getStepsCompleted()).toBe(1n);
  // Still held, still no further transition.
  built.handleFrame(input.state());
  expect(built.simulation.getStepsCompleted()).toBe(2n);
  input.release('Enter');
  input.press('Enter');
  built.handleFrame(input.state());
  expect(built.simulation.getStepsCompleted()).toBe(3n);
 });

 it('ignores a non-start key on the title screen', () => {
  const built = app();
  const input = new InputTracker();
  input.press('KeyW');
  expect(built.handleFrame(input.state())).toBe('title');
 });

 it('renders a HUD line with no DOM present', () => {
  const built = app();
  built.advanceSimulation(5n);
  const text = built.hudText();
  expect(text).toContain('t5');
  expect(text).toContain('Resting');
  expect(text).toContain('suit 100%');
 });

 it('renders the activity the simulation is in', () => {
  const built = app();
  built.simulation.beginActivity(Activity.Surveying);
  built.advanceSimulation(3n);
  expect(built.hudText()).toContain('Surveying');
  expect(built.hudText()).toContain('suit 88%');
 });

 it('is deterministic: two builds with the same seed agree exactly', () => {
  const first = build(HEADLESS, { seed: 42n });
  const second = build(HEADLESS, { seed: 42n });
  first.advanceSimulation(9n);
  second.advanceSimulation(9n);
  expect(first.hudText()).toBe(second.hudText());
  expect(first.hullMesh.positions.length).toBe(second.hullMesh.positions.length);
 });
});

describe('SimTime and Seed through the seam', () => {
 it('renders a clock the HUD can format', () => {
  expect(`t${SimTime.fromTicks(12n).getTicks()}`).toBe('t12');
 });
});
